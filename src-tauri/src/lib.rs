mod awake;
mod catalogue;
mod commands;
mod epg;
mod error;
mod library;
mod player;
mod profiles;
mod proxy;
mod secrets;
mod state;
mod xtream;

use std::sync::Arc;

use tauri::Manager;

use crate::player::Player;
use crate::state::AppState;

/// Keeps the display on while the main window is fullscreen, however it got
/// there (mpv's controls, `F`, the macOS green button). Entering and leaving
/// fullscreen always resizes the window.
fn keep_awake_in_fullscreen(app: &tauri::App) {
    use std::sync::atomic::{AtomicU64, Ordering};

    let Some(window) = app.get_webview_window("main") else {
        log::warn!("no main window; the display may sleep in fullscreen");
        return;
    };
    let awake = Arc::new(awake::KeepAwake::new());
    let latest = Arc::new(AtomicU64::new(0));
    let watched = window.clone();
    window.on_window_event(move |event| {
        if !matches!(event, tauri::WindowEvent::Resized(_)) {
            return;
        }
        let (awake, latest, window) = (awake.clone(), latest.clone(), watched.clone());
        let resize = latest.fetch_add(1, Ordering::SeqCst) + 1;
        // Read the state off the main thread, once the resizes settle: the
        // macOS fullscreen animation and a window drag send a burst of them.
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            if latest.load(Ordering::SeqCst) == resize {
                awake.set(window.is_fullscreen().unwrap_or(false));
            }
        });
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
            listener.set_nonblocking(true)?;
            let data_dir = app.path().app_data_dir()?;
            let state = Arc::new(AppState::new(listener.local_addr()?.port(), data_dir));
            app.manage(state.clone());
            let library = app.path().resource_dir()?.join(player::BUNDLED_LIBRARY);
            if !library.is_file() {
                log::warn!("{} not found; using webview playback", library.display());
            }
            app.manage(Player::new(Some(library).filter(|path| path.is_file())));
            tauri::async_runtime::spawn(proxy::serve(listener, state));
            keep_awake_in_fullscreen(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::login,
            commands::restore_session,
            commands::sign_in_profile,
            commands::list_profiles,
            commands::remove_profile,
            commands::logout,
            commands::xtream,
            commands::catalogue_get,
            commands::catalogue_refresh,
            commands::stream_url,
            commands::catchup_url,
            commands::epg_guide,
            commands::library_get,
            commands::library_set_favourite,
            commands::library_record,
            commands::library_forget,
            commands::library_set_categories,
            player::player_progress,
            player::player_available,
            player::player_open,
            player::player_set_bounds,
            player::player_set_info,
            player::player_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
