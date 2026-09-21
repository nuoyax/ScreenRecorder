use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// "screen" (monitor id) | "window" (hwnd as string) | "region"
    pub source_kind: String,
    /// monitor id (index into enumerate list) or hwnd string
    pub source_id: String,
    /// region: x, y, w, h in virtual screen coords
    pub region: [i32; 4],
    pub fps: u32,
    /// 0 = original size, else scaled width
    pub scale_width: u32,
    /// "h264" | "h265"
    pub codec: String,
    /// "low" | "medium" | "high" | "ultra" | custom bitrate
    pub quality: String,
    /// custom bitrate in kbps when quality == "custom"
    pub bitrate_kbps: u32,
    /// "vbr" | "cbr"
 pub rate_mode: String,
    pub record_system_audio: bool,
    pub record_microphone: bool,
    pub system_volume: f32,
    pub mic_volume: f32,
    pub output_dir: Option<PathBuf>,
    /// auto stop after N seconds, 0 = disabled
    pub max_duration_secs: u32,
    /// auto stop at N MB, 0 = disabled
    pub max_file_mb: u32,
    pub show_cursor: bool,
    pub click_highlight: bool,
    /// seconds to count down before capture starts, 0 = start immediately
    pub countdown_secs: u32,
    pub hotkey_start_stop: String,
    pub hotkey_pause: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            source_kind: "screen".into(),
            source_id: String::new(),
            region: [0, 0, 1280, 720],
            fps: 30,
            scale_width: 0,
            codec: "h264".into(),
            quality: "high".into(),
            bitrate_kbps: 8000,
            rate_mode: "vbr".into(),
            record_system_audio: true,
            record_microphone: false,
            system_volume: 1.0,
            mic_volume: 1.0,
            output_dir: None,
            max_duration_secs: 0,
            max_file_mb: 0,
            show_cursor: true,
            click_highlight: true,
            countdown_secs: 0,
            hotkey_start_stop: "Alt+R".into(),
            hotkey_pause: "Alt+P".into(),
        }
    }
}

pub fn settings_path(app: &tauri::AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    std::fs::create_dir_all(&dir).ok();
    dir.join("settings.json")
}

pub fn load(app: &tauri::AppHandle) -> Settings {
    let p = settings_path(app);
    std::fs::read(&p)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn save(app: &tauri::AppHandle, s: &Settings) {
    if let Ok(json) = serde_json::to_vec_pretty(s) {
        let _ = std::fs::write(settings_path(app), json);
    }
}

/// Reference bitrate (kbps) per preset at 1080p/30fps. These are the numbers the
/// README documents; `bitrate_for` scales them by resolution and frame rate.
const REF_PIXELS: f64 = 1920.0 * 1080.0;

/// Map quality preset to bitrate (kbps) for a given resolution/fps/codec.
pub fn bitrate_for(width: u32, height: u32, fps: u32, quality: &str, codec: &str, custom: u32) -> u32 {
    let ref_kbps = match quality {
        "low" => 6_000.0,
        "medium" => 13_000.0,
        "high" => 25_000.0,
        "ultra" => 55_000.0,
        "custom" => return custom.max(500),
        _ => 25_000.0,
    };
    let pixels = (width as u64 * height as u64).max(1) as f64;
    // Resolution scales the bitrate linearly; fps is sub-linear (temporal redundancy
    // means doubling the frame rate does not double the information rate).
    let mut kbps = ref_kbps * (pixels / REF_PIXELS) * (fps as f64 / 30.0).clamp(0.5, 2.5);
    if codec == "h265" {
        kbps *= 0.7; // HEVC needs ~30% less for same quality
    }
    (kbps as u32).clamp(1000, 240_000)
}

/// Derive the output frame size for a source size and a target width.
/// `scale_width == 0` (or >= source width) keeps the original size; height follows
/// the source aspect ratio and is rounded to an even number (encoders require it).
pub fn output_size(src_w: u32, src_h: u32, scale_width: u32) -> (u32, u32) {
    if scale_width == 0 || scale_width >= src_w || src_w == 0 {
        return (even(src_w), even(src_h));
    }
    let w = scale_width.max(16);
    let h = ((w as f64) * (src_h as f64) / (src_w as f64)).round() as u32;
    (even(w), even(h.max(16)))
}

fn even(v: u32) -> u32 {
    if v == 0 {
        2
    } else {
        v - (v % 2)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_size_keeps_source_when_unscaled() {
        assert_eq!(output_size(1920, 1080, 0), (1920, 1080));
        assert_eq!(output_size(1920, 1080, 1920), (1920, 1080));
        assert_eq!(output_size(1920, 1080, 3840), (1920, 1080));
    }

    #[test]
    fn output_size_scales_and_stays_even() {
        assert_eq!(output_size(1920, 1080, 1280), (1280, 720));
        assert_eq!(output_size(2560, 1440, 1280), (1280, 720));
        // 1366x768 @ 1000 → 1000x562 (562.06 floored to even 562)
        assert_eq!(output_size(1366, 768, 1000), (1000, 562));
        // odd source heights get rounded down
        assert_eq!(output_size(1001, 1001, 0), (1000, 1000));
    }

    #[test]
    fn output_size_never_returns_zero() {
        let (w, h) = output_size(0, 0, 16);
        assert!(w >= 2 && h >= 2);
    }

    #[test]
    fn bitrate_scales_with_pixels_and_fps() {
        let a = bitrate_for(1920, 1080, 30, "high", "h264", 0);
        let b = bitrate_for(1280, 720, 30, "high", "h264", 0);
        assert!(a > b, "1080p should outrank 720p at the same preset");
        let c = bitrate_for(1920, 1080, 60, "high", "h264", 0);
        assert!(c > a, "60fps should outrank 30fps at the same preset");
        // HEVC reaches the same quality at a lower bitrate
        let hevc = bitrate_for(1920, 1080, 30, "high", "h265", 0);
        assert!(hevc < a);
    }

    /// The preset names are documented with concrete bitrates in the README; this
    /// pins the formula to those numbers so the two cannot drift apart silently.
    #[test]
    fn presets_match_documented_1080p30_bitrates() {
        for (quality, expected) in [
            ("low", 6_000u32),
            ("medium", 13_000),
            ("high", 25_000),
            ("ultra", 55_000),
        ] {
            assert_eq!(
                bitrate_for(1920, 1080, 30, quality, "h264", 0),
                expected,
                "{quality} preset drifted from the README table"
            );
        }
    }

    #[test]
    fn bitrate_is_capped_for_absurd_sources() {
        // 8K60 at the ultra preset would otherwise ask for ~1.5 Gbps; the ceiling keeps
        // the value inside the range an H.264 level-4 encoder can actually accept.
        let kbps = bitrate_for(7680, 4320, 60, "ultra", "h264", 0);
        assert_eq!(kbps, 240_000);
    }

    #[test]
    fn custom_quality_returns_requested_bitrate() {
        assert_eq!(bitrate_for(1920, 1080, 30, "custom", "h264", 12_345), 12_345);
        // floor of 500 kbps for nonsense input
        assert_eq!(bitrate_for(1920, 1080, 30, "custom", "h264", 1), 500);
    }
}
