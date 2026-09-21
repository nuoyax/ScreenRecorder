//! One-shot still capture of a monitor, for the region picker.
//!
//! The picker draws a rectangle on top of a picture of the screen, so it needs a
//! real frame of the monitor it is about to cover. That frame is taken here, before
//! the picker window exists, using the same WGC path the recorder uses — which keeps
//! the picker free of any screenshot dependency and guarantees the preview shows
//! exactly what the recorder will capture.

use super::{enum_sources, wgc};
use crate::image::{png, resize::bgra_box};

/// Longest preview width handed to the webview.
///
/// 1080p monitors stay at 1:1 so aiming at a small control is still pixel-accurate;
/// only larger displays are downscaled, which keeps the base64 payload around a
/// megabyte instead of the several a full 4K still would need.
const PREVIEW_MAX_WIDTH: u32 = 1920;

/// How long to wait for the first frame before giving up on a monitor.
const FIRST_FRAME_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

pub struct Still {
    pub preview_png: Vec<u8>,
    pub preview_width: u32,
    pub preview_height: u32,
    /// Monitor pixels per preview pixel. The picker multiplies by this to convert a
    /// selection drawn on the preview back into real screen coordinates.
    pub scale: f64,
}

/// Preview dimensions for a monitor of `(w, h)`, never upscaling.
fn preview_dims(w: u32, h: u32) -> (u32, u32) {
    if w == 0 || h == 0 {
        return (0, 0);
    }
    if w <= PREVIEW_MAX_WIDTH {
        return (w, h);
    }
    let pw = PREVIEW_MAX_WIDTH;
    let ph = ((pw as f64) * (h as f64) / (w as f64)).round().max(1.0) as u32;
    (pw, ph)
}

/// Convert BGRA8 in place to RGBA8, the only channel order PNG can express.
fn bgra_to_rgba(buf: &mut [u8]) {
    for px in buf.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
}

/// Grab one frame of `monitor_id` and encode it as a PNG for display.
pub fn capture_monitor(monitor_id: &str) -> Result<Still, String> {
    // Bounded(1): only the first frame matters, and a deeper queue would just hold
    // textures open while we tear the capture down.
    let (frame_tx, frame_rx) = crossbeam_channel::bounded(1);
    let (handle, _origin) = wgc::start_capture(
        wgc::SourceKind::Monitor(monitor_id.to_string()),
        None,
        // The picker draws its own selection cursor; an OS cursor burned into the
        // preview would just be a stray artifact.
        false,
        frame_tx,
    )
    .map_err(|e| format!("无法打开该显示器进行抓帧：{e}"))?;

    let received = frame_rx.recv_timeout(FIRST_FRAME_TIMEOUT);
    // Always tear the capture down, including on the timeout path.
    handle.stop();
    let frame = received.map_err(|_| "抓帧超时（5 秒内没有收到画面）".to_string())?;

    let (pw, ph) = preview_dims(frame.width, frame.height);
    if pw == 0 || ph == 0 {
        return Err("抓到的画面尺寸为空".into());
    }
    let mut rgba = bgra_box(&frame.data, frame.width, frame.height, pw, ph)
        .ok_or_else(|| format!("画面缩放失败（{}x{} → {}x{}）", frame.width, frame.height, pw, ph))?;
    bgra_to_rgba(&mut rgba);
    let preview_png = png::encode_rgba(&rgba, pw, ph).ok_or("PNG 编码失败")?;

    Ok(Still {
        preview_png,
        preview_width: pw,
        preview_height: ph,
        scale: frame.width as f64 / pw as f64,
    })
}

/// Monitor geometry, so the picker can turn its selection into absolute coordinates.
pub fn monitor_info(monitor_id: &str) -> Result<enum_sources::MonitorInfo, String> {
    enum_sources::enumerate_monitors()
        .into_iter()
        .find(|m| m.id == monitor_id)
        .ok_or_else(|| format!("找不到显示器 {monitor_id}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_keeps_small_monitors_at_one_to_one() {
        assert_eq!(preview_dims(1920, 1080), (1920, 1080));
        assert_eq!(preview_dims(1280, 720), (1280, 720));
        assert_eq!(preview_dims(1366, 768), (1366, 768));
    }

    /// The scale factor the picker divides by has to round-trip, or every selected
    /// rectangle would be off by a few pixels on a HiDPI or 4K display.
    #[test]
    fn preview_scales_large_monitors_preserving_aspect() {
        let (w, h) = (3840u32, 2160u32);
        let (pw, ph) = preview_dims(w, h);
        assert_eq!(pw, PREVIEW_MAX_WIDTH);
        assert_eq!(ph, 1080);
        let scale = w as f64 / pw as f64;
        assert!((scale - 2.0).abs() < f64::EPSILON);
        // a selection of one preview pixel must map back to exactly `scale` monitor px
        assert_eq!((pw as f64 * scale).round() as u32, w);
        assert_eq!((ph as f64 * scale).round() as u32, h);
    }

    #[test]
    fn preview_survives_odd_dimensions() {
        let (pw, ph) = preview_dims(3000, 1001);
        assert_eq!(pw, PREVIEW_MAX_WIDTH);
        assert!(ph > 0 && ph < 1001, "must not upscale: got {ph}");
        assert_eq!(preview_dims(0, 1080), (0, 0));
    }

    #[test]
    fn bgra_to_rgba_swaps_red_and_blue() {
        let mut buf = vec![10u8, 20, 30, 255, /* */ 1, 2, 3, 4];
        bgra_to_rgba(&mut buf);
        assert_eq!(buf, vec![30u8, 20, 10, 255, /* */ 3, 2, 1, 4]);
    }

    /// A frame that made it through the whole path must decode as a real PNG of the
    /// preview size — this is the contract the frontend relies on to map its clicks.
    #[test]
    fn a_fake_frame_encodes_to_a_png_of_the_preview_size() {
        let (fw, fh) = (64u32, 32u32);
        let data = vec![0x40u8; (fw as usize) * (fh as usize) * 4];
        let (pw, ph) = preview_dims(fw, fh);
        let mut rgba = bgra_box(&data, fw, fh, pw, ph).unwrap();
        bgra_to_rgba(&mut rgba);
        let encoded = png::encode_rgba(&rgba, pw, ph).unwrap();
        assert_eq!(png::read_ihdr_size(&encoded), Some((pw, ph)));
    }
}
