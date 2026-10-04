mod commands;
mod error;
mod profiles;
mod proxy;
mod secrets;
mod state;
mod xtream;

use std::sync::Arc;

use tauri::Manager;

use crate::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
            listener.set_nonblocking(true)?;
            let data_dir = app.path().app_data_dir()?;
            let state = Arc::new(AppState::new(listener.local_addr()?.port(), data_dir));
            app.manage(state.clone());
            tauri::async_runtime::spawn(proxy::serve(listener, state));
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
            commands::stream_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
