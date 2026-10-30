//! Category and stream lists, cached per account so the app shows them at once
//! on launch.
//!
//! Xtream Codes offers no change detection (no ETag, Last-Modified or "changed
//! since" call), so lists are refreshed on a timer: a cached list is always
//! served, flagged `stale` once it is older than its kind's [`List::max_age`],
//! and the frontend then asks for a [`CatalogueStore::refresh`] in the
//! background. The provider's response is kept byte for byte in
//! `catalogue/<account key>/<list>.json` and handed to the webview without
//! being parsed into a tree.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use crate::error::{AppError, AppResult};
use crate::xtream::{self, Action, Credentials, Query};

const DIR_NAME: &str = "catalogue";
const HOUR: u64 = 60 * 60;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum List {
    LiveCategories,
    LiveStreams,
    VodCategories,
    VodStreams,
    SeriesCategories,
    Series,
}

impl List {
    fn action(self) -> Action {
        match self {
            Self::LiveCategories => Action::GetLiveCategories,
            Self::LiveStreams => Action::GetLiveStreams,
            Self::VodCategories => Action::GetVodCategories,
            Self::VodStreams => Action::GetVodStreams,
            Self::SeriesCategories => Action::GetSeriesCategories,
            Self::Series => Action::GetSeries,
        }
    }

    fn file_name(self) -> &'static str {
        match self {
            Self::LiveCategories => "live_categories.json",
            Self::LiveStreams => "live_streams.json",
            Self::VodCategories => "vod_categories.json",
            Self::VodStreams => "vod_streams.json",
            Self::SeriesCategories => "series_categories.json",
            Self::Series => "series.json",
        }
    }

    /// Channels move around more often than movies and series are added.
    fn max_age(self) -> Duration {
        Duration::from_secs(match self {
            Self::LiveCategories | Self::LiveStreams => 6 * HOUR,
            _ => 24 * HOUR,
        })
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// When the list was downloaded, in Unix seconds.
    pub updated_at: u64,
    /// Older than the list's maximum age; worth a background refresh.
    pub stale: bool,
    /// The provider's JSON array. Left out by a refresh that found no change.
    pub items: Option<Box<RawValue>>,
}

pub struct CatalogueStore {
    dir: PathBuf,
}

impl CatalogueStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            dir: data_dir.join(DIR_NAME),
        }
    }

    /// The cached list, whatever its age, or a fresh download when there is none
    /// or the cached file is unreadable.
    pub async fn get(
        &self,
        http: &reqwest::Client,
        creds: &Credentials,
        list: List,
    ) -> AppResult<Snapshot> {
        let path = self.path(creds, list);
        match read(&path).await {
            Some((items, updated_at)) => Ok(Snapshot {
                updated_at,
                stale: is_stale(list, updated_at),
                items: Some(items),
            }),
            None => {
                let items = download(http, creds, list, &path).await?;
                Ok(Snapshot {
                    updated_at: now(),
                    stale: false,
                    items: Some(items),
                })
            }
        }
    }

    /// Downloads the list again. `items` is left out when it is the same as the
    /// cached one, so the frontend has nothing to re-render. A failed download
    /// keeps the cache.
    pub async fn refresh(
        &self,
        http: &reqwest::Client,
        creds: &Credentials,
        list: List,
    ) -> AppResult<Snapshot> {
        let path = self.path(creds, list);
        let previous = tokio::fs::read(&path).await.ok();
        let body = fetch(http, creds, list).await?;
        if previous.as_deref() == Some(body.get().as_bytes()) {
            // Mark the unchanged list fresh again without rewriting tens of megabytes.
            touch(&path)?;
            return Ok(Snapshot {
                updated_at: now(),
                stale: false,
                items: None,
            });
        }
        persist(&path, body.get()).await?;
        Ok(Snapshot {
            updated_at: now(),
            stale: false,
            items: Some(body),
        })
    }

    /// Drops the lists of a removed profile.
    pub fn delete(&self, server: &str, username: &str) -> AppResult<()> {
        let creds = Credentials::new(server, username, "")?;
        match std::fs::remove_dir_all(self.dir.join(creds.cache_key())) {
            Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err.into()),
            _ => Ok(()),
        }
    }

    fn path(&self, creds: &Credentials, list: List) -> PathBuf {
        self.dir.join(creds.cache_key()).join(list.file_name())
    }
}

/// The list as a JSON array. An object here is the panel's error reply (an
/// expired account answers `{"user_info":{"auth":0}}`), which must not
/// replace a good cache.
fn as_list(body: String) -> AppResult<Box<RawValue>> {
    // Some panels answer an empty body instead of `[]` when a list is empty.
    let body = if body.trim().is_empty() {
        "[]".to_owned()
    } else {
        body
    };
    let raw = RawValue::from_string(body)?;
    if !raw.get().starts_with('[') {
        return Err(AppError::NotAList);
    }
    Ok(raw)
}

async fn fetch(
    http: &reqwest::Client,
    creds: &Credentials,
    list: List,
) -> AppResult<Box<RawValue>> {
    as_list(xtream::fetch(http, creds, list.action(), &Query::default()).await?)
}

async fn download(
    http: &reqwest::Client,
    creds: &Credentials,
    list: List,
    path: &Path,
) -> AppResult<Box<RawValue>> {
    let items = fetch(http, creds, list).await?;
    persist(path, items.get()).await?;
    Ok(items)
}

async fn read(path: &Path) -> Option<(Box<RawValue>, u64)> {
    let updated_at = modified(path)?;
    let body = tokio::fs::read_to_string(path).await.ok()?;
    match as_list(body) {
        Ok(items) => Some((items, updated_at)),
        Err(err) => {
            log::warn!("Ignoring unreadable cached list {}: {err}", path.display());
            None
        }
    }
}

/// Writes next to the target and renames, so a crash never leaves half a list.
async fn persist(path: &Path, body: &str) -> AppResult<()> {
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    // Unique, so a first download and a refresh of the same list cannot share it.
    let tmp = path.with_extension(format!("json.{}.tmp", crate::state::random_hex(4)));
    tokio::fs::write(&tmp, body).await?;
    tokio::fs::rename(&tmp, path).await?;
    Ok(())
}

fn touch(path: &Path) -> AppResult<()> {
    std::fs::File::options()
        .write(true)
        .open(path)?
        .set_modified(SystemTime::now())?;
    Ok(())
}

fn is_stale(list: List, updated_at: u64) -> bool {
    now().saturating_sub(updated_at) >= list.max_age().as_secs()
}

fn modified(path: &Path) -> Option<u64> {
    let time = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(time.duration_since(UNIX_EPOCH).ok()?.as_secs())
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU8, Ordering};

    fn temp_dir() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("catalogue-test-{}", crate::state::random_hex(8)));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn accepts_arrays_only() {
        assert_eq!(as_list(" [1, 2] ".into()).unwrap().get(), "[1, 2]");
        assert_eq!(as_list("  ".into()).unwrap().get(), "[]");
        assert!(as_list(r#"{"user_info":{"auth":0}}"#.into()).is_err());
        assert!(as_list("<html>".into()).is_err());
    }

    #[test]
    fn live_lists_go_stale_sooner() {
        let seven_hours_ago = now() - 7 * HOUR;
        assert!(is_stale(List::LiveStreams, seven_hours_ago));
        assert!(!is_stale(List::VodStreams, seven_hours_ago));
        assert!(!is_stale(List::LiveStreams, now()));
    }

    /// Serves a list from a fake panel: caches it, reports an unchanged list
    /// without items, and keeps the cache when the panel fails.
    #[tokio::test]
    async fn caches_and_refreshes_a_list() {
        use axum::Router;
        use axum::extract::State;
        use axum::http::StatusCode;
        use axum::response::{IntoResponse, Response};
        use axum::routing::get;

        // 0: the first list, 1: a changed list, 2: an error reply, 3: a server error.
        let mode = Arc::new(AtomicU8::new(0));
        let panel = Router::new()
            .route(
                "/player_api.php",
                get(|State(mode): State<Arc<AtomicU8>>| async move {
                    let response: Response = match mode.load(Ordering::SeqCst) {
                        0 => r#"[{"stream_id":1}]"#.into_response(),
                        1 => r#"[{"stream_id":1},{"stream_id":2}]"#.into_response(),
                        2 => r#"{"user_info":{"auth":0}}"#.into_response(),
                        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                    };
                    response
                }),
            )
            .with_state(mode.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, panel).await.unwrap() });

        let dir = temp_dir();
        let store = CatalogueStore::new(&dir);
        let http = reqwest::Client::new();
        let creds = Credentials::new(&format!("127.0.0.1:{port}"), "alice", "secret").unwrap();
        let items = |s: &Snapshot| s.items.as_ref().map(|i| i.get().to_owned());

        let first = store.get(&http, &creds, List::LiveStreams).await.unwrap();
        assert_eq!(items(&first).as_deref(), Some(r#"[{"stream_id":1}]"#));
        assert!(!first.stale);

        // Served from the file even though the panel now fails.
        mode.store(3, Ordering::SeqCst);
        let cached = store.get(&http, &creds, List::LiveStreams).await.unwrap();
        assert_eq!(items(&cached), items(&first));
        assert!(
            store
                .refresh(&http, &creds, List::LiveStreams)
                .await
                .is_err()
        );
        mode.store(2, Ordering::SeqCst);
        assert!(
            store
                .refresh(&http, &creds, List::LiveStreams)
                .await
                .is_err()
        );

        mode.store(0, Ordering::SeqCst);
        let same = store
            .refresh(&http, &creds, List::LiveStreams)
            .await
            .unwrap();
        assert!(same.items.is_none());
        // An unchanged list is marked fresh again.
        let path = store.path(&creds, List::LiveStreams);
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(7 * HOUR))
            .unwrap();
        assert!(
            store
                .get(&http, &creds, List::LiveStreams)
                .await
                .unwrap()
                .stale
        );
        store
            .refresh(&http, &creds, List::LiveStreams)
            .await
            .unwrap();
        assert!(
            !store
                .get(&http, &creds, List::LiveStreams)
                .await
                .unwrap()
                .stale
        );

        mode.store(1, Ordering::SeqCst);
        let changed = store
            .refresh(&http, &creds, List::LiveStreams)
            .await
            .unwrap();
        assert_eq!(
            items(&changed).as_deref(),
            Some(r#"[{"stream_id":1},{"stream_id":2}]"#)
        );
        let reread = store.get(&http, &creds, List::LiveStreams).await.unwrap();
        assert_eq!(items(&reread), items(&changed));

        store.delete(&format!("127.0.0.1:{port}"), "alice").unwrap();
        assert!(!dir.join(DIR_NAME).join(creds.cache_key()).exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
