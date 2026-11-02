//! Keeps the display on while mpv is playing, as video players do.
//!
//! mpv's own `stop-screensaver` needs a window of its own, which it has on
//! Windows but not on macOS, where it draws through the render API. So the app
//! holds the request itself, on both, while playback is neither paused nor
//! idle.
//!
//! One thread owns the request, as Windows ties `SetThreadExecutionState` to
//! the thread that calls it: it lasts until that thread clears it or exits.

use std::sync::mpsc::{Receiver, Sender, channel};

/// Sends whether the display must stay on to the thread that holds it.
pub struct KeepAwake {
    sender: Sender<bool>,
}

impl KeepAwake {
    pub fn new() -> Self {
        let (sender, receiver) = channel();
        if let Err(err) = std::thread::Builder::new()
            .name("keep-awake".into())
            .spawn(move || hold(receiver))
        {
            log::warn!("cannot keep the display awake: {err}");
        }
        Self { sender }
    }

    /// Keeps the display on until called with `false`. Repeating a value is a no-op.
    pub fn set(&self, on: bool) {
        let _ = self.sender.send(on);
    }
}

fn hold(receiver: Receiver<bool>) {
    let mut held: Option<platform::Hold> = None;
    for on in receiver {
        if on && held.is_none() {
            held = platform::Hold::acquire()
                .inspect_err(|err| log::warn!("cannot keep the display awake: {err}"))
                .ok();
        } else if !on {
            // Dropping releases it.
            held = None;
        }
    }
}

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::System::Power::{
        ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED, SetThreadExecutionState,
    };

    pub struct Hold;

    impl Hold {
        pub fn acquire() -> Result<Self, String> {
            // SAFETY: plain flags; affects only this thread's request.
            let previous = unsafe {
                SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED)
            };
            if previous == 0 {
                Err("SetThreadExecutionState failed".into())
            } else {
                Ok(Self)
            }
        }
    }

    impl Drop for Hold {
        fn drop(&mut self) {
            // SAFETY: as above; clears what `acquire` set on this same thread.
            unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::c_void;

    use objc2_core_foundation::CFString;

    type IOPMAssertionID = u32;
    const LEVEL_ON: u32 = 255;
    const SUCCESS: i32 = 0;

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: *const c_void,
            level: u32,
            name: *const c_void,
            id: *mut IOPMAssertionID,
        ) -> i32;
        fn IOPMAssertionRelease(id: IOPMAssertionID) -> i32;
    }

    /// An IOKit power assertion, as `caffeinate -d` takes; `pmset -g assertions`
    /// lists it while held.
    pub struct Hold(IOPMAssertionID);

    impl Hold {
        pub fn acquire() -> Result<Self, String> {
            let kind = CFString::from_static_str("PreventUserIdleDisplaySleep");
            let name = CFString::from_static_str("Infinite IPTV is playing video");
            let mut id = 0;
            // SAFETY: both strings outlive the call, which copies what it keeps.
            let status = unsafe {
                IOPMAssertionCreateWithName(
                    (&*kind as *const CFString).cast(),
                    LEVEL_ON,
                    (&*name as *const CFString).cast(),
                    &mut id,
                )
            };
            if status == SUCCESS {
                Ok(Self(id))
            } else {
                Err(format!("IOPMAssertionCreateWithName failed: {status:#x}"))
            }
        }
    }

    impl Drop for Hold {
        fn drop(&mut self) {
            // SAFETY: `self.0` came from a successful create and is released once.
            unsafe { IOPMAssertionRelease(self.0) };
        }
    }
}
