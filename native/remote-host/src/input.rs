use std::collections::HashSet;
use std::mem::size_of;
use std::sync::{Arc, Mutex};

use anyhow::{Result, bail};
use serde::Deserialize;
use uuid::Uuid;
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData,
};
use windows::Win32::System::Memory::{
    GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY,
    KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, KEYEVENTF_UNICODE, MOUSE_EVENT_FLAGS, MOUSEEVENTF_HWHEEL,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
    MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSEINPUT,
    SendInput, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN, SetCursorPos,
};

use crate::capture::DisplayDescriptor;
use crate::protocol::{MAX_CLIPBOARD_BYTES, MAX_CONTROL_BYTES};

const CF_UNICODETEXT_VALUE: u32 = 13;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputChannel {
    Reliable,
    Pointer,
}

#[derive(Debug, PartialEq, Eq)]
pub enum InputOutcome {
    None,
    ClipboardText(String),
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum InputFrame {
    PointerAbsolute {
        session_id: Uuid,
        sequence: u64,
        x: f64,
        y: f64,
    },
    PointerRelative {
        session_id: Uuid,
        sequence: u64,
        dx: f64,
        dy: f64,
    },
    PointerButton {
        session_id: Uuid,
        sequence: u64,
        button: MouseButton,
        down: bool,
        x: Option<f64>,
        y: Option<f64>,
    },
    PointerClick {
        session_id: Uuid,
        sequence: u64,
        button: MouseButton,
        count: u8,
    },
    Wheel {
        session_id: Uuid,
        sequence: u64,
        delta_x: f64,
        delta_y: f64,
    },
    Key {
        session_id: Uuid,
        sequence: u64,
        code: String,
        down: bool,
        #[serde(default)]
        modifiers: Vec<Modifier>,
    },
    Text {
        session_id: Uuid,
        sequence: u64,
        text: String,
    },
    ClipboardWrite {
        session_id: Uuid,
        sequence: u64,
        text: String,
    },
    ClipboardRead {
        session_id: Uuid,
        sequence: u64,
    },
    SetDisplay {
        session_id: Uuid,
        sequence: u64,
        display_id: String,
    },
    SecureAttention {
        session_id: Uuid,
        sequence: u64,
    },
}

impl InputFrame {
    fn identity(&self) -> (Uuid, u64) {
        match self {
            Self::PointerAbsolute {
                session_id,
                sequence,
                ..
            }
            | Self::PointerRelative {
                session_id,
                sequence,
                ..
            }
            | Self::PointerButton {
                session_id,
                sequence,
                ..
            }
            | Self::PointerClick {
                session_id,
                sequence,
                ..
            }
            | Self::Wheel {
                session_id,
                sequence,
                ..
            }
            | Self::Key {
                session_id,
                sequence,
                ..
            }
            | Self::Text {
                session_id,
                sequence,
                ..
            }
            | Self::ClipboardWrite {
                session_id,
                sequence,
                ..
            }
            | Self::ClipboardRead {
                session_id,
                sequence,
            }
            | Self::SetDisplay {
                session_id,
                sequence,
                ..
            }
            | Self::SecureAttention {
                session_id,
                sequence,
            } => (*session_id, *sequence),
        }
    }

    fn expected_channel(&self) -> InputChannel {
        match self {
            Self::PointerAbsolute { .. } | Self::PointerRelative { .. } => InputChannel::Pointer,
            _ => InputChannel::Reliable,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum MouseButton {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Modifier {
    Control,
    Alt,
    Shift,
    Meta,
}

pub struct InputInjector {
    session_id: Uuid,
    last_reliable_sequence: u64,
    last_pointer_sequence: u64,
    pressed_keys: HashSet<u16>,
    pressed_buttons: HashSet<u8>,
    displays: Vec<DisplayDescriptor>,
    selected_display_id: Arc<Mutex<String>>,
}

impl InputInjector {
    pub fn new(session_id: Uuid) -> Self {
        let width = unsafe { GetSystemMetrics(SM_CXSCREEN) }.max(1) as u32;
        let height = unsafe { GetSystemMetrics(SM_CYSCREEN) }.max(1) as u32;
        Self::with_displays(
            session_id,
            vec![DisplayDescriptor {
                id: "primary".into(),
                name: "Primary display".into(),
                x: 0,
                y: 0,
                width,
                height,
                rotation_degrees: 0,
                primary: true,
            }],
            Arc::new(Mutex::new("primary".into())),
        )
    }

    pub fn with_displays(
        session_id: Uuid,
        displays: Vec<DisplayDescriptor>,
        selected_display_id: Arc<Mutex<String>>,
    ) -> Self {
        Self {
            session_id,
            last_reliable_sequence: 0,
            last_pointer_sequence: 0,
            pressed_keys: HashSet::new(),
            pressed_buttons: HashSet::new(),
            displays,
            selected_display_id,
        }
    }

    pub fn handle(&mut self, bytes: &[u8], channel: InputChannel) -> Result<InputOutcome> {
        if bytes.len() > MAX_CONTROL_BYTES {
            bail!("input frame exceeds limit");
        }
        let frame: InputFrame = serde_json::from_slice(bytes)?;
        if frame.expected_channel() != channel {
            bail!("input kind is not allowed on this channel");
        }
        let (session_id, sequence) = frame.identity();
        if session_id != self.session_id {
            bail!("input session mismatch");
        }
        let last = match channel {
            InputChannel::Reliable => &mut self.last_reliable_sequence,
            InputChannel::Pointer => &mut self.last_pointer_sequence,
        };
        if sequence == 0 || sequence <= *last {
            bail!("stale input sequence");
        }
        *last = sequence;

        match frame {
            InputFrame::PointerAbsolute { x, y, .. } => {
                let display = self.selected_display()?;
                set_absolute_pointer(x, y, display)?;
            }
            InputFrame::PointerRelative { dx, dy, .. } => {
                finite_pair(dx, dy)?;
                send_mouse(dx.round() as i32, dy.round() as i32, 0, MOUSEEVENTF_MOVE)?;
            }
            InputFrame::PointerButton {
                button, down, x, y, ..
            } => {
                if let (Some(x), Some(y)) = (x, y) {
                    let display = self.selected_display()?;
                    set_absolute_pointer(x, y, display)?;
                }
                self.set_button(button, down)?;
            }
            InputFrame::PointerClick { button, count, .. } => {
                if !(1..=2).contains(&count) {
                    bail!("invalid click count");
                }
                for _ in 0..count {
                    self.set_button(button, true)?;
                    self.set_button(button, false)?;
                }
            }
            InputFrame::Wheel {
                delta_x, delta_y, ..
            } => {
                finite_pair(delta_x, delta_y)?;
                if delta_y.abs() >= 0.5 {
                    send_mouse(0, 0, (-delta_y).round() as i32 as u32, MOUSEEVENTF_WHEEL)?;
                }
                if delta_x.abs() >= 0.5 {
                    send_mouse(0, 0, delta_x.round() as i32 as u32, MOUSEEVENTF_HWHEEL)?;
                }
            }
            InputFrame::Key {
                code,
                down,
                modifiers,
                ..
            } => self.set_key(&code, down, &modifiers)?,
            InputFrame::Text { text, .. } => inject_unicode(&text)?,
            InputFrame::ClipboardWrite { text, .. } => write_clipboard_text(&text)?,
            InputFrame::ClipboardRead { .. } => {
                return Ok(InputOutcome::ClipboardText(read_clipboard_text()?));
            }
            InputFrame::SetDisplay { display_id, .. } => {
                if !self.displays.iter().any(|display| display.id == display_id) {
                    bail!("unknown display");
                }
                *self
                    .selected_display_id
                    .lock()
                    .map_err(|_| anyhow::anyhow!("display selection poisoned"))? = display_id;
            }
            InputFrame::SecureAttention { .. } => bail!("secure attention is unavailable"),
        }
        Ok(InputOutcome::None)
    }

    pub fn release_all(&mut self) {
        for scan in self.pressed_keys.iter().copied().collect::<Vec<_>>() {
            if send_scan(scan, false, is_extended_scan(scan)).is_ok() {
                self.pressed_keys.remove(&scan);
            }
        }
        for id in self.pressed_buttons.iter().copied().collect::<Vec<_>>() {
            let button = match id {
                0 => MouseButton::Left,
                1 => MouseButton::Right,
                _ => MouseButton::Middle,
            };
            if send_button(button, false).is_ok() {
                self.pressed_buttons.remove(&id);
            }
        }
    }

    fn set_button(&mut self, button: MouseButton, down: bool) -> Result<()> {
        let id = match button {
            MouseButton::Left => 0,
            MouseButton::Right => 1,
            MouseButton::Middle => 2,
        };
        send_button(button, down)?;
        if down {
            self.pressed_buttons.insert(id);
        } else {
            self.pressed_buttons.remove(&id);
        }
        Ok(())
    }

    fn set_key(&mut self, code: &str, down: bool, modifiers: &[Modifier]) -> Result<()> {
        let (scan, modifier_scans) = key_plan(code, modifiers)?;
        if down {
            for scan in &modifier_scans {
                send_scan(*scan, true, is_extended_scan(*scan))?;
                self.pressed_keys.insert(*scan);
            }
        }
        send_scan(scan, down, is_extended_scan(scan))?;
        if down {
            self.pressed_keys.insert(scan);
        } else {
            self.pressed_keys.remove(&scan);
        }
        if !down {
            for scan in modifier_scans.into_iter().rev() {
                send_scan(scan, false, is_extended_scan(scan))?;
                self.pressed_keys.remove(&scan);
            }
        }
        Ok(())
    }

    fn selected_display(&self) -> Result<&DisplayDescriptor> {
        let selected = self
            .selected_display_id
            .lock()
            .map_err(|_| anyhow::anyhow!("display selection poisoned"))?
            .clone();
        self.displays
            .iter()
            .find(|display| display.id == selected)
            .ok_or_else(|| anyhow::anyhow!("selected display is unavailable"))
    }
}

fn key_plan(code: &str, modifiers: &[Modifier]) -> Result<(u16, Vec<u16>)> {
    let scan = scan_code(code).ok_or_else(|| anyhow::anyhow!("unknown key code"))?;
    if modifiers.len() > 4 {
        bail!("too many key modifiers");
    }
    let mut modifier_scans = Vec::with_capacity(modifiers.len());
    for modifier in modifiers {
        let modifier_scan = match modifier {
            Modifier::Control => 0x1d,
            Modifier::Alt => 0x38,
            Modifier::Shift => 0x2a,
            Modifier::Meta => 0x15b,
        };
        if modifier_scans.contains(&modifier_scan) {
            bail!("duplicate key modifier");
        }
        modifier_scans.push(modifier_scan);
    }
    Ok((scan, modifier_scans))
}

impl Drop for InputInjector {
    fn drop(&mut self) {
        self.release_all();
    }
}

fn finite_pair(a: f64, b: f64) -> Result<()> {
    if !a.is_finite() || !b.is_finite() {
        bail!("non-finite pointer coordinate");
    }
    Ok(())
}

fn set_absolute_pointer(x: f64, y: f64, display: &DisplayDescriptor) -> Result<()> {
    finite_pair(x, y)?;
    if !(0.0..=1.0).contains(&x) || !(0.0..=1.0).contains(&y) {
        bail!("pointer coordinate out of range");
    }
    unsafe {
        SetCursorPos(
            display.x + (x * display.width.saturating_sub(1) as f64).round() as i32,
            display.y + (y * display.height.saturating_sub(1) as f64).round() as i32,
        )?
    };
    Ok(())
}

fn send_button(button: MouseButton, down: bool) -> Result<()> {
    let flags = match (button, down) {
        (MouseButton::Left, true) => MOUSEEVENTF_LEFTDOWN,
        (MouseButton::Left, false) => MOUSEEVENTF_LEFTUP,
        (MouseButton::Right, true) => MOUSEEVENTF_RIGHTDOWN,
        (MouseButton::Right, false) => MOUSEEVENTF_RIGHTUP,
        (MouseButton::Middle, true) => MOUSEEVENTF_MIDDLEDOWN,
        (MouseButton::Middle, false) => MOUSEEVENTF_MIDDLEUP,
    };
    send_mouse(0, 0, 0, flags)
}

fn send_mouse(dx: i32, dy: i32, mouse_data: u32, flags: MOUSE_EVENT_FLAGS) -> Result<()> {
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: mouse_data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    if unsafe { SendInput(&[input], size_of::<INPUT>() as i32) } != 1 {
        bail!("SendInput mouse failed");
    }
    Ok(())
}

fn send_scan(scan: u16, down: bool, extended: bool) -> Result<()> {
    let scan_value = scan & 0xff;
    let mut flags = KEYEVENTF_SCANCODE;
    if !down {
        flags |= KEYEVENTF_KEYUP;
    }
    if extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: scan_value,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    if unsafe { SendInput(&[input], size_of::<INPUT>() as i32) } != 1 {
        bail!("SendInput keyboard failed");
    }
    Ok(())
}

fn inject_unicode(text: &str) -> Result<()> {
    if text.is_empty() || text.len() > MAX_CLIPBOARD_BYTES {
        bail!("invalid text input size");
    }
    let mut inputs = Vec::with_capacity(text.encode_utf16().count() * 2);
    for unit in text.encode_utf16() {
        for flags in [KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP] {
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(0),
                        wScan: unit,
                        dwFlags: flags,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
        }
    }
    if unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) } != inputs.len() as u32 {
        bail!("SendInput text failed");
    }
    Ok(())
}

fn write_clipboard_text(text: &str) -> Result<()> {
    if text.len() > MAX_CLIPBOARD_BYTES {
        bail!("clipboard text exceeds limit");
    }
    let utf16: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let bytes = utf16.len() * size_of::<u16>();
    let memory = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes)? };
    let pointer = unsafe { GlobalLock(memory) };
    if pointer.is_null() {
        unsafe {
            let _ = GlobalFree(Some(memory));
        }
        bail!("GlobalLock failed");
    }
    unsafe {
        std::ptr::copy_nonoverlapping(utf16.as_ptr().cast::<u8>(), pointer.cast::<u8>(), bytes);
        let _ = GlobalUnlock(memory);
    }
    let _clipboard = ClipboardGuard::open()?;
    unsafe { EmptyClipboard()? };
    if let Err(error) = unsafe { SetClipboardData(CF_UNICODETEXT_VALUE, Some(HANDLE(memory.0))) } {
        unsafe {
            let _ = GlobalFree(Some(memory));
        }
        return Err(error.into());
    }
    Ok(())
}

fn read_clipboard_text() -> Result<String> {
    let _clipboard = ClipboardGuard::open()?;
    let handle = unsafe { GetClipboardData(CF_UNICODETEXT_VALUE)? };
    let memory = HGLOBAL(handle.0);
    let size = unsafe { GlobalSize(memory) }.min(MAX_CLIPBOARD_BYTES + 2);
    if size == 0 || size > MAX_CLIPBOARD_BYTES + 2 {
        bail!("clipboard text exceeds limit");
    }
    let pointer = unsafe { GlobalLock(memory) };
    if pointer.is_null() {
        bail!("GlobalLock failed");
    }
    let units = unsafe { std::slice::from_raw_parts(pointer.cast::<u16>(), size / 2) };
    let end = units
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(units.len());
    let owned = units[..end].to_vec();
    unsafe {
        let _ = GlobalUnlock(memory);
    }
    Ok(String::from_utf16(&owned)?)
}

struct ClipboardGuard;
impl ClipboardGuard {
    fn open() -> Result<Self> {
        unsafe { OpenClipboard(None)? };
        Ok(Self)
    }
}
impl Drop for ClipboardGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseClipboard();
        }
    }
}

fn is_extended_scan(scan: u16) -> bool {
    scan > 0xff
}

fn scan_code(code: &str) -> Option<u16> {
    let scan = match code {
        "Escape" => 0x01,
        "Digit1" => 0x02,
        "Digit2" => 0x03,
        "Digit3" => 0x04,
        "Digit4" => 0x05,
        "Digit5" => 0x06,
        "Digit6" => 0x07,
        "Digit7" => 0x08,
        "Digit8" => 0x09,
        "Digit9" => 0x0a,
        "Digit0" => 0x0b,
        "Minus" => 0x0c,
        "Equal" => 0x0d,
        "Backspace" => 0x0e,
        "Tab" => 0x0f,
        "KeyQ" => 0x10,
        "KeyW" => 0x11,
        "KeyE" => 0x12,
        "KeyR" => 0x13,
        "KeyT" => 0x14,
        "KeyY" => 0x15,
        "KeyU" => 0x16,
        "KeyI" => 0x17,
        "KeyO" => 0x18,
        "KeyP" => 0x19,
        "BracketLeft" => 0x1a,
        "BracketRight" => 0x1b,
        "Enter" => 0x1c,
        "ControlLeft" => 0x1d,
        "KeyA" => 0x1e,
        "KeyS" => 0x1f,
        "KeyD" => 0x20,
        "KeyF" => 0x21,
        "KeyG" => 0x22,
        "KeyH" => 0x23,
        "KeyJ" => 0x24,
        "KeyK" => 0x25,
        "KeyL" => 0x26,
        "Semicolon" => 0x27,
        "Quote" => 0x28,
        "Backquote" => 0x29,
        "ShiftLeft" => 0x2a,
        "Backslash" => 0x2b,
        "KeyZ" => 0x2c,
        "KeyX" => 0x2d,
        "KeyC" => 0x2e,
        "KeyV" => 0x2f,
        "KeyB" => 0x30,
        "KeyN" => 0x31,
        "KeyM" => 0x32,
        "Comma" => 0x33,
        "Period" => 0x34,
        "Slash" => 0x35,
        "ShiftRight" => 0x36,
        "AltLeft" => 0x38,
        "Space" => 0x39,
        "CapsLock" => 0x3a,
        "F1" => 0x3b,
        "F2" => 0x3c,
        "F3" => 0x3d,
        "F4" => 0x3e,
        "F5" => 0x3f,
        "F6" => 0x40,
        "F7" => 0x41,
        "F8" => 0x42,
        "F9" => 0x43,
        "F10" => 0x44,
        "F11" => 0x57,
        "F12" => 0x58,
        "ControlRight" => 0x11d,
        "AltRight" => 0x138,
        "Home" => 0x147,
        "ArrowUp" => 0x148,
        "PageUp" => 0x149,
        "ArrowLeft" => 0x14b,
        "ArrowRight" => 0x14d,
        "End" => 0x14f,
        "ArrowDown" => 0x150,
        "PageDown" => 0x151,
        "Insert" => 0x152,
        "Delete" => 0x153,
        "MetaLeft" | "MetaRight" => 0x15b,
        _ => return None,
    };
    Some(scan)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_map_marks_extended_keys() {
        assert_eq!(scan_code("KeyA"), Some(0x1e));
        assert_eq!(scan_code("ArrowLeft"), Some(0x14b));
        assert!(is_extended_scan(scan_code("ArrowLeft").unwrap()));
        assert_eq!(scan_code("not-a-key"), None);
    }

    #[test]
    fn key_plan_rejects_the_entire_frame_before_any_injection() {
        assert!(key_plan("not-a-key", &[Modifier::Control]).is_err());
        assert!(key_plan("KeyA", &[Modifier::Control, Modifier::Control]).is_err());
        assert_eq!(
            key_plan("KeyA", &[Modifier::Control, Modifier::Shift]).unwrap(),
            (0x1e, vec![0x1d, 0x2a])
        );
    }

    #[test]
    fn parser_requires_the_bound_session_and_monotonic_sequence_before_injection() {
        let session = Uuid::new_v4();
        let mut injector = InputInjector::new(session);
        let wrong = format!(
            r#"{{"type":"set-display","sessionId":"{}","sequence":1,"displayId":"primary"}}"#,
            Uuid::new_v4()
        );
        assert!(
            injector
                .handle(wrong.as_bytes(), InputChannel::Reliable)
                .is_err()
        );
        let valid = format!(
            r#"{{"type":"set-display","sessionId":"{session}","sequence":2,"displayId":"primary"}}"#
        );
        assert_eq!(
            injector
                .handle(valid.as_bytes(), InputChannel::Reliable)
                .unwrap(),
            InputOutcome::None
        );
        assert!(
            injector
                .handle(valid.as_bytes(), InputChannel::Reliable)
                .is_err()
        );
    }
}
