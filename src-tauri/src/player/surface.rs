//! The native child window mpv renders into (Windows).
//!
//! It sits above the webview inside the main window, at the rectangle the
//! Angular player reserves. A window region clips it to the part of that
//! rectangle that is visible, so it never covers UI outside the player when the
//! page scrolls.

use std::sync::Once;

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    BLACK_BRUSH, CreateRectRgn, GetStockObject, HBRUSH, SetWindowRgn,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::EnableWindow;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CS_DBLCLKS, CreateWindowExW, DefWindowProcW, HWND_TOP, RegisterClassW, SW_HIDE, SWP_NOACTIVATE,
    SWP_SHOWWINDOW, SetWindowPos, ShowWindow, WM_CREATE, WM_PARENTNOTIFY, WNDCLASSW, WS_CHILD,
    WS_CLIPCHILDREN, WS_CLIPSIBLINGS,
};

use super::Bounds;

const CLASS_NAME: &str = "InfiniteIptvVideoSurface";

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Embedded mpv creates its video window disabled, expecting the host to
/// forward input. Re-enabling it as soon as it appears lets mouse and keyboard
/// reach mpv directly, so its on-screen controller and shortcuts work.
unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // SAFETY: for WM_PARENTNOTIFY/WM_CREATE, lparam is the new child window.
    unsafe {
        if message == WM_PARENTNOTIFY && (wparam & 0xffff) as u32 == WM_CREATE {
            EnableWindow(lparam as HWND, 1);
        }
        DefWindowProcW(hwnd, message, wparam, lparam)
    }
}

/// Child window handle, stored as an integer so the state stays `Send`. Win32
/// lets other threads move and show a window; only creation is tied to the
/// main thread, whose message loop then serves it.
pub struct Surface(isize);

impl Surface {
    /// Creates the hidden child window inside `parent` (an `HWND`). Must run on
    /// the main (UI) thread.
    pub fn create(parent: isize) -> Result<Self, String> {
        static REGISTER: Once = Once::new();
        let class_name = wide(CLASS_NAME);
        // SAFETY: plain Win32 calls with valid, NUL-terminated arguments.
        unsafe {
            let instance = GetModuleHandleW(std::ptr::null());
            REGISTER.call_once(|| {
                let class = WNDCLASSW {
                    style: CS_DBLCLKS,
                    lpfnWndProc: Some(window_proc),
                    cbClsExtra: 0,
                    cbWndExtra: 0,
                    hInstance: instance,
                    hIcon: std::ptr::null_mut(),
                    hCursor: std::ptr::null_mut(),
                    hbrBackground: GetStockObject(BLACK_BRUSH) as HBRUSH,
                    lpszMenuName: std::ptr::null(),
                    lpszClassName: class_name.as_ptr(),
                };
                RegisterClassW(&class);
            });
            let hwnd = CreateWindowExW(
                0,
                class_name.as_ptr(),
                std::ptr::null(),
                WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
                0,
                0,
                0,
                0,
                parent as HWND,
                std::ptr::null_mut(),
                instance,
                std::ptr::null(),
            );
            if hwnd.is_null() {
                return Err(std::io::Error::last_os_error().to_string());
            }
            Ok(Self(hwnd as isize))
        }
    }

    fn hwnd(&self) -> HWND {
        self.0 as HWND
    }

    /// The value for mpv's `wid` option.
    pub fn id(&self) -> String {
        self.0.to_string()
    }

    /// Moves the window to `bounds` (physical pixels) and shows the visible
    /// part, or hides it when nothing is visible.
    pub fn place(&self, bounds: &Bounds) {
        let Some(clip) = bounds.visible_region() else {
            self.hide();
            return;
        };
        let (x, y, width, height) = bounds.window();
        // SAFETY: valid window handle; the system takes ownership of the region.
        unsafe {
            let region = CreateRectRgn(clip.0, clip.1, clip.2, clip.3);
            SetWindowRgn(self.hwnd(), region, 1);
            SetWindowPos(
                self.hwnd(),
                HWND_TOP,
                x,
                y,
                width,
                height,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
        }
    }

    pub fn hide(&self) {
        // SAFETY: valid window handle.
        unsafe {
            ShowWindow(self.hwnd(), SW_HIDE);
        }
    }
}
