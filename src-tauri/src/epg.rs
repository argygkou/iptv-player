//! The full TV guide from the provider's XMLTV export (`xmltv.php`).
//!
//! `get_short_epg` only covers a few upcoming programmes per channel and costs
//! one request per channel. The XMLTV file covers every channel, usually from a
//! few days back (catch-up) to a week ahead, in one download. It can be tens of
//! megabytes, so it is streamed to `epg/<account key>.xml` in the app data
//! directory, kept for [`MAX_AGE`], and parsed into memory for the account that
//! is signed in.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use quick_xml::Reader;
use quick_xml::XmlVersion;
use quick_xml::escape::resolve_html5_entity;
use quick_xml::events::{BytesStart, Event};
use serde::Serialize;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use crate::error::{AppError, AppResult};
use crate::xtream::Credentials;

const DIR_NAME: &str = "epg";
/// How long a downloaded guide is used before it is fetched again.
const MAX_AGE: Duration = Duration::from_secs(12 * 60 * 60);
/// The export is large and some panels build it on request.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// How long a failed download is not retried, unless the user asks.
const RETRY_AFTER: Duration = Duration::from_secs(15 * 60);
/// Ill-formed bits skipped before a file counts as not XMLTV at all.
const MAX_SKIPPED: usize = 10_000;
/// Used when a programme has no `stop` and is the channel's last one.
const DEFAULT_LENGTH: i64 = 30 * 60;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Programme {
    /// Unix time in seconds.
    pub start: i64,
    pub end: i64,
    pub title: String,
    pub description: String,
}

/// Programmes by lowercased XMLTV channel id, each list sorted by start.
pub type Channels = HashMap<String, Vec<Programme>>;

pub struct Guide {
    key: String,
    /// When the file was downloaded, in Unix seconds.
    pub updated_at: u64,
    /// When a download was last tried, in Unix seconds.
    checked_at: u64,
    pub channels: Channels,
}

impl Guide {
    /// The programmes of `channel` that overlap `from..to`.
    pub fn between(&self, channel: &str, from: i64, to: i64) -> Vec<Programme> {
        self.channels
            .get(&channel.to_lowercase())
            .map(|list| {
                list.iter()
                    .filter(|p| p.end > from && p.start < to)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// Holds the parsed guide of the signed-in account. Loads are serialised, so
/// concurrent requests wait for one download; reading the loaded guide and
/// signing out never wait for a download.
pub struct EpgStore {
    dir: PathBuf,
    current: std::sync::Mutex<Option<Arc<Guide>>>,
    loading: Mutex<()>,
    /// Bumped on sign-out, so a download that finishes afterwards is dropped.
    generation: AtomicU64,
    /// The account whose download last failed with no cache to fall back to, and when.
    failed: std::sync::Mutex<Option<(String, u64)>>,
}

impl EpgStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            dir: data_dir.join(DIR_NAME),
            current: std::sync::Mutex::new(None),
            loading: Mutex::new(()),
            generation: AtomicU64::new(0),
            failed: std::sync::Mutex::new(None),
        }
    }

    /// The account's guide: from memory, from the cached file, or downloaded
    /// when the cache is missing or older than [`MAX_AGE`]. With `refresh`, it
    /// is always downloaded. A failed download falls back to an older file and
    /// is not retried for [`RETRY_AFTER`] unless refreshed.
    pub async fn guide(
        &self,
        http: &reqwest::Client,
        creds: &Credentials,
        refresh: bool,
    ) -> AppResult<Arc<Guide>> {
        let key = cache_key(creds);
        let generation = self.generation.load(Ordering::SeqCst);
        if let Some(guide) = self.usable(&key, refresh)? {
            return Ok(guide);
        }
        let _loading = self.loading.lock().await;
        // Another request may have loaded it while this one waited.
        if let Some(guide) = self.usable(&key, refresh)? {
            return Ok(guide);
        }

        let path = self.path(&key);
        let cached = modified(&path);
        let loaded = match cached {
            Some(time) if !refresh && is_fresh(time) => {
                Some((parse_in_background(path.clone()).await, time))
            }
            _ => None,
        };
        let (channels, updated_at) = match loaded {
            Some((Ok(channels), time)) => (channels, time),
            // A fresh cache that no longer parses is downloaded again.
            _ => match download(http, creds, &path).await {
                Ok(channels) => (channels, now()),
                Err(err) => {
                    let fallback = match cached {
                        Some(time) => parse_in_background(path).await.ok().map(|c| (c, time)),
                        None => None,
                    };
                    match fallback {
                        Some(found) => {
                            log::warn!("TV guide download failed, using the cached one: {err}");
                            found
                        }
                        None => {
                            *lock(&self.failed) = Some((key, now()));
                            return Err(err);
                        }
                    }
                }
            },
        };
        let guide = Arc::new(Guide {
            key,
            updated_at,
            checked_at: now(),
            channels,
        });
        if self.generation.load(Ordering::SeqCst) == generation {
            *lock(&self.current) = Some(guide.clone());
            *lock(&self.failed) = None;
        }
        Ok(guide)
    }

    /// The loaded guide if it can be used as is. A stale guide is kept for a
    /// while after a failed download rather than retried on every request.
    fn usable(&self, key: &str, refresh: bool) -> AppResult<Option<Arc<Guide>>> {
        if refresh {
            return Ok(None);
        }
        if let Some((failed_key, at)) = lock(&self.failed).as_ref()
            && failed_key == key
            && now().saturating_sub(*at) < RETRY_AFTER.as_secs()
        {
            return Err(AppError::Epg(
                "the provider's guide could not be downloaded; try again later".into(),
            ));
        }
        Ok(lock(&self.current).as_ref().and_then(|guide| {
            let recent = now().saturating_sub(guide.checked_at) < RETRY_AFTER.as_secs();
            (guide.key == key && (is_fresh(guide.updated_at) || recent)).then(|| guide.clone())
        }))
    }

    /// Frees the parsed guide, on sign-out, without waiting for a download.
    pub fn close(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        *lock(&self.current) = None;
        *lock(&self.failed) = None;
    }

    /// Deletes the cached file of a removed profile.
    pub fn delete(&self, server: &str, username: &str) -> AppResult<()> {
        let creds = Credentials::new(server, username, "")?;
        match fs::remove_file(self.path(&cache_key(&creds))) {
            Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err.into()),
            _ => Ok(()),
        }
    }

    fn path(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{key}.xml"))
    }
}

fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

async fn parse_in_background(path: PathBuf) -> AppResult<Channels> {
    tauri::async_runtime::spawn_blocking(move || parse_file(&path))
        .await
        .map_err(|err| AppError::Epg(err.to_string()))?
}

/// Names the cache file after the account without putting its name on disk.
/// FNV-1a, because it must stay the same across builds.
fn cache_key(creds: &Credentials) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let input = format!("{}\n{}", creds.base, creds.username);
    for byte in input.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

fn is_fresh(updated_at: u64) -> bool {
    now().saturating_sub(updated_at) < MAX_AGE.as_secs()
}

fn modified(path: &Path) -> Option<u64> {
    let time = fs::metadata(path).ok()?.modified().ok()?;
    Some(time.duration_since(UNIX_EPOCH).ok()?.as_secs())
}

/// Streams the export to a temporary file and only moves it into place once
/// it parses into at least one programme, so an error page or a cut-off
/// download never replaces a good cache.
async fn download(http: &reqwest::Client, creds: &Credentials, path: &Path) -> AppResult<Channels> {
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let tmp = path.with_extension("xml.tmp");
    let result = async {
        let response = http
            .get(creds.xmltv_url())
            .timeout(DOWNLOAD_TIMEOUT)
            .send()
            .await?
            .error_for_status()?;
        let mut file = tokio::fs::File::create(&tmp).await?;
        let mut body = response.bytes_stream();
        while let Some(chunk) = body.next().await {
            file.write_all(&chunk?).await?;
        }
        file.flush().await?;
        drop(file);
        let channels = parse_in_background(tmp.clone()).await?;
        if channels.is_empty() {
            return Err(AppError::Epg(
                "the provider's guide lists no programmes".into(),
            ));
        }
        tokio::fs::rename(&tmp, path).await?;
        Ok(channels)
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    result
}

/// Some panels serve the export gzipped without saying so in the headers.
fn parse_file(path: &Path) -> AppResult<Channels> {
    let mut file = BufReader::new(File::open(path)?);
    let gzipped = file.fill_buf()?.starts_with(&[0x1f, 0x8b]);
    if gzipped {
        parse(BufReader::new(flate2::read::GzDecoder::new(file)))
    } else {
        parse(file)
    }
}

/// Which text element of a programme is being read.
#[derive(Clone, Copy, PartialEq)]
enum Field {
    None,
    Title,
    Description,
}

struct Pending {
    channel: String,
    start: i64,
    end: Option<i64>,
    title: Option<String>,
    description: Option<String>,
}

/// Reads `<programme>` elements; channels are matched by id, so `<channel>`
/// elements are skipped. Programmes with an unreadable `start` are dropped.
pub fn parse<R: BufRead>(input: R) -> AppResult<Channels> {
    let mut reader = Reader::from_reader(input);
    let mut buf = Vec::new();
    let mut parsed: HashMap<String, Vec<Pending>> = HashMap::new();
    let mut pending: Option<Pending> = None;
    let mut field = Field::None;
    let mut text = String::new();
    let mut skipped = 0;

    loop {
        let event = match reader.read_event_into(&mut buf) {
            Ok(event) => event,
            // Panels often leave a bare `&` in titles; skip the bad bit and go on.
            Err(quick_xml::Error::IllFormed(err)) if skipped < MAX_SKIPPED => {
                skipped += 1;
                log::debug!("skipping ill-formed XMLTV: {err}");
                buf.clear();
                continue;
            }
            Err(err) => return Err(AppError::Epg(format!("unreadable XMLTV: {err}"))),
        };
        match event {
            Event::Start(e) => match e.local_name().as_ref() {
                "programme" => pending = start_programme(&e),
                "title" | "desc" if pending.is_some() => {
                    field = if e.local_name().as_ref() == "title" {
                        Field::Title
                    } else {
                        Field::Description
                    };
                    text.clear();
                }
                _ => {}
            },
            Event::Text(e) if field != Field::None => text.push_str(&e.xml10_content()),
            Event::CData(e) if field != Field::None => text.push_str(&e.xml10_content()),
            Event::GeneralRef(e) if field != Field::None => {
                if let Ok(Some(ch)) = e.resolve_char_ref() {
                    text.push(ch);
                } else if let Some(value) = resolve_html5_entity(&e.xml10_content()) {
                    text.push_str(value);
                }
            }
            Event::End(e) => match e.local_name().as_ref() {
                "title" | "desc" if field != Field::None => {
                    if let Some(p) = pending.as_mut() {
                        // Keep the first one; others are usually translations.
                        let slot = match field {
                            Field::Title => &mut p.title,
                            _ => &mut p.description,
                        };
                        if slot.is_none() {
                            *slot = Some(text.trim().to_owned());
                        }
                    }
                    field = Field::None;
                }
                "programme" => {
                    if let Some(mut p) = pending.take() {
                        parsed
                            .entry(std::mem::take(&mut p.channel))
                            .or_default()
                            .push(p);
                    }
                    field = Field::None;
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    Ok(parsed
        .into_iter()
        .map(|(channel, mut list)| {
            list.sort_by_key(|p| p.start);
            let starts: Vec<i64> = list.iter().map(|p| p.start).skip(1).collect();
            let programmes = list
                .into_iter()
                .enumerate()
                .map(|(i, p)| Programme {
                    start: p.start,
                    // A missing stop runs until the next programme.
                    end: p
                        .end
                        .or_else(|| starts.get(i).copied())
                        .unwrap_or(p.start + DEFAULT_LENGTH),
                    title: p.title.unwrap_or_default(),
                    description: p.description.unwrap_or_default(),
                })
                .filter(|p| p.end > p.start)
                .collect();
            (channel, programmes)
        })
        .collect())
}

fn start_programme(e: &BytesStart) -> Option<Pending> {
    let attr = |name: &str| {
        e.try_get_attribute(name)
            .ok()
            .flatten()
            .and_then(|a| a.normalized_value(XmlVersion::Implicit1_0).ok())
            .map(|v| v.into_owned())
    };
    let channel = attr("channel")?.trim().to_lowercase();
    let start = parse_time(&attr("start")?)?;
    let end = attr("stop").and_then(|stop| parse_time(&stop));
    (!channel.is_empty()).then_some(Pending {
        channel,
        start,
        end,
        title: None,
        description: None,
    })
}

/// Parses an XMLTV time, `YYYYMMDDhhmmss +hhmm`, into Unix seconds. Seconds,
/// minutes and the offset may be left out; without an offset it is UTC.
pub fn parse_time(value: &str) -> Option<i64> {
    let value = value.trim();
    let digits = value.bytes().take_while(u8::is_ascii_digit).count();
    if digits < 8 {
        return None;
    }
    let number = |from: usize, len: usize| -> Option<i64> {
        if from + len <= digits {
            value[from..from + len].parse().ok()
        } else {
            Some(0)
        }
    };
    let (year, month, day) = (number(0, 4)?, number(4, 2)?, number(6, 2)?);
    let (hour, minute, second) = (number(8, 2)?, number(10, 2)?, number(12, 2)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 {
        return None;
    }
    let local = days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second;

    let offset = value[digits..].trim();
    let offset = match offset.as_bytes().first() {
        Some(sign @ (b'+' | b'-')) if offset.len() >= 5 => {
            let hours: i64 = offset[1..3].parse().ok()?;
            let minutes: i64 = offset[3..5].parse().ok()?;
            let seconds = hours * 3600 + minutes * 60;
            if *sign == b'-' { -seconds } else { seconds }
        }
        _ => 0,
    };
    Some(local - offset)
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const SAMPLE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv generator-info-name="panel">
  <channel id="BBC1.uk"><display-name>BBC One</display-name></channel>
  <programme start="20261030200000 +0100" stop="20261030210000 +0100" channel="BBC1.uk">
    <title lang="en">News &amp; Weather</title>
    <title lang="cy">Newyddion</title>
    <desc lang="en"><![CDATA[Headlines]]> &#8211; live</desc>
  </programme>
  <programme start="20261030180000 +0000" channel="bbc1.uk">
    <title>Quiz</title>
  </programme>
  <programme start="20261030180000 +0000" stop="20261030190000 +0000" channel="Other">
    <title>Film</title>
  </programme>
  <programme start="20261030190000 +0000" stop="20261030200000 +0000" channel="Other">
    <title>Tom & Jerry</title>
  </programme>
  <programme start="garbage" stop="20261030190000 +0000" channel="Other">
    <title>Broken</title>
  </programme>
</tv>"#;

    /// 2026-10-30 19:00:00 UTC.
    const SEVEN_PM: i64 = 1_793_386_800;

    #[test]
    fn parses_times_with_offsets() {
        assert_eq!(parse_time("20261030190000 +0000"), Some(SEVEN_PM));
        assert_eq!(parse_time("20261030200000 +0100"), Some(SEVEN_PM));
        assert_eq!(parse_time("20261030140000 -0500"), Some(SEVEN_PM));
        assert_eq!(parse_time("202610301900"), Some(SEVEN_PM));
        assert_eq!(parse_time("19700101000000"), Some(0));
        assert_eq!(parse_time("20240229120000 +0000"), Some(1_709_208_000));
        assert_eq!(parse_time("2026"), None);
        assert_eq!(parse_time("20261332000000"), None);
    }

    #[test]
    fn parses_programmes_by_channel() {
        let channels = parse(SAMPLE.as_bytes()).unwrap();
        assert_eq!(channels.len(), 2);

        let bbc = &channels["bbc1.uk"];
        assert_eq!(bbc.len(), 2);
        // Sorted by start; the stop-less quiz runs until the news.
        assert_eq!(bbc[0].title, "Quiz");
        assert_eq!(bbc[0].end, SEVEN_PM);
        assert_eq!(bbc[1].start, SEVEN_PM);
        assert_eq!(bbc[1].end, SEVEN_PM + 3600);
        assert_eq!(bbc[1].title, "News & Weather");
        assert_eq!(bbc[1].description, "Headlines – live");

        // The bare `&` loses the rest of that title, not the guide.
        assert_eq!(channels["other"].len(), 2);
        assert_eq!(channels["other"][1].title, "Tom");
    }

    #[test]
    fn reads_gzipped_exports() {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(SAMPLE.as_bytes()).unwrap();
        let bytes = encoder.finish().unwrap();
        let dir = std::env::temp_dir().join(format!("iptv-epg-{}", crate::state::random_hex(6)));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("guide.xml");
        fs::write(&path, &bytes).unwrap();
        assert_eq!(parse_file(&path).unwrap()["bbc1.uk"].len(), 2);
    }

    #[test]
    fn selects_programmes_in_a_window() {
        let guide = Guide {
            key: String::new(),
            updated_at: 0,
            checked_at: 0,
            channels: parse(SAMPLE.as_bytes()).unwrap(),
        };
        let titles = |from, to| -> Vec<String> {
            guide
                .between("BBC1.UK", from, to)
                .into_iter()
                .map(|p| p.title)
                .collect()
        };
        assert_eq!(titles(SEVEN_PM, SEVEN_PM + 60), ["News & Weather"]);
        assert_eq!(titles(SEVEN_PM - 60, SEVEN_PM + 60).len(), 2);
        assert!(titles(SEVEN_PM + 7200, SEVEN_PM + 9000).is_empty());
        assert!(guide.between("missing", 0, i64::MAX).is_empty());
    }

    #[test]
    fn cache_key_ignores_the_password() {
        let a = Credentials::new("tv.example.com", "alice", "one").unwrap();
        let b = Credentials::new("http://tv.example.com/", "alice", "two").unwrap();
        let c = Credentials::new("tv.example.com", "bob", "one").unwrap();
        assert_eq!(cache_key(&a), cache_key(&b));
        assert_ne!(cache_key(&a), cache_key(&c));
    }

    /// Serves an export from a fake panel, and keeps the cache when the panel
    /// later fails or answers with something that is not a guide.
    #[tokio::test]
    async fn downloads_and_caches_the_guide() {
        use axum::Router;
        use axum::extract::State;
        use axum::http::StatusCode;
        use axum::routing::get;
        use std::sync::atomic::AtomicU8;

        // 0: the guide, 1: an error status, 2: an HTML page.
        let mode = Arc::new(AtomicU8::new(0));
        let panel = Router::new()
            .route(
                "/xmltv.php",
                get(|State(mode): State<Arc<AtomicU8>>| async move {
                    match mode.load(Ordering::SeqCst) {
                        0 => Ok(SAMPLE),
                        1 => Err(StatusCode::SERVICE_UNAVAILABLE),
                        _ => Ok("<html><body>Maintenance</body></html>"),
                    }
                }),
            )
            .with_state(mode.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, panel).await.unwrap() });

        let dir = std::env::temp_dir().join(format!("iptv-epg-{}", crate::state::random_hex(6)));
        let store = EpgStore::new(&dir);
        let http = reqwest::Client::new();
        let creds = Credentials::new(&addr.to_string(), "user", "secret").unwrap();

        let guide = store.guide(&http, &creds, false).await.unwrap();
        assert_eq!(guide.channels["bbc1.uk"].len(), 2);
        let path = store.path(&cache_key(&creds));
        assert!(path.is_file());

        for failure in [1, 2] {
            mode.store(failure, Ordering::SeqCst);
            let again = store.guide(&http, &creds, true).await.unwrap();
            assert_eq!(again.channels.len(), 2);
            assert_eq!(parse_file(&path).unwrap().len(), 2);
        }

        store.close();
        store.delete(creds.base.as_ref(), "user").unwrap();
        assert!(!path.exists());
    }

    /// A failed first download is not retried on every request, and its error
    /// never carries the password from the URL.
    #[tokio::test]
    async fn remembers_failures_without_leaking_the_password() {
        use axum::Router;
        use axum::http::StatusCode;
        use axum::routing::get;

        let panel = Router::new().route("/xmltv.php", get(|| async { StatusCode::NOT_FOUND }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, panel).await.unwrap() });

        let dir = std::env::temp_dir().join(format!("iptv-epg-{}", crate::state::random_hex(6)));
        let store = EpgStore::new(&dir);
        let http = reqwest::Client::new();
        let creds = Credentials::new(&addr.to_string(), "user", "hunter2").unwrap();

        let first = store.guide(&http, &creds, false).await.err().unwrap();
        assert!(!first.to_string().contains("hunter2"), "{first}");
        let second = store.guide(&http, &creds, false).await.err().unwrap();
        assert!(second.to_string().contains("try again later"), "{second}");
    }
}
