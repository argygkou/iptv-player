use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Not signed in")]
    NotSignedIn,
    #[error("Invalid server URL: {0}")]
    InvalidServer(String),
    #[error("The provider rejected these credentials")]
    AuthFailed,
    #[error("Invalid request: {0}")]
    InvalidInput(String),
    #[error("Network error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("Unexpected response from provider: {0}")]
    Decode(#[from] serde_json::Error),
}

/// Commands return errors to the webview as plain strings.
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
