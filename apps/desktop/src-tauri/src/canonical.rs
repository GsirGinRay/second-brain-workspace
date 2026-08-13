use crate::error::NativeError;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::signature::{Ed25519KeyPair, UnparsedPublicKey, ED25519};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceCanonicalRequest {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub query: Vec<[String; 2]>,
    pub timestamp: i64,
    pub nonce: String,
    #[serde(rename = "contentType", alias = "content_type", default)]
    pub content_type: String,
    #[serde(rename = "bodySha256", alias = "body_sha256")]
    pub body_sha256: String,
}

fn encode_rfc3986(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        if matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~') {
            result.push(*byte as char);
        } else {
            result.push('%');
            result.push_str(&format!("{:02X}", byte));
        }
    }
    result
}

fn normalize_path(path: &str) -> Result<String, NativeError> {
    let path_only = path.split_once('?').map_or(path, |(path, _)| path);
    if path_only.bytes().any(|byte| byte == b'\r' || byte == b'\n') {
        return Err(NativeError::InvalidRequest);
    }
    if path_only.is_empty() {
        return Ok("/".to_owned());
    }
    if !path_only.starts_with('/') || path_only.contains('\\') {
        return Err(NativeError::InvalidRequest);
    }
    if path_only
        .split('/')
        .any(|segment| segment == "." || segment == "..")
    {
        return Err(NativeError::InvalidRequest);
    }
    Ok(path_only.to_owned())
}

fn normalize_content_type(content_type: &str) -> String {
    content_type
        .split_once(';')
        .map_or(content_type, |(value, _)| value)
        .trim()
        .to_ascii_lowercase()
}

fn canonical_query(query: &[[String; 2]]) -> String {
    let mut encoded = query
        .iter()
        .map(|pair| {
            let key = encode_rfc3986(&pair[0]);
            let value = encode_rfc3986(&pair[1]);
            (key, value)
        })
        .collect::<Vec<_>>();
    encoded.sort_by(|left, right| {
        format!("{}\0{}", left.0, left.1).cmp(&format!("{}\0{}", right.0, right.1))
    });
    encoded
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&")
}

pub fn canonicalize_request(request: &DeviceCanonicalRequest) -> Result<String, NativeError> {
    if request.timestamp < 0 || request.timestamp > 9_007_199_254_740_991 {
        return Err(NativeError::InvalidRequest);
    }
    let method = request.method.trim().to_ascii_uppercase();
    if method.is_empty() || !method.bytes().all(|byte| byte.is_ascii_uppercase()) {
        return Err(NativeError::InvalidRequest);
    }
    let nonce_bytes = URL_SAFE_NO_PAD
        .decode(&request.nonce)
        .map_err(|_| NativeError::InvalidRequest)?;
    if !(16..=64).contains(&nonce_bytes.len())
        || URL_SAFE_NO_PAD.encode(&nonce_bytes) != request.nonce
    {
        return Err(NativeError::InvalidRequest);
    }
    if request
        .content_type
        .bytes()
        .any(|byte| byte == b'\r' || byte == b'\n')
    {
        return Err(NativeError::InvalidRequest);
    }
    if request.body_sha256.len() != 64
        || !request
            .body_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(NativeError::InvalidRequest);
    }
    Ok([
        "v1".to_owned(),
        method,
        normalize_path(&request.path)?,
        canonical_query(&request.query),
        request.timestamp.to_string(),
        request.nonce.clone(),
        normalize_content_type(&request.content_type),
        request.body_sha256.to_ascii_lowercase(),
    ]
    .join("\n"))
}

pub fn sign_request_with_pkcs8(
    pkcs8: &[u8],
    request: &DeviceCanonicalRequest,
) -> Result<String, NativeError> {
    let canonical = canonicalize_request(request)?;
    let key = Ed25519KeyPair::from_pkcs8(pkcs8).map_err(|_| NativeError::KeyStorageUnavailable)?;
    Ok(URL_SAFE_NO_PAD.encode(key.sign(canonical.as_bytes()).as_ref()))
}

pub fn verify_signature(
    public_key: &[u8],
    signature_base64_url: &str,
    request: &DeviceCanonicalRequest,
) -> Result<(), NativeError> {
    let canonical = canonicalize_request(request)?;
    let signature = URL_SAFE_NO_PAD
        .decode(signature_base64_url)
        .map_err(|_| NativeError::InvalidRequest)?;
    UnparsedPublicKey::new(&ED25519, public_key)
        .verify(canonical.as_bytes(), &signature)
        .map_err(|_| NativeError::InvalidRequest)
}

pub fn public_key_fingerprint(public_key: &[u8]) -> String {
    let digest = Sha256::digest(public_key);
    format!("sha256:{}", hex::encode(digest))
}

#[cfg(test)]
fn pkcs8_from_seed(seed: &[u8]) -> Result<Vec<u8>, NativeError> {
    if seed.len() != 32 {
        return Err(NativeError::InvalidRequest);
    }
    let mut pkcs8 = hex::decode("302e020100300506032b657004220420").unwrap();
    pkcs8.extend_from_slice(seed);
    Ok(pkcs8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_and_signature_match_shared_golden_vector() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../docs/fixtures/canonical-signature-v1.json"
        ))
        .expect("fixture JSON");
        let request = DeviceCanonicalRequest {
            method: fixture["request"]["method"].as_str().unwrap().to_owned(),
            path: fixture["request"]["path"].as_str().unwrap().to_owned(),
            query: vec![],
            timestamp: fixture["request"]["timestamp"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap(),
            nonce: fixture["request"]["nonce"].as_str().unwrap().to_owned(),
            content_type: fixture["request"]["contentType"]
                .as_str()
                .unwrap()
                .to_owned(),
            body_sha256: fixture["request"]["bodySha256"]
                .as_str()
                .unwrap()
                .to_owned(),
        };
        let canonical = canonicalize_request(&request).unwrap();
        assert_eq!(canonical, fixture["canonicalUtf8"]);
        let seed = hex::decode(fixture["testSeedHex"].as_str().unwrap()).unwrap();
        let pkcs8 = pkcs8_from_seed(&seed).unwrap();
        let key = Ed25519KeyPair::from_pkcs8_maybe_unchecked(&pkcs8).unwrap();
        let signature = URL_SAFE_NO_PAD.encode(key.sign(canonical.as_bytes()).as_ref());
        assert_eq!(signature, fixture["signatureBase64Url"]);
    }
}
