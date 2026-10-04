use std::sync::Arc;

use serde_json::Value;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::proxy::parse_file;
use crate::state::AppState;
use crate::xtream::{self, Action, Credentials, Query, StreamKind};

/// Validates the credentials with the provider and keeps them for this run.
/// Returns the provider's `user_info` / `server_info` payload.
#[tauri::command]
pub async fn login(
    state: State<'_, Arc<AppState>>,
    server: String,
    username: String,
    password: String,
) -> AppResult<Value> {
    let creds = Credentials::new(&server, &username, &password)?;
    let info = xtream::authenticate(&state.http, &creds).await?;
    *state.session.write().await = Some(creds);
    Ok(info)
}

#[tauri::command]
pub async fn logout(state: State<'_, Arc<AppState>>) -> AppResult<()> {
    *state.session.write().await = None;
    Ok(())
}

#[tauri::command]
pub async fn xtream(
    state: State<'_, Arc<AppState>>,
    action: Action,
    query: Option<Query>,
) -> AppResult<Value> {
    let creds = state.credentials().await?;
    xtream::call(&state.http, &creds, action, &query.unwrap_or_default()).await
}

/// A URL on the local relay the `<video>` element or mpegts.js can play.
#[tauri::command]
pub async fn stream_url(
    state: State<'_, Arc<AppState>>,
    kind: StreamKind,
    id: String,
    ext: String,
) -> AppResult<String> {
    state.credentials().await?;
    let file = format!("{id}.{ext}");
    parse_file(&file).ok_or_else(|| AppError::InvalidInput(file.clone()))?;
    Ok(format!(
        "http://127.0.0.1:{}/{}/{}?t={}",
        state.proxy_port,
        kind.path(),
        file,
        state.proxy_token
    ))
}
