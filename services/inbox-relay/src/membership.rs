//! Who may use the phone "today" list: Skool paid members, read from the same
//! Google Sheet the member data site uses, plus emails granted by hand.
//! Verification codes go out through Resend.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::rand::SystemRandom;
use ring::signature::{RSA_PKCS1_SHA256, RsaKeyPair};
use serde::Deserialize;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unavailable;

/// Answers whether an email belongs to an active paid member.
pub trait Directory: Send + Sync {
    fn is_member<'a>(&'a self, email: &'a str) -> BoxFuture<'a, Result<bool, Unavailable>>;
}

pub trait Mailer: Send + Sync {
    fn send_code<'a>(
        &'a self,
        email: &'a str,
        code: &'a str,
    ) -> BoxFuture<'a, Result<(), Unavailable>>;
}

/// Used when no member directory is configured: nobody is a member.
pub struct NoDirectory;

impl Directory for NoDirectory {
    fn is_member<'a>(&'a self, _email: &'a str) -> BoxFuture<'a, Result<bool, Unavailable>> {
        Box::pin(async { Err(Unavailable) })
    }
}

pub struct NoMailer;

impl Mailer for NoMailer {
    fn send_code<'a>(
        &'a self,
        _email: &'a str,
        _code: &'a str,
    ) -> BoxFuture<'a, Result<(), Unavailable>> {
        Box::pin(async { Err(Unavailable) })
    }
}

pub fn normalize_email(value: &str) -> Option<String> {
    let email = value.trim().to_lowercase();
    let (local, domain) = email.split_once('@')?;
    let valid = !local.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && email.len() <= 254
        && !email.chars().any(|c| c.is_whitespace() || c.is_control());
    valid.then_some(email)
}

/// Rows with an Email and a Status other than `inactive` or `expired` count
/// as members, the same rule the member data site applies.
pub fn members_from_values(values: &[Vec<String>]) -> Option<HashMap<String, bool>> {
    let (header, rows) = values.split_first()?;
    let column = |name: &str| {
        header
            .iter()
            .position(|cell| cell.trim().eq_ignore_ascii_case(name))
    };
    let email_column = column("email")?;
    let status_column = column("status");
    let members: HashMap<String, bool> = rows
        .iter()
        .filter_map(|row| {
            let email = normalize_email(row.get(email_column)?)?;
            let status = status_column
                .and_then(|index| row.get(index))
                .map(|value| value.trim().to_lowercase())
                .unwrap_or_default();
            Some((email, !matches!(status.as_str(), "inactive" | "expired")))
        })
        .collect();
    // An empty sheet is far more likely a broken sync than zero members.
    (!members.is_empty()).then_some(members)
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

#[derive(Deserialize)]
struct ServiceAccountJson {
    client_email: String,
    private_key: String,
}

const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const SHEETS_SCOPE: &str = "https://www.googleapis.com/auth/spreadsheets.readonly";
const MEMBER_CACHE: Duration = Duration::from_secs(10 * 60);

pub struct SheetDirectory {
    http: reqwest::Client,
    client_email: String,
    key: RsaKeyPair,
    sheet_id: String,
    tab: String,
    token: tokio::sync::Mutex<Option<(Instant, String)>>,
    members: Mutex<Option<(Instant, HashMap<String, bool>)>>,
}

impl SheetDirectory {
    pub fn new(service_account_json: &str, sheet_id: &str, tab: &str) -> Result<Self, String> {
        let account: ServiceAccountJson = serde_json::from_str(service_account_json)
            .map_err(|_| "service account JSON is invalid")?;
        let pem_body: String = account
            .private_key
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect();
        let der = base64::engine::general_purpose::STANDARD
            .decode(pem_body.trim())
            .map_err(|_| "service account key is not PEM")?;
        let key =
            RsaKeyPair::from_pkcs8(&der).map_err(|_| "service account key is not PKCS#8 RSA")?;
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|_| "HTTP client")?;
        Ok(Self {
            http,
            client_email: account.client_email,
            key,
            sheet_id: sheet_id.to_owned(),
            tab: tab.to_owned(),
            token: tokio::sync::Mutex::new(None),
            members: Mutex::new(None),
        })
    }

    fn assertion(&self, now: i64) -> Result<String, Unavailable> {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
        let claims = URL_SAFE_NO_PAD.encode(
            serde_json::json!({
                "iss": self.client_email,
                "scope": SHEETS_SCOPE,
                "aud": TOKEN_URL,
                "iat": now,
                "exp": now + 3600,
            })
            .to_string(),
        );
        let message = format!("{header}.{claims}");
        let mut signature = vec![0; self.key.public().modulus_len()];
        self.key
            .sign(
                &RSA_PKCS1_SHA256,
                &SystemRandom::new(),
                message.as_bytes(),
                &mut signature,
            )
            .map_err(|_| Unavailable)?;
        Ok(format!("{message}.{}", URL_SAFE_NO_PAD.encode(signature)))
    }

    async fn access_token(&self) -> Result<String, Unavailable> {
        let mut cached = self.token.lock().await;
        if let Some((expires, token)) = cached.as_ref()
            && Instant::now() < *expires
        {
            return Ok(token.clone());
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| Unavailable)?
            .as_secs() as i64;
        let body = format!(
            "grant_type={}&assertion={}",
            percent_encode("urn:ietf:params:oauth:grant-type:jwt-bearer"),
            self.assertion(now)?
        );
        #[derive(Deserialize)]
        struct TokenResponse {
            access_token: String,
            expires_in: u64,
        }
        let response = self
            .http
            .post(TOKEN_URL)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            .map_err(|_| Unavailable)?;
        if !response.status().is_success() {
            return Err(Unavailable);
        }
        let token: TokenResponse =
            serde_json::from_slice(&response.bytes().await.map_err(|_| Unavailable)?)
                .map_err(|_| Unavailable)?;
        let lifetime = Duration::from_secs(token.expires_in.saturating_sub(120));
        *cached = Some((Instant::now() + lifetime, token.access_token.clone()));
        Ok(token.access_token)
    }

    async fn fetch_members(&self) -> Result<HashMap<String, bool>, Unavailable> {
        let range = percent_encode(&format!("'{}'!A:Z", self.tab.replace('\'', "''")));
        let url = format!(
            "https://sheets.googleapis.com/v4/spreadsheets/{}/values/{range}?majorDimension=ROWS",
            percent_encode(&self.sheet_id)
        );
        let response = self
            .http
            .get(url)
            .bearer_auth(self.access_token().await?)
            .send()
            .await
            .map_err(|_| Unavailable)?;
        if !response.status().is_success() {
            return Err(Unavailable);
        }
        #[derive(Deserialize)]
        struct Values {
            #[serde(default)]
            values: Vec<Vec<String>>,
        }
        let values: Values =
            serde_json::from_slice(&response.bytes().await.map_err(|_| Unavailable)?)
                .map_err(|_| Unavailable)?;
        members_from_values(&values.values).ok_or(Unavailable)
    }
}

impl Directory for SheetDirectory {
    fn is_member<'a>(&'a self, email: &'a str) -> BoxFuture<'a, Result<bool, Unavailable>> {
        Box::pin(async move {
            let cached = self
                .members
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .as_ref()
                .filter(|(at, _)| at.elapsed() < MEMBER_CACHE)
                .map(|(_, members)| members.get(email).copied().unwrap_or(false));
            if let Some(answer) = cached {
                return Ok(answer);
            }
            let members = self.fetch_members().await?;
            let answer = members.get(email).copied().unwrap_or(false);
            *self
                .members
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((Instant::now(), members));
            Ok(answer)
        })
    }
}

pub struct ResendMailer {
    http: reqwest::Client,
    api_key: String,
    from: String,
}

impl ResendMailer {
    pub fn new(api_key: &str, from: &str) -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|_| "HTTP client")?;
        Ok(Self {
            http,
            api_key: api_key.to_owned(),
            from: from.to_owned(),
        })
    }
}

impl Mailer for ResendMailer {
    fn send_code<'a>(
        &'a self,
        email: &'a str,
        code: &'a str,
    ) -> BoxFuture<'a, Result<(), Unavailable>> {
        Box::pin(async move {
            let body = serde_json::json!({
                "from": self.from,
                "to": [email],
                "subject": format!("第二大腦驗證碼 {code}"),
                "text": format!(
                    "你的驗證碼是 {code}，10 分鐘內有效。\n\n\
                     在第二大腦電腦版輸入這組驗證碼，就能開通手機今天清單。\n\
                     如果不是你本人操作，請忽略這封信。"
                ),
            });
            let response = self
                .http
                .post("https://api.resend.com/emails")
                .bearer_auth(&self.api_key)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn row(cells: &[&str]) -> Vec<String> {
        cells.iter().map(|cell| (*cell).to_owned()).collect()
    }

    #[test]
    fn sheet_rows_follow_the_member_site_rules() {
        let values = vec![
            row(&["FirstName", " Email ", "Status"]),
            row(&["A", "Active@Example.com", "active"]),
            row(&["B", "gone@example.com", "inactive"]),
            row(&["C", "late@example.com", "Expired"]),
            row(&["D", "nostatus@example.com"]),
            row(&["E", "not-an-email", "active"]),
        ];
        let members = members_from_values(&values).unwrap();
        assert_eq!(members.get("active@example.com"), Some(&true));
        assert_eq!(members.get("gone@example.com"), Some(&false));
        assert_eq!(members.get("late@example.com"), Some(&false));
        assert_eq!(members.get("nostatus@example.com"), Some(&true));
        assert_eq!(members.len(), 4);
    }

    #[test]
    fn an_empty_or_headerless_sheet_is_unavailable() {
        assert!(members_from_values(&[]).is_none());
        assert!(members_from_values(&[row(&["Email", "Status"])]).is_none());
        assert!(members_from_values(&[row(&["Name"]), row(&["a@b.co"])]).is_none());
    }

    #[test]
    fn emails_are_normalized() {
        assert_eq!(
            normalize_email("  Me@Example.COM "),
            Some("me@example.com".to_owned())
        );
        for bad in [
            "",
            "me",
            "@example.com",
            "me@",
            "me@example",
            "me @example.com",
            "me@.com",
        ] {
            assert_eq!(normalize_email(bad), None, "{bad}");
        }
    }

    #[test]
    fn sheet_ranges_are_percent_encoded() {
        assert_eq!(
            percent_encode("'Members(自動化)'!A:Z"),
            "%27Members%28%E8%87%AA%E5%8B%95%E5%8C%96%29%27%21A%3AZ"
        );
    }
}
