pub mod audio;
pub mod capture;
pub mod encoder;
pub mod recorder;
pub mod settings;

use recorder::{Recorder, RecorderOptions, State};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State as TauriState};

pub struct AppState {
    pub recorder: Mutex<Option<Arc<Recorder>>>,
    pub settings: Mutex<settings::Settings>,
}

type Ctx<'a> = TauriState<'a, AppState>;

#[tauri::command]
fn get_settings(ctx: Ctx) -> settings::Settings {
    ctx.settings.lock().unwrap().clone()
}

#[tauri::command]
fn save_settings(app: AppHandle, ctx: Ctx, settings: settings::Settings) {
    settings::save(&app, &settings);
    *ctx.settings.lock().unwrap() = settings;
}

#[derive(serde::Serialize)]
struct SourceLists {
    monitors: Vec<capture::enum_sources::MonitorInfo>,
    windows: Vec<capture::enum_sources::WindowInfo>,
    wgc_supported: bool,
}

#[tauri::command]
fn list_sources() -> SourceLists {
    SourceLists {
        monitors: capture::enum_sources::enumerate_monitors(),
        windows: capture::enum_sources::enumerate_windows(),
        wgc_supported: capture::enum_sources::is_supported(),
    }
}

fn default_output_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .video_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("ScreenRecord")
}

#[tauri::command]
fn start_recording(app: AppHandle, ctx: Ctx) -> Result<String, String> {
    let s = ctx.settings.lock().unwrap().clone();
    if ctx.recorder.lock().unwrap().is_some() {
        return Err("already recording".into());
    }
    let out_dir = s.output_dir.clone().unwrap_or_else(|| default_output_dir(&app));
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let ts = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let out_path = out_dir.join(format!("recording_{ts}.mp4"));

    let source = match s.source_kind.as_str() {
        "window" => {
            let hwnd: isize = s
                .source_id
                .parse()
                .map_err(|_| "invalid window handle".to_string())?;
            capture::wgc::SourceKind::Window(hwnd)
        }
        _ => {
            let id = if s.source_id.is_empty() {
                capture::enum_sources::enumerate_monitors()
                    .first()
                    .map(|m| m.id.clone())
                    .unwrap_or_default()
            } else {
                s.source_id.clone()
            };
            capture::wgc::SourceKind::Monitor(id)
        }
    };

    // resolve region for "region" mode: region is relative to chosen monitor
    let region = if s.source_kind == "region" {
        let mon = capture::enum_sources::enumerate_monitors()
            .into_iter()
            .find(|m| m.id == s.source_id)
            .ok_or("monitor not found")?;
        let [x, y, w, h] = s.region;
        Some((x - mon.x, y - mon.y, w.max(16) as u32, h.max(16) as u32))
    } else {
        None
    };

    // frame size estimate for bitrate: use monitor res (refined on first frame)
    let (est_w, est_h) = capture::enum_sources::enumerate_monitors()
        .first()
        .map(|m| (m.width as u32, m.height as u32))
        .unwrap_or((1920, 1080));
    let bitrate = settings::bitrate_for(est_w, est_h, s.fps, &s.quality, &s.codec, s.bitrate_kbps);

    let audio = if s.record_system_audio || s.record_microphone {
        Some((
            s.record_system_audio,
            s.record_microphone,
            s.system_volume,
            s.mic_volume,
        ))
    } else {
        None
    };

    let rec = Recorder::start(RecorderOptions {
        source,
        region,
        fps: s.fps,
        width: 0,
        height: 0,
        codec: s.codec.clone(),
        bitrate_kbps: bitrate,
        rate_mode: s.rate_mode.clone(),
        output_path: out_path.clone(),
        audio,
        max_duration: if s.max_duration_secs > 0 {
            Some(std::time::Duration::from_secs(s.max_duration_secs as u64))
        } else {
            None
        },
        max_file_mb: if s.max_file_mb > 0 { Some(s.max_file_mb as u64) } else { None },
    })?;

    *ctx.recorder.lock().unwrap() = Some(rec.clone());
    Ok(out_path.to_string_lossy().into_owned())
}

#[tauri::command]
fn pause_recording(ctx: Ctx) -> Result<(), String> {
    let rec = ctx.recorder.lock().unwrap().clone().ok_or("not recording")?;
    rec.pause();
    Ok(())
}

#[tauri::command]
fn resume_recording(ctx: Ctx) -> Result<(), String> {
    let rec = ctx.recorder.lock().unwrap().clone().ok_or("not recording")?;
    rec.resume();
    Ok(())
}

#[tauri::command]
fn stop_recording(ctx: Ctx) -> Result<String, String> {
    let rec_box = ctx.recorder.lock().unwrap().take().ok_or("not recording")?;
    let path = {
        let rec: Recorder = match Arc::try_unwrap(rec_box) {
            Ok(r) => r,
            Err(arc) => {
                // other refs exist (progress thread); clone path and stop via flag
                let p = arc.result_path.clone();
                arc.stop_flag().store(true, std::sync::atomic::Ordering::SeqCst);
                return Ok(p.to_string_lossy().into_owned());
            }
        };
        rec.stop()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    Ok(path)
}

#[tauri::command]
fn recording_progress(ctx: Ctx) -> Option<recorder::Progress> {
    let rec = ctx.recorder.lock().unwrap().clone()?;
    Some(rec.progress())
}

#[derive(serde::Serialize)]
struct HistoryEntry {
    path: String,
    size_mb: f64,
    modified: String,
}

#[tauri::command]
fn list_recordings(app: AppHandle, ctx: Ctx) -> Vec<HistoryEntry> {
    let s = ctx.settings.lock().unwrap();
    let dir = s.output_dir.clone().unwrap_or_else(|| default_output_dir(&app));
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().map(|x| x == "mp4").unwrap_or(false) {
                let meta = e.metadata().ok();
                out.push(HistoryEntry {
                    path: p.to_string_lossy().into_owned(),
                    size_mb: meta.as_ref().map(|m| m.len() as f64 / 1048576.0).unwrap_or(0.0),
                    modified: meta
                        .and_then(|m| m.modified().ok())
                        .map(|t| {
                            chrono::DateTime::<chrono::Local>::from(t)
                                .format("%Y-%m-%d %H:%M")
                                .to_string()
                        })
                        .unwrap_or_default(),
                });
            }
        }
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    out.truncate(30);
    out
}

#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg("/select,")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState {
            recorder: Mutex::new(None),
            settings: Mutex::new(settings::Settings::default()),
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            list_sources,
            start_recording,
            pause_recording,
            resume_recording,
            stop_recording,
            recording_progress,
            list_recordings,
            open_file
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let s = settings::load(&handle);
            *handle.state::<AppState>().settings.lock().unwrap() = s.clone();

            // progress emitter
            let h2 = handle.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(500));
                let rec = h2.state::<AppState>().recorder.lock().unwrap().clone();
                if let Some(rec) = rec {
                    let _ = h2.emit("recording-progress", rec.progress());
                }
            });

            // global shortcuts
            use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
            let hk_start = s.hotkey_start_stop.clone();
            let hk_pause = s.hotkey_pause.clone();
            app.global_shortcut().on_shortcut(hk_start.as_str(), |app, _shortcut, event| {
                if event.state() == ShortcutState::Pressed {
                    toggle_recording(app);
                }
            })?;
            app.global_shortcut().on_shortcut(hk_pause.as_str(), |app, _shortcut, event| {
                if event.state() == ShortcutState::Pressed {
                    toggle_pause(app);
                }
            })?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error running tauri app");
}

fn toggle_recording(app: &AppHandle) {
    let active = app.state::<AppState>().recorder.lock().unwrap().is_some();
    if active {
        let _ = stop_recording(app.state());
    } else {
        let _ = start_recording(app.clone(), app.state());
    }
}

fn toggle_pause(app: &AppHandle) {
    let st = app.state::<AppState>();
    let rec = st.recorder.lock().unwrap().clone();
    if let Some(rec) = rec {
        if rec.progress().state == State::Paused {
            let _ = rec.resume();
        } else {
            rec.pause();
        }
    }
}
