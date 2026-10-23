//! Shape checks for sealed items. The relay cannot decrypt them; it only makes
//! sure they look like `docs/inbox-relay.md` envelopes before storing them.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};

const P256_PUBLIC_KEY_BYTES: usize = 65;
const AES_GCM_NONCE_BYTES: usize = 12;
const AES_GCM_TAG_BYTES: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub v: u8,
    pub id: String,
    pub epk: String,
    pub nonce: String,
    pub ct: String,
}

pub fn is_inbox_id(value: &str) -> bool {
    value.len() == 22
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// Lowercase UUID v4, as `crypto.randomUUID()` produces.
pub fn is_item_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, &byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            14 => byte == b'4',
            19 => matches!(byte, b'8' | b'9' | b'a' | b'b'),
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte),
        })
}

fn decoded_len(value: &str) -> Option<usize> {
    URL_SAFE_NO_PAD.decode(value).ok().map(|bytes| bytes.len())
}

/// Uncompressed SEC1 point; the relay cannot check it is on the curve cheaply,
/// and the desktop rejects it anyway if it is not.
fn is_uncompressed_point(value: &str) -> bool {
    URL_SAFE_NO_PAD
        .decode(value)
        .is_ok_and(|bytes| bytes.len() == P256_PUBLIC_KEY_BYTES && bytes[0] == 0x04)
}

/// Parses and re-serializes an envelope so equal items compare byte for byte.
pub fn normalize(body: &[u8]) -> Option<(Envelope, String)> {
    let envelope: Envelope = serde_json::from_slice(body).ok()?;
    let valid = envelope.v == 1
        && is_item_id(&envelope.id)
        && is_uncompressed_point(&envelope.epk)
        && decoded_len(&envelope.nonce) == Some(AES_GCM_NONCE_BYTES)
        && decoded_len(&envelope.ct).is_some_and(|len| len > AES_GCM_TAG_BYTES);
    if !valid {
        return None;
    }
    let serialized = serde_json::to_string(&envelope).ok()?;
    Some((envelope, serialized))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../../docs/fixtures/inbox-envelope-v1.json");

    fn golden() -> serde_json::Value {
        let fixture: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        fixture["envelope"].clone()
    }

    #[test]
    fn accepts_the_shared_golden_envelope() {
        let body = serde_json::to_vec(&golden()).unwrap();
        let (envelope, serialized) = normalize(&body).unwrap();
        assert_eq!(envelope.id, "11111111-1111-4111-8111-111111111111");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&serialized).unwrap(),
            golden()
        );
    }

    #[test]
    fn rejects_malformed_envelopes() {
        let with = |key: &str, value: serde_json::Value| {
            let mut envelope = golden();
            envelope[key] = value;
            serde_json::to_vec(&envelope).unwrap()
        };
        assert!(normalize(&with("v", 2.into())).is_none());
        assert!(normalize(&with("id", "not-a-uuid".into())).is_none());
        assert!(normalize(&with("nonce", "AAEC".into())).is_none());
        assert!(normalize(&with("epk", golden()["nonce"].clone())).is_none());
        assert!(normalize(&with("ct", "AAEC".into())).is_none());
        assert!(normalize(&with("extra", 1.into())).is_none());
        assert!(normalize(b"not json").is_none());
    }

    #[test]
    fn validates_ids() {
        assert!(is_inbox_id("AAECAwQFBgcICQoLDA0ODw"));
        assert!(!is_inbox_id("AAECAwQFBgcICQoLDA0OD"));
        assert!(!is_inbox_id("AAECAwQFBgcICQoLDA0OD/"));
        assert!(is_item_id("11111111-1111-4111-8111-111111111111"));
        assert!(!is_item_id("11111111-1111-1111-1111-111111111111"));
        assert!(!is_item_id("11111111-1111-4111-8111-11111111111A"));
    }
}
