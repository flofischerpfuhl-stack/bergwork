//! Screen eyedropper (`ScreenColorHost`, PRODUCT-PLAN 6.1 "Pipette überall (Tauri: ganzer Bildschirm)").
//!
//! The browser EyeDropper API is used where the webview has it (WebView2 on Windows). Where it does not
//! (WebKitGTK on Linux), the editor asks this host capability instead: the next left click anywhere on the
//! screen samples one pixel of the desktop; right click, Escape or a 60 s timeout cancel.
//!
//! - Linux X11: grabs the pointer on the root window with a crosshair cursor, then `XGetImage` of one pixel.
//!   libX11 is opened at run time (x11-dl), so the app still starts on systems without it.
//! - Windows: low-level mouse/keyboard hooks swallow the picking click (it must not reach the window under the
//!   pointer), then `GetPixel` on the desktop DC.
//! - Wayland: a Wayland session does not let clients read other clients' pixels or grab the pointer globally.
//!   Under XWayland the root window only shows X clients, so the pick is refused with `wayland-unsupported` and the
//!   editor falls back to the canvas eyedropper. The proper route is the xdg-desktop-portal `Screenshot.PickColor`
//!   call (needs a D-Bus client and a signal listener; not implemented yet).

use std::time::Duration;

/// Longest time a pick waits for the click.
const PICK_TIMEOUT: Duration = Duration::from_secs(60);

/// `Ok(None)` when the user cancelled; `Err` with a stable code when this system cannot pick from the screen.
pub fn pick() -> Result<Option<[u8; 3]>, String> {
    imp::pick()
}

/// What this build and session support: `x11`, `windows`, `wayland-unsupported` or `unsupported`.
pub fn support() -> &'static str {
    imp::support()
}

#[tauri::command]
pub async fn pick_screen_color() -> Result<Option<[u8; 3]>, String> {
    tauri::async_runtime::spawn_blocking(pick)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn screen_color_support() -> String {
    support().to_string()
}

/// Channel value of an X11 pixel under a visual mask, scaled to 8 bits.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
fn masked_channel(pixel: u64, mask: u64) -> u8 {
    if mask == 0 {
        return 0;
    }
    let shift = mask.trailing_zeros();
    let max = mask >> shift;
    let value = (pixel & mask) >> shift;
    ((value * 255 + max / 2) / max) as u8
}

#[cfg(target_os = "linux")]
mod imp {
    use super::{masked_channel, PICK_TIMEOUT};
    use std::{env, os::raw::c_int, ptr, thread, time::Instant};
    use x11_dl::xlib;

    fn wayland_session() -> bool {
        env::var_os("WAYLAND_DISPLAY").is_some()
            || env::var("XDG_SESSION_TYPE").map(|value| value.eq_ignore_ascii_case("wayland")).unwrap_or(false)
    }

    pub fn support() -> &'static str {
        if wayland_session() {
            return "wayland-unsupported";
        }
        if env::var_os("DISPLAY").is_some() && xlib::Xlib::open().is_ok() {
            "x11"
        } else {
            "unsupported"
        }
    }

    pub fn pick() -> Result<Option<[u8; 3]>, String> {
        if wayland_session() {
            return Err("wayland-unsupported".into());
        }
        let xlib = xlib::Xlib::open().map_err(|_| "unsupported".to_string())?;
        unsafe {
            let display = (xlib.XOpenDisplay)(ptr::null());
            if display.is_null() {
                return Err("unsupported".into());
            }
            let result = pick_on(&xlib, display);
            (xlib.XCloseDisplay)(display);
            result
        }
    }

    unsafe fn pick_on(xlib: &xlib::Xlib, display: *mut xlib::Display) -> Result<Option<[u8; 3]>, String> {
        const XC_CROSSHAIR: u32 = 34;
        const XK_ESCAPE: u64 = 0xff1b;
        let root = (xlib.XDefaultRootWindow)(display);
        let cursor = (xlib.XCreateFontCursor)(display, XC_CROSSHAIR);
        let grabbed = (xlib.XGrabPointer)(
            display,
            root,
            xlib::False,
            (xlib::ButtonPressMask | xlib::ButtonReleaseMask) as u32,
            xlib::GrabModeAsync,
            xlib::GrabModeAsync,
            0,
            cursor,
            xlib::CurrentTime,
        );
        if grabbed != xlib::GrabSuccess {
            (xlib.XFreeCursor)(display, cursor);
            return Err("busy".into());
        }
        // Escape cancels; without the keyboard grab the key would go to the focused window instead.
        let keyboard = (xlib.XGrabKeyboard)(display, root, xlib::False, xlib::GrabModeAsync, xlib::GrabModeAsync, xlib::CurrentTime);
        let started = Instant::now();
        let mut outcome: Option<Option<(c_int, c_int)>> = None;
        while outcome.is_none() {
            while (xlib.XPending)(display) > 0 {
                let mut event: xlib::XEvent = std::mem::zeroed();
                (xlib.XNextEvent)(display, &mut event);
                match event.get_type() {
                    xlib::ButtonPress => {
                        let button = event.button;
                        outcome = Some(if button.button == xlib::Button1 { Some((button.x_root, button.y_root)) } else { None });
                        break;
                    }
                    xlib::KeyPress => {
                        let mut key = event.key;
                        if (xlib.XLookupKeysym)(&mut key, 0) == XK_ESCAPE {
                            outcome = Some(None);
                            break;
                        }
                    }
                    _ => {}
                }
            }
            if outcome.is_none() {
                if started.elapsed() > PICK_TIMEOUT {
                    outcome = Some(None);
                } else {
                    thread::sleep(std::time::Duration::from_millis(8));
                }
            }
        }
        (xlib.XUngrabPointer)(display, xlib::CurrentTime);
        if keyboard == xlib::GrabSuccess {
            (xlib.XUngrabKeyboard)(display, xlib::CurrentTime);
        }
        (xlib.XFreeCursor)(display, cursor);
        (xlib.XFlush)(display);
        let Some((x, y)) = outcome.flatten() else { return Ok(None) };
        let image = (xlib.XGetImage)(display, root, x, y, 1, 1, !0, xlib::ZPixmap);
        if image.is_null() {
            return Err("read-failed".into());
        }
        let pixel = (xlib.XGetPixel)(image, 0, 0) as u64;
        let masks = &*image;
        let rgb = [
            masked_channel(pixel, masks.red_mask as u64),
            masked_channel(pixel, masks.green_mask as u64),
            masked_channel(pixel, masks.blue_mask as u64),
        ];
        (xlib.XDestroyImage)(image);
        Ok(Some(rgb))
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::PICK_TIMEOUT;
    use std::sync::Mutex;
    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{GetDC, GetPixel, ReleaseDC, CLR_INVALID};
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, PostThreadMessageW, SetTimer, SetWindowsHookExW, UnhookWindowsHookEx,
        KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_LBUTTONDOWN,
        WM_LBUTTONUP, WM_QUIT, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_TIMER,
    };

    struct PickState {
        thread: u32,
        point: Option<(i32, i32)>,
        /// The picking click's button-up is swallowed too, then the loop ends.
        finishing: bool,
    }

    static STATE: Mutex<Option<PickState>> = Mutex::new(None);

    fn finish(state: &PickState) {
        unsafe { PostThreadMessageW(state.thread, WM_QUIT, 0, 0) };
    }

    unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            if let Ok(mut guard) = STATE.lock() {
                if let Some(state) = guard.as_mut() {
                    let message = wparam as u32;
                    let info = &*(lparam as *const MSLLHOOKSTRUCT);
                    match message {
                        WM_LBUTTONDOWN => { state.point = Some((info.pt.x, info.pt.y)); state.finishing = true; return 1; }
                        WM_RBUTTONDOWN => { state.point = None; state.finishing = true; return 1; }
                        WM_LBUTTONUP | WM_RBUTTONUP if state.finishing => { finish(state); return 1; }
                        _ => {}
                    }
                }
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }

    unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 && wparam as u32 == WM_KEYDOWN {
            let info = &*(lparam as *const KBDLLHOOKSTRUCT);
            if info.vkCode == VK_ESCAPE as u32 {
                if let Ok(mut guard) = STATE.lock() {
                    if let Some(state) = guard.as_mut() { state.point = None; finish(state); }
                }
                return 1;
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }

    pub fn support() -> &'static str { "windows" }

    pub fn pick() -> Result<Option<[u8; 3]>, String> {
        {
            let mut guard = STATE.lock().map_err(|_| "busy".to_string())?;
            if guard.is_some() { return Err("busy".into()); }
            *guard = Some(PickState { thread: unsafe { GetCurrentThreadId() }, point: None, finishing: false });
        }
        let point = unsafe {
            let mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), std::ptr::null_mut(), 0);
            let keyboard = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), std::ptr::null_mut(), 0);
            if !mouse.is_null() {
                // A thread timer ends the wait after PICK_TIMEOUT (WM_TIMER arrives in this thread's queue).
                SetTimer(std::ptr::null_mut(), 0, PICK_TIMEOUT.as_millis() as u32, None);
                let mut message: MSG = std::mem::zeroed();
                while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
                    if message.message == WM_TIMER { break; }
                }
                UnhookWindowsHookEx(mouse);
            }
            if !keyboard.is_null() { UnhookWindowsHookEx(keyboard); }
            let state = STATE.lock().ok().and_then(|mut guard| guard.take());
            if mouse.is_null() { return Err("unsupported".into()); }
            state.and_then(|state| state.point)
        };
        let Some((x, y)) = point else { return Ok(None) };
        unsafe {
            let desktop = GetDC(std::ptr::null_mut());
            if desktop.is_null() { return Err("read-failed".into()); }
            let color = GetPixel(desktop, x, y);
            ReleaseDC(std::ptr::null_mut(), desktop);
            if color == CLR_INVALID { return Err("read-failed".into()); }
            // COLORREF is 0x00BBGGRR.
            Ok(Some([(color & 0xff) as u8, ((color >> 8) & 0xff) as u8, ((color >> 16) & 0xff) as u8]))
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
mod imp {
    pub fn support() -> &'static str { "unsupported" }
    pub fn pick() -> Result<Option<[u8; 3]>, String> { Err("unsupported".into()) }
}

#[cfg(test)]
mod tests {
    use super::masked_channel;

    #[test]
    fn masked_channels_scale_to_eight_bits() {
        // 24-bit TrueColor.
        assert_eq!(masked_channel(0x00ff8000, 0x00ff0000), 255);
        assert_eq!(masked_channel(0x00ff8000, 0x0000ff00), 128);
        assert_eq!(masked_channel(0x00ff8000, 0x000000ff), 0);
        // 16-bit RGB565: 5-bit red at full, 6-bit green at half.
        assert_eq!(masked_channel(0xf800 | (32 << 5), 0xf800), 255);
        assert_eq!(masked_channel(0xf800 | (32 << 5), 0x07e0), 130);
        assert_eq!(masked_channel(0, 0), 0);
    }
}
