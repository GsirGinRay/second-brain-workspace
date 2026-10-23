use axum::Router;
use axum::body::Body;
use axum::http::{HeaderName, Request, StatusCode};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use inbox_relay::canonical::{self, CanonicalRequest};
use inbox_relay::limits::Limits;
use inbox_relay::store::Store;
use inbox_relay::{AppState, router};
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde_json::{Value, json};
use std::sync::Arc;
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
    let now = Arc::new(AtomicI64::new(START));
    let clock_now = Arc::clone(&now);
    let state = Arc::new(AppState::new(
        Store::open_in_memory().unwrap(),
        limits,
        Arc::new(move || clock_now.load(Ordering::SeqCst)),
        Some(HeaderName::from_static("x-test-ip")),
    ));
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
