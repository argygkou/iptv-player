//! Minimal binding to the libmpv client API, loaded at runtime.
//!
//! Loading the DLL at runtime instead of linking against it keeps the build free
//! of an import library and lets the app fall back to webview playback when the
//! DLL is missing. Only the handful of entry points the player needs are bound;
//! see `client.h` in mpv for their contracts. The client API is thread-safe, so
//! one handle is shared between the command handlers and the event thread.

use std::ffi::{CStr, CString, c_char, c_double, c_int, c_void};
use std::path::Path;
use std::sync::Arc;

use libloading::Library;

#[repr(C)]
pub struct Handle {
    _private: [u8; 0],
}

#[repr(C)]
struct RawEvent {
    event_id: c_int,
    error: c_int,
    reply_userdata: u64,
    data: *mut c_void,
}

#[repr(C)]
struct RawEndFile {
    reason: c_int,
    error: c_int,
}

#[repr(C)]
struct RawProperty {
    name: *const c_char,
    format: c_int,
    data: *mut c_void,
}

const EVENT_SHUTDOWN: c_int = 1;
const EVENT_START_FILE: c_int = 6;
const EVENT_END_FILE: c_int = 7;
const EVENT_PROPERTY_CHANGE: c_int = 22;
const END_FILE_REASON_EOF: c_int = 0;
const END_FILE_REASON_ERROR: c_int = 4;
const FORMAT_FLAG: c_int = 3;

/// Events the player reacts to; everything else is skipped.
pub enum Event {
    Shutdown,
    /// A file from `loadfile` starts loading; one per successful `loadfile`.
    StartFile,
    /// The current file ended by itself, rather than through `stop` or a
    /// replacing `loadfile`.
    EndFile(Ended),
    Flag(String, bool),
}

pub enum Ended {
    Eof,
    /// The file could not be opened or decoded.
    Error(String),
}

/// Whether `path` is a loadable libmpv with the entry points used here.
pub fn probe(path: &Path) -> Result<(), String> {
    Api::load(path).map(drop)
}

struct Api {
    create: unsafe extern "C" fn() -> *mut Handle,
    initialize: unsafe extern "C" fn(*mut Handle) -> c_int,
    set_option_string: unsafe extern "C" fn(*mut Handle, *const c_char, *const c_char) -> c_int,
    set_property_string: unsafe extern "C" fn(*mut Handle, *const c_char, *const c_char) -> c_int,
    command: unsafe extern "C" fn(*mut Handle, *const *const c_char) -> c_int,
    observe_property: unsafe extern "C" fn(*mut Handle, u64, *const c_char, c_int) -> c_int,
    wait_event: unsafe extern "C" fn(*mut Handle, c_double) -> *mut RawEvent,
    error_string: unsafe extern "C" fn(c_int) -> *const c_char,
    // Keeps the function pointers above valid.
    _library: Library,
}

impl Api {
    fn load(path: &Path) -> Result<Self, String> {
        // SAFETY: libmpv has no initialisation side effects on load, and the
        // symbol types below match `client.h` (API version 2.x).
        unsafe {
            let library = Library::new(path).map_err(|err| err.to_string())?;
            macro_rules! symbol {
                ($name:literal) => {
                    *library
                        .get(concat!($name, "\0").as_bytes())
                        .map_err(|err| format!("{}: {err}", $name))?
                };
            }
            Ok(Self {
                create: symbol!("mpv_create"),
                initialize: symbol!("mpv_initialize"),
                set_option_string: symbol!("mpv_set_option_string"),
                set_property_string: symbol!("mpv_set_property_string"),
                command: symbol!("mpv_command"),
                observe_property: symbol!("mpv_observe_property"),
                wait_event: symbol!("mpv_wait_event"),
                error_string: symbol!("mpv_error_string"),
                _library: library,
            })
        }
    }

    fn error(&self, code: c_int) -> String {
        // SAFETY: mpv_error_string returns a static string for any code.
        unsafe { CStr::from_ptr((self.error_string)(code)) }
            .to_string_lossy()
            .into_owned()
    }
}

/// An initialised mpv instance. Cloning shares the instance.
#[derive(Clone)]
pub struct Mpv {
    api: Arc<Api>,
    handle: *mut Handle,
}

// SAFETY: the libmpv client API may be called from any thread.
unsafe impl Send for Mpv {}
unsafe impl Sync for Mpv {}

fn c_string(value: &str) -> Result<CString, String> {
    CString::new(value).map_err(|_| format!("unexpected NUL in {value:?}"))
}

impl Mpv {
    /// Loads the library and creates an instance with `options` applied before
    /// initialisation (options such as `wid` only take effect then).
    pub fn new(library: &Path, options: &[(&str, &str)]) -> Result<Self, String> {
        let api = Arc::new(Api::load(library)?);
        // SAFETY: mpv_create has no preconditions; a null return means OOM.
        let handle = unsafe { (api.create)() };
        if handle.is_null() {
            return Err("mpv_create failed".into());
        }
        // The handle is intentionally never destroyed: it lives as long as the app.
        let mpv = Self { api, handle };
        for (name, value) in options {
            let (name, value) = (c_string(name)?, c_string(value)?);
            // SAFETY: valid handle and NUL-terminated strings.
            mpv.check(unsafe {
                (mpv.api.set_option_string)(handle, name.as_ptr(), value.as_ptr())
            })?;
        }
        // SAFETY: valid, not yet initialised handle.
        mpv.check(unsafe { (mpv.api.initialize)(handle) })?;
        Ok(mpv)
    }

    fn check(&self, code: c_int) -> Result<(), String> {
        if code < 0 {
            Err(self.api.error(code))
        } else {
            Ok(())
        }
    }

    pub fn command(&self, args: &[&str]) -> Result<(), String> {
        let owned = args
            .iter()
            .map(|arg| c_string(arg))
            .collect::<Result<Vec<_>, _>>()?;
        let mut pointers: Vec<*const c_char> = owned.iter().map(|arg| arg.as_ptr()).collect();
        pointers.push(std::ptr::null());
        // SAFETY: a NULL-terminated array of NUL-terminated strings that outlive the call.
        self.check(unsafe { (self.api.command)(self.handle, pointers.as_ptr()) })
    }

    pub fn set_property(&self, name: &str, value: &str) -> Result<(), String> {
        let (name, value) = (c_string(name)?, c_string(value)?);
        // SAFETY: valid handle and NUL-terminated strings.
        self.check(unsafe {
            (self.api.set_property_string)(self.handle, name.as_ptr(), value.as_ptr())
        })
    }

    /// Reports changes of a boolean property as [`Event::Flag`].
    pub fn observe_flag(&self, name: &str) -> Result<(), String> {
        let name = c_string(name)?;
        // SAFETY: valid handle; mpv copies the name.
        self.check(unsafe {
            (self.api.observe_property)(self.handle, 0, name.as_ptr(), FORMAT_FLAG)
        })
    }

    /// Blocks until the next event. Must only be called from one thread.
    pub fn wait_event(&self) -> Option<Event> {
        // SAFETY: the returned event stays valid until the next wait_event call
        // on this handle, and is fully read before returning.
        unsafe {
            let event = &*(self.api.wait_event)(self.handle, -1.0);
            match event.event_id {
                EVENT_SHUTDOWN => Some(Event::Shutdown),
                EVENT_START_FILE => Some(Event::StartFile),
                EVENT_END_FILE => {
                    let end = &*(event.data as *const RawEndFile);
                    match end.reason {
                        END_FILE_REASON_EOF => Some(Event::EndFile(Ended::Eof)),
                        END_FILE_REASON_ERROR => {
                            Some(Event::EndFile(Ended::Error(self.api.error(end.error))))
                        }
                        _ => None,
                    }
                }
                EVENT_PROPERTY_CHANGE => {
                    let property = &*(event.data as *const RawProperty);
                    if property.format != FORMAT_FLAG || property.data.is_null() {
                        return None;
                    }
                    let name = CStr::from_ptr(property.name).to_string_lossy().into_owned();
                    Some(Event::Flag(name, *(property.data as *const c_int) != 0))
                }
                _ => None,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs against the DLL from `npm run fetch-libmpv`, and is skipped without it.
    fn bundled() -> Option<Mpv> {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("lib")
            .join(super::super::LIBRARY);
        if !path.is_file() {
            eprintln!("{} missing, skipping", path.display());
            return None;
        }
        let options = [("vo", "null"), ("ao", "null"), ("idle", "yes")];
        Some(Mpv::new(&path, &options).expect("mpv initialises"))
    }

    fn next(mpv: &Mpv, matches: impl Fn(&Event) -> bool) -> Event {
        loop {
            match mpv.wait_event() {
                Some(Event::Shutdown) => panic!("mpv shut down"),
                Some(event) if matches(&event) => return event,
                _ => {}
            }
        }
    }

    #[test]
    fn probes_the_library() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("lib")
            .join(super::super::LIBRARY);
        assert_eq!(probe(&path).is_ok(), path.is_file());
        assert!(probe(Path::new("missing.dll")).is_err());
    }

    #[test]
    fn reports_flag_changes() {
        let Some(mpv) = bundled() else { return };
        mpv.observe_flag("pause").unwrap();
        mpv.set_property("pause", "yes").unwrap();
        next(
            &mpv,
            |e| matches!(e, Event::Flag(name, true) if name == "pause"),
        );
    }

    #[test]
    fn reports_streams_that_fail_to_open() {
        let Some(mpv) = bundled() else { return };
        // Nothing listens on the discard port, so the connection is refused.
        mpv.command(&["loadfile", "http://127.0.0.1:9/1.ts", "replace"])
            .unwrap();
        next(&mpv, |e| matches!(e, Event::StartFile));
        let event = next(&mpv, |e| matches!(e, Event::EndFile(_)));
        let Event::EndFile(Ended::Error(message)) = event else {
            panic!("expected an error")
        };
        assert!(!message.is_empty());
    }
}
