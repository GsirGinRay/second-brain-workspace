//! Seals the phone "today" snapshot. Mirrors
//! `packages/brain-core/src/inbox-snapshot.ts`; see docs/inbox-relay.md.

use crate::error::NativeError;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::hkdf::{Salt, HKDF_SHA256};
use ring::rand::{SecureRandom, SystemRandom};
use serde::Serialize;

pub const SNAPSHOT_HKDF_INFO: &[u8] = b"second-brain-snapshot-v1";
/// Leaves room for base64 and the envelope under the relay's 128 KiB cap.
pub const SNAPSHOT_PLAINTEXT_LIMIT: usize = 90 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SnapshotEnvelope {
    pub v: u8,
    pub version: i64,
    pub nonce: String,
    pub ct: String,
}

fn content_key(view_key: &[u8; 32], inbox_id: &str) -> Result<LessSafeKey, NativeError> {
    let prk = Salt::new(HKDF_SHA256, inbox_id.as_bytes()).extract(view_key);
    let okm = prk
        .expand(&[SNAPSHOT_HKDF_INFO], &AES_256_GCM)
        .map_err(|_| NativeError::InvalidRequest)?;
    Ok(LessSafeKey::new(UnboundKey::from(okm)))
}

pub fn seal_with_nonce(
    plaintext: &[u8],
    inbox_id: &str,
    view_key: &[u8; 32],
    version: i64,
    nonce: [u8; 12],
) -> Result<SnapshotEnvelope, NativeError> {
    if plaintext.len() > SNAPSHOT_PLAINTEXT_LIMIT
        || version <= 0
        || !crate::inbox_envelope::is_inbox_id(inbox_id)
    {
        return Err(NativeError::InvalidRequest);
    }
    let aad = format!("snapshot-v1\n{inbox_id}\n{version}");
    let mut buffer = plaintext.to_vec();
    content_key(view_key, inbox_id)?
        .seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(aad.as_bytes()),
            &mut buffer,
        )
        .map_err(|_| NativeError::InvalidRequest)?;
    Ok(SnapshotEnvelope {
        v: 1,
        version,
        nonce: URL_SAFE_NO_PAD.encode(nonce),
        ct: URL_SAFE_NO_PAD.encode(buffer),
    })
}

pub fn seal(
    plaintext: &[u8],
    inbox_id: &str,
    view_key: &[u8; 32],
    version: i64,
) -> Result<SnapshotEnvelope, NativeError> {
    let mut nonce = [0u8; 12];
    SystemRandom::new()
        .fill(&mut nonce)
        .map_err(|_| NativeError::KeyStorageUnavailable)?;
    seal_with_nonce(plaintext, inbox_id, view_key, version, nonce)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!(
            "../../../../docs/fixtures/inbox-snapshot-v1.json"
        ))
        .unwrap()
    }

    fn view_key(fixture: &serde_json::Value) -> [u8; 32] {
        URL_SAFE_NO_PAD
            .decode(fixture["viewKeyBase64Url"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap()
    }

    #[test]
    fn sealing_reproduces_the_shared_golden_snapshot() {
        let fixture = fixture();
        let envelope = &fixture["envelope"];
        let nonce: [u8; 12] = URL_SAFE_NO_PAD
            .decode(envelope["nonce"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let sealed = seal_with_nonce(
            fixture["plaintextUtf8"].as_str().unwrap().as_bytes(),
            fixture["inboxId"].as_str().unwrap(),
            &view_key(&fixture),
            envelope["version"].as_i64().unwrap(),
            nonce,
        )
        .unwrap();
        assert_eq!(serde_json::to_value(sealed).unwrap(), *envelope);
    }

    #[test]
    fn fresh_seals_differ_and_bad_input_is_refused() {
        let fixture = fixture();
        let key = view_key(&fixture);
        let inbox_id = fixture["inboxId"].as_str().unwrap();
        let first = seal(b"{}", inbox_id, &key, 1).unwrap();
        let second = seal(b"{}", inbox_id, &key, 1).unwrap();
        assert_ne!(first.nonce, second.nonce);
        assert!(seal(b"{}", inbox_id, &key, 0).is_err());
        assert!(seal(b"{}", "short", &key, 1).is_err());
        assert!(seal(&vec![b' '; SNAPSHOT_PLAINTEXT_LIMIT + 1], inbox_id, &key, 1).is_err());
    }
}
