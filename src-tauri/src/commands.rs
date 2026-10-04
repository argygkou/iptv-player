use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::profiles::Profile;
use crate::proxy::parse_file;
use crate::secrets;
use crate::state::AppState;
use crate::xtream::{self, Action, Credentials, Query, StreamKind};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedIn {
    /// The provider's `user_info` / `server_info` payload.
    pub account: Value,
    /// The saved profile, when the user chose to stay signed in.
    pub profile: Option<Profile>,
}

async fn authenticate(state: &AppState, creds: Credentials) -> AppResult<Value> {
    let account = xtream::authenticate(&state.http, &creds).await?;
    *state.session.write().await = Some(creds);
    Ok(account)
}

async fn sign_in_saved(state: &AppState, profile: Profile) -> AppResult<SignedIn> {
    let password = secrets::get(&state.data_dir, &profile.id)?.ok_or(AppError::MissingSecret)?;
    let creds = Credentials::new(&profile.server, &profile.username, &password)?;
    let account = authenticate(state, creds).await?;
    state.profiles.set_active(Some(&profile.id))?;
    Ok(SignedIn {
        account,
        profile: Some(profile),
    })
}

/// Validates the credentials with the provider. With `remember`, saves them as
/// a profile that is restored on the next launch.
#[tauri::command]
pub async fn login(
    state: State<'_, Arc<AppState>>,
    server: String,
    username: String,
    password: String,
    remember: bool,
) -> AppResult<SignedIn> {
    let creds = Credentials::new(&server, &username, &password)?;
    let account = authenticate(&state, creds.clone()).await?;
    let profile = if remember {
        let profile = state.profiles.save_active(&creds)?;
        secrets::set(&state.data_dir, &profile.id, &creds.password)?;
        Some(profile)
    } else {
        state.profiles.set_active(None)?;
        None
    };
    Ok(SignedIn { account, profile })
}

/// Signs in with the profile used last, if there is one. Called on startup.
#[tauri::command]
pub async fn restore_session(state: State<'_, Arc<AppState>>) -> AppResult<Option<SignedIn>> {
    match state.profiles.active() {
        Some(profile) => sign_in_saved(&state, profile).await.map(Some),
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn sign_in_profile(state: State<'_, Arc<AppState>>, id: String) -> AppResult<SignedIn> {
    let profile = state.profiles.get(&id).ok_or(AppError::UnknownProfile)?;
    sign_in_saved(&state, profile).await
}

#[tauri::command]
pub fn list_profiles(state: State<'_, Arc<AppState>>) -> Vec<Profile> {
    state.profiles.list()
}

#[tauri::command]
pub fn remove_profile(state: State<'_, Arc<AppState>>, id: String) -> AppResult<()> {
    secrets::delete(&state.data_dir, &id)?;
    state.profiles.remove(&id)
}

/// Ends the session. Saved profiles are kept, but none is restored on launch.
#[tauri::command]
pub async fn logout(state: State<'_, Arc<AppState>>) -> AppResult<()> {
    *state.session.write().await = None;
    state.profiles.set_active(None)
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
