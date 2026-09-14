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
    /// "low" | "medium" | "high" | custom bitrate
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
            countdown_secs: 3,
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

/// Map quality preset to bitrate (kbps) for a given resolution/fps/codec.
pub fn bitrate_for(width: u32, height: u32, fps: u32, quality: &str, codec: &str, custom: u32) -> u32 {
    let pixels = (width as u64 * height as u64).max(1);
    // base kbps at 30fps, scaled by fps
    let base = match quality {
        "low" => pixels as f64 * 0.06,
        "medium" => pixels as f64 * 0.12,
        "high" => pixels as f64 * 0.22,
        "custom" => return custom.max(500),
        _ => pixels as f64 * 0.22,
    };
    let mut kbps = base * (fps as f64 / 30.0).clamp(0.5, 2.0);
    if codec == "h265" {
        kbps *= 0.65; // HEVC needs ~35% less for same quality
    }
    (kbps as u32).clamp(1000, 120_000)
}
