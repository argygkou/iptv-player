//! The native view mpv draws into (macOS).
//!
//! libmpv cannot embed its own window on macOS, so mpv draws through its
//! render API into an OpenGL layer the app owns ([`VideoLayer`]), hosted by a
//! view placed above the webview at the rectangle the Angular player reserves.
//! A clipping view around it keeps the video inside the part of that rectangle
//! that is not scrolled out of view.
//!
//! Without its own window mpv sees no input either, so [`VideoView`] passes the
//! mouse and keyboard on as mpv input commands. mpv then handles them as it
//! would in its own window: the on-screen controller, double-click for
//! fullscreen, and the keyboard shortcuts all work.
//!
//! The views live on the main thread. Drawing happens on a serial queue of its
//! own, which mpv's update callback wakes for each new frame (as mpv's own
//! macOS backend does), so playback never waits for the main thread.

#![allow(deprecated)] // OpenGL is deprecated on macOS, but still what libmpv renders with.

use std::cell::Cell;
use std::ffi::{c_char, c_void};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use dispatch2::{DispatchQueue, DispatchQueueAttr, DispatchRetained, MainThreadBound};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool};
use objc2::{AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send};
use objc2_app_kit::{
    NSEvent, NSEventModifierFlags, NSResponder, NSTrackingArea, NSTrackingAreaOptions, NSView,
    NSWindowOrderingMode,
};
use objc2_core_foundation::CFTimeInterval;
use objc2_core_video::CVTimeStamp;
use objc2_foundation::{NSObject, NSPoint, NSRect, NSSize};
use objc2_open_gl::{
    CGLChoosePixelFormat, CGLContextObj, CGLCreateContext, CGLError, CGLGetCurrentContext,
    CGLOpenGLProfile, CGLPixelFormatAttribute, CGLPixelFormatObj, CGLRetainContext,
    CGLRetainPixelFormat, CGLSetCurrentContext,
};
use objc2_quartz_core::{CALayer, CAOpenGLLayer, CATransaction};
use tauri::WebviewWindow;

use super::Bounds;
use super::mpv::Mpv;
use super::mpv::render::Renderer;

const GL_VIEWPORT: u32 = 0x0BA2;
const GL_DRAW_FRAMEBUFFER_BINDING: u32 = 0x8CA6;

#[link(name = "OpenGL", kind = "framework")]
unsafe extern "C" {
    fn glGetIntegerv(name: u32, data: *mut i32);
}

/// Resolves OpenGL functions for mpv.
unsafe extern "C" fn get_proc_address(_context: *mut c_void, name: *const c_char) -> *mut c_void {
    static OPENGL: OnceLock<usize> = OnceLock::new();
    let library = *OPENGL.get_or_init(|| {
        let path = c"/System/Library/Frameworks/OpenGL.framework/OpenGL";
        // SAFETY: a NUL-terminated path; the handle is never closed.
        unsafe { libc::dlopen(path.as_ptr(), libc::RTLD_LAZY | libc::RTLD_GLOBAL) as usize }
    });
    if library == 0 {
        return std::ptr::null_mut();
    }
    // SAFETY: a valid handle and the NUL-terminated name mpv passes.
    unsafe { libc::dlsym(library as *mut c_void, name) }
}

/// Runs on an mpv thread when there is something new to draw.
unsafe extern "C" fn on_update(redraw: *mut c_void) {
    // SAFETY: `redraw` is the leaked `Redraw` from `build`.
    unsafe { &*(redraw as *const Redraw) }.request();
}

/// Schedules the layer's drawing on a serial queue.
struct Redraw {
    queue: DispatchRetained<DispatchQueue>,
    /// Set when mpv has a new frame or the layer changed size.
    dirty: AtomicBool,
    /// A display is queued and has not started yet; requests until then share it.
    queued: AtomicBool,
    /// The layer, once created; it lives as long as the app.
    layer: AtomicPtr<VideoLayer>,
    /// Width and height in pixels of the last frame drawn (`width << 32 | height`),
    /// which is the space mpv's mouse coordinates are in.
    size: AtomicU64,
}

impl Redraw {
    fn new() -> &'static Self {
        Box::leak(Box::new(Self {
            queue: DispatchQueue::new("com.argygkou.infiniteiptv.video", DispatchQueueAttr::SERIAL),
            dirty: AtomicBool::new(true),
            queued: AtomicBool::new(false),
            layer: AtomicPtr::new(std::ptr::null_mut()),
            size: AtomicU64::new(0),
        }))
    }

    /// Draws the layer again soon. Callable from any thread.
    fn request(&'static self) {
        self.dirty.store(true, Ordering::Release);
        if self.queued.swap(true, Ordering::AcqRel) {
            return;
        }
        self.queue.exec_async(move || {
            self.queued.store(false, Ordering::Release);
            let layer = self.layer.load(Ordering::Acquire);
            if layer.is_null() {
                return;
            }
            // SAFETY: the layer is never freed. Displaying a layer off the
            // main thread is supported when the transaction is flushed.
            unsafe { (*layer).display() };
            CATransaction::flush();
        });
    }
}

/// The pixel format and OpenGL context the layer draws with.
#[derive(Clone, Copy)]
struct Gl {
    pixel_format: CGLPixelFormatObj,
    context: CGLContextObj,
}

// SAFETY: CGL objects may be used from any thread, one at a time; mpv's render
// API calls are serialised by the layer.
unsafe impl Send for Gl {}
unsafe impl Sync for Gl {}

impl Gl {
    /// A 3.2 core profile context, which mpv's OpenGL renderer needs.
    fn new() -> Result<Self, String> {
        let attributes = [
            CGLPixelFormatAttribute::CGLPFAOpenGLProfile,
            CGLPixelFormatAttribute(CGLOpenGLProfile::CGLOGLPVersion_3_2_Core.0),
            CGLPixelFormatAttribute::CGLPFAAccelerated,
            CGLPixelFormatAttribute::CGLPFADoubleBuffer,
            CGLPixelFormatAttribute::CGLPFAAllowOfflineRenderers,
            CGLPixelFormatAttribute::CGLPFASupportsAutomaticGraphicsSwitching,
            CGLPixelFormatAttribute(0),
        ];
        let mut pixel_format: CGLPixelFormatObj = std::ptr::null_mut();
        let mut count = 0;
        // SAFETY: a zero-terminated attribute list and valid out pointers.
        let error = unsafe {
            CGLChoosePixelFormat(
                NonNull::from(&attributes[0]),
                NonNull::from(&mut pixel_format),
                NonNull::from(&mut count),
            )
        };
        if error != CGLError(0) || pixel_format.is_null() {
            return Err(format!("no OpenGL pixel format (CGL error {})", error.0));
        }
        let mut context: CGLContextObj = std::ptr::null_mut();
        // SAFETY: a valid pixel format and out pointer; no shared context.
        let error = unsafe {
            CGLCreateContext(
                pixel_format,
                std::ptr::null_mut(),
                NonNull::from(&mut context),
            )
        };
        if error != CGLError(0) || context.is_null() {
            return Err(format!("no OpenGL context (CGL error {})", error.0));
        }
        // Both are kept for the app's lifetime.
        Ok(Self {
            pixel_format,
            context,
        })
    }

    /// Runs `f` with this context current on the calling thread.
    fn with_current<R>(&self, f: impl FnOnce() -> R) -> R {
        // SAFETY: valid contexts; the previous one is restored.
        unsafe {
            let previous = CGLGetCurrentContext();
            CGLSetCurrentContext(self.context);
            let result = f();
            CGLSetCurrentContext(previous);
            result
        }
    }
}

struct LayerState {
    gl: Gl,
    renderer: Renderer,
    redraw: &'static Redraw,
    /// Core Animation may also display the layer on the main thread, and
    /// mpv's render calls must not overlap.
    drawing: Mutex<()>,
}

define_class!(
    // SAFETY: CAOpenGLLayer is meant to be subclassed with these overrides,
    // and `VideoLayer` does not implement `Drop`.
    #[unsafe(super(CAOpenGLLayer, CALayer, NSObject))]
    #[name = "InfiniteIptvVideoLayer"]
    #[ivars = LayerState]
    struct VideoLayer;

    impl VideoLayer {
        #[unsafe(method(display))]
        fn display_locked(&self) {
            let _drawing = self.ivars().drawing.lock().unwrap_or_else(|e| e.into_inner());
            // SAFETY: CALayer's display, which calls `can_draw` and `draw`.
            unsafe {
                let _: () = msg_send![super(self), display];
            }
        }

        #[unsafe(method(copyCGLPixelFormatForDisplayMask:))]
        fn copy_pixel_format(&self, _mask: u32) -> CGLPixelFormatObj {
            // SAFETY: a valid pixel format; Core Animation releases this reference.
            unsafe { CGLRetainPixelFormat(self.ivars().gl.pixel_format) }
        }

        #[unsafe(method(copyCGLContextForPixelFormat:))]
        fn copy_context(&self, _pixel_format: CGLPixelFormatObj) -> CGLContextObj {
            // The context mpv's renderer was created with.
            // SAFETY: a valid context; Core Animation releases this reference.
            unsafe { CGLRetainContext(self.ivars().gl.context) }
        }

        #[unsafe(method(canDrawInCGLContext:pixelFormat:forLayerTime:displayTime:))]
        fn can_draw(
            &self,
            _context: CGLContextObj,
            _pixel_format: CGLPixelFormatObj,
            _time: CFTimeInterval,
            _display: *const CVTimeStamp,
        ) -> Bool {
            let state = self.ivars();
            if !state.redraw.dirty.swap(false, Ordering::AcqRel) {
                return Bool::NO;
            }
            // Lets mpv process the update; the frame is drawn either way, as
            // the change may be the controller or the layer's size.
            let _ = state.renderer.has_frame();
            Bool::YES
        }

        #[unsafe(method(drawInCGLContext:pixelFormat:forLayerTime:displayTime:))]
        fn draw(
            &self,
            context: CGLContextObj,
            pixel_format: CGLPixelFormatObj,
            time: CFTimeInterval,
            display: *const CVTimeStamp,
        ) {
            // Core Animation draws into its own framebuffer, at the size of the
            // layer in pixels.
            let mut framebuffer = 0;
            let mut viewport = [0; 4];
            // SAFETY: Core Animation made `context` current on this thread.
            unsafe {
                glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &mut framebuffer);
                glGetIntegerv(GL_VIEWPORT, viewport.as_mut_ptr());
            }
            let (width, height) = (viewport[2], viewport[3]);
            self.ivars()
                .redraw
                .size
                .store(((width as u64) << 32) | height as u64, Ordering::Release);
            if let Err(err) = self.ivars().renderer.render(framebuffer, width, height) {
                log::warn!("mpv render failed: {err}");
            }
            // SAFETY: the superclass implementation flushes the context.
            unsafe {
                let _: () = msg_send![
                    super(self),
                    drawInCGLContext: context,
                    pixelFormat: pixel_format,
                    forLayerTime: time,
                    displayTime: display
                ];
            }
        }
    }
);

impl VideoLayer {
    fn new(state: LayerState) -> Retained<Self> {
        let this = Self::alloc().set_ivars(state);
        // SAFETY: CALayer's designated initialiser.
        let layer: Retained<Self> = unsafe { msg_send![super(this), init] };
        layer.setOpaque(true);
        layer
    }
}

define_class!(
    // SAFETY: NSView has no subclassing requirements; `ClipView` does not
    // implement `Drop`.
    #[unsafe(super(NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "InfiniteIptvClipView"]
    struct ClipView;

    impl ClipView {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }
    }
);

impl ClipView {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        // SAFETY: NSObject's initialiser; the frame is set when placed.
        unsafe { msg_send![Self::alloc(mtm), init] }
    }
}

struct ViewState {
    mpv: Mpv,
    redraw: &'static Redraw,
    /// Pixels per point, for mpv's mouse coordinates until a frame is drawn.
    scale: Cell<f64>,
    /// Trackpad scrolling not yet passed on, in points.
    scrolled: Cell<f64>,
}

define_class!(
    // SAFETY: NSView has no subclassing requirements; `VideoView` does not
    // implement `Drop`.
    #[unsafe(super(NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "InfiniteIptvVideoView"]
    #[ivars = ViewState]
    struct VideoView;

    impl VideoView {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }

        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_first_responder(&self) -> bool {
            true
        }

        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> bool {
            true
        }

        #[unsafe(method(mouseMoved:))]
        fn mouse_moved(&self, event: &NSEvent) {
            self.move_to(event);
        }

        #[unsafe(method(mouseDragged:))]
        fn mouse_dragged(&self, event: &NSEvent) {
            self.move_to(event);
        }

        #[unsafe(method(mouseEntered:))]
        fn mouse_entered(&self, event: &NSEvent) {
            self.move_to(event);
        }

        #[unsafe(method(mouseExited:))]
        fn mouse_exited(&self, _event: &NSEvent) {
            self.input(&["keypress", "MOUSE_LEAVE"]);
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) {
            self.press(event, "keydown", "MBTN_LEFT");
        }

        #[unsafe(method(mouseUp:))]
        fn mouse_up(&self, event: &NSEvent) {
            self.press(event, "keyup", "MBTN_LEFT");
        }

        #[unsafe(method(rightMouseDown:))]
        fn right_mouse_down(&self, event: &NSEvent) {
            self.press(event, "keydown", "MBTN_RIGHT");
        }

        #[unsafe(method(rightMouseUp:))]
        fn right_mouse_up(&self, event: &NSEvent) {
            self.press(event, "keyup", "MBTN_RIGHT");
        }

        #[unsafe(method(otherMouseDown:))]
        fn other_mouse_down(&self, event: &NSEvent) {
            self.press(event, "keydown", "MBTN_MID");
        }

        #[unsafe(method(otherMouseUp:))]
        fn other_mouse_up(&self, event: &NSEvent) {
            self.press(event, "keyup", "MBTN_MID");
        }

        #[unsafe(method(scrollWheel:))]
        fn scroll_wheel(&self, event: &NSEvent) {
            self.scroll(event);
        }

        #[unsafe(method(keyDown:))]
        fn key_down(&self, event: &NSEvent) {
            let flags = event.modifierFlags();
            let characters = event
                .charactersIgnoringModifiers()
                .map(|s| s.to_string())
                .unwrap_or_default();
            let modifiers = Modifiers {
                shift: flags.contains(NSEventModifierFlags::Shift),
                ctrl: flags.contains(NSEventModifierFlags::Control),
                alt: flags.contains(NSEventModifierFlags::Option),
                meta: flags.contains(NSEventModifierFlags::Command),
            };
            if let Some(key) = mpv_key(event.keyCode(), &characters, modifiers) {
                self.input(&["keypress", key.as_str()]);
            }
        }
    }
);

impl VideoView {
    fn new(mtm: MainThreadMarker, mpv: Mpv, redraw: &'static Redraw) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(ViewState {
            mpv,
            redraw,
            scale: Cell::new(1.0),
            scrolled: Cell::new(0.0),
        });
        // SAFETY: NSObject's initialiser; the frame is set when placed.
        let view: Retained<Self> = unsafe { msg_send![super(this), init] };
        // Mouse moves, enters and exits anywhere over the visible video, while
        // the app is active.
        let options = NSTrackingAreaOptions::MouseMoved
            | NSTrackingAreaOptions::MouseEnteredAndExited
            | NSTrackingAreaOptions::ActiveInKeyWindow
            | NSTrackingAreaOptions::InVisibleRect;
        let owner: &AnyObject = &view;
        // SAFETY: the rect is ignored with `InVisibleRect`; the view outlives
        // the area, which it owns.
        let area = unsafe {
            NSTrackingArea::initWithRect_options_owner_userInfo(
                NSTrackingArea::alloc(),
                NSRect::ZERO,
                options,
                Some(owner),
                None,
            )
        };
        view.addTrackingArea(&area);
        view
    }

    /// Input goes to mpv's input queue; a failure only loses that event.
    fn input(&self, args: &[&str]) {
        if let Err(err) = self.ivars().mpv.command(args) {
            log::debug!("mpv input {args:?}: {err}");
        }
    }

    /// Tells mpv where the mouse is, in pixels from the top left.
    fn move_to(&self, event: &NSEvent) {
        let point = self.convertPoint_fromView(event.locationInWindow(), None);
        // In the pixels of the frame mpv drew, wherever its size came from.
        let size = self.bounds().size;
        let drawn = self.ivars().redraw.size.load(Ordering::Acquire);
        let (scale_x, scale_y) = if drawn != 0 && size.width > 0.0 && size.height > 0.0 {
            (
                (drawn >> 32) as f64 / size.width,
                (drawn & 0xffff_ffff) as f64 / size.height,
            )
        } else {
            let scale = self.ivars().scale.get();
            (scale, scale)
        };
        let x = ((point.x * scale_x).round() as i64).to_string();
        let y = ((point.y * scale_y).round() as i64).to_string();
        self.input(&["mouse", x.as_str(), y.as_str()]);
    }

    fn press(&self, event: &NSEvent, action: &str, button: &str) {
        if action == "keydown" {
            // Keyboard shortcuts go to mpv after a click on the video.
            if let Some(window) = self.window() {
                window.makeFirstResponder(Some(self));
            }
        }
        self.move_to(event);
        self.input(&[action, button]);
    }

    /// One wheel step per notch, or per 24 points of trackpad scrolling.
    fn scroll(&self, event: &NSEvent) {
        let delta = event.scrollingDeltaY();
        let steps = if event.hasPreciseScrollingDeltas() {
            let total = self.ivars().scrolled.get() + delta;
            let steps = (total / 24.0).trunc();
            self.ivars().scrolled.set(total - steps * 24.0);
            steps as i64
        } else if delta == 0.0 {
            // Horizontal wheels and scroll phases; `signum` would make this 1.
            0
        } else {
            delta.signum() as i64
        };
        let key = if steps > 0 { "WHEEL_UP" } else { "WHEEL_DOWN" };
        for _ in 0..steps.unsigned_abs().min(5) {
            self.input(&["keypress", key]);
        }
    }
}

#[derive(Clone, Copy, Default)]
struct Modifiers {
    shift: bool,
    ctrl: bool,
    alt: bool,
    meta: bool,
}

/// mpv's name for a key press, such as `f`, `F`, `Ctrl+LEFT` or `SPACE`.
/// `characters` is what the key types with Shift but without other modifiers,
/// so Shift is already part of printable keys.
fn mpv_key(code: u16, characters: &str, modifiers: Modifiers) -> Option<String> {
    let special = match code {
        36 => "ENTER",
        48 => "TAB",
        49 => "SPACE",
        51 => "BS",
        53 => "ESC",
        76 => "KP_ENTER",
        96 => "F5",
        97 => "F6",
        98 => "F7",
        99 => "F3",
        100 => "F8",
        101 => "F9",
        103 => "F11",
        109 => "F10",
        111 => "F12",
        115 => "HOME",
        116 => "PGUP",
        117 => "DEL",
        118 => "F4",
        119 => "END",
        120 => "F2",
        121 => "PGDWN",
        122 => "F1",
        123 => "LEFT",
        124 => "RIGHT",
        125 => "DOWN",
        126 => "UP",
        _ => "",
    };
    let mut name = String::new();
    let key = if special.is_empty() {
        let mut chars = characters.chars();
        let c = chars.next()?;
        if chars.next().is_some() || c.is_control() {
            return None;
        }
        match c {
            '#' => "SHARP".to_owned(),
            c => c.to_string(),
        }
    } else {
        if modifiers.shift {
            name.push_str("Shift+");
        }
        special.to_owned()
    };
    if modifiers.ctrl {
        name.push_str("Ctrl+");
    }
    if modifiers.alt {
        name.push_str("Alt+");
    }
    if modifiers.meta {
        name.push_str("Meta+");
    }
    name.push_str(&key);
    Some(name)
}

struct Views {
    webview: Retained<NSView>,
    clip: Retained<ClipView>,
    video: Retained<VideoView>,
    layer: Retained<VideoLayer>,
    redraw: &'static Redraw,
}

impl Views {
    /// A rect in CSS pixels relative to the viewport, in the webview's
    /// superview's coordinates. CSS pixels are points, as the webview is not
    /// zoomed. `inset` is how far below the webview's top the viewport starts.
    fn in_parent(&self, inset: f64, x: f64, y: f64, width: f64, height: f64) -> NSRect {
        let view = self.webview.bounds();
        let top = inset + y;
        let y = if self.webview.isFlipped() {
            view.origin.y + top
        } else {
            view.origin.y + view.size.height - top - height
        };
        let x = view.origin.x + x;
        let rect = NSRect::new(NSPoint::new(x, y), NSSize::new(width, height));
        // SAFETY: read on the main thread, as `Views` always is.
        let parent = unsafe { self.webview.superview() };
        self.webview.convertRect_toView(rect, parent.as_deref())
    }

    fn place(&self, bounds: &Bounds) {
        let (rect, Some(visible)) = (bounds.rect, bounds.visible) else {
            return self.hide();
        };
        if visible.width <= 0.0 || visible.height <= 0.0 {
            return self.hide();
        }
        // On recent macOS the webview reaches under the title bar, and the page
        // starts below it.
        let inset = bounds.viewport.map_or(0.0, |viewport| {
            (self.webview.bounds().size.height - viewport.height).max(0.0)
        });
        CATransaction::begin();
        CATransaction::setDisableActions(true);
        self.clip.setFrame(self.in_parent(
            inset,
            visible.x,
            visible.y,
            visible.width,
            visible.height,
        ));
        // The clip view is flipped, so this is the offset from its top left.
        self.video.setFrame(NSRect::new(
            NSPoint::new(rect.x - visible.x, rect.y - visible.y),
            NSSize::new(rect.width, rect.height),
        ));
        self.video.ivars().scale.set(bounds.scale);
        self.layer.setContentsScale(bounds.scale);
        self.layer.setFrame(self.video.bounds());
        CATransaction::commit();
        self.clip.setHidden(false);
        self.redraw.request();
    }

    fn hide(&self) {
        self.clip.setHidden(true);
        // Keys go back to the page.
        if let Some(window) = self.video.window() {
            let focused = window.firstResponder();
            let video: &NSResponder = &self.video;
            if focused.as_deref().is_some_and(|f| std::ptr::eq(f, video)) {
                window.makeFirstResponder(Some(&self.webview));
            }
        }
    }
}

/// Builds the views over `webview`, hidden until placed. Main thread only.
fn build(webview: *mut c_void, mpv: Mpv) -> Result<MainThreadBound<Views>, String> {
    let mtm = MainThreadMarker::new().ok_or("not on the main thread")?;
    // SAFETY: Tauri hands over its WKWebView, an NSView.
    let webview: Retained<NSView> =
        unsafe { Retained::retain(webview.cast()) }.ok_or("no webview")?;
    // SAFETY: on the main thread.
    let parent = unsafe { webview.superview() }.ok_or("the webview has no parent view")?;

    let gl = Gl::new()?;
    let renderer = gl.with_current(|| Renderer::new(&mpv, get_proc_address))?;
    // Shared with mpv's update callback for the app's lifetime.
    let redraw = Redraw::new();
    // SAFETY: `redraw` is never freed.
    unsafe { renderer.on_update(on_update, (redraw as *const Redraw).cast_mut().cast()) };

    let layer = VideoLayer::new(LayerState {
        gl,
        renderer,
        redraw,
        drawing: Mutex::new(()),
    });
    redraw
        .layer
        .store(Retained::as_ptr(&layer).cast_mut(), Ordering::Release);
    let video = VideoView::new(mtm, mpv, redraw);
    // Setting the layer before `wantsLayer` makes the view host it as is.
    video.setLayer(Some(&layer));
    video.setWantsLayer(true);
    let clip = ClipView::new(mtm);
    clip.setWantsLayer(true);
    if let Some(clip_layer) = clip.layer() {
        clip_layer.setMasksToBounds(true);
    }
    clip.addSubview(&video);
    clip.setHidden(true);
    parent.addSubview_positioned_relativeTo(&clip, NSWindowOrderingMode::Above, Some(&webview));
    Ok(MainThreadBound::new(
        Views {
            webview,
            clip,
            video,
            layer,
            redraw,
        },
        mtm,
    ))
}

/// The video views. The handle can be used from any thread; the views
/// themselves are only touched on the main thread.
pub struct Surface {
    window: WebviewWindow,
    views: Arc<MainThreadBound<Views>>,
}

impl Surface {
    /// Creates mpv's renderer and the hidden views over `window`'s webview.
    /// mpv must already be initialised with `vo=libmpv`.
    pub async fn create(window: &WebviewWindow, mpv: &Mpv) -> Result<Self, String> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let mpv = mpv.clone();
        window
            .with_webview(move |webview| {
                let _ = sender.send(build(webview.inner(), mpv));
            })
            .map_err(|err| err.to_string())?;
        let views = receiver
            .await
            .map_err(|_| "the video view was not created".to_owned())??;
        Ok(Self {
            window: window.clone(),
            views: Arc::new(views),
        })
    }

    fn on_main(&self, f: impl FnOnce(&Views) + Send + 'static) {
        let views = self.views.clone();
        let _ = self.window.run_on_main_thread(move || {
            if let Some(mtm) = MainThreadMarker::new() {
                f(views.get(mtm));
            }
        });
    }

    /// Moves the video to `bounds` and shows its visible part, or hides it
    /// when nothing is visible.
    pub fn place(&self, bounds: &Bounds) {
        let bounds = *bounds;
        self.on_main(move |views| views.place(&bounds));
    }

    pub fn hide(&self) {
        self.on_main(Views::hide);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONE: Modifiers = Modifiers {
        shift: false,
        ctrl: false,
        alt: false,
        meta: false,
    };

    #[test]
    fn names_keys_like_mpv() {
        assert_eq!(mpv_key(3, "f", NONE).as_deref(), Some("f"));
        // Shift is already in the character.
        let shift = Modifiers {
            shift: true,
            ..NONE
        };
        assert_eq!(mpv_key(3, "F", shift).as_deref(), Some("F"));
        assert_eq!(mpv_key(20, "#", shift).as_deref(), Some("SHARP"));
        assert_eq!(mpv_key(49, " ", NONE).as_deref(), Some("SPACE"));
        assert_eq!(mpv_key(53, "\u{1b}", NONE).as_deref(), Some("ESC"));
        assert_eq!(mpv_key(124, "", shift).as_deref(), Some("Shift+RIGHT"));
        let ctrl = Modifiers { ctrl: true, ..NONE };
        assert_eq!(mpv_key(123, "", ctrl).as_deref(), Some("Ctrl+LEFT"));
        assert_eq!(mpv_key(46, "m", ctrl).as_deref(), Some("Ctrl+m"));
    }

    #[test]
    fn skips_keys_mpv_cannot_name() {
        assert_eq!(mpv_key(200, "", NONE), None);
        assert_eq!(mpv_key(200, "ab", NONE), None);
        assert_eq!(mpv_key(200, "\u{7f}", NONE), None);
    }
}
