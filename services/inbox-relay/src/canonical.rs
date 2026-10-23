//! Device request signatures. Must produce the same canonical text as
//! `packages/brain-core/src/signing.ts`; locked by
//! `docs/fixtures/canonical-signature-v1.json`.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::digest::{SHA256, digest};
use ring::signature::{ED25519, UnparsedPublicKey};

pub const DEVICE_ID_HEADER: &str = "x-brain-device-id";
pub const TIMESTAMP_HEADER: &str = "x-brain-timestamp";
pub const NONCE_HEADER: &str = "x-brain-nonce";
pub const SIGNATURE_HEADER: &str = "x-brain-signature";

pub struct CanonicalRequest<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub timestamp: i64,
    pub nonce: &'a str,
    pub content_type: &'a str,
    pub body: &'a [u8],
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(digest(&SHA256, bytes))
}

/// Relay routes take no query string, so the query line is always empty.
pub fn canonicalize(request: &CanonicalRequest) -> Option<String> {
    if request.timestamp < 0 || request.timestamp > 9_007_199_254_740_991 {
        return None;
    }
    let method = request.method.trim().to_ascii_uppercase();
    if method.is_empty() || !method.bytes().all(|byte| byte.is_ascii_uppercase()) {
        return None;
    }
    let path = request.path;
    if !path.starts_with('/')
        || path.contains(['\\', '?', '\r', '\n'])
        || path
            .split('/')
            .any(|segment| segment == "." || segment == "..")
    {
        return None;
    }
    let nonce = URL_SAFE_NO_PAD.decode(request.nonce).ok()?;
    if !(16..=64).contains(&nonce.len()) || URL_SAFE_NO_PAD.encode(&nonce) != request.nonce {
        return None;
    }
    if request.content_type.contains(['\r', '\n']) {
        return None;
    }
    let content_type = request
        .content_type
        .split_once(';')
        .map_or(request.content_type, |(value, _)| value)
        .trim()
        .to_ascii_lowercase();
    Some(
        [
            "v1".to_owned(),
            method,
            path.to_owned(),
            String::new(),
            request.timestamp.to_string(),
            request.nonce.to_owned(),
            content_type,
            sha256_hex(request.body),
        ]
        .join("\n"),
    )
}

pub fn verify(public_key: &[u8], signature: &str, canonical: &str) -> bool {
    let Ok(signature) = URL_SAFE_NO_PAD.decode(signature) else {
        return false;
    };
    UnparsedPublicKey::new(&ED25519, public_key)
        .verify(canonical.as_bytes(), &signature)
        .is_ok()
}
