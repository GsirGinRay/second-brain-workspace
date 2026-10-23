//! Encrypted phone-to-desktop inbox relay. Protocol: docs/inbox-relay.md.

pub mod canonical;
pub mod envelope;
mod hub;
pub mod limits;
pub mod store;

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{
    ConnectInfo, DefaultBodyLimit, FromRequestParts, MatchedPath, OriginalUri, Path, Request, State,
};
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE, RETRY_AFTER};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderName, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, delete, get, post};
use axum::{Json, Router};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::digest::{SHA256, digest};
use ring::rand::{SecureRandom, SystemRandom};
use serde::Deserialize;
use serde_json::json;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast::error::RecvError;

use canonical::{
    CanonicalRequest, DEVICE_ID_HEADER, NONCE_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER,
};
use hub::Hub;
use limits::{Limits, RateLimiter};
use store::{PutOutcome, Store};

pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

pub fn system_clock() -> Clock {
    Arc::new(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_secs() as i64)
    })
}

pub struct AppState {
    pub store: Store,
    pub limits: Limits,
    pub clock: Clock,
    /// Header that carries the client IP when behind a trusted proxy,
    /// for example `cf-connecting-ip`. Without it the socket address is used.
    pub client_ip_header: Option<HeaderName>,
    limiter: RateLimiter,
    hub: Hub,
}

impl AppState {
    pub fn new(
        store: Store,
        limits: Limits,
        clock: Clock,
        client_ip_header: Option<HeaderName>,
    ) -> Self {
        Self {
            store,
            limits,
            clock,
            client_ip_header,
            limiter: RateLimiter::default(),
            hub: Hub::default(),
        }
    }

    fn now(&self) -> i64 {
        (self.clock)()
    }

    /// Hourly housekeeping: expired items, idle inboxes, nonces, rate windows.
    pub fn purge(&self) -> rusqlite::Result<store::Purged> {
        let now = self.now();
        self.limiter.purge(now);
        self.hub.purge();
        self.store.purge(now, &self.limits)
    }
}

fn api_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/health", get(health))
        .route("/v1/inboxes", post(create_inbox))
        .route("/v1/inboxes/{id}", delete(delete_inbox))
        .route("/v1/inboxes/{id}/token", post(rotate_token))
        .route("/v1/inboxes/{id}/items", post(put_item).get(list_items))
        .route("/v1/inboxes/{id}/items/{item_id}", delete(delete_item))
        .route("/v1/inboxes/{id}/stream", get(stream))
        // Unknown API paths stay JSON errors instead of falling to the web app.
        .route("/v1/{*rest}", any(|| async { ApiError::NotFound }))
        .route("/api/{*rest}", any(|| async { ApiError::NotFound }))
}

fn finish(routes: Router<Arc<AppState>>, state: Arc<AppState>) -> Router {
    let body_limit = state.limits.envelope_bytes;
    routes
        .layer(DefaultBodyLimit::max(body_limit))
        .layer(middleware::from_fn(log_request))
        .layer(middleware::from_fn(security_headers))
        .with_state(state)
}

pub fn router(state: Arc<AppState>) -> Router {
    finish(api_routes(), state)
}

/// The API plus the phone web app built into `static_dir`. Unknown paths get
/// `index.html`, so share-sheet URLs such as `/?text=…` load the app.
pub fn router_with_static(state: Arc<AppState>, static_dir: &std::path::Path) -> Router {
    let site = tower_http::services::ServeDir::new(static_dir).not_found_service(
        tower_http::services::ServeFile::new(static_dir.join("index.html")),
    );
    finish(api_routes().fallback_service(site), state)
}

const CONTENT_SECURITY_POLICY: &str = concat!(
    "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; ",
    "connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; ",
    "form-action 'self'; frame-ancestors 'none'; object-src 'none'"
);

/// Strict headers for the API and the web app; hashed assets cache for a year,
/// everything else is revalidated so a deploy reaches phones right away.
async fn security_headers(request: Request, next: Next) -> Response {
    let immutable = request.uri().path().starts_with("/assets/");
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    let fixed = [
        ("content-security-policy", CONTENT_SECURITY_POLICY),
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"),
        ("x-frame-options", "DENY"),
        (
            "permissions-policy",
            "camera=(), microphone=(), geolocation=()",
        ),
        (
            "cache-control",
            if immutable {
                "public, max-age=31536000, immutable"
            } else {
                "no-cache"
            },
        ),
    ];
    for (name, value) in fixed {
        headers.insert(
            HeaderName::from_static(name),
            axum::http::HeaderValue::from_static(value),
        );
    }
    response
}

/// Logs method, route template and status only: no ids, tokens or addresses.
async fn log_request(request: Request, next: Next) -> Response {
    let method = request.method().clone();
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map_or("-".to_owned(), |path| path.as_str().to_owned());
    let response = next.run(request).await;
    println!("{method} {route} {}", response.status().as_u16());
    response
}

#[derive(Debug)]
pub enum ApiError {
    BadRequest,
    Unauthorized,
    NotFound,
    Conflict,
    TooLarge,
    RateLimited,
    StorageFull,
    Internal,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code) = match self {
            Self::BadRequest => (StatusCode::BAD_REQUEST, "bad_request"),
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            Self::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            Self::Conflict => (StatusCode::CONFLICT, "conflict"),
            Self::TooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "too_large"),
            Self::RateLimited => (StatusCode::TOO_MANY_REQUESTS, "rate_limited"),
            Self::StorageFull => (StatusCode::INSUFFICIENT_STORAGE, "storage_full"),
            Self::Internal => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        };
        let mut response = (status, Json(json!({ "error": code }))).into_response();
        if status == StatusCode::TOO_MANY_REQUESTS {
            response
                .headers_mut()
                .insert(RETRY_AFTER, "60".parse().expect("static header"));
        }
        response
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(_: rusqlite::Error) -> Self {
        Self::Internal
    }
}

type ApiResult<T> = Result<T, ApiError>;

pub struct ClientIp(String);

impl FromRequestParts<Arc<AppState>> for ClientIp {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<AppState>,
    ) -> Result<Self, Self::Rejection> {
        let from_header = state.client_ip_header.as_ref().and_then(|name| {
            parts
                .headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(|value| value.split(',').next().unwrap_or("").trim().to_owned())
        });
        let ip = from_header
            .filter(|value| !value.is_empty())
            .or_else(|| {
                parts
                    .extensions
                    .get::<ConnectInfo<SocketAddr>>()
                    .map(|info| info.0.ip().to_string())
            })
            .unwrap_or_else(|| "unknown".to_owned());
        Ok(Self(ip))
    }
}

fn random_base64url(len: usize) -> ApiResult<String> {
    let mut bytes = vec![0; len];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| ApiError::Internal)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn token_hash(token: &str) -> Vec<u8> {
    digest(&SHA256, token.as_bytes()).as_ref().to_vec()
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

/// Checks a device signature over this exact request and burns its nonce.
fn verify_signed(
    state: &AppState,
    headers: &HeaderMap,
    method: &str,
    uri: &OriginalUri,
    body: &[u8],
    signing_key: &[u8],
) -> ApiResult<()> {
    if uri.query().is_some() {
        return Err(ApiError::BadRequest);
    }
    let timestamp: i64 = header(headers, TIMESTAMP_HEADER)
        .and_then(|value| value.parse().ok())
        .ok_or(ApiError::Unauthorized)?;
    let now = state.now();
    if (now - timestamp).abs() > state.limits.signature_skew_secs {
        return Err(ApiError::Unauthorized);
    }
    let nonce = header(headers, NONCE_HEADER).ok_or(ApiError::Unauthorized)?;
    let signature = header(headers, SIGNATURE_HEADER).ok_or(ApiError::Unauthorized)?;
    let canonical = canonical::canonicalize(&CanonicalRequest {
        method,
        path: uri.path(),
        timestamp,
        nonce,
        content_type: header(headers, CONTENT_TYPE.as_str()).unwrap_or(""),
        body,
    })
    .ok_or(ApiError::Unauthorized)?;
    if !canonical::verify(signing_key, signature, &canonical) {
        return Err(ApiError::Unauthorized);
    }
    let expires_at = timestamp + state.limits.signature_skew_secs * 2;
    if !state.store.use_nonce(nonce, expires_at)? {
        return Err(ApiError::Unauthorized);
    }
    Ok(())
}

/// Authenticates the desktop that owns `id` and records that it was seen.
fn authenticate_desktop(
    state: &AppState,
    id: &str,
    headers: &HeaderMap,
    method: &str,
    uri: &OriginalUri,
    body: &[u8],
) -> ApiResult<()> {
    if !envelope::is_inbox_id(id) {
        return Err(ApiError::NotFound);
    }
    let inbox = state.store.inbox(id)?.ok_or(ApiError::NotFound)?;
    if header(headers, DEVICE_ID_HEADER) != Some(id) {
        return Err(ApiError::Unauthorized);
    }
    if !state.limiter.allow(
        &format!("desktop:{id}"),
        state.limits.desktop_requests_per_inbox_minute,
        60,
        state.now(),
    ) {
        return Err(ApiError::RateLimited);
    }
    verify_signed(state, headers, method, uri, body, &inbox.signing_key)?;
    state.store.touch(id, state.now())?;
    Ok(())
}

async fn health(State(state): State<Arc<AppState>>) -> ApiResult<Json<serde_json::Value>> {
    state.store.inbox("")?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CreateInbox {
    signing_public_key: String,
}

async fn create_inbox(
    State(state): State<Arc<AppState>>,
    ClientIp(ip): ClientIp,
    uri: OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let limits = &state.limits;
    if !state.limiter.allow(
        &format!("create:{ip}"),
        limits.inbox_creations_per_ip_hour,
        3600,
        state.now(),
    ) {
        return Err(ApiError::RateLimited);
    }
    let request: CreateInbox = serde_json::from_slice(&body).map_err(|_| ApiError::BadRequest)?;
    let signing_key = URL_SAFE_NO_PAD
        .decode(&request.signing_public_key)
        .ok()
        .filter(|key| key.len() == 32)
        .ok_or(ApiError::BadRequest)?;
    verify_signed(&state, &headers, "POST", &uri, &body, &signing_key)?;

    let inbox_id = random_base64url(16)?;
    let capture_token = random_base64url(32)?;
    state.store.create_inbox(
        &inbox_id,
        &signing_key,
        &token_hash(&capture_token),
        state.now(),
    )?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "inboxId": inbox_id, "captureToken": capture_token })),
    )
        .into_response())
}

async fn rotate_token(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<serde_json::Value>> {
    authenticate_desktop(&state, &id, &headers, "POST", &uri, &body)?;
    let capture_token = random_base64url(32)?;
    state.store.rotate_token(&id, &token_hash(&capture_token))?;
    Ok(Json(json!({ "captureToken": capture_token })))
}

async fn delete_inbox(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<StatusCode> {
    authenticate_desktop(&state, &id, &headers, "DELETE", &uri, &body)?;
    state.store.delete_inbox(&id)?;
    state.hub.close(&id);
    Ok(StatusCode::NO_CONTENT)
}

async fn put_item(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    ClientIp(ip): ClientIp,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<StatusCode> {
    let limits = &state.limits;
    let now = state.now();
    if body.len() > limits.envelope_bytes {
        return Err(ApiError::TooLarge);
    }
    if !state.limiter.allow(
        &format!("upload-ip:{ip}"),
        limits.uploads_per_ip_minute,
        60,
        now,
    ) {
        return Err(ApiError::RateLimited);
    }
    if !envelope::is_inbox_id(&id) {
        return Err(ApiError::NotFound);
    }
    let inbox = state.store.inbox(&id)?.ok_or(ApiError::NotFound)?;
    let token = header(&headers, AUTHORIZATION.as_str())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or(ApiError::Unauthorized)?;
    if token_hash(token) != inbox.token_hash {
        return Err(ApiError::Unauthorized);
    }
    if !state.limiter.allow(
        &format!("upload:{id}"),
        limits.uploads_per_inbox_minute,
        60,
        now,
    ) {
        return Err(ApiError::RateLimited);
    }
    let (envelope, serialized) = envelope::normalize(&body).ok_or(ApiError::BadRequest)?;
    match state
        .store
        .put_item(&id, &envelope.id, &serialized, now, limits)?
    {
        PutOutcome::Created => {
            state.hub.publish(&id, &serialized);
            Ok(StatusCode::CREATED)
        }
        PutOutcome::Duplicate => Ok(StatusCode::OK),
        PutOutcome::Conflict => Err(ApiError::Conflict),
        PutOutcome::InboxFull => Err(ApiError::RateLimited),
        PutOutcome::StorageFull => Err(ApiError::StorageFull),
    }
}

async fn list_items(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
) -> ApiResult<Response> {
    authenticate_desktop(&state, &id, &headers, "GET", &uri, b"")?;
    let items = state.store.items(&id)?;
    Ok((
        [(CONTENT_TYPE, "application/json")],
        format!(r#"{{"items":[{}]}}"#, items.join(",")),
    )
        .into_response())
}

async fn delete_item(
    State(state): State<Arc<AppState>>,
    Path((id, item_id)): Path<(String, String)>,
    uri: OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<StatusCode> {
    authenticate_desktop(&state, &id, &headers, "DELETE", &uri, &body)?;
    if !envelope::is_item_id(&item_id) {
        return Err(ApiError::BadRequest);
    }
    state.store.delete_item(&id, &item_id)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn stream(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> ApiResult<Response> {
    authenticate_desktop(&state, &id, &headers, "GET", &uri, b"")?;
    let receiver = state
        .hub
        .subscribe(&id, state.limits.streams_per_inbox)
        .ok_or(ApiError::RateLimited)?;
    Ok(upgrade.on_upgrade(move |socket| run_stream(socket, state, id, receiver)))
}

const PING_INTERVAL: Duration = Duration::from_secs(30);

fn item_message(body: &str) -> Message {
    Message::Text(format!(r#"{{"type":"item","envelope":{body}}}"#).into())
}

async fn send_pending(socket: &mut WebSocket, state: &AppState, id: &str) -> Result<(), ()> {
    let items = state.store.items(id).map_err(|_| ())?;
    for body in items {
        socket.send(item_message(&body)).await.map_err(|_| ())?;
    }
    Ok(())
}

#[derive(Deserialize)]
struct Ack {
    #[serde(rename = "type")]
    kind: String,
    id: String,
}

fn handle_ack(state: &AppState, inbox_id: &str, text: &str) {
    let Ok(ack) = serde_json::from_str::<Ack>(text) else {
        return;
    };
    if ack.kind == "ack" && envelope::is_item_id(&ack.id) {
        let _ = state.store.delete_item(inbox_id, &ack.id);
        let _ = state.store.touch(inbox_id, state.now());
    }
}

/// Subscribes before sending the backlog, so an item that arrives in between
/// may be sent twice; the desktop drops ids it already wrote.
async fn run_stream(
    mut socket: WebSocket,
    state: Arc<AppState>,
    id: String,
    mut receiver: tokio::sync::broadcast::Receiver<Arc<str>>,
) {
    if send_pending(&mut socket, &state, &id).await.is_err() {
        return;
    }
    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.tick().await;
    loop {
        tokio::select! {
            published = receiver.recv() => match published {
                Ok(body) => {
                    if socket.send(item_message(&body)).await.is_err() {
                        break;
                    }
                }
                Err(RecvError::Lagged(_)) => {
                    if send_pending(&mut socket, &state, &id).await.is_err() {
                        break;
                    }
                }
                Err(RecvError::Closed) => break,
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(text))) => handle_ack(&state, &id, text.as_str()),
                Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
            _ = ping.tick() => {
                if socket.send(Message::Ping(Bytes::new())).await.is_err() {
                    break;
                }
            }
        }
    }
    let _ = socket.send(Message::Close(None)).await;
}
