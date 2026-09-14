//! WGC frame capture → BGRA frames on a channel.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use windows::Foundation::{TimeSpan, TypedEventHandler};
use windows::Graphics::Capture::{
    Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_FLAG, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE,
    D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::System::WinRT::Direct3D11::CreateDirect3D11DeviceFromDXGIDevice;
use windows::core::{Interface, IInspectable};

use super::enum_sources::{capture_item_for_monitor, capture_item_for_window};

#[derive(Debug, Clone)]
pub struct RawFrame {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// capture-start-relative microseconds
    pub ts_us: u64,
}

pub struct CaptureHandle {
    pub stop: Arc<AtomicBool>,
    pub paused: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl CaptureHandle {
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

#[derive(Clone)]
pub enum SourceKind {
    Monitor(String),
    Window(isize),
}

fn create_d3d_device() -> windows::core::Result<(ID3D11Device, windows::Graphics::DirectX::Direct3D11::IDirect3DDevice)> {
    unsafe {
        let mut device: Option<ID3D11Device> = None;
        let mut ctx: Option<ID3D11DeviceContext> = None;
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            windows::Win32::Foundation::HMODULE::default(),
            D3D11_CREATE_DEVICE_FLAG(0),
            Some(&[D3D_FEATURE_LEVEL_11_0]),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut ctx),
        )?;
        let device = device.unwrap();
        let dxgi: IDXGIDevice = device.cast()?;
        let insp: IInspectable = CreateDirect3D11DeviceFromDXGIDevice(&dxgi)?;
        let winrt_device: windows::Graphics::DirectX::Direct3D11::IDirect3DDevice =
            insp.cast()?;
        Ok((device, winrt_device))
    }
}

/// Spawn a capture thread producing BGRA frames.
/// `region` (x,y,w,h) is in capture-item coordinates; None = full item.
pub fn start_capture(
    source: SourceKind,
    region: Option<(i32, i32, u32, u32)>,
    frame_tx: crossbeam_channel::Sender<RawFrame>,
) -> windows::core::Result<CaptureHandle> {
    let item = match source {
        SourceKind::Monitor(ref id) => capture_item_for_monitor(id)?,
        SourceKind::Window(hwnd) => capture_item_for_window(hwnd)?,
    };

    let (d3d_device, rt_device) = create_d3d_device()?;
    let ctx: ID3D11DeviceContext = unsafe { d3d_device.GetImmediateContext() }.ok().unwrap();

    let frame_size = item.Size()?;
    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        &rt_device,
        DirectXPixelFormat::B8G8R8A8UIntNormalized,
        2,
        frame_size,
    )?;
    let session: GraphicsCaptureSession = pool.CreateCaptureSession(&item)?;
    let _ = session.SetIsCursorCaptureEnabled(true);
    if let Ok(newer) = windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
        &windows::core::HSTRING::from("Windows.Graphics.Capture.GraphicsCaptureSession"),
        &windows::core::HSTRING::from("IsBorderRequired"),
    ) {
        if newer {
            let _ = session.SetIsBorderRequired(false);
        }
    }

    let stop = Arc::new(AtomicBool::new(false));
    let paused = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    let paused2 = paused.clone();

    let start_time = std::time::Instant::now();
    let item_w = frame_size.Width;
    let item_h = frame_size.Height;

    let (surface_tx, surface_rx) = crossbeam_channel::bounded::<Direct3D11CaptureFrame>(4);

    session.StartCapture()?;

    // FrameArrived handler token must stay alive for the pool's lifetime
    let _handler_token = pool.FrameArrived(
        &TypedEventHandler::<Direct3D11CaptureFramePool, IInspectable>::new(            move |pool, _| -> windows::core::Result<()> {
                if let Ok(frame) = pool.ok()?.TryGetNextFrame() {
                    let _ = surface_tx.try_send(frame);
                }
                Ok(())
            },
        ),
    )?;

    let device2 = d3d_device.clone();
    let join = std::thread::spawn(move || {
        while !stop2.load(Ordering::SeqCst) {
            if paused2.load(Ordering::SeqCst) {
                while let Ok(f) = surface_rx.try_recv() {

                    let _ = f.Close();

                }
                std::thread::sleep(std::time::Duration::from_millis(20));
                continue;
            }
            match surface_rx.recv_timeout(std::time::Duration::from_millis(200)) {
                Ok(frame) => {
                    let ts_us = start_time.elapsed().as_micros() as u64;
                    if let Some(tex) = extract_texture(&frame) {
                        let w = tex.width;
                        let hgt = tex.height;
                        if let Some(data) = read_texture(&device2, &ctx, &tex.texture, w, hgt) {
                            let (data, cw, ch) = if let Some((rx, ry, rw, rh)) = region {
                                (
                                    crop(&data, w, hgt, rx, ry, rw, rh),
                                    rw.min(item_w as u32),
                                    rh.min(item_h as u32),
                                )
                            } else {
                                (data, w, hgt)
                            };
                            let frame_out = RawFrame {
                                data,
                                width: cw,
                                height: ch,
                                ts_us,
                            };
                            let _ = frame_tx.send_timeout(frame_out, std::time::Duration::from_millis(500));
                        }
                    }
                    let _ = frame.Close();
                }
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
                Err(_) => break,
            }
        }
    });

    Ok(CaptureHandle {
        stop,
        paused,
        join: Some(join),
    })
}

struct TexWrap {
    texture: ID3D11Texture2D,
    width: u32,
    height: u32,
}

fn extract_texture(frame: &Direct3D11CaptureFrame) -> Option<TexWrap> {
    let surface = frame.Surface().ok()?;
    let access: windows::Win32::System::WinRT::Direct3D11::IDirect3DDxgiInterfaceAccess =
        surface.cast().ok()?;
    unsafe {
        let tex: ID3D11Texture2D = access.GetInterface().ok()?;
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        tex.GetDesc(&mut desc);
        Some(TexWrap {
            texture: tex,
            width: desc.Width,
            height: desc.Height,
        })
    }
}

fn read_texture(
    device: &ID3D11Device,
    ctx: &ID3D11DeviceContext,
    tex: &ID3D11Texture2D,
    width: u32,
    height: u32,
) -> Option<Vec<u8>> {
    unsafe {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        tex.GetDesc(&mut desc);
        desc.Usage = D3D11_USAGE_STAGING;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        desc.BindFlags = 0;
        desc.MiscFlags = 0;
        desc.MipLevels = 1;
        desc.ArraySize = 1;
        desc.SampleDesc.Count = 1;
        desc.SampleDesc.Quality = 0;
        let staging: Option<ID3D11Texture2D> = None;
        let mut staging = staging;
        device.CreateTexture2D(&desc, None, Some(&mut staging)).ok()?;
        let staging = staging?;
        ctx.CopyResource(&staging, tex);
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        ctx.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).ok()?;
        let row_pitch = mapped.RowPitch as usize;
        let bytes_pp = 4usize;
        let mut out = Vec::with_capacity(width as usize * height as usize * bytes_pp);
        let src = mapped.pData as *const u8;
        for y in 0..height as usize {
            let row = src.add(y * row_pitch);
            out.extend_from_slice(std::slice::from_raw_parts(row, width as usize * bytes_pp));
        }
        ctx.Unmap(&staging, 0);
        Some(out)
    }
}

/// Crop a BGRA buffer (clamped to bounds).
fn crop(data: &[u8], w: u32, h: u32, x: i32, y: i32, cw: u32, ch: u32) -> Vec<u8> {
    let x = x.clamp(0, w as i32 - 1) as u32;
    let y = y.clamp(0, h as i32 - 1) as u32;
    let cw = cw.min(w - x).max(1);
    let ch = ch.min(h - y).max(1);
    let mut out = Vec::with_capacity(cw as usize * ch as usize * 4);
    for row in y..y + ch {
        let start = (row as usize * w as usize + x as usize) * 4;
        let end = start + cw as usize * 4;
        out.extend_from_slice(&data[start..end]);
    }
    out
}

#[allow(dead_code)]
fn unused(_: TimeSpan) {}
