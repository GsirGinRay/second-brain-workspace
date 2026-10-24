use axum::Router;
use axum::body::Body;
use axum::http::{HeaderName, Request, StatusCode};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use inbox_relay::canonical::{self, CanonicalRequest};
use inbox_relay::limits::Limits;
use inbox_relay::line::{Line, LineApi};
use inbox_relay::membership::{BoxFuture, Directory, Mailer, NoDirectory, NoMailer, Unavailable};
use inbox_relay::store::Store;
use inbox_relay::{AppState, router};
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest};
use tower::ServiceExt;

const START: i64 = 1_790_000_000;
const DAY: i64 = 24 * 60 * 60;
const SIGNATURE_FIXTURE: &str = include_str!("../../../docs/fixtures/canonical-signature-v1.json");
const ENVELOPE_FIXTURE: &str = include_str!("../../../docs/fixtures/inbox-envelope-v1.json");

struct Harness {
    state: Arc<AppState>,
    app: Router,
    now: Arc<AtomicI64>,
    key: Ed25519KeyPair,
    nonce: AtomicU64,
}

struct Inbox {
    id: String,
    token: String,
}

fn harness(limits: Limits) -> Harness {
    harness_with(limits, Arc::new(NoDirectory), Arc::new(NoMailer))
}

fn harness_with(limits: Limits, directory: Arc<dyn Directory>, mailer: Arc<dyn Mailer>) -> Harness {
    build_harness(limits, directory, mailer, None)
}

fn build_harness(
    limits: Limits,
    directory: Arc<dyn Directory>,
    mailer: Arc<dyn Mailer>,
    line: Option<Line>,
) -> Harness {
    let now = Arc::new(AtomicI64::new(START));
    let clock_now = Arc::clone(&now);
    let mut state = AppState::new(
        Store::open_in_memory().unwrap(),
        limits,
        Arc::new(move || clock_now.load(Ordering::SeqCst)),
        Some(HeaderName::from_static("x-test-ip")),
    )
    .with_membership(directory, mailer);
    if let Some(line) = line {
        state = state.with_line(line);
    }
    let state = Arc::new(state);
    Harness {
        app: router(Arc::clone(&state)),
        state,
        now,
        key: Ed25519KeyPair::from_seed_unchecked(&[7; 32]).unwrap(),
        nonce: AtomicU64::new(1),
    }
}

fn item_id(n: u32) -> String {
    format!("{n:08x}-1111-4111-8111-111111111111")
}

fn envelope(id: &str) -> Value {
    let fixture: Value = serde_json::from_str(ENVELOPE_FIXTURE).unwrap();
    let mut envelope = fixture["envelope"].clone();
    envelope["id"] = id.into();
    envelope
}

impl Harness {
    fn now(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }

    fn advance(&self, seconds: i64) {
        self.now.fetch_add(seconds, Ordering::SeqCst);
    }

    fn next_nonce(&self) -> String {
        let n = self.nonce.fetch_add(1, Ordering::SeqCst);
        URL_SAFE_NO_PAD.encode([n.to_be_bytes(), [9; 8]].concat())
    }

    fn signed(
        &self,
        method: &str,
        path: &str,
        body: &[u8],
        device_id: Option<&str>,
    ) -> Request<Body> {
        self.signed_with(
            method,
            path,
            body,
            device_id,
            &self.next_nonce(),
            self.now(),
        )
    }

    fn signed_with(
        &self,
        method: &str,
        path: &str,
        body: &[u8],
        device_id: Option<&str>,
        nonce: &str,
        timestamp: i64,
    ) -> Request<Body> {
        let content_type = if body.is_empty() {
            ""
        } else {
            "application/json"
        };
        let canonical = canonical::canonicalize(&CanonicalRequest {
            method,
            path,
            timestamp,
            nonce,
            content_type,
            body,
        })
        .unwrap();
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header("x-brain-timestamp", timestamp.to_string())
            .header("x-brain-nonce", nonce)
            .header(
                "x-brain-signature",
                URL_SAFE_NO_PAD.encode(self.key.sign(canonical.as_bytes())),
            );
        if !content_type.is_empty() {
            builder = builder.header("content-type", content_type);
        }
        if let Some(device_id) = device_id {
            builder = builder.header("x-brain-device-id", device_id);
        }
        builder.body(Body::from(body.to_vec())).unwrap()
    }

    fn create_body(&self) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "signingPublicKey": URL_SAFE_NO_PAD.encode(self.key.public_key().as_ref())
        }))
        .unwrap()
    }

    async fn send(&self, request: Request<Body>) -> (StatusCode, Value) {
        let response = self.app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, body)
    }

    async fn create_inbox(&self) -> Inbox {
        let (status, body) = self
            .send(self.signed("POST", "/v1/inboxes", &self.create_body(), None))
            .await;
        assert_eq!(status, StatusCode::CREATED);
        Inbox {
            id: body["inboxId"].as_str().unwrap().to_owned(),
            token: body["captureToken"].as_str().unwrap().to_owned(),
        }
    }

    async fn post_item(&self, inbox: &str, token: &str, body: &Value) -> StatusCode {
        self.post_raw(
            inbox,
            token,
            serde_json::to_vec(body).unwrap(),
            "203.0.113.1",
        )
        .await
    }

    async fn post_raw(&self, inbox: &str, token: &str, body: Vec<u8>, ip: &str) -> StatusCode {
        let request = Request::post(format!("/v1/inboxes/{inbox}/items"))
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .header("x-test-ip", ip)
            .body(Body::from(body))
            .unwrap();
        self.send(request).await.0
    }

    async fn list(&self, inbox: &Inbox) -> Vec<Value> {
        let path = format!("/v1/inboxes/{}/items", inbox.id);
        let (status, body) = self
            .send(self.signed("GET", &path, b"", Some(&inbox.id)))
            .await;
        assert_eq!(status, StatusCode::OK);
        body["items"].as_array().unwrap().clone()
    }
}

#[test]
fn canonical_text_matches_the_shared_golden_vector() {
    let fixture: Value = serde_json::from_str(SIGNATURE_FIXTURE).unwrap();
    let request = &fixture["request"];
    let canonical = canonical::canonicalize(&CanonicalRequest {
        method: request["method"].as_str().unwrap(),
        path: request["path"].as_str().unwrap(),
        timestamp: request["timestamp"].as_str().unwrap().parse().unwrap(),
        nonce: request["nonce"].as_str().unwrap(),
        content_type: request["contentType"].as_str().unwrap(),
        body: request["rawBodyUtf8"].as_str().unwrap().as_bytes(),
    })
    .unwrap();
    assert_eq!(canonical, fixture["canonicalUtf8"]);
    let public_key = URL_SAFE_NO_PAD
        .decode(fixture["publicKeyBase64Url"].as_str().unwrap())
        .unwrap();
    assert!(canonical::verify(
        &public_key,
        fixture["signatureBase64Url"].as_str().unwrap(),
        &canonical
    ));
    assert!(!canonical::verify(&public_key, "AAAA", &canonical));
}

#[tokio::test]
async fn health_answers() {
    let harness = harness(Limits::default());
    let (status, body) = harness
        .send(Request::get("/api/health").body(Body::empty()).unwrap())
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "ok": true }));
}

#[tokio::test]
async fn inbox_creation_requires_a_fresh_signature_from_the_posted_key() {
    let harness = harness(Limits::default());
    let inbox = harness.create_inbox().await;
    assert_eq!(inbox.id.len(), 22);
    assert_eq!(URL_SAFE_NO_PAD.decode(&inbox.token).unwrap().len(), 32);

    let body = harness.create_body();
    let nonce = harness.next_nonce();
    let replayed =
        || harness.signed_with("POST", "/v1/inboxes", &body, None, &nonce, harness.now());
    assert_eq!(harness.send(replayed()).await.0, StatusCode::CREATED);
    assert_eq!(harness.send(replayed()).await.0, StatusCode::UNAUTHORIZED);

    let stale = harness.signed_with(
        "POST",
        "/v1/inboxes",
        &body,
        None,
        &harness.next_nonce(),
        harness.now() - 301,
    );
    assert_eq!(harness.send(stale).await.0, StatusCode::UNAUTHORIZED);

    let other = Ed25519KeyPair::from_seed_unchecked(&[8; 32]).unwrap();
    let wrong_key = serde_json::to_vec(&json!({
        "signingPublicKey": URL_SAFE_NO_PAD.encode(other.public_key().as_ref())
    }))
    .unwrap();
    let mut request = harness.signed("POST", "/v1/inboxes", &body, None);
    *request.body_mut() = Body::from(wrong_key);
    assert_eq!(harness.send(request).await.0, StatusCode::UNAUTHORIZED);

    let malformed = harness.signed(
        "POST",
        "/v1/inboxes",
        br#"{"signingPublicKey":"AAAA"}"#,
        None,
    );
    assert_eq!(harness.send(malformed).await.0, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn phone_items_are_idempotent_and_delivered_oldest_first() {
    let harness = harness(Limits::default());
    let inbox = harness.create_inbox().await;
    let first = envelope(&item_id(1));
    let second = envelope(&item_id(2));

    assert_eq!(
        harness.post_item(&inbox.id, &inbox.token, &first).await,
        StatusCode::CREATED
    );
    harness.advance(1);
    assert_eq!(
        harness.post_item(&inbox.id, &inbox.token, &second).await,
        StatusCode::CREATED
    );
    assert_eq!(
        harness.post_item(&inbox.id, &inbox.token, &first).await,
        StatusCode::OK
    );

    let mut changed = first.clone();
    changed["nonce"] = second["epk"].as_str().unwrap()[..16].into();
    assert_eq!(
        harness.post_item(&inbox.id, &inbox.token, &changed).await,
        StatusCode::CONFLICT
    );

    assert_eq!(harness.list(&inbox).await, vec![first, second]);
}

#[tokio::test]
async fn phone_requests_are_checked() {
    let harness = harness(Limits::default());
    let inbox = harness.create_inbox().await;
    let item = envelope(&item_id(1));

    assert_eq!(
        harness.post_item(&inbox.id, "wrong", &item).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        harness
            .post_item("BBECAwQFBgcICQoLDA0ODw", &inbox.token, &item)
            .await,
        StatusCode::NOT_FOUND
    );
    let mut malformed = item.clone();
    malformed["extra"] = 1.into();
    assert_eq!(
        harness.post_item(&inbox.id, &inbox.token, &malformed).await,
        StatusCode::BAD_REQUEST
    );
    let oversized = vec![b' '; 4097];
    assert_eq!(
        harness
            .post_raw(&inbox.id, &inbox.token, oversized, "203.0.113.1")
            .await,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert!(harness.list(&inbox).await.is_empty());
}

#[tokio::test]
async fn desktop_acknowledges_items_and_requests_must_be_its_own() {
    let harness = harness(Limits::default());
    let inbox = harness.create_inbox().await;
    harness
        .post_item(&inbox.id, &inbox.token, &envelope(&item_id(1)))
        .await;
    let path = format!("/v1/inboxes/{}/items/{}", inbox.id, item_id(1));

    let other = harness.create_inbox().await;
    let foreign = harness.signed("DELETE", &path, b"", Some(&other.id));
    assert_eq!(harness.send(foreign).await.0, StatusCode::UNAUTHORIZED);
    let unsigned = Request::delete(&path)
        .header("x-brain-device-id", &inbox.id)
        .body(Body::empty())
        .unwrap();
    assert_eq!(harness.send(unsigned).await.0, StatusCode::UNAUTHORIZED);
    let with_query = harness.signed(
        "GET",
        &format!("/v1/inboxes/{}/items", inbox.id),
        b"",
        Some(&inbox.id),
    );
    let (mut parts, body) = with_query.into_parts();
    parts.uri = format!("/v1/inboxes/{}/items?all=1", inbox.id)
        .parse()
        .unwrap();
    assert_eq!(
        harness.send(Request::from_parts(parts, body)).await.0,
        StatusCode::BAD_REQUEST
    );

    let ack = || harness.signed("DELETE", &path, b"", Some(&inbox.id));
    assert_eq!(harness.send(ack()).await.0, StatusCode::NO_CONTENT);
    assert_eq!(harness.send(ack()).await.0, StatusCode::NO_CONTENT);
    assert!(harness.list(&inbox).await.is_empty());
}

#[tokio::test]
async fn rotating_the_token_locks_out_the_old_phone() {
    let harness = harness(Limits::default());
    let inbox = harness.create_inbox().await;
    let path = format!("/v1/inboxes/{}/token", inbox.id);
    let (status, body) = harness
        .send(harness.signed("POST", &path, b"", Some(&inbox.id)))
        .await;
    assert_eq!(status, StatusCode::OK);
    let token = body["captureToken"].as_str().unwrap();
    assert_ne!(token, inbox.token);

    let item = envelope(&item_id(1));
    assert_eq!(
        harness.post_item(&inbox.id, &inbox.token, &item).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        harness.post_item(&inbox.id, token, &item).await,
        StatusCode::CREATED
    );
}

#[tokio::test]
async fn deleting_the_inbox_removes_everything() {
    let harness = harness(Limits::default());
    let inbox = harness.create_inbox().await;
    harness
        .post_item(&inbox.id, &inbox.token, &envelope(&item_id(1)))
        .await;
    let path = format!("/v1/inboxes/{}", inbox.id);
    assert_eq!(
        harness
            .send(harness.signed("DELETE", &path, b"", Some(&inbox.id)))
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        harness
            .post_item(&inbox.id, &inbox.token, &envelope(&item_id(2)))
            .await,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn pending_and_storage_limits_are_enforced() {
    let limits = Limits {
        pending_items_per_inbox: 2,
        ..Limits::default()
    };
    let harness = harness(limits);
    let inbox = harness.create_inbox().await;
    for n in 1..=2 {
        assert_eq!(
            harness
                .post_item(&inbox.id, &inbox.token, &envelope(&item_id(n)))
                .await,
            StatusCode::CREATED
        );
    }
    assert_eq!(
        harness
            .post_item(&inbox.id, &inbox.token, &envelope(&item_id(3)))
            .await,
        StatusCode::TOO_MANY_REQUESTS
    );

    let item_bytes = serde_json::to_string(&envelope(&item_id(1))).unwrap().len();
    let small = harness_with_storage(item_bytes * 2);
    let inbox = small.create_inbox().await;
    for n in 1..=2 {
        assert_eq!(
            small
                .post_item(&inbox.id, &inbox.token, &envelope(&item_id(n)))
                .await,
            StatusCode::CREATED
        );
    }
    assert_eq!(
        small
            .post_item(&inbox.id, &inbox.token, &envelope(&item_id(3)))
            .await,
        StatusCode::INSUFFICIENT_STORAGE
    );
}

fn harness_with_storage(storage_bytes: usize) -> Harness {
    harness(Limits {
        storage_bytes,
        ..Limits::default()
    })
}

#[tokio::test]
async fn creation_and_uploads_are_rate_limited() {
    let harness = harness(Limits {
        inbox_creations_per_ip_hour: 2,
        inbox_creations_per_hour: 3,
        uploads_per_inbox_minute: 3,
        uploads_per_ip_minute: 2,
        ..Limits::default()
    });
    let inbox = harness.create_inbox().await;
    harness.create_inbox().await;
    let (status, _) = harness
        .send(harness.signed("POST", "/v1/inboxes", &harness.create_body(), None))
        .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    let mut other_ip = harness.signed("POST", "/v1/inboxes", &harness.create_body(), None);
    other_ip
        .headers_mut()
        .insert("x-test-ip", "192.0.2.9".parse().unwrap());
    assert_eq!(harness.send(other_ip).await.0, StatusCode::CREATED);
    let mut third_ip = harness.signed("POST", "/v1/inboxes", &harness.create_body(), None);
    third_ip
        .headers_mut()
        .insert("x-test-ip", "192.0.2.10".parse().unwrap());
    assert_eq!(
        harness.send(third_ip).await.0,
        StatusCode::TOO_MANY_REQUESTS,
        "the global cap holds across addresses"
    );

    let post = |n: u32, ip: &'static str| {
        let body = serde_json::to_vec(&envelope(&item_id(n))).unwrap();
        harness.post_raw(&inbox.id, &inbox.token, body, ip)
    };
    assert_eq!(post(1, "198.51.100.1").await, StatusCode::CREATED);
    assert_eq!(post(2, "198.51.100.1").await, StatusCode::CREATED);
    assert_eq!(post(3, "198.51.100.1").await, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(post(3, "198.51.100.2").await, StatusCode::CREATED);
    assert_eq!(post(4, "198.51.100.3").await, StatusCode::TOO_MANY_REQUESTS);
    harness.advance(60);
    assert_eq!(post(4, "198.51.100.3").await, StatusCode::CREATED);
}

#[tokio::test]
async fn old_items_and_idle_inboxes_are_purged() {
    let harness = harness(Limits::default());
    let inbox = harness.create_inbox().await;
    harness
        .post_item(&inbox.id, &inbox.token, &envelope(&item_id(1)))
        .await;
    harness.advance(13 * DAY);
    harness
        .post_item(&inbox.id, &inbox.token, &envelope(&item_id(2)))
        .await;
    harness.advance(DAY + 1);
    let purged = harness.state.purge().unwrap();
    assert_eq!((purged.items, purged.inboxes), (1, 0));
    assert_eq!(harness.list(&inbox).await, vec![envelope(&item_id(2))]);

    let idle = harness.create_inbox().await;
    harness.advance(180 * DAY + 1);
    harness.list(&inbox).await;
    let purged = harness.state.purge().unwrap();
    assert_eq!(purged.inboxes, 1);
    assert_eq!(
        harness
            .post_item(&idle.id, &idle.token, &envelope(&item_id(3)))
            .await,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn the_stream_pushes_backlog_and_new_items_and_takes_acks() {
    let harness = harness(Limits::default());
    let inbox = harness.create_inbox().await;
    harness
        .post_item(&inbox.id, &inbox.token, &envelope(&item_id(1)))
        .await;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = harness.app.clone();
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });

    let path = format!("/v1/inboxes/{}/stream", inbox.id);
    let signed = harness.signed("GET", &path, b"", Some(&inbox.id));
    let mut request = format!("ws://{addr}{path}").into_client_request().unwrap();
    for (name, value) in signed.headers() {
        request.headers_mut().insert(name, value.clone());
    }
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();

    let next_item = async |socket: &mut tokio_tungstenite::WebSocketStream<_>| loop {
        match socket.next().await.unwrap().unwrap() {
            tungstenite::Message::Text(text) => {
                let message: Value = serde_json::from_str(&text).unwrap();
                assert_eq!(message["type"], "item");
                return message["envelope"].clone();
            }
            _ => continue,
        }
    };
    assert_eq!(next_item(&mut socket).await, envelope(&item_id(1)));

    harness
        .post_item(&inbox.id, &inbox.token, &envelope(&item_id(2)))
        .await;
    assert_eq!(next_item(&mut socket).await, envelope(&item_id(2)));

    for n in 1..=2 {
        let ack = json!({ "type": "ack", "id": item_id(n) }).to_string();
        socket
            .send(tungstenite::Message::Text(ack.into()))
            .await
            .unwrap();
    }
    for _ in 0..50 {
        if harness.list(&inbox).await.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(harness.list(&inbox).await.is_empty());

    let unsigned = format!("ws://{addr}{path}").into_client_request().unwrap();
    assert!(tokio_tungstenite::connect_async(unsigned).await.is_err());
}

#[tokio::test]
async fn desktop_requests_and_streams_are_limited_per_inbox() {
    let harness = harness(Limits {
        desktop_requests_per_inbox_minute: 2,
        streams_per_inbox: 1,
        ..Limits::default()
    });
    let inbox = harness.create_inbox().await;
    let path = format!("/v1/inboxes/{}/items", inbox.id);
    let list = || harness.signed("GET", &path, b"", Some(&inbox.id));
    assert_eq!(harness.send(list()).await.0, StatusCode::OK);
    assert_eq!(harness.send(list()).await.0, StatusCode::OK);
    assert_eq!(harness.send(list()).await.0, StatusCode::TOO_MANY_REQUESTS);
    harness.advance(60);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = harness.app.clone();
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let stream_path = format!("/v1/inboxes/{}/stream", inbox.id);
    let connect = || {
        let signed = harness.signed("GET", &stream_path, b"", Some(&inbox.id));
        let mut request = format!("ws://{addr}{stream_path}")
            .into_client_request()
            .unwrap();
        for (name, value) in signed.headers() {
            request.headers_mut().insert(name, value.clone());
        }
        tokio_tungstenite::connect_async(request)
    };
    let (first, _) = connect().await.unwrap();
    assert!(connect().await.is_err());
    drop(first);
    let mut reconnected = false;
    for _ in 0..50 {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        harness.advance(60);
        if connect().await.is_ok() {
            reconnected = true;
            break;
        }
    }
    assert!(reconnected, "a closed stream frees its slot");
}

#[tokio::test]
async fn the_web_app_is_served_with_strict_headers() {
    let dir = std::env::temp_dir().join(format!("inbox-relay-static-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("assets")).unwrap();
    std::fs::write(dir.join("index.html"), "<!doctype html><title>app</title>").unwrap();
    std::fs::write(dir.join("assets/app-1234.js"), "console.log(1)").unwrap();
    let harness = harness(Limits::default());
    let app = inbox_relay::router_with_static(Arc::clone(&harness.state), &dir);
    let get = |path: &str| {
        let app = app.clone();
        let request = Request::get(path).body(Body::empty()).unwrap();
        async move { app.oneshot(request).await.unwrap() }
    };

    let index = get("/").await;
    assert_eq!(index.status(), StatusCode::OK);
    let headers = index.headers();
    assert!(
        headers["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("default-src 'self'")
    );
    assert_eq!(headers["x-content-type-options"], "nosniff");
    assert_eq!(headers["referrer-policy"], "no-referrer");
    assert_eq!(headers["cache-control"], "no-cache");

    let shared = get("/?text=hello").await;
    assert_eq!(shared.status(), StatusCode::OK);
    let body = shared.into_body().collect().await.unwrap().to_bytes();
    assert!(String::from_utf8_lossy(&body).contains("<title>app</title>"));

    let asset = get("/assets/app-1234.js").await;
    assert_eq!(asset.status(), StatusCode::OK);
    assert!(
        asset.headers()["cache-control"]
            .to_str()
            .unwrap()
            .contains("immutable")
    );

    let unknown_api = get("/v1/nope").await;
    assert_eq!(unknown_api.status(), StatusCode::NOT_FOUND);
    assert_eq!(unknown_api.headers()["content-type"], "application/json");
    assert_eq!(get("/api/health").await.status(), StatusCode::OK);

    std::fs::remove_dir_all(&dir).unwrap();
}

/// Members by email; `None` behaves like an unreachable Google Sheet.
struct FakeDirectory(Mutex<Option<Vec<String>>>);

impl Directory for FakeDirectory {
    fn is_member<'a>(&'a self, email: &'a str) -> BoxFuture<'a, Result<bool, Unavailable>> {
        let answer = self
            .0
            .lock()
            .unwrap()
            .as_ref()
            .map(|members| members.iter().any(|member| member == email))
            .ok_or(Unavailable);
        Box::pin(async move { answer })
    }
}

#[derive(Default)]
struct FakeMailer {
    sent: Mutex<Vec<(String, String)>>,
    broken: Mutex<bool>,
}

impl Mailer for FakeMailer {
    fn send_code<'a>(
        &'a self,
        email: &'a str,
        code: &'a str,
    ) -> BoxFuture<'a, Result<(), Unavailable>> {
        let result = if *self.broken.lock().unwrap() {
            Err(Unavailable)
        } else {
            self.sent
                .lock()
                .unwrap()
                .push((email.to_owned(), code.to_owned()));
            Ok(())
        };
        Box::pin(async move { result })
    }
}

struct Members {
    harness: Harness,
    directory: Arc<FakeDirectory>,
    mailer: Arc<FakeMailer>,
}

fn members(list: &[&str]) -> Members {
    members_with_line(list, None)
}

fn members_with_line(list: &[&str], line: Option<Line>) -> Members {
    let directory = Arc::new(FakeDirectory(Mutex::new(Some(
        list.iter().map(|email| (*email).to_owned()).collect(),
    ))));
    let mailer = Arc::new(FakeMailer::default());
    let harness = build_harness(
        Limits::default(),
        Arc::clone(&directory) as Arc<dyn Directory>,
        Arc::clone(&mailer) as Arc<dyn Mailer>,
        line,
    );
    Members {
        harness,
        directory,
        mailer,
    }
}

impl Members {
    async fn desktop(
        &self,
        inbox: &Inbox,
        method: &str,
        path: &str,
        body: Value,
    ) -> (StatusCode, Value) {
        let body = if body.is_null() {
            Vec::new()
        } else {
            serde_json::to_vec(&body).unwrap()
        };
        let path = format!("/v1/inboxes/{}{path}", inbox.id);
        self.harness
            .send(self.harness.signed(method, &path, &body, Some(&inbox.id)))
            .await
    }

    async fn phone_snapshot(&self, inbox: &Inbox, token: &str) -> (StatusCode, Value) {
        let request = Request::get(format!("/v1/inboxes/{}/snapshot", inbox.id))
            .header("authorization", format!("Bearer {token}"))
            .header("x-test-ip", "203.0.113.5")
            .body(Body::empty())
            .unwrap();
        self.harness.send(request).await
    }

    fn last_code(&self) -> String {
        self.mailer.sent.lock().unwrap().last().unwrap().1.clone()
    }

    async fn entitle(&self, inbox: &Inbox, email: &str) {
        let (status, _) = self
            .desktop(
                inbox,
                "POST",
                "/entitlement/code",
                json!({ "email": email }),
            )
            .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let code = self.last_code();
        let (status, _) = self
            .desktop(
                inbox,
                "POST",
                "/entitlement/verify",
                json!({ "code": code }),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
    }
}

fn snapshot_envelope(version: i64, ct_bytes: usize) -> Value {
    json!({
        "v": 1,
        "version": version,
        "nonce": URL_SAFE_NO_PAD.encode([1u8; 12]),
        "ct": URL_SAFE_NO_PAD.encode(vec![2u8; ct_bytes]),
    })
}

#[tokio::test]
async fn members_unlock_the_today_list_with_an_emailed_code() {
    let relay = members(&["member@example.com"]);
    let inbox = relay.harness.create_inbox().await;

    let (status, body) = relay
        .desktop(&inbox, "GET", "/entitlement", Value::Null)
        .await;
    assert_eq!(
        (status, body),
        (StatusCode::OK, json!({ "entitled": false, "email": null }))
    );

    let (status, body) = relay
        .desktop(
            &inbox,
            "POST",
            "/entitlement/code",
            json!({ "email": "someone@example.com" }),
        )
        .await;
    assert_eq!(
        (status, body["error"].clone()),
        (StatusCode::FORBIDDEN, json!("not_member"))
    );
    assert!(relay.mailer.sent.lock().unwrap().is_empty());

    let (status, _) = relay
        .desktop(
            &inbox,
            "POST",
            "/entitlement/code",
            json!({ "email": " Member@Example.com " }),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (sent_to, code) = relay.mailer.sent.lock().unwrap()[0].clone();
    assert_eq!(sent_to, "member@example.com");
    assert_eq!(code.len(), 6);

    let (status, _) = relay
        .desktop(
            &inbox,
            "POST",
            "/entitlement/code",
            json!({ "email": "member@example.com" }),
        )
        .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "one code a minute");

    let wrong = if code == "000000" { "111111" } else { "000000" };
    let (status, body) = relay
        .desktop(
            &inbox,
            "POST",
            "/entitlement/verify",
            json!({ "code": wrong }),
        )
        .await;
    assert_eq!(
        (status, body["error"].clone()),
        (StatusCode::BAD_REQUEST, json!("wrong_code"))
    );

    let (status, body) = relay
        .desktop(
            &inbox,
            "POST",
            "/entitlement/verify",
            json!({ "code": code }),
        )
        .await;
    assert_eq!(
        (status, body),
        (
            StatusCode::OK,
            json!({ "entitled": true, "email": "member@example.com" })
        )
    );
    let (_, body) = relay
        .desktop(&inbox, "GET", "/entitlement", Value::Null)
        .await;
    assert_eq!(body["email"], "member@example.com");
}

#[tokio::test]
async fn codes_expire_and_allow_five_attempts() {
    let relay = members(&["member@example.com"]);
    let inbox = relay.harness.create_inbox().await;
    relay
        .desktop(
            &inbox,
            "POST",
            "/entitlement/code",
            json!({ "email": "member@example.com" }),
        )
        .await;
    let code = relay.last_code();
    let wrong = if code == "000000" { "111111" } else { "000000" };
    for _ in 0..5 {
        let (status, _) = relay
            .desktop(
                &inbox,
                "POST",
                "/entitlement/verify",
                json!({ "code": wrong }),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    let (status, body) = relay
        .desktop(
            &inbox,
            "POST",
            "/entitlement/verify",
            json!({ "code": code }),
        )
        .await;
    assert_eq!(
        (status, body["error"].clone()),
        (StatusCode::TOO_MANY_REQUESTS, json!("too_many_attempts"))
    );

    relay.harness.advance(61);
    relay
        .desktop(
            &inbox,
            "POST",
            "/entitlement/code",
            json!({ "email": "member@example.com" }),
        )
        .await;
    let code = relay.last_code();
    relay.harness.advance(10 * 60 + 1);
    let (status, body) = relay
        .desktop(
            &inbox,
            "POST",
            "/entitlement/verify",
            json!({ "code": code }),
        )
        .await;
    assert_eq!(
        (status, body["error"].clone()),
        (StatusCode::GONE, json!("code_expired"))
    );
}

#[tokio::test]
async fn outages_are_reported_and_manual_grants_work() {
    let relay = members(&[]);
    let inbox = relay.harness.create_inbox().await;
    *relay.directory.0.lock().unwrap() = None;
    let (status, body) = relay
        .desktop(
            &inbox,
            "POST",
            "/entitlement/code",
            json!({ "email": "paid@example.com" }),
        )
        .await;
    assert_eq!(
        (status, body["error"].clone()),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            json!("directory_unavailable")
        )
    );

    relay
        .harness
        .state
        .store
        .grant("paid@example.com", "bank transfer", START)
        .unwrap();
    *relay.mailer.broken.lock().unwrap() = true;
    let (status, body) = relay
        .desktop(
            &inbox,
            "POST",
            "/entitlement/code",
            json!({ "email": "paid@example.com" }),
        )
        .await;
    assert_eq!(
        (status, body["error"].clone()),
        (StatusCode::SERVICE_UNAVAILABLE, json!("mail_unavailable"))
    );

    *relay.mailer.broken.lock().unwrap() = false;
    relay.entitle(&inbox, "paid@example.com").await;
    let (_, body) = relay
        .desktop(&inbox, "GET", "/entitlement", Value::Null)
        .await;
    assert_eq!(body["entitled"], true);
}

#[tokio::test]
async fn only_entitled_inboxes_store_and_serve_snapshots() {
    let relay = members(&["member@example.com"]);
    let inbox = relay.harness.create_inbox().await;

    let (status, body) = relay
        .desktop(&inbox, "PUT", "/snapshot", snapshot_envelope(10, 64))
        .await;
    assert_eq!(
        (status, body["error"].clone()),
        (StatusCode::FORBIDDEN, json!("not_entitled"))
    );
    let (status, body) = relay.phone_snapshot(&inbox, &inbox.token).await;
    assert_eq!(
        (status, body["error"].clone()),
        (StatusCode::FORBIDDEN, json!("not_entitled"))
    );

    relay.entitle(&inbox, "member@example.com").await;
    let (status, body) = relay.phone_snapshot(&inbox, &inbox.token).await;
    assert_eq!(
        (status, body["error"].clone()),
        (StatusCode::NOT_FOUND, json!("no_snapshot"))
    );

    let large = snapshot_envelope(10, 20_000);
    assert_eq!(
        relay
            .desktop(&inbox, "PUT", "/snapshot", large.clone())
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        relay.desktop(&inbox, "PUT", "/snapshot", large).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        relay
            .desktop(&inbox, "PUT", "/snapshot", snapshot_envelope(9, 64))
            .await
            .0,
        StatusCode::CONFLICT
    );
    let mut extra = snapshot_envelope(11, 64);
    extra["extra"] = 1.into();
    assert_eq!(
        relay.desktop(&inbox, "PUT", "/snapshot", extra).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        relay
            .desktop(&inbox, "PUT", "/snapshot", snapshot_envelope(12, 140_000))
            .await
            .0,
        StatusCode::PAYLOAD_TOO_LARGE
    );

    let (status, body) = relay.phone_snapshot(&inbox, &inbox.token).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["version"], 10);
    assert_eq!(
        relay.phone_snapshot(&inbox, "wrong-token").await.0,
        StatusCode::UNAUTHORIZED
    );

    assert_eq!(
        relay
            .desktop(&inbox, "DELETE", "/entitlement", Value::Null)
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        relay.phone_snapshot(&inbox, &inbox.token).await.0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn the_daily_recheck_revokes_former_members_but_not_during_an_outage() {
    let relay = members(&["member@example.com"]);
    let inbox = relay.harness.create_inbox().await;
    relay.entitle(&inbox, "member@example.com").await;
    relay
        .desktop(&inbox, "PUT", "/snapshot", snapshot_envelope(1, 64))
        .await;

    relay.harness.advance(DAY + 1);
    assert_eq!(
        relay.harness.state.recheck_entitlements().await.unwrap(),
        (1, 0)
    );

    *relay.directory.0.lock().unwrap() = Some(Vec::new());
    assert_eq!(
        relay.harness.state.recheck_entitlements().await.unwrap(),
        (0, 0),
        "checked today"
    );
    relay.harness.advance(DAY + 1);
    *relay.directory.0.lock().unwrap() = None;
    assert_eq!(
        relay.harness.state.recheck_entitlements().await.unwrap(),
        (0, 0),
        "outage revokes nobody"
    );
    assert_eq!(
        relay.phone_snapshot(&inbox, &inbox.token).await.0,
        StatusCode::OK
    );

    *relay.directory.0.lock().unwrap() = Some(Vec::new());
    assert_eq!(
        relay.harness.state.recheck_entitlements().await.unwrap(),
        (0, 1)
    );
    assert_eq!(
        relay.phone_snapshot(&inbox, &inbox.token).await.0,
        StatusCode::FORBIDDEN
    );
    let (_, body) = relay
        .desktop(&inbox, "GET", "/entitlement", Value::Null)
        .await;
    assert_eq!(body["entitled"], false);
}

const LINE_SECRET: &str = "line-test-channel-secret";

#[derive(Default)]
struct FakeLine {
    replies: Mutex<Vec<(String, String)>>,
}

impl LineApi for FakeLine {
    fn reply<'a>(
        &'a self,
        reply_token: &'a str,
        text: &'a str,
    ) -> BoxFuture<'a, Result<(), Unavailable>> {
        self.replies
            .lock()
            .unwrap()
            .push((reply_token.to_owned(), text.to_owned()));
        Box::pin(async { Ok(()) })
    }
}

struct LineRelay {
    relay: Members,
    line: Arc<FakeLine>,
    events: AtomicU64,
}

fn line_relay() -> LineRelay {
    let line = Arc::new(FakeLine::default());
    let relay = members_with_line(
        &["member@example.com"],
        Some(Line::new(
            LINE_SECRET,
            "@testbot",
            Arc::clone(&line) as Arc<dyn LineApi>,
        )),
    );
    LineRelay {
        relay,
        line,
        events: AtomicU64::new(1),
    }
}

fn line_signature(body: &[u8]) -> String {
    use base64::engine::general_purpose::STANDARD;
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, LINE_SECRET.as_bytes());
    STANDARD.encode(ring::hmac::sign(&key, body).as_ref())
}

fn fixture_recipient() -> (String, p256::SecretKey) {
    let fixture: Value = serde_json::from_str(ENVELOPE_FIXTURE).unwrap();
    let scalar = URL_SAFE_NO_PAD
        .decode(
            fixture["recipient"]["privateScalarBase64Url"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
    (
        fixture["recipient"]["publicKeyBase64Url"]
            .as_str()
            .unwrap()
            .to_owned(),
        p256::SecretKey::from_slice(&scalar).unwrap(),
    )
}

/// Opens an envelope the way the desktop does (inbox_envelope.rs).
fn open_envelope(envelope: &Value, inbox_id: &str, secret: &p256::SecretKey) -> String {
    use p256::elliptic_curve::sec1::ToEncodedPoint;
    use ring::aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};
    use ring::hkdf::{HKDF_SHA256, Salt};
    let decode = |key: &str| {
        URL_SAFE_NO_PAD
            .decode(envelope[key].as_str().unwrap())
            .unwrap()
    };
    let epk = decode("epk");
    let peer = p256::PublicKey::from_sec1_bytes(&epk).unwrap();
    let shared = p256::ecdh::diffie_hellman(secret.to_nonzero_scalar(), peer.as_affine());
    let recipient = secret.public_key().to_encoded_point(false);
    let salt = [epk.as_slice(), recipient.as_bytes()].concat();
    let prk = Salt::new(HKDF_SHA256, &salt).extract(shared.raw_secret_bytes());
    let okm = prk
        .expand(&[b"second-brain-inbox-v1"], &AES_256_GCM)
        .unwrap();
    let key = LessSafeKey::new(UnboundKey::from(okm));
    let nonce: [u8; 12] = decode("nonce").try_into().unwrap();
    let aad = format!("v1\n{inbox_id}\n{}", envelope["id"].as_str().unwrap());
    let mut buffer = decode("ct");
    let plaintext = key
        .open_in_place(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(aad.as_bytes()),
            &mut buffer,
        )
        .unwrap();
    String::from_utf8(plaintext.to_vec()).unwrap()
}

impl LineRelay {
    fn harness(&self) -> &Harness {
        &self.relay.harness
    }

    async fn webhook_raw(&self, body: &[u8], signature: &str) -> StatusCode {
        let request = Request::post("/line/webhook")
            .header("content-type", "application/json")
            .header("x-line-signature", signature)
            .body(Body::from(body.to_vec()))
            .unwrap();
        self.harness().send(request).await.0
    }

    /// Sends one event from `user` and returns the reply, if any.
    async fn event(&self, user: &str, event: Value) -> Option<String> {
        let n = self.events.fetch_add(1, Ordering::SeqCst);
        let mut event = event;
        event["replyToken"] = format!("reply-{n}").into();
        event["source"] = json!({ "type": "user", "userId": user });
        event["mode"] = "active".into();
        event["timestamp"] = (self.harness().now() * 1000).into();
        if event.get("webhookEventId").is_none() {
            event["webhookEventId"] = format!("EVENT{n}").into();
        }
        let body =
            serde_json::to_vec(&json!({ "destination": "Ubot", "events": [event] })).unwrap();
        assert_eq!(
            self.webhook_raw(&body, &line_signature(&body)).await,
            StatusCode::OK
        );
        let replies = self.line.replies.lock().unwrap();
        replies
            .iter()
            .find(|(token, _)| *token == format!("reply-{n}"))
            .map(|(_, text)| text.clone())
    }

    async fn say(&self, user: &str, text: &str) -> String {
        self.event(
            user,
            json!({ "type": "message", "message": { "type": "text", "id": "1", "text": text } }),
        )
        .await
        .expect("a reply")
    }

    async fn link_code(&self, inbox: &Inbox) -> Value {
        let (public_key, _) = fixture_recipient();
        let (status, body) = self
            .relay
            .desktop(inbox, "POST", "/line", json!({ "publicKey": public_key }))
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }
}

#[tokio::test]
async fn line_is_off_without_an_official_account() {
    let relay = members(&["member@example.com"]);
    let inbox = relay.harness.create_inbox().await;
    relay.entitle(&inbox, "member@example.com").await;
    let (status, body) = relay.desktop(&inbox, "GET", "/line", Value::Null).await;
    assert_eq!(
        (status, body),
        (
            StatusCode::OK,
            json!({ "available": false, "linked": false })
        )
    );
    let (public_key, _) = fixture_recipient();
    let (status, body) = relay
        .desktop(&inbox, "POST", "/line", json!({ "publicKey": public_key }))
        .await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::SERVICE_UNAVAILABLE, Some("line_unavailable"))
    );
    let request = Request::post("/line/webhook")
        .header("x-line-signature", line_signature(b"{}"))
        .body(Body::from("{}"))
        .unwrap();
    assert_eq!(relay.harness.send(request).await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn members_link_line_and_their_messages_arrive_sealed() {
    let line = line_relay();
    let relay = &line.relay;
    let inbox = relay.harness.create_inbox().await;
    let (_, secret) = fixture_recipient();

    let (status, body) = relay.desktop(&inbox, "GET", "/line", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["available"], true);
    assert_eq!(body["linked"], false);
    assert_eq!(body["addFriendUrl"], "https://line.me/R/ti/p/%40testbot");

    let (public_key, _) = fixture_recipient();
    let (status, body) = relay
        .desktop(&inbox, "POST", "/line", json!({ "publicKey": public_key }))
        .await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::FORBIDDEN, Some("not_entitled"))
    );
    relay.entitle(&inbox, "member@example.com").await;
    let (status, _) = relay
        .desktop(
            &inbox,
            "POST",
            "/line",
            json!({ "publicKey": URL_SAFE_NO_PAD.encode([4u8; 65]) }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "not a point on the curve");

    assert!(line.say("U1", "明天 繳電話費").await.contains("還沒有連結"));
    let link = line.link_code(&inbox).await;
    let code = link["code"].as_str().unwrap().to_owned();
    assert_eq!(code.len(), 9);
    assert!(
        link["linkUrl"]
            .as_str()
            .unwrap()
            .starts_with("https://line.me/R/oaMessage/%40testbot/?%E9%80%A3%E7%B5%90%20")
    );
    assert!(
        line.say("U1", &format!("連結 {code}"))
            .await
            .contains("已連結")
    );
    assert!(
        line.say("U1", &format!("連結 {code}"))
            .await
            .contains("不對或已經過期"),
        "codes work once"
    );
    let (_, body) = relay.desktop(&inbox, "GET", "/line", Value::Null).await;
    assert_eq!(body["linked"], true);

    let reply = line
        .event(
            "U1",
            json!({
                "type": "message",
                "webhookEventId": "01FZ74A0TDDPYRVKNK77XKC3ZR",
                "message": { "type": "text", "id": "2", "text": "  明天下午三點 繳電話費\r\n帶帳單 " }
            }),
        )
        .await
        .unwrap();
    assert_eq!(reply, "已送到收件匣：明天下午三點 繳電話費…");
    let items = relay.harness.list(&inbox).await;
    assert_eq!(items.len(), 1);
    let plaintext = open_envelope(&items[0], &inbox.id, &secret);
    let created_at = {
        let payload: Value = serde_json::from_str(&plaintext).unwrap();
        payload["createdAt"].as_str().unwrap().to_owned()
    };
    assert_eq!(
        plaintext,
        format!(
            r#"{{"v":1,"text":"明天下午三點 繳電話費\n帶帳單","createdAt":"{created_at}","source":"line"}}"#
        )
    );
    assert_eq!(created_at, "2026-09-21T14:13:20.000Z");

    // LINE redelivers an event it thinks failed: still one item.
    line.event(
        "U1",
        json!({
            "type": "message",
            "webhookEventId": "01FZ74A0TDDPYRVKNK77XKC3ZR",
            "message": { "type": "text", "id": "2", "text": "明天下午三點 繳電話費" }
        }),
    )
    .await;
    assert_eq!(relay.harness.list(&inbox).await.len(), 1);

    let sticker = line
        .event(
            "U1",
            json!({ "type": "message", "message": { "type": "sticker", "id": "3" } }),
        )
        .await
        .unwrap();
    assert!(sticker.contains("只能把文字"));
    assert!(line.say("U2", "別人的訊息").await.contains("還沒有連結"));

    // Group chats and standby events are ignored.
    let body = serde_json::to_vec(&json!({ "events": [{
        "type": "message", "replyToken": "group", "mode": "active",
        "source": { "type": "group", "groupId": "G1", "userId": "U1" },
        "message": { "type": "text", "id": "4", "text": "群組訊息" }
    }] }))
    .unwrap();
    assert_eq!(
        line.webhook_raw(&body, &line_signature(&body)).await,
        StatusCode::OK
    );
    assert_eq!(relay.harness.list(&inbox).await.len(), 1);

    let (status, _) = relay
        .desktop(&inbox, "DELETE", "/entitlement", Value::Null)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(line.say("U1", "付費過期後").await.contains("付費會員"));
    assert_eq!(relay.harness.list(&inbox).await.len(), 1);
    relay.entitle(&inbox, "member@example.com").await;

    assert!(line.say("U1", "解除連結").await.contains("已解除連結"));
    assert!(line.say("U1", "還會送嗎").await.contains("還沒有連結"));
    let (_, body) = relay.desktop(&inbox, "GET", "/line", Value::Null).await;
    assert_eq!(body["linked"], false);

    // Relink, then unfollowing (blocking the account) unlinks too.
    let code = line.link_code(&inbox).await["code"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        line.say("U1", &code.replace('-', "").to_lowercase())
            .await
            .contains("已連結")
    );
    assert!(
        line.event("U1", json!({ "type": "unfollow" }))
            .await
            .is_none()
    );
    assert!(line.say("U1", "封鎖後").await.contains("還沒有連結"));

    // The desktop can drop the link; deleting the inbox drops it as well.
    let code = line.link_code(&inbox).await["code"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(line.say("U1", &code).await.contains("已連結"));
    let (status, _) = relay.desktop(&inbox, "DELETE", "/line", Value::Null).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(line.say("U1", "還在嗎").await.contains("還沒有連結"));
}

#[tokio::test]
async fn line_webhooks_need_the_channel_signature() {
    let line = line_relay();
    let body = br#"{"events":[]}"#;
    assert_eq!(
        line.webhook_raw(body, &line_signature(body)).await,
        StatusCode::OK
    );
    assert_eq!(
        line.webhook_raw(body, "bm90IGEgc2lnbmF0dXJl").await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(line.webhook_raw(body, "").await, StatusCode::UNAUTHORIZED);
    let tampered = br#"{"events":[{}]}"#;
    assert_eq!(
        line.webhook_raw(tampered, &line_signature(body)).await,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn line_codes_expire_and_guessing_is_limited() {
    let line = line_relay();
    let relay = &line.relay;
    let inbox = relay.harness.create_inbox().await;
    relay.entitle(&inbox, "member@example.com").await;

    let code = line.link_code(&inbox).await["code"]
        .as_str()
        .unwrap()
        .to_owned();
    relay.harness.advance(16 * 60);
    assert!(line.say("U1", &code).await.contains("不對或已經過期"));

    let code = line.link_code(&inbox).await["code"]
        .as_str()
        .unwrap()
        .to_owned();
    for _ in 0..10 {
        assert!(
            line.say("U9", "連結 2222-2222")
                .await
                .contains("不對或已經過期")
        );
    }
    assert!(line.say("U9", &code).await.contains("太多次"));
    assert!(
        line.say("U1", &code).await.contains("已連結"),
        "other people are not affected"
    );

    relay.harness.advance(3600);
    relay.harness.state.purge().unwrap();
    let (_, body) = relay.desktop(&inbox, "GET", "/line", Value::Null).await;
    assert_eq!(body["linked"], true, "purging old codes keeps links");
}
