use crate::error::NativeError;

fn validate_web_url(value: &str) -> Result<url::Url, NativeError> {
    let url = url::Url::parse(value).map_err(|_| NativeError::InvalidRequest)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(NativeError::InvalidRequest);
    }
    Ok(url)
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), NativeError> {
    let url = validate_web_url(&url)?;
    open::that_detached(url.as_str()).map_err(|_| NativeError::Io)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_links_preserve_queries_and_fragments() {
        for value in [
            "https://example.com/page?q=hello%20world&n=2#section",
            "http://localhost:5174/notes",
        ] {
            assert_eq!(validate_web_url(value).unwrap().as_str(), value);
        }
    }

    #[test]
    fn non_web_targets_and_embedded_credentials_are_rejected() {
        for value in [
            "javascript:alert(1)",
            "data:text/html,test",
            "file:///C:/Windows/notepad.exe",
            "ms-settings:display",
            "mailto:test@example.com",
            "//example.com",
            "notes.md",
            "https://user:password@example.com/",
            "",
        ] {
            assert!(validate_web_url(value).is_err());
        }
    }
}
