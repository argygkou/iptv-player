//! The user's own lists: favourites and watch history, with resume positions.
//!
//! Each saved profile has its own file, `library/<profile id>.json` in the app
//! data directory, opened on sign-in. A one-off sign-in (no saved profile) gets
//! an in-memory library that is dropped on sign-out.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const DIR_NAME: &str = "library";
/// Oldest entries beyond this are dropped from the history.
const HISTORY_LIMIT: usize = 200;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ItemKind {
    Live,
    Movie,
    Series,
    Episode,
}

/// Enough about a channel, movie, series or episode to list and open it
/// without asking the provider again.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub kind: ItemKind,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub image: String,
    /// For episodes: the series they belong to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub series_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub series_name: Option<String>,
}

impl Item {
    fn is(&self, kind: ItemKind, id: &str) -> bool {
        self.kind == kind && self.id == id
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Favourite {
    #[serde(flatten)]
    pub item: Item,
    /// Unix time in seconds.
    pub added_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Watched {
    #[serde(flatten)]
    pub item: Item,
    /// Unix time in seconds.
    pub watched_at: u64,
    /// Seconds into the movie or episode; 0 for live channels.
    #[serde(default)]
    pub position: f64,
    /// Length in seconds, when known.
    #[serde(default)]
    pub duration: f64,
}

/// Newest first in both lists.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub favourites: Vec<Favourite>,
    pub history: Vec<Watched>,
}

impl Library {
    fn set_favourite(&mut self, item: Item, favourite: bool, now: u64) {
        let existing = self
            .favourites
            .iter()
            .position(|f| f.item.is(item.kind, &item.id));
        match (existing, favourite) {
            (None, true) => self.favourites.insert(
                0,
                Favourite {
                    item,
                    added_at: now,
                },
            ),
            (Some(index), false) => {
                self.favourites.remove(index);
            }
            // Keep the original position, but pick up a renamed title or new art.
            (Some(index), true) => self.favourites[index].item = item,
            (None, false) => {}
        }
    }

    /// Moves the item to the top of the history. Without a `position`, a saved
    /// one is kept, so reopening a movie does not lose where it was.
    fn record(&mut self, item: Item, position: Option<f64>, duration: Option<f64>, now: u64) {
        let previous = self
            .history
            .iter()
            .position(|w| w.item.is(item.kind, &item.id))
            .map(|index| self.history.remove(index));
        let finite = |value: Option<f64>| value.filter(|v| v.is_finite() && *v >= 0.0);
        self.history.insert(
            0,
            Watched {
                item,
                watched_at: now,
                position: finite(position)
                    .or(previous.as_ref().map(|w| w.position))
                    .unwrap_or_default(),
                duration: finite(duration)
                    .or(previous.as_ref().map(|w| w.duration))
                    .unwrap_or_default(),
            },
        );
        self.history.truncate(HISTORY_LIMIT);
    }

    fn forget(&mut self, kind: ItemKind, id: &str) {
        self.history.retain(|w| !w.item.is(kind, id));
    }
}

struct Open {
    /// `None` for a library that is not saved to disk.
    path: Option<PathBuf>,
    data: Library,
}

pub struct LibraryStore {
    dir: PathBuf,
    open: Mutex<Option<Open>>,
}

impl LibraryStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            dir: data_dir.join(DIR_NAME),
            open: Mutex::new(None),
        }
    }

    fn path(&self, profile_id: &str) -> AppResult<PathBuf> {
        // Profile ids are generated hex, but never let one escape the directory.
        if profile_id.is_empty() || !profile_id.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(AppError::UnknownProfile);
        }
        Ok(self.dir.join(format!("{profile_id}.json")))
    }

    /// Opens the library of the signed-in profile, or an empty in-memory one.
    /// An unreadable file starts empty rather than blocking sign-in.
    pub fn open(&self, profile_id: Option<&str>) -> AppResult<()> {
        let path = profile_id.map(|id| self.path(id)).transpose()?;
        let data = path
            .as_deref()
            .and_then(|path| {
                let text = fs::read_to_string(path).ok()?;
                serde_json::from_str(&text)
                    .inspect_err(|err| log::warn!("ignoring unreadable {}: {err}", path.display()))
                    .ok()
            })
            .unwrap_or_default();
        *self.lock() = Some(Open { path, data });
        Ok(())
    }

    pub fn close(&self) {
        *self.lock() = None;
    }

    /// Deletes a removed profile's library.
    pub fn delete(&self, profile_id: &str) -> AppResult<()> {
        let path = self.path(profile_id)?;
        let mut open = self.lock();
        if open
            .as_ref()
            .is_some_and(|o| o.path.as_ref() == Some(&path))
        {
            *open = None;
        }
        match fs::remove_file(&path) {
            Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err.into()),
            _ => Ok(()),
        }
    }

    pub fn get(&self) -> AppResult<Library> {
        self.update(|_| {})
    }

    pub fn set_favourite(&self, item: Item, favourite: bool) -> AppResult<Library> {
        self.update(|data| data.set_favourite(item, favourite, now()))
    }

    pub fn record(
        &self,
        item: Item,
        position: Option<f64>,
        duration: Option<f64>,
    ) -> AppResult<Library> {
        self.update(|data| data.record(item, position, duration, now()))
    }

    pub fn forget(&self, kind: ItemKind, id: &str) -> AppResult<Library> {
        self.update(|data| data.forget(kind, id))
    }

    /// Applies `change`, saves when something changed, and returns the result.
    fn update(&self, change: impl FnOnce(&mut Library)) -> AppResult<Library> {
        let mut guard = self.lock();
        let open = guard.as_mut().ok_or(AppError::NotSignedIn)?;
        let before = open.data.clone();
        change(&mut open.data);
        if open.data != before
            && let Some(path) = &open.path
        {
            persist(path, &open.data)?;
        }
        Ok(open.data.clone())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Open>> {
        self.open
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// Writes via a temporary file so a crash mid-write cannot corrupt the library.
fn persist(path: &Path, data: &Library) -> AppResult<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec(data)?)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::random_hex;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("iptv-library-{}", random_hex(6)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn item(kind: ItemKind, id: &str) -> Item {
        Item {
            kind,
            id: id.into(),
            name: format!("Item {id}"),
            image: String::new(),
            series_id: None,
            series_name: None,
        }
    }

    #[test]
    fn needs_a_signed_in_session() {
        let store = LibraryStore::new(&temp_dir());
        assert!(matches!(store.get(), Err(AppError::NotSignedIn)));
        store.open(None).unwrap();
        assert_eq!(store.get().unwrap(), Library::default());
        store.close();
        assert!(store.get().is_err());
    }

    #[test]
    fn saves_per_profile() {
        let dir = temp_dir();
        let store = LibraryStore::new(&dir);
        store.open(Some("aa11")).unwrap();
        store
            .set_favourite(item(ItemKind::Live, "1"), true)
            .unwrap();
        store.open(Some("bb22")).unwrap();
        assert!(store.get().unwrap().favourites.is_empty());

        let reloaded = LibraryStore::new(&dir);
        reloaded.open(Some("aa11")).unwrap();
        assert_eq!(reloaded.get().unwrap().favourites[0].item.id, "1");

        reloaded.delete("aa11").unwrap();
        assert!(reloaded.get().is_err());
        reloaded.open(Some("aa11")).unwrap();
        assert!(reloaded.get().unwrap().favourites.is_empty());
    }

    #[test]
    fn rejects_ids_that_are_not_plain_names() {
        let store = LibraryStore::new(&temp_dir());
        assert!(store.open(Some("../profiles")).is_err());
        assert!(store.delete("").is_err());
    }

    #[test]
    fn favourites_are_unique_and_newest_first() {
        let mut library = Library::default();
        library.set_favourite(item(ItemKind::Movie, "1"), true, 1);
        library.set_favourite(item(ItemKind::Live, "1"), true, 2);
        library.set_favourite(item(ItemKind::Movie, "1"), true, 3);
        let keys: Vec<_> = library
            .favourites
            .iter()
            .map(|f| (f.item.kind, f.added_at))
            .collect();
        assert_eq!(keys, [(ItemKind::Live, 2), (ItemKind::Movie, 1)]);

        library.set_favourite(item(ItemKind::Movie, "1"), false, 4);
        assert_eq!(library.favourites.len(), 1);
    }

    #[test]
    fn history_moves_to_the_top_and_keeps_the_position() {
        let mut library = Library::default();
        library.record(item(ItemKind::Movie, "1"), Some(600.0), Some(5400.0), 1);
        library.record(item(ItemKind::Live, "9"), None, None, 2);
        // Reopening the movie without a position yet keeps the saved one.
        library.record(item(ItemKind::Movie, "1"), None, None, 3);

        assert_eq!(library.history.len(), 2);
        let movie = &library.history[0];
        assert_eq!(
            (movie.watched_at, movie.position, movie.duration),
            (3, 600.0, 5400.0)
        );

        library.record(item(ItemKind::Movie, "1"), Some(f64::NAN), Some(5400.0), 4);
        assert_eq!(library.history[0].position, 600.0);

        library.forget(ItemKind::Movie, "1");
        assert_eq!(library.history[0].item.kind, ItemKind::Live);
    }

    #[test]
    fn history_is_capped() {
        let mut library = Library::default();
        for i in 0..HISTORY_LIMIT + 5 {
            library.record(item(ItemKind::Live, &i.to_string()), None, None, i as u64);
        }
        assert_eq!(library.history.len(), HISTORY_LIMIT);
        assert_eq!(library.history[0].item.id, (HISTORY_LIMIT + 4).to_string());
    }

    #[test]
    fn corrupt_file_starts_empty() {
        let dir = temp_dir();
        fs::create_dir_all(dir.join(DIR_NAME)).unwrap();
        fs::write(dir.join(DIR_NAME).join("aa11.json"), "{not json").unwrap();
        let store = LibraryStore::new(&dir);
        store.open(Some("aa11")).unwrap();
        assert_eq!(store.get().unwrap(), Library::default());
    }
}
