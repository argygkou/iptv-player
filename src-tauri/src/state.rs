use std::time::Duration;

use rand::Rng;
use tokio::sync::RwLock;

use crate::error::{AppError, AppResult};
use crate::xtream::Credentials;

/// Many panels only serve known player user agents, so identify as a common one.
const USER_AGENT: &str = "VLC/3.0.20 LibVLC/3.0.20";

pub struct AppState {
    pub http: reqwest::Client,
    pub session: RwLock<Option<Credentials>>,
    pub proxy_port: u16,
    /// Required on every proxy request so other local processes or web pages
    /// cannot use the relay.
    pub proxy_token: String,
}

impl AppState {
    pub fn new(proxy_port: u16) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(Duration::from_secs(15))
            .build()
            .expect("valid reqwest configuration");
        let token: [u8; 16] = rand::rng().random();
        Self {
            http,
            session: RwLock::new(None),
            proxy_port,
            proxy_token: token.iter().map(|b| format!("{b:02x}")).collect(),
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
