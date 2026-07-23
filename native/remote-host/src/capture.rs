use std::mem::size_of;

use anyhow::{Result, bail};
use windows::Win32::Foundation::{LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CAPTUREBLT, CreateCompatibleBitmap, CreateCompatibleDC,
    DEVMODEW, DIB_RGB_COLORS, DMDO_90, DMDO_180, DMDO_270, DeleteDC, DeleteObject,
    ENUM_CURRENT_SETTINGS, EnumDisplayMonitors, EnumDisplaySettingsW, GetDC, GetDIBits,
    GetMonitorInfoW, HALFTONE, HBITMAP, HDC, HGDIOBJ, HMONITOR, MONITORINFO, MONITORINFOEXW,
    ReleaseDC, SRCCOPY, SelectObject, SetStretchBltMode, StretchBlt,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CURSOR_SHOWING, CURSORINFO, DI_NORMAL, DrawIconEx, GetCursorInfo, GetSystemMetrics, HICON,
    MONITORINFOF_PRIMARY, SM_CXCURSOR, SM_CYCURSOR,
};
use windows::core::{BOOL, PCWSTR};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayDescriptor {
    pub id: String,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub rotation_degrees: u16,
    pub primary: bool,
}

pub fn enumerate_displays() -> Result<Vec<DisplayDescriptor>> {
    unsafe extern "system" fn collect(
        monitor: HMONITOR,
        _dc: HDC,
        _rect: *mut RECT,
        data: LPARAM,
    ) -> BOOL {
        let displays = unsafe { &mut *(data.0 as *mut Vec<DisplayDescriptor>) };
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
        if !unsafe {
            GetMonitorInfoW(
                monitor,
                (&mut info as *mut MONITORINFOEXW).cast::<MONITORINFO>(),
            )
        }
        .as_bool()
        {
            return BOOL(1);
        }
        let rect = info.monitorInfo.rcMonitor;
        let width = (rect.right - rect.left).max(0) as u32;
        let height = (rect.bottom - rect.top).max(0) as u32;
        if width == 0 || height == 0 {
            return BOOL(1);
        }
        let end = info
            .szDevice
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(info.szDevice.len());
        let device = String::from_utf16_lossy(&info.szDevice[..end]);
        let mut mode = DEVMODEW {
            dmSize: size_of::<DEVMODEW>() as u16,
            ..Default::default()
        };
        let rotation_degrees = if unsafe {
            EnumDisplaySettingsW(
                PCWSTR(info.szDevice.as_ptr()),
                ENUM_CURRENT_SETTINGS,
                &mut mode,
            )
        }
        .as_bool()
        {
            match unsafe { mode.Anonymous1.Anonymous2.dmDisplayOrientation } {
                value if value == DMDO_90 => 90,
                value if value == DMDO_180 => 180,
                value if value == DMDO_270 => 270,
                _ => 0,
            }
        } else {
            0
        };
        let ordinal = displays.len() + 1;
        displays.push(DisplayDescriptor {
            id: if device.is_empty() {
                format!("display-{ordinal}")
            } else {
                device.clone()
            },
            name: if device.is_empty() {
                format!("Display {ordinal}")
            } else {
                device
            },
            x: rect.left,
            y: rect.top,
            width,
            height,
            rotation_degrees,
            primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
        });
        BOOL(1)
    }

    let mut displays = Vec::<DisplayDescriptor>::new();
    let ok = unsafe {
        EnumDisplayMonitors(
            None,
            None,
            Some(collect),
            LPARAM((&mut displays as *mut Vec<DisplayDescriptor>) as isize),
        )
    };
    if !ok.as_bool() {
        bail!("EnumDisplayMonitors failed");
    }
    displays.sort_by_key(|display| (!display.primary, display.x, display.y));
    if displays.is_empty() {
        bail!("no active display is available");
    }
    Ok(displays)
}

/// A reusable top-down BGRA capture of one interactive display.
/// GDI is the compatibility path; the service agent can replace it with DXGI
/// without changing the encoder/transport contract.
pub struct DisplayCapture {
    screen_dc: HDC,
    memory_dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    source: DisplayDescriptor,
    width: usize,
    height: usize,
    pixels: Vec<u8>,
}

// The capture owns independent GDI handles and is used on one dedicated
// capture thread only.
unsafe impl Send for DisplayCapture {}

impl DisplayCapture {
    pub fn new(source: DisplayDescriptor, max_width: u32, max_height: u32) -> Result<Self> {
        let scale = f64::min(
            1.0,
            f64::min(
                max_width as f64 / source.width as f64,
                max_height as f64 / source.height as f64,
            ),
        );
        let width = even_dimension((source.width as f64 * scale).round() as usize);
        let height = even_dimension((source.height as f64 * scale).round() as usize);

        let screen_dc = unsafe { GetDC(None) };
        if screen_dc.0.is_null() {
            bail!("GetDC failed");
        }
        let memory_dc = unsafe { CreateCompatibleDC(Some(screen_dc)) };
        if memory_dc.0.is_null() {
            unsafe { ReleaseDC(None, screen_dc) };
            bail!("CreateCompatibleDC failed");
        }
        let bitmap = unsafe { CreateCompatibleBitmap(screen_dc, width as i32, height as i32) };
        if bitmap.0.is_null() {
            unsafe {
                let _ = DeleteDC(memory_dc);
                ReleaseDC(None, screen_dc);
            }
            bail!("CreateCompatibleBitmap failed");
        }
        let previous = unsafe { SelectObject(memory_dc, HGDIOBJ(bitmap.0)) };
        unsafe { SetStretchBltMode(memory_dc, HALFTONE) };
        Ok(Self {
            screen_dc,
            memory_dc,
            bitmap,
            previous,
            source,
            width,
            height,
            pixels: vec![0; width * height * 4],
        })
    }

    pub fn dimensions(&self) -> (usize, usize) {
        (self.width, self.height)
    }

    pub fn capture(&mut self) -> Result<&[u8]> {
        let copied = unsafe {
            StretchBlt(
                self.memory_dc,
                0,
                0,
                self.width as i32,
                self.height as i32,
                Some(self.screen_dc),
                self.source.x,
                self.source.y,
                self.source.width as i32,
                self.source.height as i32,
                SRCCOPY | CAPTUREBLT,
            )
        };
        if !copied.as_bool() {
            bail!("desktop capture failed");
        }
        self.draw_cursor();
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: self.width as i32,
                // Negative height asks GDI for top-down rows.
                biHeight: -(self.height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                biSizeImage: self.pixels.len() as u32,
                ..Default::default()
            },
            ..Default::default()
        };
        let rows = unsafe {
            GetDIBits(
                self.memory_dc,
                self.bitmap,
                0,
                self.height as u32,
                Some(self.pixels.as_mut_ptr().cast()),
                &mut info,
                DIB_RGB_COLORS,
            )
        };
        if rows != self.height as i32 {
            bail!("GetDIBits returned an incomplete frame");
        }
        Ok(&self.pixels)
    }

    fn draw_cursor(&self) {
        let mut cursor = CURSORINFO {
            cbSize: size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        if unsafe { GetCursorInfo(&mut cursor) }.is_err() || cursor.flags != CURSOR_SHOWING {
            return;
        }
        let relative_x = cursor.ptScreenPos.x - self.source.x;
        let relative_y = cursor.ptScreenPos.y - self.source.y;
        if relative_x < 0
            || relative_y < 0
            || relative_x >= self.source.width as i32
            || relative_y >= self.source.height as i32
        {
            return;
        }
        let scale_x = self.width as f64 / self.source.width as f64;
        let scale_y = self.height as f64 / self.source.height as f64;
        let x = (relative_x as f64 * scale_x).round() as i32;
        let y = (relative_y as f64 * scale_y).round() as i32;
        let width = (unsafe { GetSystemMetrics(SM_CXCURSOR) } as f64 * scale_x)
            .round()
            .max(8.0) as i32;
        let height = (unsafe { GetSystemMetrics(SM_CYCURSOR) } as f64 * scale_y)
            .round()
            .max(8.0) as i32;
        let _ = unsafe {
            DrawIconEx(
                self.memory_dc,
                x,
                y,
                HICON(cursor.hCursor.0),
                width,
                height,
                0,
                None,
                DI_NORMAL,
            )
        };
    }
}

impl Drop for DisplayCapture {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.memory_dc, self.previous);
            let _ = DeleteObject(HGDIOBJ(self.bitmap.0));
            let _ = DeleteDC(self.memory_dc);
            ReleaseDC(None, self.screen_dc);
        }
    }
}

fn even_dimension(value: usize) -> usize {
    value.max(2) & !1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dimensions_are_even_for_yuv420() {
        assert_eq!(even_dimension(1), 2);
        assert_eq!(even_dimension(721), 720);
        assert_eq!(even_dimension(1080), 1080);
    }
}
