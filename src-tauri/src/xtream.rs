//! Thin client for the Xtream Codes `player_api.php` API.
//!
//! Requests go through Rust rather than the webview so they are not subject to
//! CORS or mixed-content rules, and so credentials never leave the backend.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

use crate::error::{AppError, AppResult};

/// Applies to API calls only; streams are long-lived and must not time out.
const API_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub struct Credentials {
    pub base: Url,
    pub username: String,
    pub password: String,
}

impl Credentials {
    pub fn new(server: &str, username: &str, password: &str) -> AppResult<Self> {
        Ok(Self {
            base: normalize_server(server)?,
            username: username.trim().to_owned(),
            password: password.to_owned(),
        })
    }

    fn api_url(&self) -> Url {
        let mut url = self.base.join("player_api.php").expect("static path");
        url.query_pairs_mut()
            .append_pair("username", &self.username)
            .append_pair("password", &self.password);
        url
    }

    /// Direct upstream URL for a playable stream. Only ever used by the local proxy.
    pub fn stream_url(&self, kind: StreamKind, id: &str, ext: &str) -> Url {
        let path = format!(
            "{}/{}/{}/{}.{}",
            kind.path(),
            urlencode(&self.username),
            urlencode(&self.password),
            id,
            ext
        );
        self.base.join(&path).expect("validated segments")
    }
}

/// Accepts `host:port`, `http://host:port`, or a pasted `.../player_api.php?...` URL.
pub fn normalize_server(input: &str) -> AppResult<Url> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidServer("empty".into()));
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_owned()
    } else {
        format!("http://{trimmed}")
    };
    let mut url = Url::parse(&with_scheme).map_err(|e| AppError::InvalidServer(e.to_string()))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(AppError::InvalidServer(trimmed.into()));
    }
    url.set_query(None);
    url.set_fragment(None);
    // Keep any sub-path the provider lives under, minus a pasted endpoint file.
    let path = url.path().trim_end_matches('/').to_owned();
    let path = path
        .strip_suffix("/player_api.php")
        .or_else(|| path.strip_suffix("/get.php"))
        .unwrap_or(&path)
        .to_owned();
    url.set_path(&format!("{path}/"));
    Ok(url)
}

fn urlencode(segment: &str) -> String {
    url::form_urlencoded::byte_serialize(segment.as_bytes()).collect()
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StreamKind {
    Live,
    Movie,
    Series,
}

impl StreamKind {
    pub fn path(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::Movie => "movie",
            Self::Series => "series",
        }
    }

    pub fn from_path(path: &str) -> Option<Self> {
        match path {
            "live" => Some(Self::Live),
            "movie" => Some(Self::Movie),
            "series" => Some(Self::Series),
            _ => None,
        }
    }
}

/// The subset of `player_api.php` actions the app uses. Anything else is rejected.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
#[allow(clippy::enum_variant_names)] // Mirrors the API's own action names.
pub enum Action {
    GetLiveCategories,
    GetVodCategories,
    GetSeriesCategories,
    GetLiveStreams,
    GetVodStreams,
    GetSeries,
    GetVodInfo,
    GetSeriesInfo,
    GetShortEpg,
    GetSimpleDataTable,
}

impl Action {
    fn as_str(self) -> &'static str {
        match self {
            Self::GetLiveCategories => "get_live_categories",
            Self::GetVodCategories => "get_vod_categories",
            Self::GetSeriesCategories => "get_series_categories",
            Self::GetLiveStreams => "get_live_streams",
            Self::GetVodStreams => "get_vod_streams",
            Self::GetSeries => "get_series",
            Self::GetVodInfo => "get_vod_info",
            Self::GetSeriesInfo => "get_series_info",
            Self::GetShortEpg => "get_short_epg",
            Self::GetSimpleDataTable => "get_simple_data_table",
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    pub category_id: Option<String>,
    pub stream_id: Option<String>,
    pub vod_id: Option<String>,
    pub series_id: Option<String>,
    pub limit: Option<u32>,
}

pub async fn authenticate(http: &reqwest::Client, creds: &Credentials) -> AppResult<Value> {
    let body: Value = http
        .get(creds.api_url())
        .timeout(API_TIMEOUT)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let authorized = body
        .pointer("/user_info/auth")
        .map(|v| v.as_i64() == Some(1) || v.as_str() == Some("1"))
        .unwrap_or(false);
    if !authorized {
        return Err(AppError::AuthFailed);
    }
    Ok(body)
}

pub async fn call(
    http: &reqwest::Client,
    creds: &Credentials,
    action: Action,
    query: &Query,
) -> AppResult<Value> {
    let mut url = creds.api_url();
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("action", action.as_str());
        let ids = [
            ("category_id", &query.category_id),
            ("stream_id", &query.stream_id),
            ("vod_id", &query.vod_id),
            ("series_id", &query.series_id),
        ];
        for (key, value) in ids {
            if let Some(value) = value {
                pairs.append_pair(key, value);
            }
        }
        if let Some(limit) = query.limit {
            pairs.append_pair("limit", &limit.to_string());
        }
    }
    let text = http
        .get(url)
        .timeout(API_TIMEOUT)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    // Some panels answer an empty body instead of `[]` when a category is empty.
    if text.trim().is_empty() {
        return Ok(Value::Array(Vec::new()));
    }
    Ok(serde_json::from_str(&text)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_bare_host() {
        let url = normalize_server("example.com:8080").unwrap();
        assert_eq!(url.as_str(), "http://example.com:8080/");
    }

    #[test]
    fn strips_pasted_api_url() {
        let url = normalize_server("https://tv.example.com/player_api.php?username=a&password=b")
            .unwrap();
        assert_eq!(url.as_str(), "https://tv.example.com/");
    }

    #[test]
    fn keeps_sub_path() {
        let url = normalize_server("http://example.com/panel/").unwrap();
        assert_eq!(url.as_str(), "http://example.com/panel/");
    }

    #[test]
    fn rejects_other_schemes() {
        assert!(normalize_server("ftp://example.com").is_err());
    }

    #[test]
    fn builds_stream_url() {
        let creds = Credentials::new("example.com:8080", "user", "p@ss").unwrap();
        let url = creds.stream_url(StreamKind::Movie, "42", "mkv");
        assert_eq!(
            url.as_str(),
            "http://example.com:8080/movie/user/p%40ss/42.mkv"
        );
    }
}
