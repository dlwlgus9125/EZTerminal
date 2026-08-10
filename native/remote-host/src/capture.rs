use std::{mem::size_of, ptr, slice};

use anyhow::{Context, Result, bail};
use windows::Win32::Foundation::{HMODULE, LPARAM, RECT};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING, D3D11CreateDevice, ID3D11Device,
    ID3D11DeviceContext, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_MODE_ROTATION_IDENTITY, DXGI_MODE_ROTATION_UNSPECIFIED,
    DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, DXGI_ERROR_NOT_FOUND, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
    IDXGIAdapter1, IDXGIFactory1, IDXGIOutput1, IDXGIOutputDuplication, IDXGIResource,
};
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CAPTUREBLT, CreateCompatibleBitmap, CreateCompatibleDC,
    CreateDIBSection, DEVMODEW, DIB_RGB_COLORS, DMDO_90, DMDO_180, DMDO_270, DeleteDC,
    DeleteObject, ENUM_CURRENT_SETTINGS, EnumDisplayMonitors, EnumDisplaySettingsW, GetDC,
    GetDIBits, GetMonitorInfoW, HALFTONE, HBITMAP, HDC, HGDIOBJ, HMONITOR, MONITORINFO,
    MONITORINFOEXW, ReleaseDC, SRCCOPY, SelectObject, SetStretchBltMode, StretchBlt,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CURSOR_SHOWING, CURSORINFO, DI_NORMAL, DrawIconEx, GetCursorInfo, GetSystemMetrics, HICON,
    MONITORINFOF_PRIMARY, SM_CXCURSOR, SM_CYCURSOR,
};
use windows::core::{BOOL, Interface, PCWSTR};

use crate::protocol::{CaptureBackend, NormalizedRegion};

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

#[derive(Clone, Copy)]
struct CaptureGeometry {
    source_x: u32,
    source_y: u32,
    source_width: u32,
    source_height: u32,
    source_region: NormalizedRegion,
    width: usize,
    height: usize,
}

fn capture_geometry(
    source: &DisplayDescriptor,
    max_width: u32,
    max_height: u32,
    region: Option<NormalizedRegion>,
) -> Result<CaptureGeometry> {
    let source_region = region.unwrap_or(NormalizedRegion::FULL);
    if !source_region.is_valid() {
        bail!("invalid capture region");
    }
    let left = ((source_region.x * source.width as f64).floor() as u32)
        .min(source.width.saturating_sub(2));
    let top = ((source_region.y * source.height as f64).floor() as u32)
        .min(source.height.saturating_sub(2));
    let right = ((source_region.x + source_region.width) * source.width as f64).ceil() as u32;
    let bottom = ((source_region.y + source_region.height) * source.height as f64).ceil() as u32;
    let source_width = right.min(source.width).saturating_sub(left).max(2);
    let source_height = bottom.min(source.height).saturating_sub(top).max(2);
    let (width, height) = if region.is_some() {
        fitted_dimensions_with_upscale(source_width, source_height, max_width, max_height)
    } else {
        fitted_dimensions(source_width, source_height, max_width, max_height)
    };
    Ok(CaptureGeometry {
        source_x: left,
        source_y: top,
        source_width,
        source_height,
        source_region,
        width,
        height,
    })
}

enum DisplayCaptureInner {
    Dxgi(DxgiDisplayCapture),
    Gdi(GdiDisplayCapture),
}

/// Captures one display through DXGI Desktop Duplication when the selected
/// output supports it and falls back to GDI without changing the stream
/// contract. A runtime DXGI loss also moves the session to the compatibility
/// path on the next frame.
pub struct DisplayCapture {
    inner: DisplayCaptureInner,
    source: DisplayDescriptor,
    max_width: u32,
    max_height: u32,
    region: Option<NormalizedRegion>,
}

impl DisplayCapture {
    pub fn new(source: DisplayDescriptor, max_width: u32, max_height: u32) -> Result<Self> {
        Self::new_region(source, max_width, max_height, None)
    }

    pub fn new_region(
        source: DisplayDescriptor,
        max_width: u32,
        max_height: u32,
        region: Option<NormalizedRegion>,
    ) -> Result<Self> {
        let inner =
            match DxgiDisplayCapture::new_region(source.clone(), max_width, max_height, region) {
                Ok(capture) => DisplayCaptureInner::Dxgi(capture),
                Err(dxgi_error) => DisplayCaptureInner::Gdi(
                    GdiDisplayCapture::new_region(source.clone(), max_width, max_height, region)
                        .with_context(|| {
                            format!(
                                "DXGI capture unavailable ({dxgi_error:#}); GDI fallback failed"
                            )
                        })?,
                ),
            };
        Ok(Self {
            inner,
            source,
            max_width,
            max_height,
            region,
        })
    }

    pub fn dimensions(&self) -> (usize, usize) {
        match &self.inner {
            DisplayCaptureInner::Dxgi(capture) => capture.dimensions(),
            DisplayCaptureInner::Gdi(capture) => capture.dimensions(),
        }
    }

    pub fn source_region(&self) -> NormalizedRegion {
        match &self.inner {
            DisplayCaptureInner::Dxgi(capture) => capture.source_region(),
            DisplayCaptureInner::Gdi(capture) => capture.source_region(),
        }
    }

    pub fn backend(&self) -> CaptureBackend {
        match &self.inner {
            DisplayCaptureInner::Dxgi(_) => CaptureBackend::Dxgi,
            DisplayCaptureInner::Gdi(_) => CaptureBackend::Gdi,
        }
    }

    pub fn capture(&mut self) -> Result<&[u8]> {
        if matches!(&self.inner, DisplayCaptureInner::Dxgi(_)) {
            let failed = match &mut self.inner {
                DisplayCaptureInner::Dxgi(capture) => capture.capture_frame().is_err(),
                DisplayCaptureInner::Gdi(_) => unreachable!(),
            };
            if failed {
                self.inner = DisplayCaptureInner::Gdi(GdiDisplayCapture::new_region(
                    self.source.clone(),
                    self.max_width,
                    self.max_height,
                    self.region,
                )?);
            }
        }
        match &mut self.inner {
            DisplayCaptureInner::Dxgi(capture) => Ok(capture.pixels()),
            DisplayCaptureInner::Gdi(capture) => capture.capture(),
        }
    }
}

struct BgraDib {
    dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    bits: *mut u8,
    len: usize,
    width: usize,
    height: usize,
}

unsafe impl Send for BgraDib {}

impl BgraDib {
    fn new(width: usize, height: usize) -> Result<Self> {
        let dc = unsafe { CreateCompatibleDC(None) };
        if dc.0.is_null() {
            bail!("CreateCompatibleDC for DXGI frame failed");
        }
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width as i32,
                biHeight: -(height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                biSizeImage: (width * height * 4) as u32,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits = ptr::null_mut();
        let bitmap = match unsafe {
            CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0)
        } {
            Ok(bitmap) => bitmap,
            Err(error) => {
                unsafe {
                    let _ = DeleteDC(dc);
                }
                return Err(error).context("CreateDIBSection for DXGI frame failed");
            }
        };
        if bits.is_null() {
            unsafe {
                let _ = DeleteObject(HGDIOBJ(bitmap.0));
                let _ = DeleteDC(dc);
            }
            bail!("CreateDIBSection returned no frame memory");
        }
        let previous = unsafe { SelectObject(dc, HGDIOBJ(bitmap.0)) };
        unsafe {
            SetStretchBltMode(dc, HALFTONE);
        }
        Ok(Self {
            dc,
            bitmap,
            previous,
            bits: bits.cast(),
            len: width * height * 4,
            width,
            height,
        })
    }

    fn pixels(&self) -> &[u8] {
        unsafe { slice::from_raw_parts(self.bits, self.len) }
    }

    fn pixels_mut(&mut self) -> &mut [u8] {
        unsafe { slice::from_raw_parts_mut(self.bits, self.len) }
    }

    fn draw_cursor(
        &self,
        source: &DisplayDescriptor,
        source_x: u32,
        source_y: u32,
        source_width: u32,
        source_height: u32,
    ) {
        let mut cursor = CURSORINFO {
            cbSize: size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        if unsafe { GetCursorInfo(&mut cursor) }.is_err() || cursor.flags != CURSOR_SHOWING {
            return;
        }
        let relative_x = cursor.ptScreenPos.x - (source.x + source_x as i32);
        let relative_y = cursor.ptScreenPos.y - (source.y + source_y as i32);
        if relative_x < 0
            || relative_y < 0
            || relative_x >= source_width as i32
            || relative_y >= source_height as i32
        {
            return;
        }
        let scale_x = self.width as f64 / source_width as f64;
        let scale_y = self.height as f64 / source_height as f64;
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
                self.dc,
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

impl Drop for BgraDib {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc, self.previous);
            let _ = DeleteObject(HGDIOBJ(self.bitmap.0));
            let _ = DeleteDC(self.dc);
        }
    }
}

struct DxgiDisplayCapture {
    context: ID3D11DeviceContext,
    duplication: IDXGIOutputDuplication,
    staging: ID3D11Texture2D,
    source: DisplayDescriptor,
    geometry: CaptureGeometry,
    source_surface: BgraDib,
    output_surface: BgraDib,
    acquired_once: bool,
}

impl DxgiDisplayCapture {
    fn new_region(
        source: DisplayDescriptor,
        max_width: u32,
        max_height: u32,
        region: Option<NormalizedRegion>,
    ) -> Result<Self> {
        let geometry = capture_geometry(&source, max_width, max_height, region)?;
        let (adapter, output) = find_dxgi_output(&source)?;
        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;
        unsafe {
            D3D11CreateDevice(
                &adapter,
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
        }
        .context("D3D11CreateDevice for desktop duplication failed")?;
        let device = device.context("D3D11CreateDevice returned no device")?;
        let context = context.context("D3D11CreateDevice returned no context")?;
        let duplication = unsafe { output.DuplicateOutput(&device) }
            .context("IDXGIOutput1::DuplicateOutput failed")?;
        let duplication_desc = unsafe { duplication.GetDesc() };
        if duplication_desc.Rotation != DXGI_MODE_ROTATION_IDENTITY
            && duplication_desc.Rotation != DXGI_MODE_ROTATION_UNSPECIFIED
        {
            bail!("rotated DXGI output requires GDI fallback");
        }
        if duplication_desc.ModeDesc.Format != DXGI_FORMAT_B8G8R8A8_UNORM
            || duplication_desc.ModeDesc.Width != source.width
            || duplication_desc.ModeDesc.Height != source.height
        {
            bail!("DXGI output geometry or pixel format does not match the selected display");
        }
        let texture_desc = D3D11_TEXTURE2D_DESC {
            Width: duplication_desc.ModeDesc.Width,
            Height: duplication_desc.ModeDesc.Height,
            MipLevels: 1,
            ArraySize: 1,
            Format: duplication_desc.ModeDesc.Format,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut staging = None;
        unsafe { device.CreateTexture2D(&texture_desc, None, Some(&mut staging)) }
            .context("creating the DXGI staging texture failed")?;
        Ok(Self {
            context,
            duplication,
            staging: staging.context("D3D11 returned no staging texture")?,
            source,
            geometry,
            source_surface: BgraDib::new(
                geometry.source_width as usize,
                geometry.source_height as usize,
            )?,
            output_surface: BgraDib::new(geometry.width, geometry.height)?,
            acquired_once: false,
        })
    }

    fn dimensions(&self) -> (usize, usize) {
        (self.geometry.width, self.geometry.height)
    }

    fn source_region(&self) -> NormalizedRegion {
        self.geometry.source_region
    }

    fn pixels(&self) -> &[u8] {
        self.output_surface.pixels()
    }

    fn capture_frame(&mut self) -> Result<()> {
        let mut frame_info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut resource: Option<IDXGIResource> = None;
        let timeout_ms = if self.acquired_once { 0 } else { 100 };
        match unsafe {
            self.duplication
                .AcquireNextFrame(timeout_ms, &mut frame_info, &mut resource)
        } {
            Ok(()) => {}
            Err(error) if error.code() == DXGI_ERROR_WAIT_TIMEOUT && self.acquired_once => {
                return Ok(());
            }
            Err(error) => {
                return Err(error).context("acquiring the next DXGI desktop frame failed");
            }
        }
        let capture_result = self.copy_acquired_frame(resource);
        let release_result = unsafe { self.duplication.ReleaseFrame() };
        capture_result?;
        release_result.context("releasing the DXGI desktop frame failed")?;
        self.acquired_once = true;
        Ok(())
    }

    fn copy_acquired_frame(&mut self, resource: Option<IDXGIResource>) -> Result<()> {
        let texture = resource
            .context("DXGI returned no desktop resource")?
            .cast::<ID3D11Texture2D>()
            .context("DXGI desktop resource is not a D3D11 texture")?;
        unsafe {
            self.context.CopyResource(&self.staging, &texture);
        }
        let mut mapped = Default::default();
        unsafe {
            self.context
                .Map(&self.staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
        }
        .context("mapping the DXGI staging texture failed")?;
        let copy_result = (|| -> Result<()> {
            if mapped.pData.is_null() {
                bail!("DXGI mapped frame has no data");
            }
            let row_bytes = self.geometry.source_width as usize * 4;
            if (mapped.RowPitch as usize)
                < (self.geometry.source_x as usize * 4).saturating_add(row_bytes)
            {
                bail!("DXGI mapped frame row is shorter than the capture region");
            }
            let source = mapped.pData.cast::<u8>();
            let source_x_bytes = self.geometry.source_x as usize * 4;
            let row_pitch = mapped.RowPitch as usize;
            let target = self.source_surface.pixels_mut();
            for row in 0..self.geometry.source_height as usize {
                let source_offset = (self.geometry.source_y as usize + row)
                    .saturating_mul(row_pitch)
                    .saturating_add(source_x_bytes);
                let target_offset = row * row_bytes;
                unsafe {
                    ptr::copy_nonoverlapping(
                        source.add(source_offset),
                        target.as_mut_ptr().add(target_offset),
                        row_bytes,
                    );
                }
            }
            Ok(())
        })();
        unsafe {
            self.context.Unmap(&self.staging, 0);
        }
        copy_result?;
        let stretched = unsafe {
            StretchBlt(
                self.output_surface.dc,
                0,
                0,
                self.geometry.width as i32,
                self.geometry.height as i32,
                Some(self.source_surface.dc),
                0,
                0,
                self.geometry.source_width as i32,
                self.geometry.source_height as i32,
                SRCCOPY,
            )
        };
        if !stretched.as_bool() {
            bail!("scaling the DXGI desktop frame failed");
        }
        self.output_surface.draw_cursor(
            &self.source,
            self.geometry.source_x,
            self.geometry.source_y,
            self.geometry.source_width,
            self.geometry.source_height,
        );
        Ok(())
    }
}

fn find_dxgi_output(source: &DisplayDescriptor) -> Result<(IDXGIAdapter1, IDXGIOutput1)> {
    let factory: IDXGIFactory1 =
        unsafe { CreateDXGIFactory1() }.context("CreateDXGIFactory1 failed")?;
    let mut adapter_index = 0;
    loop {
        let adapter = match unsafe { factory.EnumAdapters1(adapter_index) } {
            Ok(adapter) => adapter,
            Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(error) => return Err(error).context("enumerating DXGI adapters failed"),
        };
        let mut output_index = 0;
        loop {
            let output = match unsafe { adapter.EnumOutputs(output_index) } {
                Ok(output) => output,
                Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break,
                Err(error) => return Err(error).context("enumerating DXGI outputs failed"),
            };
            let desc = unsafe { output.GetDesc() }.context("reading the DXGI output failed")?;
            let end = desc
                .DeviceName
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(desc.DeviceName.len());
            let name = String::from_utf16_lossy(&desc.DeviceName[..end]);
            let rect = desc.DesktopCoordinates;
            let geometry_matches = rect.left == source.x
                && rect.top == source.y
                && (rect.right - rect.left).max(0) as u32 == source.width
                && (rect.bottom - rect.top).max(0) as u32 == source.height;
            if desc.AttachedToDesktop.as_bool() && (name == source.id || geometry_matches) {
                return Ok((
                    adapter,
                    output
                        .cast::<IDXGIOutput1>()
                        .context("selected DXGI output does not support Desktop Duplication")?,
                ));
            }
            output_index += 1;
        }
        adapter_index += 1;
    }
    bail!("the selected display has no DXGI output")
}

/// A reusable top-down BGRA capture of one interactive display.
/// GDI is the compatibility path for outputs where Desktop Duplication cannot
/// be created or is lost at runtime.
struct GdiDisplayCapture {
    screen_dc: HDC,
    memory_dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    source: DisplayDescriptor,
    source_x: i32,
    source_y: i32,
    source_width: u32,
    source_height: u32,
    source_region: NormalizedRegion,
    width: usize,
    height: usize,
    pixels: Vec<u8>,
}

// The capture owns independent GDI handles and is used on one dedicated
// capture thread only.
unsafe impl Send for GdiDisplayCapture {}

impl GdiDisplayCapture {
    pub fn new_region(
        source: DisplayDescriptor,
        max_width: u32,
        max_height: u32,
        region: Option<NormalizedRegion>,
    ) -> Result<Self> {
        let geometry = capture_geometry(&source, max_width, max_height, region)?;

        let screen_dc = unsafe { GetDC(None) };
        if screen_dc.0.is_null() {
            bail!("GetDC failed");
        }
        let memory_dc = unsafe { CreateCompatibleDC(Some(screen_dc)) };
        if memory_dc.0.is_null() {
            unsafe { ReleaseDC(None, screen_dc) };
            bail!("CreateCompatibleDC failed");
        }
        let bitmap = unsafe {
            CreateCompatibleBitmap(screen_dc, geometry.width as i32, geometry.height as i32)
        };
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
            source_x: geometry.source_x as i32,
            source_y: geometry.source_y as i32,
            source_width: geometry.source_width,
            source_height: geometry.source_height,
            source_region: geometry.source_region,
            width: geometry.width,
            height: geometry.height,
            pixels: vec![0; geometry.width * geometry.height * 4],
        })
    }

    pub fn dimensions(&self) -> (usize, usize) {
        (self.width, self.height)
    }

    pub fn source_region(&self) -> NormalizedRegion {
        self.source_region
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
                self.source.x + self.source_x,
                self.source.y + self.source_y,
                self.source_width as i32,
                self.source_height as i32,
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
        let relative_x = cursor.ptScreenPos.x - (self.source.x + self.source_x);
        let relative_y = cursor.ptScreenPos.y - (self.source.y + self.source_y);
        if relative_x < 0
            || relative_y < 0
            || relative_x >= self.source_width as i32
            || relative_y >= self.source_height as i32
        {
            return;
        }
        let scale_x = self.width as f64 / self.source_width as f64;
        let scale_y = self.height as f64 / self.source_height as f64;
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

impl Drop for GdiDisplayCapture {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.memory_dc, self.previous);
            let _ = DeleteObject(HGDIOBJ(self.bitmap.0));
            let _ = DeleteDC(self.memory_dc);
            ReleaseDC(None, self.screen_dc);
        }
    }
}

pub fn fitted_dimensions(
    source_width: u32,
    source_height: u32,
    max_width: u32,
    max_height: u32,
) -> (usize, usize) {
    let scale = f64::min(
        1.0,
        f64::min(
            max_width as f64 / source_width.max(1) as f64,
            max_height as f64 / source_height.max(1) as f64,
        ),
    );
    (
        even_dimension((source_width.max(1) as f64 * scale).floor() as usize),
        even_dimension((source_height.max(1) as f64 * scale).floor() as usize),
    )
}

pub fn fitted_dimensions_with_upscale(
    source_width: u32,
    source_height: u32,
    max_width: u32,
    max_height: u32,
) -> (usize, usize) {
    let scale = f64::min(
        max_width.max(2) as f64 / source_width.max(1) as f64,
        max_height.max(2) as f64 / source_height.max(1) as f64,
    );
    (
        even_dimension((source_width.max(1) as f64 * scale).floor() as usize),
        even_dimension((source_height.max(1) as f64 * scale).floor() as usize),
    )
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

    #[test]
    fn viewport_fit_preserves_the_entire_landscape_source() {
        assert_eq!(fitted_dimensions(2_560, 1_440, 1_080, 1_920), (1_080, 606));
        assert_eq!(fitted_dimensions(2_560, 1_440, 1_170, 800), (1_170, 658));
    }

    #[test]
    fn viewport_fit_is_portrait_aware_and_never_upscales() {
        assert_eq!(
            fitted_dimensions(1_440, 2_560, 1_080, 1_920),
            (1_080, 1_920)
        );
        assert_eq!(fitted_dimensions(800, 600, 1_920, 1_080), (800, 600));
    }

    #[test]
    fn roi_fit_uses_the_available_encode_surface() {
        assert_eq!(
            fitted_dimensions_with_upscale(540, 960, 1_080, 1_920),
            (1_080, 1_920)
        );
        assert_eq!(
            fitted_dimensions_with_upscale(960, 540, 1_280, 720),
            (1_280, 720)
        );
    }

    #[test]
    fn roi_geometry_is_cropped_in_physical_display_pixels() {
        let display = DisplayDescriptor {
            id: "primary".into(),
            name: "Primary".into(),
            x: -2_560,
            y: 0,
            width: 2_560,
            height: 1_440,
            rotation_degrees: 0,
            primary: true,
        };
        let geometry = capture_geometry(
            &display,
            1_080,
            1_920,
            Some(NormalizedRegion {
                x: 0.9,
                y: 0.9,
                width: 0.1,
                height: 0.1,
            }),
        )
        .unwrap();
        assert_eq!(geometry.source_x, 2_304);
        assert_eq!(geometry.source_y, 1_296);
        assert_eq!(geometry.source_width, 256);
        assert_eq!(geometry.source_height, 144);
        assert_eq!((geometry.width, geometry.height), (1_080, 606));
    }
}
