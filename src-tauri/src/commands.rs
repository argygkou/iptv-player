use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::catalogue::{List, Snapshot};
use crate::epg::Programme;
use crate::error::{AppError, AppResult};
use crate::library::{Catalogue, CategoryPrefs, Item, ItemKind, Library};
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
    state.library.open(Some(&profile.id))?;
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
    state
        .library
        .open(profile.as_ref().map(|p| p.id.as_str()))?;
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
    if let Some(profile) = state.profiles.get(&id) {
        state.epg.delete(&profile.server, &profile.username)?;
        state.catalogue.delete(&profile.server, &profile.username)?;
    }
    secrets::delete(&state.data_dir, &id)?;
    state.library.delete(&id)?;
    state.profiles.remove(&id)
}

/// Ends the session. Saved profiles are kept, but none is restored on launch.
#[tauri::command]
pub async fn logout(state: State<'_, Arc<AppState>>) -> AppResult<()> {
    *state.session.write().await = None;
    state.library.close();
    state.epg.close();
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

/// A category or stream list: the cached copy whatever its age (flagged
/// `stale` when due a refresh), or a download when nothing is cached.
#[tauri::command]
pub async fn catalogue_get(state: State<'_, Arc<AppState>>, list: List) -> AppResult<Snapshot> {
    let creds = state.credentials().await?;
    state.catalogue.get(&state.http, &creds, list).await
}

/// Downloads a list again; `items` is left out when nothing changed.
#[tauri::command]
pub async fn catalogue_refresh(state: State<'_, Arc<AppState>>, list: List) -> AppResult<Snapshot> {
    let creds = state.credentials().await?;
    state.catalogue.refresh(&state.http, &creds, list).await
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

/// A relay URL for `duration` minutes of a channel's archive from `start`
/// (`YYYY-MM-DD:HH-MM` in the panel's time zone).
#[tauri::command]
pub async fn catchup_url(
    state: State<'_, Arc<AppState>>,
    id: String,
    start: String,
    duration: u32,
) -> AppResult<String> {
    state.credentials().await?;
    let file = format!("{id}.ts");
    parse_file(&file).ok_or_else(|| AppError::InvalidInput(file.clone()))?;
    if !xtream::is_timeshift_start(&start) || !(1..=MAX_CATCHUP_MINUTES).contains(&duration) {
        return Err(AppError::InvalidInput(format!(
            "{start} for {duration} minutes"
        )));
    }
    Ok(format!(
        "http://127.0.0.1:{}/timeshift/{duration}/{start}/{file}?t={}",
        state.proxy_port, state.proxy_token
    ))
}

/// Longest recording the relay asks for: a full day.
pub const MAX_CATCHUP_MINUTES: u32 = 24 * 60;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideWindow {
    /// When the guide was downloaded, in Unix seconds.
    pub updated_at: u64,
    /// By the requested channel id; channels without programmes are left out.
    pub programmes: HashMap<String, Vec<Programme>>,
}

/// Programmes of the XMLTV `channels` that overlap `from..to` (Unix seconds).
/// The guide is downloaded on first use and cached; `refresh` downloads it again.
#[tauri::command]
pub async fn epg_guide(
    state: State<'_, Arc<AppState>>,
    channels: Vec<String>,
    from: i64,
    to: i64,
    refresh: Option<bool>,
) -> AppResult<GuideWindow> {
    let creds = state.credentials().await?;
    let guide = state
        .epg
        .guide(&state.http, &creds, refresh.unwrap_or(false))
        .await?;
    let programmes = channels
        .into_iter()
        .filter_map(|channel| {
            let list = guide.between(&channel, from, to);
            (!list.is_empty()).then_some((channel, list))
        })
        .collect();
    Ok(GuideWindow {
        updated_at: guide.updated_at,
        programmes,
    })
}

#[tauri::command]
pub fn library_get(state: State<'_, Arc<AppState>>) -> AppResult<Library> {
    state.library.get()
}

#[tauri::command]
pub fn library_set_favourite(
    state: State<'_, Arc<AppState>>,
    item: Item,
    favourite: bool,
) -> AppResult<Library> {
    state.library.set_favourite(item, favourite)
}

/// Adds the item to the top of the history, with how far it was watched.
#[tauri::command]
pub fn library_record(
    state: State<'_, Arc<AppState>>,
    item: Item,
    position: Option<f64>,
    duration: Option<f64>,
) -> AppResult<Library> {
    state.library.record(item, position, duration)
}

#[tauri::command]
pub fn library_forget(
    state: State<'_, Arc<AppState>>,
    kind: ItemKind,
    id: String,
) -> AppResult<Library> {
    state.library.forget(kind, &id)
}

/// Replaces how the catalogue's categories are pinned and hidden.
#[tauri::command]
pub fn library_set_categories(
    state: State<'_, Arc<AppState>>,
    catalogue: Catalogue,
    prefs: CategoryPrefs,
) -> AppResult<Library> {
    state.library.set_categories(catalogue, prefs)
}
