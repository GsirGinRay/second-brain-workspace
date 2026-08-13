use crate::atomic_write::{AtomicWriter, WriteOutcome};
use crate::canonical::{public_key_fingerprint, sign_request_with_pkcs8, DeviceCanonicalRequest};
use crate::error::NativeError;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum KeyBackend {
    #[serde(rename = "windows-dpapi-v1")]
    WindowsDpapiV1,
    #[serde(rename = "test-memory-v1")]
    TestMemoryV1,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublicIdentity {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    #[serde(rename = "publicKeyBase64Url")]
    pub public_key_base64_url: String,
    pub fingerprint: String,
    pub backend: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PersistedKey {
    version: u8,
    algorithm: String,
    backend: KeyBackend,
    #[serde(rename = "deviceId")]
    device_id: String,
    #[serde(rename = "publicKeyBase64Url")]
    public_key_base64_url: String,
    fingerprint: String,
    #[serde(rename = "protectedKeyBase64Url")]
    protected_key_base64_url: String,
}

pub struct KeyStore {
    identity: PublicIdentity,
    backend: KeyBackend,
    protected_key: Mutex<Zeroizing<Vec<u8>>>,
    key_path: Option<PathBuf>,
}

impl KeyStore {
    pub fn open(app_data_dir: &Path) -> Result<Self, NativeError> {
        fs::create_dir_all(app_data_dir)?;
        let path = app_data_dir.join("device-key-v1.json");
        if path.exists() {
            if fs::metadata(&path)?.len() > 16 * 1024 {
                return Err(NativeError::KeyStorageUnavailable);
            }
            let persisted: PersistedKey = serde_json::from_slice(&fs::read(&path)?)
                .map_err(|_| NativeError::KeyStorageUnavailable)?;
            if persisted.version != 1
                || persisted.algorithm != "Ed25519"
                || persisted.backend != KeyBackend::WindowsDpapiV1
                || persisted.device_id.is_empty()
                || persisted.device_id.len() > 128
            {
                return Err(NativeError::KeyStorageUnavailable);
            }
            let protected_key = URL_SAFE_NO_PAD
                .decode(persisted.protected_key_base64_url)
                .map_err(|_| NativeError::KeyStorageUnavailable)?;
            let private_key = Zeroizing::new(unprotect_key(&protected_key)?);
            let (public_key_base64_url, fingerprint) = {
                let key = Ed25519KeyPair::from_pkcs8(private_key.as_slice())
                    .map_err(|_| NativeError::KeyStorageUnavailable)?;
                (
                    URL_SAFE_NO_PAD.encode(key.public_key().as_ref()),
                    public_key_fingerprint(key.public_key().as_ref()),
                )
            };
            let metadata_matches = persisted.public_key_base64_url == public_key_base64_url
                && persisted.fingerprint == fingerprint;
            if !metadata_matches {
                return Err(NativeError::KeyStorageUnavailable);
            }
            let identity = PublicIdentity {
                device_id: persisted.device_id,
                public_key_base64_url: persisted.public_key_base64_url,
                fingerprint: persisted.fingerprint,
                backend: "windows-dpapi-v1".to_owned(),
            };
            return Ok(Self {
                identity,
                backend: KeyBackend::WindowsDpapiV1,
                protected_key: Mutex::new(Zeroizing::new(protected_key)),
                key_path: Some(path),
            });
        }

        let rng = SystemRandom::new();
        let generated = Zeroizing::new(
            Ed25519KeyPair::generate_pkcs8(&rng)
                .map_err(|_| NativeError::KeyStorageUnavailable)?
                .as_ref()
                .to_vec(),
        );
        let key = Ed25519KeyPair::from_pkcs8(&generated)
            .map_err(|_| NativeError::KeyStorageUnavailable)?;
        let public_key = key.public_key().as_ref();
        let protected_key = protect_key(&generated)?;
        let identity = PublicIdentity {
            device_id: Uuid::new_v4().to_string(),
            public_key_base64_url: URL_SAFE_NO_PAD.encode(public_key),
            fingerprint: public_key_fingerprint(public_key),
            backend: "windows-dpapi-v1".to_owned(),
        };
        let persisted = PersistedKey {
            version: 1,
            algorithm: "Ed25519".to_owned(),
            backend: KeyBackend::WindowsDpapiV1,
            device_id: identity.device_id.clone(),
            public_key_base64_url: identity.public_key_base64_url.clone(),
            fingerprint: identity.fingerprint.clone(),
            protected_key_base64_url: URL_SAFE_NO_PAD.encode(&protected_key),
        };
        let bytes = serde_json::to_vec_pretty(&persisted)
            .map_err(|_| NativeError::KeyStorageUnavailable)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        use std::io::Write;
        file.write_all(&bytes)?;
        file.sync_all()?;
        Ok(Self {
            identity,
            backend: KeyBackend::WindowsDpapiV1,
            protected_key: Mutex::new(Zeroizing::new(protected_key)),
            key_path: Some(path),
        })
    }

    pub fn create_for_test(_directory: &Path) -> Result<Self, NativeError> {
        let rng = SystemRandom::new();
        let pkcs8 =
            Ed25519KeyPair::generate_pkcs8(&rng).map_err(|_| NativeError::KeyStorageUnavailable)?;
        let key = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref())
            .map_err(|_| NativeError::KeyStorageUnavailable)?;
        let public_key = key.public_key().as_ref();
        Ok(Self {
            identity: PublicIdentity {
                device_id: "test-device".to_owned(),
                public_key_base64_url: URL_SAFE_NO_PAD.encode(public_key),
                fingerprint: public_key_fingerprint(public_key),
                backend: "test-memory-v1".to_owned(),
            },
            backend: KeyBackend::TestMemoryV1,
            protected_key: Mutex::new(Zeroizing::new(pkcs8.as_ref().to_vec())),
            key_path: None,
        })
    }

    pub fn backend(&self) -> KeyBackend {
        self.backend
    }

    pub fn public_identity(&self) -> PublicIdentity {
        self.identity.clone()
    }

    pub fn set_device_id(&mut self, device_id: &str) -> Result<(), NativeError> {
        let canonical = Uuid::parse_str(device_id)
            .map_err(|_| NativeError::InvalidRequest)?
            .to_string();
        if canonical == self.identity.device_id {
            return Ok(());
        }
        if let Some(path) = &self.key_path {
            let original = fs::read(path)?;
            let mut persisted: PersistedKey = serde_json::from_slice(&original)
                .map_err(|_| NativeError::KeyStorageUnavailable)?;
            persisted.device_id = canonical.clone();
            let replacement = serde_json::to_vec_pretty(&persisted)
                .map_err(|_| NativeError::KeyStorageUnavailable)?;
            let journal_dir = path
                .parent()
                .ok_or(NativeError::KeyStorageUnavailable)?
                .join("key-journals");
            let outcome =
                AtomicWriter::new(journal_dir)?.write_bytes(path, &original, &replacement, None)?;
            if outcome == WriteOutcome::CommitUnknown {
                let confirmed: PersistedKey = serde_json::from_slice(&fs::read(path)?)
                    .map_err(|_| NativeError::KeyStorageUnavailable)?;
                if confirmed.device_id != canonical {
                    return Err(NativeError::KeyStorageUnavailable);
                }
            }
        }
        self.identity.device_id = canonical;
        Ok(())
    }

    pub fn sign(&self, request: &DeviceCanonicalRequest) -> Result<String, NativeError> {
        let protected = self
            .protected_key
            .lock()
            .map_err(|_| NativeError::KeyStorageUnavailable)?
            .clone();
        let private_key = Zeroizing::new(match self.backend {
            KeyBackend::TestMemoryV1 => protected.to_vec(),
            KeyBackend::WindowsDpapiV1 => unprotect_key(protected.as_slice())?,
        });
        sign_request_with_pkcs8(private_key.as_slice(), request)
    }
}

#[cfg(windows)]
fn protect_key(value: &[u8]) -> Result<Vec<u8>, NativeError> {
    use std::ptr::null;
    use windows_sys::Win32::Foundation::{GetLastError, LocalFree};
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: value.len() as u32,
        pbData: value.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let result = unsafe {
        CryptProtectData(
            &input,
            null(),
            null(),
            null(),
            null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if result == 0 || output.pbData.is_null() {
        let _ = unsafe { GetLastError() };
        return Err(NativeError::KeyStorageUnavailable);
    }
    let protected =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as *mut std::ffi::c_void);
    }
    Ok(protected)
}

#[cfg(not(windows))]
fn protect_key(_value: &[u8]) -> Result<Vec<u8>, NativeError> {
    Err(NativeError::KeyStorageUnavailable)
}

#[cfg(windows)]
fn unprotect_key(value: &[u8]) -> Result<Vec<u8>, NativeError> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{GetLastError, LocalFree};
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: value.len() as u32,
        pbData: value.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let result = unsafe {
        CryptUnprotectData(
            &input,
            null_mut(),
            null(),
            null(),
            null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if result == 0 || output.pbData.is_null() {
        let _ = unsafe { GetLastError() };
        return Err(NativeError::KeyStorageUnavailable);
    }
    let plain =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as *mut std::ffi::c_void);
    }
    Ok(plain)
}

#[cfg(not(windows))]
fn unprotect_key(_value: &[u8]) -> Result<Vec<u8>, NativeError> {
    Err(NativeError::KeyStorageUnavailable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_completion_replaces_only_the_device_id() {
        let directory = std::env::temp_dir().join(format!("publisher-key-test-{}", Uuid::new_v4()));
        let mut store = KeyStore::create_for_test(&directory).expect("test key");
        let before = store.public_identity();
        let assigned = "11111111-1111-4111-8111-111111111111";

        store.set_device_id(assigned).expect("pairing completion");

        let after = store.public_identity();
        assert_eq!(after.device_id, assigned);
        assert_eq!(after.public_key_base64_url, before.public_key_base64_url);
        assert_eq!(after.fingerprint, before.fingerprint);
    }
}
