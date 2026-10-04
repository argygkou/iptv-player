//! Password storage for saved profiles, keyed by profile id.
//!
//! Windows and macOS use the OS credential store (Windows Credential Manager /
//! Keychain). Linux has no store that works everywhere (WSL usually has no
//! Secret Service running), so it falls back to an owner-only file in the app
//! data directory.

use std::path::Path;

use crate::error::AppResult;

#[cfg(any(target_os = "windows", target_os = "macos"))]
mod imp {
    use super::*;
    use crate::error::AppError;

    const SERVICE: &str = "com.argygkou.iptvplayer";

    fn entry(id: &str) -> AppResult<keyring::Entry> {
        keyring::Entry::new(SERVICE, id).map_err(|e| AppError::Storage(e.to_string()))
    }

    pub fn set(_dir: &Path, id: &str, password: &str) -> AppResult<()> {
        entry(id)?
            .set_password(password)
            .map_err(|e| AppError::Storage(e.to_string()))
    }

    pub fn get(_dir: &Path, id: &str) -> AppResult<Option<String>> {
        match entry(id)?.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AppError::Storage(e.to_string())),
        }
    }

    pub fn delete(_dir: &Path, id: &str) -> AppResult<()> {
        match entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::Storage(e.to_string())),
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod imp {
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::PathBuf;

    use super::*;

    const FILE_NAME: &str = "secrets.json";

    fn path(dir: &Path) -> PathBuf {
        dir.join(FILE_NAME)
    }

    fn read(dir: &Path) -> BTreeMap<String, String> {
        fs::read_to_string(path(dir))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn write(dir: &Path, secrets: &BTreeMap<String, String>) -> AppResult<()> {
        fs::create_dir_all(dir)?;
        let target = path(dir);
        let tmp = target.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec(secrets)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
        }
        fs::rename(&tmp, &target)?;
        Ok(())
    }

    pub fn set(dir: &Path, id: &str, password: &str) -> AppResult<()> {
        let mut secrets = read(dir);
        secrets.insert(id.to_owned(), password.to_owned());
        write(dir, &secrets)
    }

    pub fn get(dir: &Path, id: &str) -> AppResult<Option<String>> {
        Ok(read(dir).remove(id))
    }

    pub fn delete(dir: &Path, id: &str) -> AppResult<()> {
        let mut secrets = read(dir);
        if secrets.remove(id).is_some() {
            write(dir, &secrets)?;
        }
        Ok(())
    }
}

pub use imp::{delete, get, set};

#[cfg(all(test, not(any(target_os = "windows", target_os = "macos"))))]
mod tests {
    use super::*;
    use crate::state::random_hex;

    #[test]
    fn file_store_round_trips() {
        let dir = std::env::temp_dir().join(format!("iptv-secrets-{}", random_hex(6)));
        set(&dir, "a", "one").unwrap();
        set(&dir, "b", "two").unwrap();
        delete(&dir, "a").unwrap();

        assert_eq!(get(&dir, "a").unwrap(), None);
        assert_eq!(get(&dir, "b").unwrap().as_deref(), Some("two"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join("secrets.json"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }
}
