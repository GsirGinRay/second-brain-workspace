//! The phone "today" list is for paid members. A desktop proves the user's
//! email with a 6-digit code, the relay checks the member directory (or a
//! manual grant), and only entitled inboxes may store a snapshot. Entitlements
//! are re-checked daily; a directory outage never revokes anyone.

use super::*;
use crate::membership::{Unavailable, normalize_email};
use crate::store::SnapshotOutcome;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmailBody {
    email: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CodeBody {
    code: String,
}

#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct SnapshotEnvelope {
    v: u8,
    version: i64,
    nonce: String,
    ct: String,
}

const AES_GCM_NONCE_BYTES: usize = 12;
const AES_GCM_TAG_BYTES: usize = 16;

fn code_hash(inbox_id: &str, code: &str) -> Vec<u8> {
    digest(&SHA256, format!("{inbox_id}:{code}").as_bytes())
        .as_ref()
        .to_vec()
}

fn six_digit_code() -> ApiResult<String> {
    let mut bytes = [0u8; 4];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| ApiError::Internal)?;
    Ok(format!("{:06}", u32::from_be_bytes(bytes) % 1_000_000))
}

pub(crate) async fn eligible(state: &AppState, email: &str) -> Result<bool, Unavailable> {
    if state.store.is_granted(email).map_err(|_| Unavailable)? {
        return Ok(true);
    }
    state.directory.is_member(email).await
}

pub(crate) async fn get_entitlement(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
) -> ApiResult<Json<serde_json::Value>> {
    authenticate_desktop(&state, &id, &headers, "GET", &uri, b"")?;
    let entitlement = state.store.entitlement(&id)?;
    Ok(Json(json!({
        "entitled": entitlement.is_some(),
        "email": entitlement.map(|entitlement| entitlement.email),
    })))
}

pub(crate) async fn delete_entitlement(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<StatusCode> {
    authenticate_desktop(&state, &id, &headers, "DELETE", &uri, &body)?;
    state.store.revoke(&id)?;
    state.store.delete_code(&id)?;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn request_code(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<StatusCode> {
    authenticate_desktop(&state, &id, &headers, "POST", &uri, &body)?;
    let request: EmailBody = serde_json::from_slice(&body).map_err(|_| ApiError::BadRequest)?;
    let email = normalize_email(&request.email).ok_or(ApiError::BadRequest)?;
    let limits = &state.limits;
    let now = state.now();
    if let Some(pending) = state.store.code(&id)?
        && now - pending.sent_at < limits.code_resend_secs
    {
        return Err(ApiError::RateLimited);
    }
    if !state.limiter.allow(
        &format!("code:{id}"),
        limits.codes_per_inbox_hour,
        3600,
        now,
    ) {
        return Err(ApiError::RateLimited);
    }
    match eligible(&state, &email).await {
        Ok(true) => {}
        Ok(false) => return Err(ApiError::Code(StatusCode::FORBIDDEN, "not_member")),
        Err(Unavailable) => {
            return Err(ApiError::Code(
                StatusCode::SERVICE_UNAVAILABLE,
                "directory_unavailable",
            ));
        }
    }
    let code = six_digit_code()?;
    state.store.put_code(
        &id,
        &email,
        &code_hash(&id, &code),
        now,
        now + limits.code_ttl_secs,
    )?;
    if state.mailer.send_code(&email, &code).await.is_err() {
        state.store.delete_code(&id)?;
        return Err(ApiError::Code(
            StatusCode::SERVICE_UNAVAILABLE,
            "mail_unavailable",
        ));
    }
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn verify_code(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<serde_json::Value>> {
    authenticate_desktop(&state, &id, &headers, "POST", &uri, &body)?;
    let request: CodeBody = serde_json::from_slice(&body).map_err(|_| ApiError::BadRequest)?;
    let code = request.code.trim();
    if code.len() != 6 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(ApiError::Code(StatusCode::BAD_REQUEST, "wrong_code"));
    }
    let pending = state
        .store
        .code(&id)?
        .ok_or(ApiError::Code(StatusCode::GONE, "no_code"))?;
    if state.now() > pending.expires_at {
        state.store.delete_code(&id)?;
        return Err(ApiError::Code(StatusCode::GONE, "code_expired"));
    }
    if pending.attempts >= state.limits.code_attempts {
        state.store.delete_code(&id)?;
        return Err(ApiError::Code(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_attempts",
        ));
    }
    if code_hash(&id, code) != pending.code_hash {
        state.store.count_code_attempt(&id)?;
        return Err(ApiError::Code(StatusCode::BAD_REQUEST, "wrong_code"));
    }
    state.store.entitle(&id, &pending.email, state.now())?;
    Ok(Json(json!({ "entitled": true, "email": pending.email })))
}

pub(crate) async fn put_snapshot(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    uri: OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<StatusCode> {
    authenticate_desktop(&state, &id, &headers, "PUT", &uri, &body)?;
    if state.store.entitlement(&id)?.is_none() {
        return Err(ApiError::Code(StatusCode::FORBIDDEN, "not_entitled"));
    }
    let envelope: SnapshotEnvelope =
        serde_json::from_slice(&body).map_err(|_| ApiError::BadRequest)?;
    let decoded = |value: &str| URL_SAFE_NO_PAD.decode(value).ok().map(|bytes| bytes.len());
    let valid = envelope.v == 1
        && envelope.version > 0
        && decoded(&envelope.nonce) == Some(AES_GCM_NONCE_BYTES)
        && decoded(&envelope.ct).is_some_and(|len| len > AES_GCM_TAG_BYTES);
    if !valid {
        return Err(ApiError::BadRequest);
    }
    let serialized = serde_json::to_string(&envelope).map_err(|_| ApiError::Internal)?;
    match state
        .store
        .put_snapshot(&id, envelope.version, &serialized)?
    {
        SnapshotOutcome::Stored => Ok(StatusCode::NO_CONTENT),
        SnapshotOutcome::Stale => Err(ApiError::Conflict),
    }
}

pub(crate) async fn get_snapshot(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    ClientIp(ip): ClientIp,
    headers: HeaderMap,
) -> ApiResult<Response> {
    if !state.limiter.allow(
        &format!("snapshot-ip:{ip}"),
        state.limits.uploads_per_ip_minute,
        60,
        state.now(),
    ) {
        return Err(ApiError::RateLimited);
    }
    authenticate_phone(&state, &id, &headers)?;
    if state.store.entitlement(&id)?.is_none() {
        return Err(ApiError::Code(StatusCode::FORBIDDEN, "not_entitled"));
    }
    let body = state
        .store
        .snapshot(&id)?
        .ok_or(ApiError::Code(StatusCode::NOT_FOUND, "no_snapshot"))?;
    Ok(([(CONTENT_TYPE, "application/json")], body).into_response())
}

impl AppState {
    /// Confirms entitlements not checked for a day; returns (kept, revoked).
    /// Stops at the first directory error so an outage revokes nobody.
    pub async fn recheck_entitlements(&self) -> rusqlite::Result<(usize, usize)> {
        let now = self.now();
        let due = self
            .store
            .entitlements_checked_before(now - self.limits.entitlement_recheck_secs)?;
        let (mut kept, mut revoked) = (0, 0);
        for (inbox_id, email) in due {
            match eligible(self, &email).await {
                Ok(true) => {
                    self.store.mark_checked(&inbox_id, now)?;
                    kept += 1;
                }
                Ok(false) => {
                    self.store.revoke(&inbox_id)?;
                    revoked += 1;
                }
                Err(Unavailable) => break,
            }
        }
        Ok((kept, revoked))
    }
}
