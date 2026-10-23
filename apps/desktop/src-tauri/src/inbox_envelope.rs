//! Opens phone-to-desktop inbox envelopes. Mirrors
//! `packages/brain-core/src/inbox-envelope.ts`; see docs/inbox-relay.md.

use crate::error::NativeError;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::hkdf::{Salt, HKDF_SHA256};
use serde::{Deserialize, Serialize};

pub const INBOX_HKDF_INFO: &[u8] = b"second-brain-inbox-v1";
pub const INBOX_TEXT_BYTES_LIMIT: usize = 2400;
const P256_PUBLIC_KEY_BYTES: usize = 65;
const AES_GCM_NONCE_BYTES: usize = 12;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InboxEnvelope {
    pub v: u8,
    pub id: String,
    pub epk: String,
    pub nonce: String,
    pub ct: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InboxSource {
    Pwa,
    Line,
    Email,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InboxPayload {
    pub v: u8,
    pub text: String,
    pub created_at: String,
    pub source: InboxSource,
    /// Changes an existing task instead of adding one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<InboxAction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// The new date of a `reschedule`, or the date of an added task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    /// The project of an added task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InboxAction {
    Complete,
    Reschedule,
    Focus,
}

fn is_date_key(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(index, &byte)| match index {
            4 | 7 => byte == b'-',
            _ => byte.is_ascii_digit(),
        })
}

pub fn is_inbox_id(value: &str) -> bool {
    value.len() == 22
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// Lowercase UUID v4, as `crypto.randomUUID()` produces.
pub fn is_inbox_item_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, &byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            14 => byte == b'4',
            19 => matches!(byte, b'8' | b'9' | b'a' | b'b'),
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte),
        })
}

pub fn associated_data(inbox_id: &str, item_id: &str) -> Result<Vec<u8>, NativeError> {
    if !is_inbox_id(inbox_id) || !is_inbox_item_id(item_id) {
        return Err(NativeError::InvalidRequest);
    }
    Ok(format!("v1\n{inbox_id}\n{item_id}").into_bytes())
}

pub fn public_key_bytes(secret: &SecretKey) -> Vec<u8> {
    secret
        .public_key()
        .to_encoded_point(false)
        .as_bytes()
        .to_vec()
}

fn decode(value: &str) -> Result<Vec<u8>, NativeError> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| NativeError::InvalidRequest)
}

fn decode_public_key(bytes: &[u8]) -> Result<PublicKey, NativeError> {
    if bytes.len() != P256_PUBLIC_KEY_BYTES || bytes[0] != 0x04 {
        return Err(NativeError::InvalidRequest);
    }
    PublicKey::from_sec1_bytes(bytes).map_err(|_| NativeError::InvalidRequest)
}

fn content_key(
    secret: &SecretKey,
    peer: &PublicKey,
    ephemeral_public: &[u8],
    recipient_public: &[u8],
) -> Result<LessSafeKey, NativeError> {
    let shared = p256::ecdh::diffie_hellman(secret.to_nonzero_scalar(), peer.as_affine());
    let salt = [ephemeral_public, recipient_public].concat();
    let prk = Salt::new(HKDF_SHA256, &salt).extract(shared.raw_secret_bytes());
    let okm = prk
        .expand(&[INBOX_HKDF_INFO], &AES_256_GCM)
        .map_err(|_| NativeError::InvalidRequest)?;
    Ok(LessSafeKey::new(UnboundKey::from(okm)))
}

fn validate_payload(payload: InboxPayload) -> Result<InboxPayload, NativeError> {
    let text = payload.text.replace("\r\n", "\n").replace('\r', "\n");
    let text = text.trim();
    if payload.v != 1
        || text.is_empty()
        || text.len() > INBOX_TEXT_BYTES_LIMIT
        || payload.created_at.is_empty()
        || payload.created_at.len() > 40
        || payload.action.is_some() != payload.task_id.is_some()
        || payload
            .task_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 100)
        || payload
            .date
            .as_deref()
            .is_some_and(|date| !is_date_key(date))
        || (payload.action == Some(InboxAction::Reschedule))
            != (payload.action.is_some() && payload.date.is_some())
        || (payload.action.is_some() && payload.project_id.is_some())
        || payload
            .project_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 100)
    {
        return Err(NativeError::InvalidRequest);
    }
    Ok(InboxPayload {
        text: text.to_owned(),
        ..payload
    })
}

/// Decrypts an envelope addressed to this desktop's inbox key. Any failure,
/// including a wrong inbox id or tampering, is `InvalidRequest`.
pub fn open_inbox_item(
    envelope: &InboxEnvelope,
    inbox_id: &str,
    recipient: &SecretKey,
) -> Result<InboxPayload, NativeError> {
    if envelope.v != 1 {
        return Err(NativeError::InvalidRequest);
    }
    let aad = associated_data(inbox_id, &envelope.id)?;
    let ephemeral_bytes = decode(&envelope.epk)?;
    let ephemeral = decode_public_key(&ephemeral_bytes)?;
    let nonce: [u8; AES_GCM_NONCE_BYTES] = decode(&envelope.nonce)?
        .try_into()
        .map_err(|_| NativeError::InvalidRequest)?;
    let key = content_key(
        recipient,
        &ephemeral,
        &ephemeral_bytes,
        &public_key_bytes(recipient),
    )?;
    let mut buffer = decode(&envelope.ct)?;
    let plaintext = key
        .open_in_place(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(aad),
            &mut buffer,
        )
        .map_err(|_| NativeError::InvalidRequest)?;
    let payload: InboxPayload =
        serde_json::from_slice(plaintext).map_err(|_| NativeError::InvalidRequest)?;
    validate_payload(payload)
}

#[cfg(test)]
pub(crate) fn seal_with(
    plaintext: &[u8],
    inbox_id: &str,
    item_id: &str,
    recipient_public: &[u8],
    ephemeral: &SecretKey,
    nonce: [u8; AES_GCM_NONCE_BYTES],
) -> InboxEnvelope {
    let ephemeral_public = public_key_bytes(ephemeral);
    let peer = decode_public_key(recipient_public).unwrap();
    let key = content_key(ephemeral, &peer, &ephemeral_public, recipient_public).unwrap();
    let mut buffer = plaintext.to_vec();
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce),
        Aad::from(associated_data(inbox_id, item_id).unwrap()),
        &mut buffer,
    )
    .unwrap();
    InboxEnvelope {
        v: 1,
        id: item_id.to_owned(),
        epk: URL_SAFE_NO_PAD.encode(ephemeral_public),
        nonce: URL_SAFE_NO_PAD.encode(nonce),
        ct: URL_SAFE_NO_PAD.encode(buffer),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        json: serde_json::Value,
        recipient: SecretKey,
        ephemeral: SecretKey,
        envelope: InboxEnvelope,
    }

    fn fixture() -> Fixture {
        let json: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../docs/fixtures/inbox-envelope-v1.json"
        ))
        .expect("fixture JSON");
        let secret = |name: &str| {
            let scalar = decode(json[name]["privateScalarBase64Url"].as_str().unwrap()).unwrap();
            let key = SecretKey::from_slice(&scalar).unwrap();
            assert_eq!(
                URL_SAFE_NO_PAD.encode(public_key_bytes(&key)),
                json[name]["publicKeyBase64Url"]
            );
            key
        };
        let recipient = secret("recipient");
        let ephemeral = secret("ephemeral");
        let envelope = serde_json::from_value(json["envelope"].clone()).unwrap();
        Fixture {
            json,
            recipient,
            ephemeral,
            envelope,
        }
    }

    fn str_field<'a>(fixture: &'a Fixture, name: &str) -> &'a str {
        fixture.json[name].as_str().unwrap()
    }

    #[test]
    fn opens_the_shared_golden_envelope() {
        let fixture = fixture();
        let payload = open_inbox_item(
            &fixture.envelope,
            str_field(&fixture, "inboxId"),
            &fixture.recipient,
        )
        .unwrap();
        assert_eq!(payload.text, fixture.json["payload"]["text"]);
        assert_eq!(payload.created_at, fixture.json["payload"]["createdAt"]);
        assert_eq!(payload.source, InboxSource::Pwa);
    }

    #[test]
    fn sealing_reproduces_the_shared_golden_envelope() {
        let fixture = fixture();
        let nonce: [u8; AES_GCM_NONCE_BYTES] =
            decode(&fixture.envelope.nonce).unwrap().try_into().unwrap();
        let sealed = seal_with(
            str_field(&fixture, "plaintextUtf8").as_bytes(),
            str_field(&fixture, "inboxId"),
            str_field(&fixture, "itemId"),
            &public_key_bytes(&fixture.recipient),
            &fixture.ephemeral,
            nonce,
        );
        assert_eq!(sealed, fixture.envelope);
        assert_eq!(
            associated_data(
                str_field(&fixture, "inboxId"),
                str_field(&fixture, "itemId")
            )
            .unwrap(),
            str_field(&fixture, "associatedDataUtf8").as_bytes()
        );
    }

    #[test]
    fn rejects_replay_under_another_inbox_or_item() {
        let fixture = fixture();
        assert!(open_inbox_item(
            &fixture.envelope,
            "BBECAwQFBgcICQoLDA0ODw",
            &fixture.recipient
        )
        .is_err());
        let moved = InboxEnvelope {
            id: "22222222-2222-4222-8222-222222222222".to_owned(),
            ..fixture.envelope.clone()
        };
        assert!(
            open_inbox_item(&moved, str_field(&fixture, "inboxId"), &fixture.recipient).is_err()
        );
    }

    #[test]
    fn rejects_tampering_and_the_wrong_key() {
        let fixture = fixture();
        let mut bytes = decode(&fixture.envelope.ct).unwrap();
        bytes[0] ^= 1;
        let tampered = InboxEnvelope {
            ct: URL_SAFE_NO_PAD.encode(bytes),
            ..fixture.envelope.clone()
        };
        let inbox_id = str_field(&fixture, "inboxId");
        assert!(open_inbox_item(&tampered, inbox_id, &fixture.recipient).is_err());
        assert!(open_inbox_item(&fixture.envelope, inbox_id, &fixture.ephemeral).is_err());
    }

    #[test]
    fn rejects_malformed_envelopes_and_payloads() {
        let fixture = fixture();
        let inbox_id = str_field(&fixture, "inboxId");
        let item_id = str_field(&fixture, "itemId");
        let short_nonce = InboxEnvelope {
            nonce: "AAEC".to_owned(),
            ..fixture.envelope.clone()
        };
        assert!(open_inbox_item(&short_nonce, inbox_id, &fixture.recipient).is_err());
        assert!(serde_json::from_value::<InboxEnvelope>(serde_json::json!({
            "v": 1, "id": item_id, "epk": "", "nonce": "", "ct": "", "extra": 1
        }))
        .is_err());

        let recipient_public = public_key_bytes(&fixture.recipient);
        let open_plaintext = |plaintext: &str| {
            let sealed = seal_with(
                plaintext.as_bytes(),
                inbox_id,
                item_id,
                &recipient_public,
                &fixture.ephemeral,
                [7; AES_GCM_NONCE_BYTES],
            );
            open_inbox_item(&sealed, inbox_id, &fixture.recipient)
        };
        let created = r#""createdAt":"2026-10-23T09:30:00.000Z","source":"pwa""#;
        assert_eq!(
            open_plaintext(&format!(r#"{{"v":1,"text":"  a\r\nb  ",{created}}}"#))
                .unwrap()
                .text,
            "a\nb"
        );
        assert!(open_plaintext(&format!(r#"{{"v":1,"text":"   ",{created}}}"#)).is_err());
        let too_long = "字".repeat(INBOX_TEXT_BYTES_LIMIT / 3 + 1);
        assert!(open_plaintext(&format!(r#"{{"v":1,"text":"{too_long}",{created}}}"#)).is_err());
        assert!(open_plaintext(
            r#"{"v":1,"text":"a","createdAt":"2026-10-23T09:30:00.000Z","source":"fax"}"#
        )
        .is_err());
    }

    #[test]
    fn validates_actions_dates_and_projects() {
        let fixture = fixture();
        let inbox_id = str_field(&fixture, "inboxId");
        let item_id = str_field(&fixture, "itemId");
        let recipient_public = public_key_bytes(&fixture.recipient);
        let open = |extra: &str| {
            let plaintext = format!(
                r#"{{"v":1,"text":"a","createdAt":"2026-10-23T09:30:00.000Z","source":"pwa"{extra}}}"#
            );
            let sealed = seal_with(
                plaintext.as_bytes(),
                inbox_id,
                item_id,
                &recipient_public,
                &fixture.ephemeral,
                [8; AES_GCM_NONCE_BYTES],
            );
            open_inbox_item(&sealed, inbox_id, &fixture.recipient)
        };
        let task = r#","taskId":"t1""#;
        let moved = open(&format!(
            r#","action":"reschedule"{task},"date":"2026-10-24""#
        ))
        .unwrap();
        assert_eq!(moved.action, Some(InboxAction::Reschedule));
        assert_eq!(moved.date.as_deref(), Some("2026-10-24"));
        assert_eq!(
            open(&format!(r#","action":"focus"{task}"#)).unwrap().action,
            Some(InboxAction::Focus)
        );
        let added = open(r#","date":"2026-10-25","projectId":"p1""#).unwrap();
        assert_eq!(added.project_id.as_deref(), Some("p1"));
        assert!(open(&format!(r#","action":"reschedule"{task}"#)).is_err());
        assert!(open(&format!(
            r#","action":"complete"{task},"date":"2026-10-24""#
        ))
        .is_err());
        assert!(open(&format!(r#","action":"focus"{task},"projectId":"p1""#)).is_err());
        assert!(open(r#","date":"10/24/2026""#).is_err());
        assert!(open(&format!(r#","action":"delete"{task}"#)).is_err());
    }

    #[test]
    fn validates_ids() {
        assert!(is_inbox_id("AAECAwQFBgcICQoLDA0ODw"));
        assert!(!is_inbox_id("AAECAwQFBgcICQoLDA0OD"));
        assert!(!is_inbox_id("AAECAwQFBgcICQoLDA0OD/"));
        assert!(is_inbox_item_id("11111111-1111-4111-8111-111111111111"));
        assert!(!is_inbox_item_id("11111111-1111-1111-1111-111111111111"));
        assert!(!is_inbox_item_id("11111111-1111-4111-8111-11111111111A"));
    }
}
