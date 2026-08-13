use crate::atomic_write::sha256_hex;
use crate::canonical::DeviceCanonicalRequest;
use crate::error::NativeError;
use crate::key_store::PublicIdentity;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use reqwest::{header::HeaderMap, redirect::Policy as RedirectPolicy, Client, Method};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;
use uuid::Uuid;

const MAX_REQUEST_BYTES: usize = 4_000_000;
const MAX_RESPONSE_BYTES: u64 = 8_000_000;
const PRIVATE_ORIGIN: Option<&str> = option_env!("SECOND_BRAIN_PUBLISHER_ORIGIN");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublisherHttpRequest {
    pub origin: String,
    pub method: String,
    pub path: String,
    pub body: Option<String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    pub signed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublisherHttpResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: String,
}

#[derive(Debug, Clone)]
pub struct PublisherPolicy {
    private_origin: Option<String>,
    allow_loopback: bool,
}

impl PublisherPolicy {
    pub fn new(private_origin: Option<&str>, allow_loopback: bool) -> Result<Self, NativeError> {
        let private_origin = private_origin.map(validate_private_origin).transpose()?;
        Ok(Self {
            private_origin,
            allow_loopback,
        })
    }

    fn authorize(&self, origin: &str) -> Result<Url, NativeError> {
        let url = Url::parse(origin).map_err(|_| NativeError::PublisherOriginRejected)?;
        if url.as_str().trim_end_matches('/') != origin
            || url.username() != ""
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(NativeError::PublisherOriginRejected);
        }
        let normalized = url.origin().ascii_serialization();
        if self.private_origin.as_deref() == Some(normalized.as_str()) {
            return Ok(url);
        }
        if self.allow_loopback && is_loopback(&url) && url.scheme() == "http" {
            return Ok(url);
        }
        if self.private_origin.is_none() {
            Err(NativeError::PublisherDisabled)
        } else {
            Err(NativeError::PublisherOriginRejected)
        }
    }

    pub fn private_origin(&self) -> Option<String> {
        self.private_origin.clone()
    }

    fn api_url(&self, origin: &str, path: &str) -> Result<Url, NativeError> {
        validate_api_path(path)?;
        let mut url = self.authorize(origin)?;
        url.set_path(path);
        Ok(url)
    }

    fn pairing_url(&self, origin: &str, pairing_id: &str) -> Result<Url, NativeError> {
        let pairing_id = Uuid::parse_str(pairing_id).map_err(|_| NativeError::InvalidRequest)?;
        let mut url = self.authorize(origin)?;
        url.set_path("/devices");
        url.query_pairs_mut()
            .append_pair("pairingId", &pairing_id.to_string());
        Ok(url)
    }
}

fn validate_private_origin(value: &str) -> Result<String, NativeError> {
    let url = Url::parse(value).map_err(|_| NativeError::PublisherOriginRejected)?;
    if url.scheme() != "https"
        || is_loopback(&url)
        || url.username() != ""
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || url.origin().ascii_serialization() != value
    {
        return Err(NativeError::PublisherOriginRejected);
    }
    Ok(value.to_owned())
}

fn is_loopback(url: &Url) -> bool {
    matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    )
}

fn validate_api_path(path: &str) -> Result<(), NativeError> {
    if path.len() > 512
        || !path.starts_with("/api/brain/device/")
        || path
            .bytes()
            .any(|byte| matches!(byte, b'?' | b'#' | b'\\' | b'\r' | b'\n'))
        || path.split('/').any(|part| part == "." || part == "..")
    {
        return Err(NativeError::InvalidRequest);
    }
    Ok(())
}

#[derive(Clone)]
pub struct PublisherTransport {
    policy: PublisherPolicy,
    client: Client,
}

impl PublisherTransport {
    pub fn from_compiled_profile() -> Result<Self, NativeError> {
        Self::new(PublisherPolicy::new(
            PRIVATE_ORIGIN,
            cfg!(debug_assertions),
        )?)
    }

    fn new(policy: PublisherPolicy) -> Result<Self, NativeError> {
        let client = Client::builder()
            .redirect(RedirectPolicy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .user_agent("Second-Brain-Workspace/0.2")
            .build()
            .map_err(|_| NativeError::PublisherTransport)?;
        Ok(Self { policy, client })
    }

    pub fn private_origin(&self) -> Option<String> {
        self.policy.private_origin()
    }

    pub fn pairing_url(&self, origin: &str, pairing_id: &str) -> Result<Url, NativeError> {
        self.policy.pairing_url(origin, pairing_id)
    }

    pub fn canonical_request(
        &self,
        request: &PublisherHttpRequest,
    ) -> Result<DeviceCanonicalRequest, NativeError> {
        validate_request(request)?;
        self.policy.api_url(&request.origin, &request.path)?;
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| NativeError::PublisherTransport)?
            .as_secs() as i64;
        let mut nonce_bytes = [0_u8; 16];
        SystemRandom::new()
            .fill(&mut nonce_bytes)
            .map_err(|_| NativeError::PublisherTransport)?;
        Ok(DeviceCanonicalRequest {
            method: request.method.clone(),
            path: request.path.clone(),
            query: vec![],
            timestamp,
            nonce: URL_SAFE_NO_PAD.encode(nonce_bytes),
            content_type: request
                .body
                .as_ref()
                .map(|_| "application/json")
                .unwrap_or("")
                .to_owned(),
            body_sha256: sha256_hex(request.body.as_deref().unwrap_or("").as_bytes()),
        })
    }

    pub async fn execute(
        &self,
        request: PublisherHttpRequest,
        identity: Option<PublicIdentity>,
        signature: Option<String>,
        canonical: Option<DeviceCanonicalRequest>,
    ) -> Result<PublisherHttpResponse, NativeError> {
        validate_request(&request)?;
        let url = self.policy.api_url(&request.origin, &request.path)?;
        let method = Method::from_bytes(request.method.as_bytes())
            .map_err(|_| NativeError::InvalidRequest)?;
        let mut builder = self.client.request(method, url);
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        if request.signed {
            let canonical = canonical.ok_or(NativeError::KeyStorageUnavailable)?;
            let identity = identity.ok_or(NativeError::KeyStorageUnavailable)?;
            let signature = signature.ok_or(NativeError::KeyStorageUnavailable)?;
            builder = builder
                .header("x-brain-device-id", identity.device_id)
                .header("x-brain-timestamp", canonical.timestamp.to_string())
                .header("x-brain-nonce", canonical.nonce)
                .header("x-brain-signature", signature);
        }
        if let Some(body) = request.body {
            builder = builder
                .header("content-type", "application/json")
                .body(body);
        }
        let response = builder
            .send()
            .await
            .map_err(|_| NativeError::PublisherTransport)?;
        if response
            .content_length()
            .is_some_and(|size| size > MAX_RESPONSE_BYTES)
        {
            return Err(NativeError::LimitExceeded);
        }
        let status = response.status().as_u16();
        let headers = selected_response_headers(response.headers());
        let bytes = response
            .bytes()
            .await
            .map_err(|_| NativeError::PublisherTransport)?;
        if bytes.len() as u64 > MAX_RESPONSE_BYTES {
            return Err(NativeError::LimitExceeded);
        }
        let body =
            String::from_utf8(bytes.to_vec()).map_err(|_| NativeError::PublisherTransport)?;
        Ok(PublisherHttpResponse {
            status,
            headers,
            body,
        })
    }
}

fn validate_request(request: &PublisherHttpRequest) -> Result<(), NativeError> {
    validate_api_path(&request.path)?;
    let pairing_route = matches!(
        request.path.as_str(),
        "/api/brain/device/pair/start" | "/api/brain/device/pair/status"
    );
    if !matches!(request.method.as_str(), "GET" | "POST" | "DELETE")
        || request
            .body
            .as_ref()
            .is_some_and(|body| body.len() > MAX_REQUEST_BYTES)
        || (request.method != "POST" && request.body.is_some())
        || pairing_route == request.signed
    {
        return Err(NativeError::InvalidRequest);
    }
    for (name, value) in &request.headers {
        if !matches!(
            name.to_ascii_lowercase().as_str(),
            "if-none-match" | "idempotency-key"
        ) || value.bytes().any(|byte| matches!(byte, b'\r' | b'\n'))
        {
            return Err(NativeError::InvalidRequest);
        }
    }
    Ok(())
}

fn selected_response_headers(headers: &HeaderMap) -> BTreeMap<String, String> {
    ["etag", "content-type", "retry-after"]
        .into_iter()
        .filter_map(|name| {
            headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(|value| (name.to_owned(), value.to_owned()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_source_policy_cannot_connect_to_remote_https() {
        let policy = PublisherPolicy::new(None, false).unwrap();
        assert!(matches!(
            policy.api_url("https://publisher.example.com", "/api/brain/device/state"),
            Err(NativeError::PublisherDisabled)
        ));
    }

    #[test]
    fn private_policy_allows_only_the_compiled_origin() {
        let policy = PublisherPolicy::new(Some("https://publisher.example.com"), false).unwrap();
        assert!(policy
            .api_url(
                "https://publisher.example.com",
                "/api/brain/device/sync/plan"
            )
            .is_ok());
        assert!(matches!(
            policy.api_url("https://evil.example.com", "/api/brain/device/sync/plan"),
            Err(NativeError::PublisherOriginRejected)
        ));
    }

    #[test]
    fn localhost_http_is_development_only() {
        assert!(PublisherPolicy::new(None, true)
            .unwrap()
            .api_url("http://localhost:3000", "/api/brain/device/state")
            .is_ok());
        assert!(PublisherPolicy::new(None, false)
            .unwrap()
            .api_url("http://localhost:3000", "/api/brain/device/state")
            .is_err());
    }

    #[test]
    fn pairing_page_is_fixed_and_uuid_bound() {
        let policy = PublisherPolicy::new(Some("https://publisher.example.com"), false).unwrap();
        let url = policy
            .pairing_url(
                "https://publisher.example.com",
                "11111111-1111-4111-8111-111111111111",
            )
            .unwrap();
        assert_eq!(
            url.as_str(),
            "https://publisher.example.com/devices?pairingId=11111111-1111-4111-8111-111111111111"
        );
    }

    #[test]
    fn pairing_routes_must_be_unsigned_and_sync_routes_must_be_signed() {
        let base = PublisherHttpRequest {
            origin: "https://publisher.example.com".to_owned(),
            method: "POST".to_owned(),
            path: "/api/brain/device/pair/start".to_owned(),
            body: Some("{}".to_owned()),
            headers: BTreeMap::new(),
            signed: false,
        };
        assert!(validate_request(&base).is_ok());
        assert!(validate_request(&PublisherHttpRequest {
            signed: true,
            ..base.clone()
        })
        .is_err());
        assert!(validate_request(&PublisherHttpRequest {
            path: "/api/brain/device/sync/plan".to_owned(),
            signed: true,
            ..base
        })
        .is_ok());
    }
}
