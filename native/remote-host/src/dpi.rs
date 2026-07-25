use anyhow::{Context, Result};
use windows::Win32::UI::HiDpi::{
    AreDpiAwarenessContextsEqual, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    GetThreadDpiAwarenessContext, SetProcessDpiAwarenessContext,
};

/// Establishes physical-pixel monitor coordinates before GDI capture or
/// SendInput-related display enumeration can observe a virtualized desktop.
pub fn ensure_per_monitor_v2() -> Result<()> {
    let requested = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2;
    let result = unsafe { SetProcessDpiAwarenessContext(requested) };
    if result.is_ok() {
        return Ok(());
    }

    // A manifest or parent-created process may already have fixed the process
    // context. Treat that as success only when it is exactly the context the
    // capture/input contract requires.
    let current = unsafe { GetThreadDpiAwarenessContext() };
    if unsafe { AreDpiAwarenessContextsEqual(current, requested) }.as_bool() {
        return Ok(());
    }

    result.context("the remote host must run with Per-Monitor DPI Awareness v2")
}
