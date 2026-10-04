//! Saved provider accounts ("profiles").
//!
//! Profiles are stored as JSON in the app data directory without passwords;
//! passwords live in the secret store (see `secrets.rs`). The file holds a list
//! so more than one account can be saved, plus the profile to restore on launch.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::state::random_hex;
use crate::xtream::Credentials;

const FILE_NAME: &str = "profiles.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    /// Display name; defaults to `username@host`.
    pub name: String,
    /// Normalised server URL.
    pub server: String,
    pub username: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfilesFile {
    active_profile_id: Option<String>,
    profiles: Vec<Profile>,
}

pub struct ProfileStore {
    path: PathBuf,
    data: Mutex<ProfilesFile>,
}

impl ProfileStore {
    /// Loads the store from `dir`. A missing or unreadable file starts empty
    /// rather than blocking startup.
    pub fn load(dir: &Path) -> Self {
        let path = dir.join(FILE_NAME);
        let data = fs::read_to_string(&path)
            .ok()
            .and_then(|text| match serde_json::from_str(&text) {
                Ok(data) => Some(data),
                Err(err) => {
                    log::warn!("ignoring unreadable {}: {err}", path.display());
                    None
                }
            })
            .unwrap_or_default();
        Self {
            path,
            data: Mutex::new(data),
        }
    }

    pub fn list(&self) -> Vec<Profile> {
        self.lock().profiles.clone()
    }

    pub fn get(&self, id: &str) -> Option<Profile> {
        self.lock().profiles.iter().find(|p| p.id == id).cloned()
    }

    pub fn active(&self) -> Option<Profile> {
        let data = self.lock();
        let id = data.active_profile_id.as_deref()?;
        data.profiles.iter().find(|p| p.id == id).cloned()
    }

    /// Adds the account, or reuses the existing profile for the same server and
    /// username, and makes it the active one.
    pub fn save_active(&self, creds: &Credentials) -> AppResult<Profile> {
        let mut data = self.lock();
        let server = creds.base.as_str().to_owned();
        let profile = match data
            .profiles
            .iter()
            .find(|p| p.server == server && p.username == creds.username)
        {
            Some(existing) => existing.clone(),
            None => {
                let profile = Profile {
                    id: random_hex(8),
                    name: format!(
                        "{}@{}",
                        creds.username,
                        creds.base.host_str().unwrap_or_default()
                    ),
                    server,
                    username: creds.username.clone(),
                };
                data.profiles.push(profile.clone());
                profile
            }
        };
        data.active_profile_id = Some(profile.id.clone());
        self.persist(&data)?;
        Ok(profile)
    }

    pub fn set_active(&self, id: Option<&str>) -> AppResult<()> {
        let mut data = self.lock();
        if let Some(id) = id
            && !data.profiles.iter().any(|p| p.id == id)
        {
            return Err(AppError::UnknownProfile);
        }
        data.active_profile_id = id.map(str::to_owned);
        self.persist(&data)
    }

    pub fn remove(&self, id: &str) -> AppResult<()> {
        let mut data = self.lock();
        data.profiles.retain(|p| p.id != id);
        if data.active_profile_id.as_deref() == Some(id) {
            data.active_profile_id = None;
        }
        self.persist(&data)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ProfilesFile> {
        self.data
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Writes via a temporary file so a crash mid-write cannot corrupt the store.
    fn persist(&self, data: &ProfilesFile) -> AppResult<()> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(data)?)?;
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("iptv-profiles-{}", random_hex(6)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn saves_and_reloads_the_active_profile() {
        let dir = temp_dir();
        let store = ProfileStore::load(&dir);
        let creds = Credentials::new("tv.example.com:8080", "alice", "pw").unwrap();
        let saved = store.save_active(&creds).unwrap();

        let reloaded = ProfileStore::load(&dir);
        assert_eq!(reloaded.active(), Some(saved.clone()));
        assert_eq!(saved.name, "alice@tv.example.com");
        assert_eq!(saved.server, "http://tv.example.com:8080/");
    }

    #[test]
    fn reuses_the_profile_for_the_same_account() {
        let store = ProfileStore::load(&temp_dir());
        let alice = Credentials::new("tv.example.com", "alice", "pw").unwrap();
        let bob = Credentials::new("tv.example.com", "bob", "pw").unwrap();

        let first = store.save_active(&alice).unwrap();
        store.save_active(&bob).unwrap();
        let again = store.save_active(&alice).unwrap();

        assert_eq!(first.id, again.id);
        assert_eq!(store.list().len(), 2);
        assert_eq!(store.active().unwrap().username, "alice");
    }

    #[test]
    fn signing_out_keeps_the_profile_but_clears_active() {
        let dir = temp_dir();
        let store = ProfileStore::load(&dir);
        let creds = Credentials::new("tv.example.com", "alice", "pw").unwrap();
        let profile = store.save_active(&creds).unwrap();

        store.set_active(None).unwrap();
        assert!(ProfileStore::load(&dir).active().is_none());
        assert_eq!(store.list(), vec![profile.clone()]);

        store.remove(&profile.id).unwrap();
        assert!(ProfileStore::load(&dir).list().is_empty());
    }

    #[test]
    fn corrupt_file_starts_empty() {
        let dir = temp_dir();
        fs::write(dir.join(FILE_NAME), "{not json").unwrap();
        assert!(ProfileStore::load(&dir).list().is_empty());
    }
}
