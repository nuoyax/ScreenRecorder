use serde::Serialize;
use windows::Foundation::Metadata::ApiInformation;
use windows::Graphics::Capture::GraphicsCaptureItem;
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::core::BOOL;
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFOEXW,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::core::{Interface, HSTRING};

#[derive(Debug, Clone, Serialize)]
pub struct MonitorInfo {
    pub id: String,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub is_primary: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct WindowInfo {
    pub hwnd: isize,
    pub title: String,
}

pub fn is_supported() -> bool {
    ApiInformation::IsApiContractPresentByMajor(
        &HSTRING::from("Windows.Foundation.UniversalApiContract"),
        8,
    )
    .unwrap_or(false)
}

unsafe extern "system" fn monitor_enum_proc(
    hmonitor: HMONITOR,
    _hdc: HDC,
    _rect: *mut RECT,
    lparam: LPARAM,
) -> BOOL {
    let list = &mut *(lparam.0 as *mut Vec<MonitorInfo>);
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    if GetMonitorInfoW(hmonitor, &mut info as *mut _ as *mut _).as_bool() {
        let name = String::from_utf16_lossy(&info.szDevice)
            .trim_end_matches('\0')
            .to_string();
        list.push(MonitorInfo {
            id: name.clone(),
            name,
            x: info.monitorInfo.rcMonitor.left,
            y: info.monitorInfo.rcMonitor.top,
            width: info.monitorInfo.rcMonitor.right - info.monitorInfo.rcMonitor.left,
            height: info.monitorInfo.rcMonitor.bottom - info.monitorInfo.rcMonitor.top,
            is_primary: (info.monitorInfo.dwFlags & 1) != 0,
        });
    }
    true.into()
}

pub fn enumerate_monitors() -> Vec<MonitorInfo> {
    let mut list: Vec<MonitorInfo> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(monitor_enum_proc),
            LPARAM(&mut list as *mut _ as isize),
        );
    }
    list
}

pub fn enumerate_windows() -> Vec<WindowInfo> {
    let mut out = Vec::new();
    unsafe extern "system" fn wnd_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        if !windows::Win32::UI::WindowsAndMessaging::IsWindowVisible(hwnd).as_bool() {
            return true.into();
        }
        let len = unsafe {
            windows::Win32::UI::WindowsAndMessaging::GetWindowTextLengthW(hwnd)
        };
        if len <= 0 {
            return true.into();
        }
        let mut buf = vec![0u16; len as usize + 1];
        unsafe {
            windows::Win32::UI::WindowsAndMessaging::GetWindowTextW(hwnd, &mut buf);
        }
        let title = String::from_utf16_lossy(&buf[..len as usize]);
        let ex = unsafe {
            windows::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
                hwnd,
                windows::Win32::UI::WindowsAndMessaging::GWL_EXSTYLE,
            )
        };
        if ex & 0x80 != 0 {
            // WS_EX_TOOLWINDOW
            return true.into();
        }
        let list = &mut *(lparam.0 as *mut Vec<WindowInfo>);
        list.push(WindowInfo {
            hwnd: hwnd.0 as isize,
            title,
        });
        true.into()
    }
    unsafe {
        let _ = windows::Win32::UI::WindowsAndMessaging::EnumWindows(
            Some(wnd_proc),
            LPARAM(&mut out as *mut _ as isize),
        );
    }
    out
}

/// Find HMONITOR by device name (e.g. "\\.\DISPLAY1")
fn hmonitor_for(device_name: &str) -> Option<HMONITOR> {
    unsafe extern "system" fn find_proc(
        hmon: HMONITOR,
        _h: HDC,
        _r: *mut RECT,
        lp: LPARAM,
    ) -> BOOL {
        let ctx = &mut *(lp.0 as *mut (String, HMONITOR));
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        unsafe {
            if GetMonitorInfoW(hmon, &mut info as *mut _ as *mut _).as_bool() {
                let n = String::from_utf16_lossy(&info.szDevice)
                    .trim_end_matches('\0')
                    .to_string();
                if n == ctx.0 {
                    ctx.1 = hmon;
                }
            }
        }
        true.into()
    }
    let mut ctx = (device_name.to_string(), HMONITOR(std::ptr::null_mut()));
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(find_proc),
            LPARAM(&mut ctx as *mut _ as isize),
        );
    }
    if ctx.1 .0.is_null() {
        None
    } else {
        Some(ctx.1)
    }
}

/// Create a GraphicsCaptureItem for a monitor by device name
pub fn capture_item_for_monitor(device_name: &str) -> windows::core::Result<GraphicsCaptureItem> {
    let hm = hmonitor_for(device_name)
        .ok_or_else(|| windows::core::Error::from(windows::core::HRESULT(-1)))?;
    unsafe {
        let interop: IGraphicsCaptureItemInterop =
            windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
        interop.CreateForMonitor::<GraphicsCaptureItem>(hm)
    }
}

pub fn capture_item_for_window(hwnd: isize) -> windows::core::Result<GraphicsCaptureItem> {
    unsafe {
        let interop: IGraphicsCaptureItemInterop =
            windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
        interop.CreateForWindow::<GraphicsCaptureItem>(HWND(hwnd as *mut _))
    }
}

// keep Interface trait in scope for `.cast` use elsewhere
#[allow(unused_imports)]
use Interface as _;
