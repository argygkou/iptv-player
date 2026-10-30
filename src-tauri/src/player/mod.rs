//! Native playback through libmpv.
//!
//! The webview's decoders cannot play MKV, HEVC, AC3/DTS and many other formats
//! IPTV providers serve, so on Windows playback happens in mpv instead. mpv
//! renders into a child window ([`surface`]) that the Angular player keeps
//! positioned over the rectangle it reserves, and mpv's own on-screen
//! controller handles seeking, tracks, subtitles and keyboard shortcuts.
//!
//! The commands are `async`, so they run on the async runtime rather than the
//! main thread; see [`Native::start`] for why that matters.

#[cfg(windows)]
mod mpv;
#[cfg(windows)]
mod surface;

use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
#[cfg(windows)]
use tauri::Manager;
use tauri::{AppHandle, State, WebviewWindow};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// The DLL from the `mpv-dev` builds, bundled next to the executable.
pub const LIBRARY: &str = "libmpv-2.dll";

/// A rectangle in CSS pixels, relative to the webview.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Where the player element is, and which part of it is not scrolled out of view.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Bounds {
    pub rect: Rect,
    /// `None` when the element is entirely out of view.
    pub visible: Option<Rect>,
    /// `devicePixelRatio`, to convert CSS to physical pixels.
    pub scale: f64,
}

#[cfg_attr(not(windows), allow(dead_code))]
impl Bounds {
    fn px(&self, value: f64) -> i32 {
        (value * self.scale).round() as i32
    }

    /// `(x, y, width, height)` of the window in physical pixels.
    pub fn window(&self) -> (i32, i32, i32, i32) {
        let r = self.rect;
        let (x, y) = (self.px(r.x), self.px(r.y));
        (
            x,
            y,
            self.px(r.x + r.width) - x,
            self.px(r.y + r.height) - y,
        )
    }

    /// `(left, top, right, bottom)` of the visible part in physical pixels,
    /// relative to the window, or `None` when nothing is visible.
    pub fn visible_region(&self) -> Option<(i32, i32, i32, i32)> {
        let v = self.visible?;
        let (x, y, width, height) = self.window();
        let left = (self.px(v.x) - x).clamp(0, width);
        let top = (self.px(v.y) - y).clamp(0, height);
        let right = (self.px(v.x + v.width) - x).clamp(0, width);
        let bottom = (self.px(v.y + v.height) - y).clamp(0, height);
        (right > left && bottom > top).then_some((left, top, right, bottom))
    }
}

/// Lazily created mpv instance and its window.
pub struct Player {
    library: Option<PathBuf>,
    #[cfg(windows)]
    native: tokio::sync::OnceCell<Native>,
}

#[cfg(windows)]
struct Native {
    mpv: mpv::Mpv,
    surface: surface::Surface,
}

impl Player {
    /// `library` is the path of libmpv when it was found; without it every
    /// command reports that native playback is unavailable.
    pub fn new(library: Option<PathBuf>) -> Self {
        Self {
            library: library.filter(|_| cfg!(windows)),
            #[cfg(windows)]
            native: Default::default(),
        }
    }
}

fn unavailable() -> AppError {
    AppError::Playback("native playback is not available".into())
}

/// Only relay URLs may be opened, never arbitrary files or protocols.
fn check_url(state: &AppState, url: &str) -> AppResult<()> {
    let prefix = format!("http://127.0.0.1:{}/", state.proxy_port);
    if url.starts_with(&prefix) {
        Ok(())
    } else {
        Err(AppError::InvalidInput(url.to_owned()))
    }
}

#[cfg(windows)]
impl Native {
    /// Creates the window on the main thread and mpv on the calling one. mpv
    /// must never be called from the main thread: its video thread sends
    /// messages to the parent window, so a main thread blocked in mpv could
    /// deadlock with it.
    async fn start(
        library: &std::path::Path,
        window: &WebviewWindow,
        app: &AppHandle,
    ) -> AppResult<Self> {
        let failed = |err: tauri::Error| AppError::Playback(err.to_string());
        let parent = window.hwnd().map_err(failed)?.0 as isize;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        window
            .run_on_main_thread(move || {
                let _ = sender.send(surface::Surface::create(parent));
            })
            .map_err(failed)?;
        let surface = receiver
            .await
            .map_err(|_| unavailable())?
            .map_err(AppError::Playback)?;
        let wid = surface.id();
        // mpv's own log, for diagnosing playback and input problems.
        let log_dir = app.path().app_log_dir().map_err(failed)?;
        std::fs::create_dir_all(&log_dir)?;
        let log_file = log_dir.join("mpv.log").to_string_lossy().into_owned();
        let mpv = mpv::Mpv::new(
            library,
            &[
                ("wid", &wid),
                ("idle", "yes"),
                ("force-window", "yes"),
                ("keep-open", "yes"),
                ("hwdec", "auto-safe"),
                ("osc", "yes"),
                // Show the controller on any mouse movement over the video, not just
                // the bottom half, and keep it up a little longer than mpv does.
                (
                    "script-opts",
                    "osc-windowcontrols=no,osc-deadzonesize=0,osc-hidetimeout=2500",
                ),
                ("input-default-bindings", "yes"),
                ("input-vo-keyboard", "yes"),
                ("ytdl", "no"),
                ("network-timeout", "20"),
                ("log-file", &log_file),
            ],
        )
        .map_err(AppError::Playback)?;
        mpv.observe_flag("fullscreen").map_err(AppError::Playback)?;
        let (events, app, window) = (mpv.clone(), app.clone(), window.clone());
        std::thread::Builder::new()
            .name("mpv-events".into())
            .spawn(move || forward_events(&events, &app, &window))
            .map_err(|err| AppError::Playback(err.to_string()))?;
        Ok(Self { mpv, surface })
    }
}

/// Embedded mpv cannot go fullscreen itself, so its `fullscreen` property
/// (the OSC button, double-click, `f`, `Esc`) drives the app window instead.
#[cfg(windows)]
fn forward_events(mpv: &mpv::Mpv, app: &AppHandle, window: &WebviewWindow) {
    use tauri::Emitter;
    loop {
        match mpv.wait_event() {
            Some(mpv::Event::Shutdown) => break,
            Some(mpv::Event::EndFileError(message)) => {
                let _ = app.emit("player://error", message);
            }
            Some(mpv::Event::Flag(name, value)) if name == "fullscreen" => {
                let _ = window.set_fullscreen(value);
                let _ = app.emit("player://fullscreen", value);
            }
            _ => {}
        }
    }
}

#[tauri::command]
pub fn player_available(player: State<'_, Player>) -> bool {
    player.library.is_some()
}

#[cfg(windows)]
#[tauri::command]
pub async fn player_open(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    player: State<'_, Player>,
    url: String,
    bounds: Bounds,
) -> AppResult<()> {
    check_url(&state, &url)?;
    let library = player.library.as_deref().ok_or_else(unavailable)?;
    let native = player
        .native
        .get_or_try_init(|| Native::start(library, &window, &app))
        .await?;
    native.surface.place(&bounds);
    native
        .mpv
        .command(&["loadfile", &url, "replace"])
        .and_then(|()| native.mpv.set_property("pause", "no"))
        .map_err(AppError::Playback)
}

#[cfg(windows)]
#[tauri::command]
pub async fn player_set_bounds(player: State<'_, Player>, bounds: Bounds) -> AppResult<()> {
    if let Some(native) = player.native.get() {
        native.surface.place(&bounds);
    }
    Ok(())
}

#[cfg(windows)]
#[tauri::command]
pub async fn player_stop(player: State<'_, Player>) -> AppResult<()> {
    let Some(native) = player.native.get() else {
        return Ok(());
    };
    native.surface.hide();
    native
        .mpv
        .set_property("fullscreen", "no")
        .and_then(|()| native.mpv.command(&["stop"]))
        .map_err(AppError::Playback)
}

#[cfg(not(windows))]
#[tauri::command]
pub fn player_open(
    _app: AppHandle,
    _window: WebviewWindow,
    state: State<'_, Arc<AppState>>,
    _player: State<'_, Player>,
    url: String,
    _bounds: Bounds,
) -> AppResult<()> {
    check_url(&state, &url)?;
    Err(unavailable())
}

#[cfg(not(windows))]
#[tauri::command]
pub fn player_set_bounds(_player: State<'_, Player>, _bounds: Bounds) -> AppResult<()> {
    Err(unavailable())
}

#[cfg(not(windows))]
#[tauri::command]
pub fn player_stop(_player: State<'_, Player>) -> AppResult<()> {
    Err(unavailable())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn scales_the_window_to_physical_pixels() {
        let bounds = Bounds {
            rect: rect(10.5, 20.0, 640.0, 360.0),
            visible: Some(rect(10.5, 20.0, 640.0, 360.0)),
            scale: 1.5,
        };
        assert_eq!(bounds.window(), (16, 30, 960, 540));
        assert_eq!(bounds.visible_region(), Some((0, 0, 960, 540)));
    }

    #[test]
    fn clips_to_the_visible_part() {
        let bounds = Bounds {
            rect: rect(0.0, -100.0, 800.0, 450.0),
            visible: Some(rect(0.0, 0.0, 800.0, 350.0)),
            scale: 1.0,
        };
        assert_eq!(bounds.visible_region(), Some((0, 100, 800, 450)));
    }

    #[test]
    fn nothing_visible_hides_the_window() {
        let hidden = Bounds {
            rect: rect(0.0, 0.0, 800.0, 450.0),
            visible: None,
            scale: 1.0,
        };
        assert_eq!(hidden.visible_region(), None);
        let empty = Bounds {
            visible: Some(rect(0.0, 0.0, 0.0, 450.0)),
            ..hidden
        };
        assert_eq!(empty.visible_region(), None);
    }

    #[test]
    fn library_is_ignored_off_windows() {
        let player = Player::new(Some(PathBuf::from(LIBRARY)));
        assert_eq!(player.library.is_some(), cfg!(windows));
    }
}
