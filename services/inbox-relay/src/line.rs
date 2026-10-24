//! LINE to inbox (docs/inbox-relay.md, "LINE"). A paid member links their LINE
//! account to an inbox with a one-time code from the desktop; afterwards text
//! sent to the official account is sealed with the inbox public key on
//! arrival and stored like a phone item. The relay keeps neither the text nor
//! the LINE user id, only an HMAC of the id.

use super::*;
use crate::envelope::Envelope;
use crate::membership::{BoxFuture, Unavailable};
use base64::engine::general_purpose::STANDARD;
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};
use ring::agreement::{ECDH_P256, EphemeralPrivateKey, UnparsedPublicKey, agree_ephemeral};
use ring::hkdf::{HKDF_SHA256, Salt};
use ring::hmac;
use serde::Serialize;

const INBOX_HKDF_INFO: &[u8] = b"second-brain-inbox-v1";
const P256_PUBLIC_KEY_BYTES: usize = 65;
const TEXT_BYTES_LIMIT: usize = 2400;
const CODE_ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH: usize = 8;
const CODE_TTL_SECS: i64 = 15 * 60;
const CODE_TRIES_PER_USER_HOUR: u32 = 10;
const PREVIEW_CHARS: usize = 40;
pub const WEBHOOK_BYTES: usize = 256 * 1024;
const UNLINK_WORDS: [&str; 2] = ["解除連結", "取消連結"];

const REPLY_LINKED: &str = "已連結第二大腦 ✅\n之後傳文字給我，就會變成電腦收件匣裡的任務。可以寫日期和時間，例如「明天下午三點 繳電話費」。\n傳「解除連結」可以取消。";
const REPLY_HELP: &str = "還沒有連結第二大腦。請在電腦版「設定 → 手機收件匣 → LINE 轉任務」按「連結 LINE」，再用手機掃描畫面上的 QR code。";
const REPLY_BAD_CODE: &str =
    "這組連結碼不對或已經過期。請在電腦版「設定 → 手機收件匣 → LINE 轉任務」重新產生。";
const REPLY_TOO_MANY_TRIES: &str = "嘗試太多次了，請一小時後再試。";
const REPLY_UNLINKED: &str = "已解除連結，之後的訊息不會再送到收件匣。";
const REPLY_NOT_ENTITLED: &str =
    "LINE 轉任務是 Skool 付費會員功能。請在電腦版「設定 → 手機收件匣」開通後再傳。";
const REPLY_TEXT_ONLY: &str = "目前只能把文字訊息轉成任務。";
const REPLY_TOO_LONG: &str = "訊息太長了，請分成幾則傳送（每則約 800 字以內）。";
const REPLY_FULL: &str = "收件匣有太多還沒收取的任務。請打開電腦版第二大腦讓它收取後再傳。";
const REPLY_FAILED: &str = "暫時存不進去，請稍後再傳一次。";

/// Sends replies through the LINE Messaging API. Replies are free; pushes are not used.
pub trait LineApi: Send + Sync {
    fn reply<'a>(
        &'a self,
        reply_token: &'a str,
        text: &'a str,
    ) -> BoxFuture<'a, Result<(), Unavailable>>;
}

pub struct LineMessaging {
    http: reqwest::Client,
    access_token: String,
}

impl LineMessaging {
    pub fn new(access_token: &str) -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| "HTTP client")?;
        Ok(Self {
            http,
            access_token: access_token.to_owned(),
        })
    }
}

impl LineApi for LineMessaging {
    fn reply<'a>(
        &'a self,
        reply_token: &'a str,
        text: &'a str,
    ) -> BoxFuture<'a, Result<(), Unavailable>> {
        Box::pin(async move {
            let body = json!({
                "replyToken": reply_token,
                "messages": [{ "type": "text", "text": text }],
            });
            let response = self
                .http
                .post("https://api.line.me/v2/bot/message/reply")
                .bearer_auth(&self.access_token)
                .header("content-type", "application/json")
                .body(body.to_string())
                .send()
                .await
                .map_err(|_| Unavailable)?;
            if response.status().is_success() {
                Ok(())
            } else {
                Err(Unavailable)
            }
        })
    }
}

/// The official account: its channel secret signs webhooks and keys the
/// user-id HMAC; `bot_id` is the basic id such as `@123abcde`.
pub struct Line {
    signature_key: hmac::Key,
    user_key: hmac::Key,
    bot_id: String,
    api: Arc<dyn LineApi>,
}

impl Line {
    pub fn new(channel_secret: &str, bot_id: &str, api: Arc<dyn LineApi>) -> Self {
        let user_secret = digest(&SHA256, format!("line-user\n{channel_secret}").as_bytes());
        Self {
            signature_key: hmac::Key::new(hmac::HMAC_SHA256, channel_secret.as_bytes()),
            user_key: hmac::Key::new(hmac::HMAC_SHA256, user_secret.as_ref()),
            bot_id: bot_id.trim().to_owned(),
            api,
        }
    }

    fn user_hash(&self, user_id: &str) -> Vec<u8> {
        hmac::sign(&self.user_key, user_id.as_bytes())
            .as_ref()
            .to_vec()
    }

    fn verify(&self, headers: &HeaderMap, body: &[u8]) -> bool {
        header(headers, "x-line-signature")
            .and_then(|value| STANDARD.decode(value).ok())
            .is_some_and(|signature| hmac::verify(&self.signature_key, body, &signature).is_ok())
    }

    /// Opens a chat with the account with "連結 <code>" already typed.
    fn link_url(&self, code: &str) -> String {
        format!(
            "https://line.me/R/oaMessage/{}/?{}",
            percent_encode(&self.bot_id),
            percent_encode(&format!("連結 {}", display_code(code)))
        )
    }

    fn add_friend_url(&self) -> String {
        format!("https://line.me/R/ti/p/{}", percent_encode(&self.bot_id))
    }
}

fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn display_code(code: &str) -> String {
    format!("{}-{}", &code[..4], &code[4..])
}

fn new_code() -> ApiResult<String> {
    let mut bytes = [0u8; CODE_LENGTH];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| ApiError::Internal)?;
    // 256 is not a multiple of 31; the slight bias does not matter for a
    // 40-bit code that lives 15 minutes and allows 10 tries an hour.
    Ok(bytes
        .iter()
        .map(|byte| CODE_ALPHABET[*byte as usize % CODE_ALPHABET.len()] as char)
        .collect())
}

fn code_hash(code: &str) -> Vec<u8> {
    digest(&SHA256, format!("line-code\n{code}").as_bytes())
        .as_ref()
        .to_vec()
}

/// A message that is only a link code, with or without "連結", spaces or a dash.
fn parse_code(text: &str) -> Option<String> {
    let rest = text.trim().strip_prefix("連結").unwrap_or(text.trim());
    let code: String = rest
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| c.to_ascii_uppercase())
        .collect();
    (code.len() == CODE_LENGTH && code.bytes().all(|byte| CODE_ALPHABET.contains(&byte)))
        .then_some(code)
}

fn preview(text: &str) -> String {
    let first_line = text.lines().next().unwrap_or("");
    let mut preview: String = first_line.chars().take(PREVIEW_CHARS).collect();
    if preview.len() < first_line.len() || text.contains('\n') {
        preview.push('…');
    }
    preview
}

fn line(state: &AppState) -> ApiResult<&Line> {
    state.line.as_ref().ok_or(ApiError::Code(
        StatusCode::SERVICE_UNAVAILABLE,
        "line_unavailable",
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct LinkBody {
    public_key: String,
}

pub(crate) async fn get_link(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
) -> ApiResult<Json<serde_json::Value>> {
    authenticate_desktop(&state, &id, &headers, "GET", &uri, b"")?;
    let Some(line) = state.line.as_ref() else {
        return Ok(Json(json!({ "available": false, "linked": false })));
    };
    let link = state.store.line_link(&id)?;
    Ok(Json(json!({
        "available": true,
        "linked": link.as_ref().is_some_and(|link| link.linked),
        "botId": line.bot_id,
        "addFriendUrl": line.add_friend_url(),
    })))
}

/// Stores the inbox public key and returns a fresh link code. The code alone
/// links whichever LINE account sends it, so it is shown only on the desktop.
pub(crate) async fn create_link(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<serde_json::Value>> {
    authenticate_desktop(&state, &id, &headers, "POST", &uri, &body)?;
    let line = line(&state)?;
    if state.store.entitlement(&id)?.is_none() {
        return Err(ApiError::Code(StatusCode::FORBIDDEN, "not_entitled"));
    }
    let request: LinkBody = serde_json::from_slice(&body).map_err(|_| ApiError::BadRequest)?;
    let public_key = URL_SAFE_NO_PAD
        .decode(&request.public_key)
        .ok()
        .filter(|key| is_public_key(key))
        .ok_or(ApiError::BadRequest)?;
    let now = state.now();
    if !state.limiter.allow(
        &format!("line-link:{id}"),
        state.limits.codes_per_inbox_hour,
        3600,
        now,
    ) {
        return Err(ApiError::RateLimited);
    }
    let code = new_code()?;
    let expires_at = now + CODE_TTL_SECS;
    state
        .store
        .line_prepare(&id, &public_key, &code_hash(&code), expires_at)?;
    Ok(Json(json!({
        "code": display_code(&code),
        "linkUrl": line.link_url(&code),
        "addFriendUrl": line.add_friend_url(),
        "botId": line.bot_id,
        "expiresAt": expires_at,
    })))
}

pub(crate) async fn delete_link(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<StatusCode> {
    authenticate_desktop(&state, &id, &headers, "DELETE", &uri, &body)?;
    state.store.line_delete(&id)?;
    Ok(StatusCode::NO_CONTENT)
}

/// A real point on P-256: a trial agreement fails for anything else.
fn is_public_key(bytes: &[u8]) -> bool {
    if bytes.len() != P256_PUBLIC_KEY_BYTES || bytes[0] != 0x04 {
        return false;
    }
    let Ok(private) = EphemeralPrivateKey::generate(&ECDH_P256, &SystemRandom::new()) else {
        return false;
    };
    agree_ephemeral(private, &UnparsedPublicKey::new(&ECDH_P256, bytes), |_| ()).is_ok()
}

#[derive(Serialize)]
struct Payload<'a> {
    v: u8,
    text: &'a str,
    #[serde(rename = "createdAt")]
    created_at: String,
    source: &'static str,
}

/// Seals `plaintext` for the inbox exactly as the phone does (docs/inbox-relay.md, "Envelope").
pub fn seal(
    plaintext: &[u8],
    inbox_id: &str,
    item_id: &str,
    recipient_public: &[u8],
) -> Option<Envelope> {
    let rng = SystemRandom::new();
    let private = EphemeralPrivateKey::generate(&ECDH_P256, &rng).ok()?;
    let ephemeral_public = private.compute_public_key().ok()?.as_ref().to_vec();
    let salt = [ephemeral_public.as_slice(), recipient_public].concat();
    let key = agree_ephemeral(
        private,
        &UnparsedPublicKey::new(&ECDH_P256, recipient_public),
        |shared| {
            let prk = Salt::new(HKDF_SHA256, &salt).extract(shared);
            let okm = prk.expand(&[INBOX_HKDF_INFO], &AES_256_GCM).ok()?;
            Some(LessSafeKey::new(UnboundKey::from(okm)))
        },
    )
    .ok()??;
    let mut nonce = [0u8; 12];
    rng.fill(&mut nonce).ok()?;
    let aad = format!("v1\n{inbox_id}\n{item_id}");
    let mut buffer = plaintext.to_vec();
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce),
        Aad::from(aad.as_bytes()),
        &mut buffer,
    )
    .ok()?;
    Some(Envelope {
        v: 1,
        id: item_id.to_owned(),
        epk: URL_SAFE_NO_PAD.encode(ephemeral_public),
        nonce: URL_SAFE_NO_PAD.encode(nonce),
        ct: URL_SAFE_NO_PAD.encode(buffer),
    })
}

/// A UUID v4 derived from LINE's event id, so a redelivered event lands on
/// the same item instead of creating a second task.
fn item_id_for(event_id: Option<&str>) -> ApiResult<String> {
    let mut bytes = [0u8; 16];
    match event_id {
        Some(event_id) => bytes.copy_from_slice(
            &digest(&SHA256, format!("line-event\n{event_id}").as_bytes()).as_ref()[..16],
        ),
        None => SystemRandom::new()
            .fill(&mut bytes)
            .map_err(|_| ApiError::Internal)?,
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = hex::encode(bytes);
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

/// `2026-10-23T09:30:00.000Z` for a Unix time in milliseconds.
fn iso_from_millis(millis: i64) -> String {
    let seconds = millis.div_euclid(1000);
    let (days, rest) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
    // Civil-from-days (Howard Hinnant), valid for the proleptic Gregorian calendar.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60,
        millis.rem_euclid(1000)
    )
}

#[derive(Deserialize)]
struct Webhook {
    #[serde(default)]
    events: Vec<Event>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Event {
    #[serde(rename = "type")]
    kind: String,
    mode: Option<String>,
    reply_token: Option<String>,
    source: Option<Source>,
    message: Option<EventMessage>,
    webhook_event_id: Option<String>,
    timestamp: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Source {
    #[serde(rename = "type")]
    kind: String,
    user_id: Option<String>,
}

#[derive(Deserialize)]
struct EventMessage {
    #[serde(rename = "type")]
    kind: String,
    text: Option<String>,
}

/// LINE retries a webhook that does not answer 200, so once the signature is
/// good every event is handled (or ignored) and the answer is 200.
pub(crate) async fn webhook(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<StatusCode> {
    let line = state.line.as_ref().ok_or(ApiError::NotFound)?;
    if !line.verify(&headers, &body) {
        return Err(ApiError::Unauthorized);
    }
    let webhook: Webhook = serde_json::from_slice(&body).map_err(|_| ApiError::BadRequest)?;
    for event in webhook.events {
        if event.mode.as_deref() == Some("standby") {
            continue;
        }
        let Some(user_id) = event
            .source
            .as_ref()
            .filter(|source| source.kind == "user")
            .and_then(|source| source.user_id.as_deref())
        else {
            continue;
        };
        let user_hash = line.user_hash(user_id);
        let reply = match event.kind.as_str() {
            "follow" => Some(
                if state.store.line_target(&user_hash)?.is_some() {
                    REPLY_LINKED
                } else {
                    REPLY_HELP
                }
                .to_owned(),
            ),
            "unfollow" => {
                state.store.line_unlink_user(&user_hash)?;
                None
            }
            "message" => Some(handle_message(&state, &user_hash, &event)?),
            _ => None,
        };
        if let (Some(text), Some(token)) = (reply, event.reply_token.as_deref()) {
            // A failed reply is not retried: the item, if any, is already stored.
            let _ = line.api.reply(token, &text).await;
        }
    }
    Ok(StatusCode::OK)
}

fn handle_message(state: &AppState, user_hash: &[u8], event: &Event) -> ApiResult<String> {
    let Some(text) = event
        .message
        .as_ref()
        .filter(|message| message.kind == "text")
        .and_then(|message| message.text.as_deref())
    else {
        return Ok(REPLY_TEXT_ONLY.to_owned());
    };
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let text = text.trim();
    if UNLINK_WORDS.contains(&text) {
        state.store.line_unlink_user(user_hash)?;
        return Ok(REPLY_UNLINKED.to_owned());
    }
    if let Some(code) = parse_code(text) {
        if !state.limiter.allow(
            &format!("line-code:{}", hex::encode(user_hash)),
            CODE_TRIES_PER_USER_HOUR,
            3600,
            state.now(),
        ) {
            return Ok(REPLY_TOO_MANY_TRIES.to_owned());
        }
        return Ok(if state
            .store
            .line_redeem(&code_hash(&code), user_hash, state.now())?
        {
            REPLY_LINKED
        } else {
            REPLY_BAD_CODE
        }
        .to_owned());
    }
    let Some((inbox_id, public_key)) = state.store.line_target(user_hash)? else {
        return Ok(REPLY_HELP.to_owned());
    };
    if state.store.entitlement(&inbox_id)?.is_none() {
        return Ok(REPLY_NOT_ENTITLED.to_owned());
    }
    if text.is_empty() {
        return Ok(REPLY_TEXT_ONLY.to_owned());
    }
    if text.len() > TEXT_BYTES_LIMIT {
        return Ok(REPLY_TOO_LONG.to_owned());
    }
    let now = state.now();
    let payload = Payload {
        v: 1,
        text,
        created_at: iso_from_millis(event.timestamp.unwrap_or(now * 1000)),
        source: "line",
    };
    let plaintext = serde_json::to_vec(&payload).map_err(|_| ApiError::Internal)?;
    let item_id = item_id_for(event.webhook_event_id.as_deref())?;
    let envelope = seal(&plaintext, &inbox_id, &item_id, &public_key).ok_or(ApiError::Internal)?;
    let serialized = serde_json::to_string(&envelope).map_err(|_| ApiError::Internal)?;
    if serialized.len() > state.limits.envelope_bytes {
        return Ok(REPLY_TOO_LONG.to_owned());
    }
    Ok(
        match state
            .store
            .put_item(&inbox_id, &item_id, &serialized, now, &state.limits)?
        {
            PutOutcome::Created => {
                state.hub.publish(&inbox_id, &serialized);
                format!("已送到收件匣：{}", preview(text))
            }
            // A redelivery: the first copy (sealed with another nonce) is kept.
            PutOutcome::Duplicate | PutOutcome::Conflict => {
                format!("已送到收件匣：{}", preview(text))
            }
            PutOutcome::InboxFull => REPLY_FULL.to_owned(),
            PutOutcome::StorageFull => REPLY_FAILED.to_owned(),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_parse_with_or_without_the_prefix() {
        assert_eq!(parse_code("連結 ABCD-EFGH").as_deref(), Some("ABCDEFGH"));
        assert_eq!(parse_code("abcdefgh").as_deref(), Some("ABCDEFGH"));
        assert_eq!(parse_code(" 連結abcd efgh ").as_deref(), Some("ABCDEFGH"));
        assert_eq!(parse_code("ABCD-EFG"), None);
        assert_eq!(parse_code("ABCD-EFG1"), None, "1 is not in the alphabet");
        assert_eq!(parse_code("明天 繳電話費"), None);
        let code = new_code().unwrap();
        assert_eq!(parse_code(&display_code(&code)), Some(code));
    }

    #[test]
    fn times_and_item_ids_are_well_formed() {
        assert_eq!(iso_from_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso_from_millis(1_792_747_800_123),
            "2026-10-23T09:30:00.123Z"
        );
        assert_eq!(iso_from_millis(951_782_400_000), "2000-02-29T00:00:00.000Z");
        let id = item_id_for(Some("01FZ74A0TDDPYRVKNK77XKC3ZR")).unwrap();
        assert!(crate::envelope::is_item_id(&id), "{id}");
        assert_eq!(id, item_id_for(Some("01FZ74A0TDDPYRVKNK77XKC3ZR")).unwrap());
        assert!(crate::envelope::is_item_id(&item_id_for(None).unwrap()));
    }

    #[test]
    fn links_open_a_chat_with_the_code_typed() {
        let line = Line::new("secret", "@123abcde", Arc::new(NoReplies));
        assert_eq!(
            line.link_url("ABCDEFGH"),
            "https://line.me/R/oaMessage/%40123abcde/?%E9%80%A3%E7%B5%90%20ABCD-EFGH"
        );
        assert_eq!(line.add_friend_url(), "https://line.me/R/ti/p/%40123abcde");
    }

    #[test]
    fn previews_are_short() {
        assert_eq!(preview("繳電話費"), "繳電話費");
        assert_eq!(preview("第一行\n第二行"), "第一行…");
        assert_eq!(preview(&"字".repeat(50)).chars().count(), PREVIEW_CHARS + 1);
    }

    struct NoReplies;

    impl LineApi for NoReplies {
        fn reply<'a>(
            &'a self,
            _reply_token: &'a str,
            _text: &'a str,
        ) -> BoxFuture<'a, Result<(), Unavailable>> {
            Box::pin(async { Ok(()) })
        }
    }
}
