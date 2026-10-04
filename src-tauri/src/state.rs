use std::path::PathBuf;
use std::time::Duration;

use rand::Rng;
use tokio::sync::RwLock;

use crate::error::{AppError, AppResult};
use crate::profiles::ProfileStore;
use crate::xtream::Credentials;

/// Many panels only serve known player user agents, so identify as a common one.
const USER_AGENT: &str = "VLC/3.0.20 LibVLC/3.0.20";

pub struct AppState {
    pub http: reqwest::Client,
    pub session: RwLock<Option<Credentials>>,
    pub profiles: ProfileStore,
    /// App data directory; holds profiles and, on Linux, the secrets file.
    pub data_dir: PathBuf,
    pub proxy_port: u16,
    /// Required on every proxy request so other local processes or web pages
    /// cannot use the relay.
    pub proxy_token: String,
}

impl AppState {
    pub fn new(proxy_port: u16, data_dir: PathBuf) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(Duration::from_secs(15))
            .build()
            .expect("valid reqwest configuration");
        Self {
            http,
            session: RwLock::new(None),
            profiles: ProfileStore::load(&data_dir),
            data_dir,
            proxy_port,
            proxy_token: random_hex(16),
        }
    }

    pub async fn credentials(&self) -> AppResult<Credentials> {
        self.session
            .read()
            .await
            .clone()
            .ok_or(AppError::NotSignedIn)
    }
}

/// `bytes` random bytes as lowercase hex.
pub fn random_hex(bytes: usize) -> String {
    let mut rng = rand::rng();
    (0..bytes)
        .map(|_| format!("{:02x}", rng.random::<u8>()))
        .collect()
}
