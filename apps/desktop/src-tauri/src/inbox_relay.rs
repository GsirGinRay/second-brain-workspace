//! Desktop side of the encrypted inbox relay (docs/inbox-relay.md).
//!
//! Nothing here runs until the user pairs a phone. After pairing, a
//! background task keeps a WebSocket to the relay, opens each sealed item
//! with the inbox key and queues it for the webview. The webview writes the
//! task to Markdown and then calls `inbox_relay_ack`, which records the id and
//! tells the relay to delete the item.

use crate::canonical::DeviceCanonicalRequest;
use crate::error::NativeError;
use crate::inbox_envelope::{self, InboxEnvelope, InboxSource};
use crate::key_store::{protect_key, unprotect_key};
use crate::AppState;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures_util::{SinkExt, StreamExt};
use p256::SecretKey;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue, Message};
use zeroize::Zeroizing;

pub const DEFAULT_ORIGIN: &str = "https://inbox.aizbrain.com";
/// Points a development build at a local relay, e.g. `http://127.0.0.1:8114`.
pub const ORIGIN_ENV: &str = "SECOND_BRAIN_INBOX_RELAY_ORIGIN";
pub const ITEMS_EVENT: &str = "inbox-relay-items";
pub const STATUS_EVENT: &str = "inbox-relay-status";

const PAIRING_FILE: &str = "inbox-relay-v1.json";
const WRITTEN_FILE: &str = "inbox-relay-written.json";
const WRITTEN_RETENTION_SECS: i64 = 30 * 24 * 60 * 60;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_BACKOFF_SECS: u64 = 60;

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs() as i64)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// HTTPS only, except plain HTTP to this machine for development.
pub fn validate_origin(value: &str) -> Result<String, NativeError> {
    let url = url::Url::parse(value.trim()).map_err(|_| NativeError::InvalidRequest)?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && loopback);
    if !scheme_ok
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.path(), "" | "/")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(NativeError::InvalidRequest);
    }
    Ok(url.origin().ascii_serialization())
}

pub fn relay_origin() -> Result<String, NativeError> {
    match std::env::var(ORIGIN_ENV) {
        Ok(value) if !value.trim().is_empty() => validate_origin(&value),
        _ => Ok(DEFAULT_ORIGIN.to_owned()),
    }
}

// ---------------------------------------------------------------------------
// Pairing file

type Protect = fn(&[u8]) -> Result<Vec<u8>, NativeError>;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedPairing {
    version: u8,
    origin: String,
    inbox_id: String,
    public_key_base64_url: String,
    protected_secret_base64_url: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PairingSecret {
    private_scalar_base64_url: String,
    capture_token: String,
}

pub struct Pairing {
    pub origin: String,
    pub inbox_id: String,
    pub public_key: String,
    capture_token: Zeroizing<String>,
    secret: SecretKey,
}

impl Pairing {
    /// The QR code target. Everything after `#` stays on the phone.
    pub fn pairing_url(&self) -> String {
        format!(
            "{}/#v=1&i={}&t={}&k={}",
            self.origin,
            self.inbox_id,
            self.capture_token.as_str(),
            self.public_key
        )
    }

    fn with_token(&self, capture_token: String) -> Self {
        Self {
            origin: self.origin.clone(),
            inbox_id: self.inbox_id.clone(),
            public_key: self.public_key.clone(),
            capture_token: Zeroizing::new(capture_token),
            secret: self.secret.clone(),
        }
    }

    fn save(&self, path: &Path, protect: Protect) -> Result<(), NativeError> {
        let scalar = Zeroizing::new(self.secret.to_bytes().to_vec());
        let secret = Zeroizing::new(
            serde_json::to_vec(&PairingSecret {
                private_scalar_base64_url: URL_SAFE_NO_PAD.encode(scalar.as_slice()),
                capture_token: self.capture_token.to_string(),
            })
            .map_err(|_| NativeError::KeyStorageUnavailable)?,
        );
        let persisted = PersistedPairing {
            version: 1,
            origin: self.origin.clone(),
            inbox_id: self.inbox_id.clone(),
            public_key_base64_url: self.public_key.clone(),
            protected_secret_base64_url: URL_SAFE_NO_PAD.encode(protect(&secret)?),
        };
        let bytes = serde_json::to_vec_pretty(&persisted)
            .map_err(|_| NativeError::KeyStorageUnavailable)?;
        write_replacing(path, &bytes)
    }

    fn load(path: &Path, unprotect: Protect) -> Result<Option<Self>, NativeError> {
        if !path.exists() {
            return Ok(None);
        }
        if fs::metadata(path)?.len() > 16 * 1024 {
            return Err(NativeError::KeyStorageUnavailable);
        }
        let persisted: PersistedPairing = serde_json::from_slice(&fs::read(path)?)
            .map_err(|_| NativeError::KeyStorageUnavailable)?;
        let protected = URL_SAFE_NO_PAD
            .decode(&persisted.protected_secret_base64_url)
            .map_err(|_| NativeError::KeyStorageUnavailable)?;
        let plain = Zeroizing::new(unprotect(&protected)?);
        let secret: PairingSecret =
            serde_json::from_slice(&plain).map_err(|_| NativeError::KeyStorageUnavailable)?;
        let scalar = Zeroizing::new(
            URL_SAFE_NO_PAD
                .decode(&secret.private_scalar_base64_url)
                .map_err(|_| NativeError::KeyStorageUnavailable)?,
        );
        let key = SecretKey::from_slice(&scalar).map_err(|_| NativeError::KeyStorageUnavailable)?;
        let public_key = URL_SAFE_NO_PAD.encode(inbox_envelope::public_key_bytes(&key));
        if persisted.version != 1
            || public_key != persisted.public_key_base64_url
            || !inbox_envelope::is_inbox_id(&persisted.inbox_id)
        {
            return Err(NativeError::KeyStorageUnavailable);
        }
        Ok(Some(Self {
            origin: validate_origin(&persisted.origin)?,
            inbox_id: persisted.inbox_id,
            public_key,
            capture_token: Zeroizing::new(secret.capture_token),
            secret: key,
        }))
    }
}

fn write_replacing(path: &Path, bytes: &[u8]) -> Result<(), NativeError> {
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, bytes)?;
    fs::rename(&temporary, path)?;
    Ok(())
}

fn generate_secret() -> Result<SecretKey, NativeError> {
    let rng = SystemRandom::new();
    for _ in 0..8 {
        let mut bytes = Zeroizing::new([0u8; 32]);
        rng.fill(bytes.as_mut())
            .map_err(|_| NativeError::KeyStorageUnavailable)?;
        if let Ok(key) = SecretKey::from_slice(bytes.as_ref()) {
            return Ok(key);
        }
    }
    Err(NativeError::KeyStorageUnavailable)
}

// ---------------------------------------------------------------------------
// Ids already written to Markdown

/// Ids written during the last 30 days. A lost ack makes the relay send an
/// item again; this keeps it from becoming a second task.
pub struct WrittenLog {
    path: Option<PathBuf>,
    entries: HashMap<String, i64>,
}

impl WrittenLog {
    pub fn load(path: PathBuf) -> Self {
        let entries = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            path: Some(path),
            entries,
        }
    }

    #[cfg(test)]
    fn in_memory() -> Self {
        Self {
            path: None,
            entries: HashMap::new(),
        }
    }

    pub fn contains(&self, id: &str) -> bool {
        self.entries.contains_key(id)
    }

    pub fn record(&mut self, ids: &[String], now: i64) -> Result<(), NativeError> {
        self.entries
            .retain(|_, written_at| *written_at > now - WRITTEN_RETENTION_SECS);
        for id in ids {
            self.entries.insert(id.clone(), now);
        }
        self.persist()
    }

    pub fn clear(&mut self) -> Result<(), NativeError> {
        self.entries.clear();
        if let Some(path) = &self.path {
            if path.exists() {
                fs::remove_file(path)?;
            }
        }
        Ok(())
    }

    fn persist(&self) -> Result<(), NativeError> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let bytes = serde_json::to_vec(&self.entries).map_err(|_| NativeError::Io)?;
        write_replacing(path, &bytes)
    }
}

// ---------------------------------------------------------------------------
// Session state shared with the commands

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeliveredItem {
    pub id: String,
    pub text: String,
    pub created_at: String,
    pub source: InboxSource,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Connection {
    Connecting,
    Connected,
    Offline,
}

pub struct Session {
    pending: Mutex<Vec<DeliveredItem>>,
    connection: Mutex<Connection>,
    discarded: Mutex<u32>,
    outgoing: Mutex<Option<mpsc::UnboundedSender<String>>>,
    written: Arc<Mutex<WrittenLog>>,
    notify: Box<dyn Fn(&'static str) + Send + Sync>,
}

fn ack_message(id: &str) -> String {
    serde_json::json!({ "type": "ack", "id": id }).to_string()
}

impl Session {
    pub fn new(
        written: Arc<Mutex<WrittenLog>>,
        notify: Box<dyn Fn(&'static str) + Send + Sync>,
    ) -> Self {
        Self {
            pending: Mutex::new(Vec::new()),
            connection: Mutex::new(Connection::Connecting),
            discarded: Mutex::new(0),
            outgoing: Mutex::new(None),
            written,
            notify,
        }
    }

    fn set_connection(&self, connection: Connection) {
        let changed = {
            let mut current = lock(&self.connection);
            let changed = *current != connection;
            *current = connection;
            changed
        };
        if changed {
            (self.notify)(STATUS_EVENT);
        }
    }

    pub fn connection(&self) -> Connection {
        *lock(&self.connection)
    }

    pub fn discarded(&self) -> u32 {
        *lock(&self.discarded)
    }

    fn send_ack(&self, id: &str) {
        if let Some(sender) = lock(&self.outgoing).as_ref() {
            let _ = sender.send(ack_message(id));
        }
    }

    /// Opens one sealed item. Items already written are acked again, and items
    /// this desktop cannot open are acked so they do not block the inbox.
    pub fn receive(&self, envelope: &InboxEnvelope, inbox_id: &str, secret: &SecretKey) {
        if lock(&self.written).contains(&envelope.id) {
            self.send_ack(&envelope.id);
            return;
        }
        if lock(&self.pending)
            .iter()
            .any(|item| item.id == envelope.id)
        {
            return;
        }
        match inbox_envelope::open_inbox_item(envelope, inbox_id, secret) {
            Ok(payload) => {
                lock(&self.pending).push(DeliveredItem {
                    id: envelope.id.clone(),
                    text: payload.text,
                    created_at: payload.created_at,
                    source: payload.source,
                });
                (self.notify)(ITEMS_EVENT);
            }
            Err(_) => {
                *lock(&self.discarded) += 1;
                self.send_ack(&envelope.id);
                (self.notify)(STATUS_EVENT);
            }
        }
    }

    pub fn pending(&self) -> Vec<DeliveredItem> {
        lock(&self.pending).clone()
    }

    /// Called after the items are in Markdown.
    pub fn ack(&self, ids: &[String]) -> Result<(), NativeError> {
        lock(&self.written).record(ids, now_secs())?;
        lock(&self.pending).retain(|item| !ids.contains(&item.id));
        for id in ids {
            self.send_ack(id);
        }
        Ok(())
    }
}

#[derive(Deserialize)]
struct StreamMessage {
    #[serde(rename = "type")]
    kind: String,
    envelope: Option<InboxEnvelope>,
}

fn parse_stream_message(text: &str) -> Option<InboxEnvelope> {
    let message: StreamMessage = serde_json::from_str(text).ok()?;
    (message.kind == "item")
        .then_some(message.envelope)
        .flatten()
}

// ---------------------------------------------------------------------------
// Signed HTTP and WebSocket requests

pub type Signer = Arc<dyn Fn(&DeviceCanonicalRequest) -> Result<String, NativeError> + Send + Sync>;

fn signed_headers(
    signer: &Signer,
    method: &str,
    path: &str,
    body: &[u8],
    device_id: Option<&str>,
) -> Result<Vec<(&'static str, String)>, NativeError> {
    let mut nonce = [0u8; 16];
    SystemRandom::new()
        .fill(&mut nonce)
        .map_err(|_| NativeError::KeyStorageUnavailable)?;
    let content_type = if body.is_empty() {
        ""
    } else {
        "application/json"
    };
    let request = DeviceCanonicalRequest {
        method: method.to_owned(),
        path: path.to_owned(),
        query: vec![],
        timestamp: now_secs(),
        nonce: URL_SAFE_NO_PAD.encode(nonce),
        content_type: content_type.to_owned(),
        body_sha256: hex::encode(Sha256::digest(body)),
    };
    let signature = signer(&request)?;
    let mut headers = vec![
        ("x-brain-timestamp", request.timestamp.to_string()),
        ("x-brain-nonce", request.nonce),
        ("x-brain-signature", signature),
    ];
    if !content_type.is_empty() {
        headers.push(("content-type", content_type.to_owned()));
    }
    if let Some(device_id) = device_id {
        headers.push(("x-brain-device-id", device_id.to_owned()));
    }
    Ok(headers)
}

pub struct RelayClient {
    http: reqwest::Client,
    signer: Signer,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreatedInbox {
    inbox_id: String,
    capture_token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RotatedToken {
    capture_token: String,
}

async fn read_json<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
) -> Result<T, NativeError> {
    let bytes = response
        .bytes()
        .await
        .map_err(|_| NativeError::InboxRelayUnavailable)?;
    serde_json::from_slice(&bytes).map_err(|_| NativeError::InboxRelayUnavailable)
}

impl RelayClient {
    pub fn new(signer: Signer) -> Result<Self, NativeError> {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| NativeError::InboxRelayUnavailable)?;
        Ok(Self { http, signer })
    }

    async fn send(
        &self,
        method: reqwest::Method,
        origin: &str,
        path: &str,
        body: Vec<u8>,
        device_id: Option<&str>,
    ) -> Result<reqwest::Response, NativeError> {
        let headers = signed_headers(&self.signer, method.as_str(), path, &body, device_id)?;
        let mut request = self.http.request(method, format!("{origin}{path}"));
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let response = request
            .body(body)
            .send()
            .await
            .map_err(|_| NativeError::InboxRelayUnavailable)?;
        if response.status().is_success() {
            Ok(response)
        } else {
            Err(NativeError::InboxRelayUnavailable)
        }
    }

    /// Creates the inbox and returns a pairing that is not saved yet.
    pub async fn create_inbox(
        &self,
        origin: &str,
        signing_public_key: &str,
    ) -> Result<Pairing, NativeError> {
        let body =
            serde_json::to_vec(&serde_json::json!({ "signingPublicKey": signing_public_key }))
                .map_err(|_| NativeError::InvalidRequest)?;
        let created: CreatedInbox = read_json(
            self.send(reqwest::Method::POST, origin, "/v1/inboxes", body, None)
                .await?,
        )
        .await?;
        if !inbox_envelope::is_inbox_id(&created.inbox_id) {
            return Err(NativeError::InboxRelayUnavailable);
        }
        let secret = generate_secret()?;
        Ok(Pairing {
            origin: origin.to_owned(),
            inbox_id: created.inbox_id,
            public_key: URL_SAFE_NO_PAD.encode(inbox_envelope::public_key_bytes(&secret)),
            capture_token: Zeroizing::new(created.capture_token),
            secret,
        })
    }

    pub async fn rotate_token(&self, pairing: &Pairing) -> Result<Pairing, NativeError> {
        let path = format!("/v1/inboxes/{}/token", pairing.inbox_id);
        let rotated: RotatedToken = read_json(
            self.send(
                reqwest::Method::POST,
                &pairing.origin,
                &path,
                Vec::new(),
                Some(&pairing.inbox_id),
            )
            .await?,
        )
        .await?;
        Ok(pairing.with_token(rotated.capture_token))
    }

    pub async fn delete_inbox(&self, pairing: &Pairing) -> Result<(), NativeError> {
        let path = format!("/v1/inboxes/{}", pairing.inbox_id);
        self.send(
            reqwest::Method::DELETE,
            &pairing.origin,
            &path,
            Vec::new(),
            Some(&pairing.inbox_id),
        )
        .await
        .map(|_| ())
    }

    /// One WebSocket connection; returns when it closes or `stop` fires.
    /// The relay sends every pending item first, then each new one.
    async fn stream_once(
        &self,
        pairing: &Pairing,
        session: &Session,
        stop: &mut watch::Receiver<bool>,
    ) -> Result<(), NativeError> {
        let path = format!("/v1/inboxes/{}/stream", pairing.inbox_id);
        let url = format!("{}{}", pairing.origin.replacen("http", "ws", 1), path);
        let mut request = url
            .into_client_request()
            .map_err(|_| NativeError::InvalidRequest)?;
        for (name, value) in
            signed_headers(&self.signer, "GET", &path, b"", Some(&pairing.inbox_id))?
        {
            request.headers_mut().insert(
                name,
                HeaderValue::from_str(&value).map_err(|_| NativeError::InvalidRequest)?,
            );
        }
        let (socket, _) = tokio_tungstenite::connect_async(request)
            .await
            .map_err(|_| NativeError::InboxRelayUnavailable)?;
        let (mut write, mut read) = socket.split();
        let (sender, mut acks) = mpsc::unbounded_channel();
        *lock(&session.outgoing) = Some(sender);
        session.set_connection(Connection::Connected);

        let result = loop {
            tokio::select! {
                incoming = read.next() => match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if let Some(envelope) = parse_stream_message(text.as_str()) {
                            session.receive(&envelope, &pairing.inbox_id, &pairing.secret);
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if write.send(Message::Pong(payload)).await.is_err() {
                            break Err(NativeError::InboxRelayUnavailable);
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break Ok(()),
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break Err(NativeError::InboxRelayUnavailable),
                },
                Some(ack) = acks.recv() => {
                    if write.send(Message::Text(ack.into())).await.is_err() {
                        break Err(NativeError::InboxRelayUnavailable);
                    }
                }
                _ = stop.changed() => {
                    let _ = write.send(Message::Close(None)).await;
                    break Ok(());
                }
            }
        };
        *lock(&session.outgoing) = None;
        result
    }

    /// Keeps a stream open until `stop` fires, backing off up to a minute.
    pub async fn run(
        &self,
        pairing: Arc<Pairing>,
        session: Arc<Session>,
        mut stop: watch::Receiver<bool>,
    ) {
        let mut backoff = 1;
        while !*stop.borrow() {
            session.set_connection(Connection::Connecting);
            let started = tokio::time::Instant::now();
            let result = self.stream_once(&pairing, &session, &mut stop).await;
            if *stop.borrow() {
                break;
            }
            session.set_connection(Connection::Offline);
            if result.is_ok() || started.elapsed() > Duration::from_secs(MAX_BACKOFF_SECS) {
                backoff = 1;
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(backoff)) => {}
                _ = stop.changed() => break,
            }
            backoff = (backoff * 2).min(MAX_BACKOFF_SECS);
        }
    }
}

// ---------------------------------------------------------------------------
// Manager kept in AppState

struct Active {
    pairing: Arc<Pairing>,
    session: Arc<Session>,
    stop: watch::Sender<bool>,
}

pub struct InboxRelayManager {
    data_dir: PathBuf,
    active: Mutex<Option<Active>>,
    written: Arc<Mutex<WrittenLog>>,
    /// A pairing file exists but this Windows account cannot open it.
    unreadable: Mutex<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxRelayStatus {
    pub paired: bool,
    pub needs_repair: bool,
    pub connection: Option<Connection>,
    pub origin: String,
    pub pending: usize,
    pub discarded: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxRelayPairing {
    pub url: String,
    pub qr_svg: String,
}

fn pairing_dto(pairing: &Pairing) -> Result<InboxRelayPairing, NativeError> {
    let url = pairing.pairing_url();
    let qr_svg = qrcode::QrCode::new(url.as_bytes())
        .map_err(|_| NativeError::InvalidRequest)?
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(240, 240)
        .build();
    Ok(InboxRelayPairing { url, qr_svg })
}

impl InboxRelayManager {
    pub fn new(data_dir: PathBuf) -> Self {
        let written = WrittenLog::load(data_dir.join(WRITTEN_FILE));
        Self {
            data_dir,
            active: Mutex::new(None),
            written: Arc::new(Mutex::new(written)),
            unreadable: Mutex::new(false),
        }
    }

    fn pairing_path(&self) -> PathBuf {
        self.data_dir.join(PAIRING_FILE)
    }

    fn start<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        pairing: Arc<Pairing>,
    ) -> Result<(), NativeError> {
        let notifier = app.clone();
        let session = Arc::new(Session::new(
            Arc::clone(&self.written),
            Box::new(move |event| {
                let _ = notifier.emit(event, ());
            }),
        ));
        let (stop, stopped) = watch::channel(false);
        let client = RelayClient::new(device_signer(app))?;
        let running = (Arc::clone(&pairing), Arc::clone(&session));
        tauri::async_runtime::spawn(async move {
            client.run(running.0, running.1, stopped).await;
        });
        *lock(&self.active) = Some(Active {
            pairing,
            session,
            stop,
        });
        let _ = app.emit(STATUS_EVENT, ());
        Ok(())
    }

    fn stop(&self) -> Option<Arc<Pairing>> {
        let active = lock(&self.active).take()?;
        let _ = active.stop.send(true);
        Some(active.pairing)
    }

    fn session(&self) -> Option<Arc<Session>> {
        lock(&self.active)
            .as_ref()
            .map(|active| Arc::clone(&active.session))
    }

    fn pairing(&self) -> Option<Arc<Pairing>> {
        lock(&self.active)
            .as_ref()
            .map(|active| Arc::clone(&active.pairing))
    }
}

fn device_signer<R: Runtime>(app: &AppHandle<R>) -> Signer {
    let app = app.clone();
    Arc::new(move |request| {
        let state = app.state::<AppState>();
        let store = state
            .key_store
            .lock()
            .map_err(|_| NativeError::KeyStorageUnavailable)?;
        store.sign(request)
    })
}

/// Resumes a saved pairing at startup. Unpaired installs never connect.
pub fn resume<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    let manager = &state.inbox_relay;
    match Pairing::load(&manager.pairing_path(), unprotect_key) {
        Ok(Some(pairing)) => {
            let _ = manager.start(app, Arc::new(pairing));
        }
        Ok(None) => {}
        Err(_) => *lock(&manager.unreadable) = true,
    }
}

#[tauri::command]
pub fn inbox_relay_status(state: State<'_, AppState>) -> Result<InboxRelayStatus, NativeError> {
    let manager = &state.inbox_relay;
    let session = manager.session();
    Ok(InboxRelayStatus {
        paired: session.is_some(),
        needs_repair: *lock(&manager.unreadable),
        connection: session.as_ref().map(|session| session.connection()),
        origin: manager.pairing().map_or_else(
            || relay_origin().unwrap_or_default(),
            |pairing| pairing.origin.clone(),
        ),
        pending: session
            .as_ref()
            .map_or(0, |session| session.pending().len()),
        discarded: session.as_ref().map_or(0, |session| session.discarded()),
    })
}

#[tauri::command]
pub async fn inbox_relay_pair(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<InboxRelayPairing, NativeError> {
    let manager = &state.inbox_relay;
    if manager.pairing().is_some() {
        return Err(NativeError::InvalidRequest);
    }
    let signing_public_key = state
        .key_store
        .lock()
        .map_err(|_| NativeError::KeyStorageUnavailable)?
        .public_identity()
        .public_key_base64_url;
    let client = RelayClient::new(device_signer(&app))?;
    let pairing = client
        .create_inbox(&relay_origin()?, &signing_public_key)
        .await?;
    pairing.save(&manager.pairing_path(), protect_key)?;
    lock(&manager.written).clear()?;
    *lock(&manager.unreadable) = false;
    let dto = pairing_dto(&pairing)?;
    manager.start(&app, Arc::new(pairing))?;
    Ok(dto)
}

#[tauri::command]
pub fn inbox_relay_pairing(state: State<'_, AppState>) -> Result<InboxRelayPairing, NativeError> {
    let pairing = state
        .inbox_relay
        .pairing()
        .ok_or(NativeError::InvalidRequest)?;
    pairing_dto(&pairing)
}

/// A new capture token; phones paired with the old one get `401`.
#[tauri::command]
pub async fn inbox_relay_rotate(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<InboxRelayPairing, NativeError> {
    let manager = &state.inbox_relay;
    let current = manager.pairing().ok_or(NativeError::InvalidRequest)?;
    let rotated = RelayClient::new(device_signer(&app))?
        .rotate_token(&current)
        .await?;
    rotated.save(&manager.pairing_path(), protect_key)?;
    let dto = pairing_dto(&rotated)?;
    if let Some(active) = lock(&manager.active).as_mut() {
        active.pairing = Arc::new(rotated);
    }
    Ok(dto)
}

/// Stops the stream and forgets the pairing. Deleting the inbox on the relay
/// is best effort: an unreachable relay still expires it after 180 days.
#[tauri::command]
pub async fn inbox_relay_unpair(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), NativeError> {
    let manager = &state.inbox_relay;
    let path = manager.pairing_path();
    if let Some(pairing) = manager.stop() {
        if let Ok(client) = RelayClient::new(device_signer(&app)) {
            let _ = client.delete_inbox(&pairing).await;
        }
    }
    if path.exists() {
        fs::remove_file(&path)?;
    }
    lock(&manager.written).clear()?;
    *lock(&manager.unreadable) = false;
    let _ = app.emit(STATUS_EVENT, ());
    Ok(())
}

#[tauri::command]
pub fn inbox_relay_pending(state: State<'_, AppState>) -> Vec<DeliveredItem> {
    state
        .inbox_relay
        .session()
        .map(|session| session.pending())
        .unwrap_or_default()
}

#[tauri::command]
pub fn inbox_relay_ack(ids: Vec<String>, state: State<'_, AppState>) -> Result<(), NativeError> {
    if ids.len() > 500 || !ids.iter().all(|id| inbox_envelope::is_inbox_item_id(id)) {
        return Err(NativeError::InvalidRequest);
    }
    match state.inbox_relay.session() {
        Some(session) => session.ack(&ids),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canonical::verify_signature;
    use ring::signature::{Ed25519KeyPair, KeyPair};
    use std::sync::atomic::{AtomicUsize, Ordering};

    const FIXTURE: &str = include_str!("../../../../docs/fixtures/inbox-envelope-v1.json");

    fn fixture() -> serde_json::Value {
        serde_json::from_str(FIXTURE).unwrap()
    }

    fn fixture_secret(name: &str) -> SecretKey {
        let scalar = URL_SAFE_NO_PAD
            .decode(fixture()[name]["privateScalarBase64Url"].as_str().unwrap())
            .unwrap();
        SecretKey::from_slice(&scalar).unwrap()
    }

    fn fixture_envelope(id: Option<&str>) -> InboxEnvelope {
        let fixture = fixture();
        let envelope: InboxEnvelope = serde_json::from_value(fixture["envelope"].clone()).unwrap();
        let Some(id) = id else {
            return envelope;
        };
        inbox_envelope::seal_with(
            fixture["plaintextUtf8"].as_str().unwrap().as_bytes(),
            fixture["inboxId"].as_str().unwrap(),
            id,
            &inbox_envelope::public_key_bytes(&fixture_secret("recipient")),
            &fixture_secret("ephemeral"),
            [3; 12],
        )
    }

    fn test_pairing() -> Pairing {
        let secret = fixture_secret("recipient");
        Pairing {
            origin: "https://inbox.example.test".to_owned(),
            inbox_id: fixture()["inboxId"].as_str().unwrap().to_owned(),
            public_key: URL_SAFE_NO_PAD.encode(inbox_envelope::public_key_bytes(&secret)),
            capture_token: Zeroizing::new("token-abc".to_owned()),
            secret,
        }
    }

    fn plain(value: &[u8]) -> Result<Vec<u8>, NativeError> {
        Ok(value.to_vec())
    }

    fn session() -> (Session, Arc<AtomicUsize>, mpsc::UnboundedReceiver<String>) {
        let events = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&events);
        let session = Session::new(
            Arc::new(Mutex::new(WrittenLog::in_memory())),
            Box::new(move |event| {
                if event == ITEMS_EVENT {
                    counter.fetch_add(1, Ordering::SeqCst);
                }
            }),
        );
        let (sender, receiver) = mpsc::unbounded_channel();
        *lock(&session.outgoing) = Some(sender);
        (session, events, receiver)
    }

    #[test]
    fn origins_must_be_https_or_loopback_http() {
        assert_eq!(
            validate_origin("https://inbox.aizbrain.com/").unwrap(),
            "https://inbox.aizbrain.com"
        );
        assert_eq!(
            validate_origin("http://127.0.0.1:8114").unwrap(),
            "http://127.0.0.1:8114"
        );
        for rejected in [
            "http://inbox.aizbrain.com",
            "https://inbox.aizbrain.com/path",
            "https://inbox.aizbrain.com/?q=1",
            "https://user@inbox.aizbrain.com",
            "ftp://127.0.0.1",
            "not a url",
        ] {
            assert!(validate_origin(rejected).is_err(), "{rejected}");
        }
        assert_eq!(DEFAULT_ORIGIN, validate_origin(DEFAULT_ORIGIN).unwrap());
    }

    #[test]
    fn pairing_url_keeps_secrets_in_the_fragment() {
        let pairing = test_pairing();
        let url = pairing.pairing_url();
        let (before, fragment) = url.split_once('#').unwrap();
        assert_eq!(before, "https://inbox.example.test/");
        assert_eq!(
            fragment,
            format!(
                "v=1&i={}&t=token-abc&k={}",
                pairing.inbox_id, pairing.public_key
            )
        );
        assert!(pairing_dto(&pairing).unwrap().qr_svg.starts_with("<?xml"));
    }

    #[test]
    fn pairing_round_trips_and_rejects_tampering() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(PAIRING_FILE);
        assert!(Pairing::load(&path, plain).unwrap().is_none());

        let pairing = test_pairing();
        pairing.save(&path, plain).unwrap();
        let loaded = Pairing::load(&path, plain).unwrap().unwrap();
        assert_eq!(loaded.pairing_url(), pairing.pairing_url());
        assert_eq!(loaded.secret.to_bytes(), pairing.secret.to_bytes());
        let stored = fs::read_to_string(&path).unwrap();
        assert!(!stored.contains("token-abc"));

        let rotated = loaded.with_token("token-new".to_owned());
        rotated.save(&path, plain).unwrap();
        assert!(Pairing::load(&path, plain)
            .unwrap()
            .unwrap()
            .pairing_url()
            .contains("t=token-new"));

        let mut persisted: serde_json::Value = serde_json::from_str(&stored).unwrap();
        persisted["publicKeyBase64Url"] = "BAAA".into();
        fs::write(&path, serde_json::to_vec(&persisted).unwrap()).unwrap();
        assert!(Pairing::load(&path, plain).is_err());
    }

    #[test]
    fn written_log_persists_and_forgets_after_thirty_days() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(WRITTEN_FILE);
        let mut log = WrittenLog::load(path.clone());
        log.record(&["a".to_owned()], 1_000).unwrap();
        assert!(WrittenLog::load(path.clone()).contains("a"));

        log.record(&["b".to_owned()], 1_000 + WRITTEN_RETENTION_SECS + 1)
            .unwrap();
        let reloaded = WrittenLog::load(path.clone());
        assert!(!reloaded.contains("a"));
        assert!(reloaded.contains("b"));

        log.clear().unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn session_opens_items_once_and_acks_after_writing() {
        let (session, events, mut acks) = session();
        let pairing = test_pairing();
        let envelope = fixture_envelope(None);

        session.receive(&envelope, &pairing.inbox_id, &pairing.secret);
        session.receive(&envelope, &pairing.inbox_id, &pairing.secret);
        let pending = session.pending();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].text, fixture()["payload"]["text"]);
        assert_eq!(pending[0].source, InboxSource::Pwa);
        assert_eq!(events.load(Ordering::SeqCst), 1);
        assert!(acks.try_recv().is_err());

        session.ack(std::slice::from_ref(&envelope.id)).unwrap();
        assert!(session.pending().is_empty());
        assert_eq!(acks.try_recv().unwrap(), ack_message(&envelope.id));

        // The relay sends it again because the ack was lost: no second task.
        session.receive(&envelope, &pairing.inbox_id, &pairing.secret);
        assert!(session.pending().is_empty());
        assert_eq!(acks.try_recv().unwrap(), ack_message(&envelope.id));
        assert_eq!(events.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn session_discards_items_it_cannot_open() {
        let (session, events, mut acks) = session();
        let pairing = test_pairing();
        let envelope = fixture_envelope(Some("22222222-2222-4222-8222-222222222222"));
        session.receive(&envelope, &pairing.inbox_id, &fixture_secret("ephemeral"));
        assert!(session.pending().is_empty());
        assert_eq!(session.discarded(), 1);
        assert_eq!(acks.try_recv().unwrap(), ack_message(&envelope.id));
        assert_eq!(events.load(Ordering::SeqCst), 0);

        session.receive(&envelope, &pairing.inbox_id, &pairing.secret);
        assert_eq!(session.pending().len(), 1);
    }

    #[test]
    fn stream_messages_are_parsed_strictly() {
        let envelope = fixture_envelope(None);
        let message = serde_json::json!({ "type": "item", "envelope": envelope }).to_string();
        assert_eq!(parse_stream_message(&message), Some(envelope));
        assert_eq!(parse_stream_message(r#"{"type":"other"}"#), None);
        assert_eq!(parse_stream_message("not json"), None);
    }

    #[test]
    fn signed_headers_verify_with_the_device_key() {
        let key = Arc::new(Ed25519KeyPair::from_seed_unchecked(&[5; 32]).unwrap());
        let signing = Arc::clone(&key);
        let captured = Arc::new(Mutex::new(None));
        let capture = Arc::clone(&captured);
        let signer: Signer = Arc::new(move |request: &DeviceCanonicalRequest| {
            *lock(&capture) = Some(request.clone());
            let canonical = crate::canonical::canonicalize_request(request)?;
            Ok(URL_SAFE_NO_PAD.encode(signing.sign(canonical.as_bytes())))
        });
        let headers = signed_headers(&signer, "DELETE", "/v1/inboxes/x", b"", Some("x")).unwrap();
        let header = |name: &str| {
            headers
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.clone())
        };
        let request = lock(&captured).clone().unwrap();
        assert_eq!(request.content_type, "");
        assert_eq!(header("x-brain-device-id").as_deref(), Some("x"));
        assert_eq!(header("content-type"), None);
        assert_eq!(header("x-brain-nonce").unwrap(), request.nonce);
        verify_signature(
            key.public_key().as_ref(),
            &header("x-brain-signature").unwrap(),
            &request,
        )
        .unwrap();
    }

    /// Runs against a real relay: `npm run relay:dev`, then
    /// `INBOX_RELAY_TEST_ORIGIN=http://127.0.0.1:8114 cargo test -- --ignored inbox_relay`.
    #[tokio::test]
    #[ignore]
    async fn end_to_end_against_a_running_relay() {
        let origin = validate_origin(&std::env::var("INBOX_RELAY_TEST_ORIGIN").unwrap()).unwrap();
        let key = Arc::new(Ed25519KeyPair::from_seed_unchecked(&[6; 32]).unwrap());
        let signing = Arc::clone(&key);
        let signer: Signer = Arc::new(move |request: &DeviceCanonicalRequest| {
            let canonical = crate::canonical::canonicalize_request(request)?;
            Ok(URL_SAFE_NO_PAD.encode(signing.sign(canonical.as_bytes())))
        });
        let client = Arc::new(RelayClient::new(signer).unwrap());
        let pairing = client
            .create_inbox(&origin, &URL_SAFE_NO_PAD.encode(key.public_key().as_ref()))
            .await
            .unwrap();

        // The phone seals an item to the new inbox key and uploads it.
        let item_id = "33333333-3333-4333-8333-333333333333";
        let plaintext = r#"{"v":1,"text":"E2E 測試 明天繳費","createdAt":"2026-10-23T09:30:00.000Z","source":"pwa"}"#;
        let envelope = inbox_envelope::seal_with(
            plaintext.as_bytes(),
            &pairing.inbox_id,
            item_id,
            &inbox_envelope::public_key_bytes(&pairing.secret),
            &fixture_secret("ephemeral"),
            [4; 12],
        );
        let upload = reqwest::Client::new()
            .post(format!("{origin}/v1/inboxes/{}/items", pairing.inbox_id))
            .header(
                "authorization",
                format!("Bearer {}", pairing.capture_token.as_str()),
            )
            .header("content-type", "application/json")
            .body(serde_json::to_vec(&envelope).unwrap())
            .send()
            .await
            .unwrap();
        assert_eq!(upload.status(), 201);

        let pairing = Arc::new(pairing);
        let session = Arc::new(Session::new(
            Arc::new(Mutex::new(WrittenLog::in_memory())),
            Box::new(|_| {}),
        ));
        let (stop, stopped) = watch::channel(false);
        let running = tokio::spawn({
            let (client, pairing, session) = (
                Arc::clone(&client),
                Arc::clone(&pairing),
                Arc::clone(&session),
            );
            async move { client.run(pairing, session, stopped).await }
        });
        let mut delivered = Vec::new();
        for _ in 0..100 {
            delivered = session.pending();
            if !delivered.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(delivered.len(), 1);
        assert_eq!(delivered[0].text, "E2E 測試 明天繳費");
        assert_eq!(session.connection(), Connection::Connected);

        session.ack(&[item_id.to_owned()]).unwrap();
        let path = format!("/v1/inboxes/{}/items", pairing.inbox_id);
        let mut remaining = String::new();
        for _ in 0..100 {
            let response = client
                .send(
                    reqwest::Method::GET,
                    &origin,
                    &path,
                    Vec::new(),
                    Some(&pairing.inbox_id),
                )
                .await
                .unwrap();
            remaining = response.text().await.unwrap();
            if remaining == r#"{"items":[]}"# {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(remaining, r#"{"items":[]}"#);

        let _ = stop.send(true);
        running.await.unwrap();
        client.delete_inbox(&pairing).await.unwrap();
    }
}
