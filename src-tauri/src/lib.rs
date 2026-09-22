pub mod audio;
pub mod capture;
pub mod encoder;
pub mod export;
pub mod image;
pub mod input;
pub mod recorder;
pub mod settings;

use recorder::{Recorder, RecorderOptions, State};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State as TauriState};

pub struct AppState {
    pub recorder: Mutex<Option<Arc<Recorder>>>,
    pub settings: Mutex<settings::Settings>,
    /// Monitor the region picker window was opened over, so the picker page knows
    /// which still to show. Empty until a picker has been opened.
    pub region_target: Mutex<String>,
    /// GIF being assembled by the current export, if any.
    ///
    /// Streaming, not batch: the editor emits frames as it renders them and holding a
    /// two-minute 720p30 export in memory would be close to a gigabyte of RGBA before
    /// the first byte reaches disk.
    pub gif_export: Mutex<Option<GifExport>>,
}

/// A GIF export in progress: where it is going, what it is made of, and how far along.
pub struct GifExport {
    writer: export::gif::GifWriter,
    path: PathBuf,
    width: u32,
    height: u32,
    expected_frames: u32,
    delay_cs: u16,
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
    let mut s = ctx.settings.lock().unwrap().clone();
    if ctx.recorder.lock().unwrap().is_some() {
        return Err("already recording".into());
    }

    // Countdown: announce each tick before any capture is created, so the screen the
    // user is about to record never contains a half-initialised capture session.
    if s.countdown_secs > 0 {
        for remaining in (1..=s.countdown_secs).rev() {
            let _ = app.emit("countdown", remaining);
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
        let _ = app.emit("countdown", 0u32);
    }

    // HEVC may be unavailable (no encoder MFT installed); probe synchronously
    // and fall back to H.264 so recording still works.
    if s.codec == "h265" {
        let probe_path = std::env::temp_dir().join("hevc_probe.mp4");
        let _ = std::fs::remove_file(&probe_path);
        let probe = encoder::SinkEncoder::new(
            &probe_path,
            &encoder::EncoderConfig {
                width: 320,
                height: 240,
                fps: 30,
                codec: "h265".into(),
                bitrate_kbps: 2000,
                rate_mode: "vbr".into(),
                audio: None,
                input_bgra: true,
            },
        );
        match probe {
            Ok(_) => {
                let _ = std::fs::remove_file(&probe_path);
            }
            Err(_) => {
                s.codec = "h264".into();
                eprintln!("[rec] HEVC 不可用，自动降级 H.264");
                let _ = app.emit("codec-fallback", "h265");
            }
        }
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

    // The screen rectangle the recording covers, in virtual-screen coordinates. Cursor
    // samples are absolute, so this is what lets the editor put the cursor in the right
    // place on a region recording — or on any multi-monitor setup where the recorded
    // display does not start at (0,0). Falls back to the first monitor rather than
    // refusing to record: a wrong-but-present rectangle degrades the cursor overlay,
    // while no rectangle at all would drop it.
    let sample_rect = match s.source_kind.as_str() {
        "window" => s.source_id.parse::<isize>().ok().and_then(capture::enum_sources::window_rect),
        "region" => {
            let [x, y, w, h] = s.region;
            Some(input::mouse::SampleRect {
                x,
                y,
                width: w.max(16) as u32,
                height: h.max(16) as u32,
            })
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
            capture::enum_sources::monitor_rect(&id)
        }
    }
    .or_else(|| capture::enum_sources::enumerate_monitors().first().map(|m| input::mouse::SampleRect {
        x: m.x,
        y: m.y,
        width: m.width as u32,
        height: m.height as u32,
    }))
    .unwrap_or(input::mouse::SampleRect { x: 0, y: 0, width: 1920, height: 1080 });

    // frame size estimate for bitrate: use the capture source resolution, then apply
    // the same output scaling the recorder will use so the bitrate matches what is
    // actually encoded (a 720p output should not be budgeted at 1080p rates).
    let (est_w, est_h) = capture::enum_sources::enumerate_monitors()
        .first()
        .map(|m| (m.width as u32, m.height as u32))
        .unwrap_or((1920, 1080));
    let (out_w, out_h) = settings::output_size(est_w, est_h, s.scale_width);
    let bitrate = settings::bitrate_for(out_w, out_h, s.fps, &s.quality, &s.codec, s.bitrate_kbps);

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
        scale_width: s.scale_width,
        codec: s.codec.clone(),
        bitrate_kbps: bitrate,
        rate_mode: s.rate_mode.clone(),
        output_path: out_path.clone(),
        audio,
        mic_device: if s.mic_device.is_empty() {
            None
        } else {
            Some(s.mic_device.clone())
        },
        show_cursor: s.show_cursor,
        // Sample whenever the cursor is hidden (so the editor can draw its own) or the
        // user asked for click highlights. Sampling costs a poll thread, nothing more.
        sample_mouse: !s.show_cursor || s.click_highlight,
        sample_rect,
        max_duration: if s.max_duration_secs > 0 {
            Some(std::time::Duration::from_secs(s.max_duration_secs as u64))
        } else {
            None
        },
        max_file_mb: if s.max_file_mb > 0 { Some(s.max_file_mb as u64) } else { None },
    })?;

    *ctx.recorder.lock().unwrap() = Some(rec.clone());
    eprintln!(
        "[rec] started → {}, codec={}, fps={}, {}x{} (src {}x{}, scale_width={}), bitrate={}kbps",
        out_path.display(),
        s.codec,
        s.fps,
        out_w,
        out_h,
        est_w,
        est_h,
        s.scale_width,
        bitrate
    );
    Ok(out_path.to_string_lossy().into_owned())
}

#[tauri::command]
fn pause_recording(ctx: Ctx) -> Result<(), String> {
    let rec = ctx.recorder.lock().unwrap().clone().ok_or("not recording")?;
    rec.pause();
    eprintln!("[rec] paused, state={:?}", rec.progress().state);
    Ok(())
}

#[tauri::command]
fn resume_recording(ctx: Ctx) -> Result<(), String> {
    let rec = ctx.recorder.lock().unwrap().clone().ok_or("not recording")?;
    rec.resume();
    eprintln!("[rec] resumed, state={:?}", rec.progress().state);
    Ok(())
}

#[tauri::command]
async fn stop_recording(app: AppHandle, ctx: Ctx<'_>) -> Result<String, String> {
    let rec_box = ctx.recorder.lock().unwrap().take().ok_or("not recording")?;
    eprintln!("[rec] stop requested");
    // Finalizing a large MP4 can take a while; do it off the IPC thread and
    // notify the UI when the file is ready.
    let handle = app.clone();
    let rec: Recorder = match Arc::try_unwrap(rec_box) {
        Ok(r) => r,
        Err(arc) => {
            let p = arc.result_path.clone();
            arc.stop_flag().store(true, std::sync::atomic::Ordering::SeqCst);
            std::mem::forget(arc);
            let _ = handle.emit("recording-saved", p.to_string_lossy().to_string());
            return Ok(p.to_string_lossy().into_owned());
        }
    };
    tauri::async_runtime::spawn(async move {
        let path = rec
            .stop()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        eprintln!("[rec] stop finished → {path}");
        let _ = handle.emit("recording-saved", path.clone());
    });
    Ok(String::new())
}

#[tauri::command]
fn recording_progress(ctx: Ctx) -> Option<recorder::Progress> {
    let rec = ctx.recorder.lock().unwrap().clone()?;
    Some(rec.progress())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    // stop any active recording first so the MP4 gets finalized
    let st = app.state::<AppState>();
    if let Some(rec) = st.recorder.lock().unwrap().take() {
        rec.stop_flag()
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
    app.exit(0);
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
fn list_microphones() -> Vec<audio::MicrophoneInfo> {
    audio::list_microphones()
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

/// Read a text file the editor owns (a `.srec.json` project next to a recording).
///
/// Scoped to text on purpose: this is how the editor loads a project, and a command
/// that returned arbitrary bytes would be a bigger door than the feature needs.
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("读取 {path} 失败：{e}"))
}

/// Write a text file, creating parent directories if the recording folder is gone.
#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    std::fs::write(&path, contents).map_err(|e| format!("写入 {path} 失败：{e}"))
}

/// Whether a file exists, so the editor can offer "open project" or "new project".
#[tauri::command]
fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).is_file()
}

/// Whether this build's IPC can carry a raw byte payload.
///
/// The exporters send frames as an `ArrayBuffer` rather than a JSON array of numbers,
/// which Tauri only accepts on the custom-protocol path. Rather than discover that by
/// failing halfway through an export, the UI calls this once at startup with a real
/// bytes payload and greys out the frame-based exports if it does not arrive as bytes.
///
/// This command *is* the probe: it reports what the transport actually delivered, so
/// there is no second mechanism that could disagree with the exporters.
#[tauri::command]
fn ipc_raw_supported(request: tauri::ipc::Request<'_>) -> bool {
    matches!(request.body(), tauri::ipc::InvokeBody::Raw(_))
}

/// Locate `ffmpeg`, once, for the transcode card.
#[tauri::command]
fn ffmpeg_status() -> export::probe::FfmpegStatus {
    export::probe::status()
}

/// Begin a streaming GIF export.
///
/// The header and loop extension are written now, so a bad frame count or an
/// unwritable path fails before the editor spends a minute rendering.
#[tauri::command]
fn export_setup(
    ctx: Ctx,
    path: String,
    width: u32,
    height: u32,
    frames: u32,
    delay_cs: u16,
) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Err("导出尺寸无效".to_string());
    }
    if frames == 0 {
        return Err("没有可导出的帧".to_string());
    }
    // GIF stores dimensions in 16 bits; a taller frame cannot be represented at all, and
    // silently truncating it would produce a corrupt file.
    if width > u16::MAX as u32 || height > u16::MAX as u32 {
        return Err(format!("GIF 尺寸上限为 {}x{}", u16::MAX, u16::MAX));
    }
    // Reject an impossible delay here rather than writing a file that plays at the
    // wrong speed: 0 means "as fast as possible" to most viewers, not "very fast".
    if delay_cs == 0 {
        return Err("帧间隔不能为 0".to_string());
    }
    let out = PathBuf::from(&path);
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    let writer = export::gif::GifWriter::new(width as u16, height as u16);
    *ctx.gif_export.lock().unwrap() = Some(GifExport {
        writer,
        path: out,
        width,
        height,
        expected_frames: frames,
        delay_cs,
    });
    Ok(())
}

/// Add one frame to the export in progress.
///
/// Takes `tauri::ipc::Request` rather than a typed argument: a raw payload has no named
/// arguments, so the settings travel in the payload's own JSON header (see
/// [`export::frame`]).
#[tauri::command]
fn export_push_frame(ctx: Ctx, request: tauri::ipc::Request<'_>) -> Result<u32, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("帧数据必须以二进制 payload 发送".to_string());
    };
    let frame = export::frame::unpack(bytes)?;
    let pixels = export::frame::frame_pixels(frame.meta.width, frame.meta.height, &frame.rgba)?;
    let mut guard = ctx.gif_export.lock().unwrap();
    let export = guard
        .as_mut()
        .ok_or_else(|| "没有正在进行的导出（先调用 export_setup）".to_string())?;

    // The stream's geometry is fixed by the header; a frame that disagrees would be
    // silently mis-scaled, so it is refused instead.
    if frame.meta.width != export.width || frame.meta.height != export.height {
        return Err(format!(
            "帧尺寸 {}x{} 与导出尺寸 {}x{} 不一致",
            frame.meta.width, frame.meta.height, export.width, export.height
        ));
    }
    let delay = if frame.meta.delay_cs == 0 {
        export.delay_cs
    } else {
        frame.meta.delay_cs
    };
    export
        .writer
        .push_frame(pixels, delay, frame.meta.alpha_threshold);
    Ok(export.writer.frames())
}

/// Write the GIF and report what landed on disk.
#[tauri::command]
fn export_finish(ctx: Ctx) -> Result<ExportResult, String> {
    let export = ctx
        .gif_export
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| "没有正在进行的导出".to_string())?;
    let count = export.writer.frames();
    // An animation of fewer than two frames is not an animation. Writing it anyway would
    // produce a file the user cannot tell apart from a failed export.
    if count < 2 {
        return Err(format!("只收到 {count} 帧，动画至少需要 2 帧"));
    }
    let bytes = export.writer.finish();
    if let Some(parent) = export.path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    std::fs::write(&export.path, &bytes).map_err(|e| format!("写入失败：{e}"))?;
    Ok(ExportResult {
        path: export.path.to_string_lossy().to_string(),
        bytes: bytes.len() as u64,
        frames: count,
        expected_frames: export.expected_frames,
        format: "gif".to_string(),
    })
}

/// Abandon the export in progress without writing anything.
#[tauri::command]
fn export_cancel(ctx: Ctx) -> bool {
    ctx.gif_export.lock().unwrap().take().is_some()
}

/// What one export produced, for the panel to report honestly.
#[derive(serde::Serialize)]
struct ExportResult {
    path: String,
    bytes: u64,
    frames: u32,
    /// What the caller said it would send. A shortfall is worth surfacing: it usually
    /// means the render loop gave up partway, and a half-length GIF is not obvious.
    expected_frames: u32,
    format: String,
}

/// Write one composed frame as a PNG sticker.
///
/// The destination and the framing arrive inside the payload header rather than as
/// command arguments: a raw bytes body has no JSON object for Tauri to read named keys
/// from, so anything not in the payload would not arrive at all.
#[tauri::command]
fn export_img_sticker(request: tauri::ipc::Request<'_>) -> Result<ExportResult, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("帧数据必须以二进制 payload 发送".to_string());
    };
    let (header, rgba) = export::frame::unpack_json::<export::img::StickerFrame>(bytes)?;
    if header.path.is_empty() {
        return Err("帧数据未给出导出路径".to_string());
    }
    let pixels = export::frame::frame_pixels(header.width, header.height, &rgba)?;
    let (rgba, w, h) =
        export::img::build_sticker(pixels, header.width, header.height, header.options())
            .ok_or_else(|| "贴纸尺寸与像素不匹配".to_string())?;
    let png = image::png::encode_rgba(&rgba, w, h).ok_or_else(|| "PNG 编码失败".to_string())?;
    let out = PathBuf::from(&header.path);
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    std::fs::write(&out, &png).map_err(|e| format!("写入失败：{e}"))?;
    Ok(ExportResult {
        path: out.to_string_lossy().to_string(),
        bytes: png.len() as u64,
        frames: 1,
        expected_frames: 1,
        format: "png".to_string(),
    })
}

/// Allow the editor to load one recording through the `asset:` protocol.
///
/// The asset protocol scope is empty in `tauri.conf.json` and widened here instead:
/// recordings can live anywhere the user points the app at, and a static `**` glob
/// in the config would expose the whole filesystem to the webview. This grants
/// exactly the file the editor is about to open.
#[tauri::command]
fn allow_asset(app: AppHandle, path: String) -> Result<(), String> {
    let canonical =
        std::fs::canonicalize(&path).map_err(|e| format!("找不到文件 {path}：{e}"))?;
    app.asset_protocol_scope()
        .allow_file(&canonical)
        .map_err(|e| format!("无法授权访问 {}：{e}", canonical.display()))
}

/// Cursor path + click track recorded alongside a video, if one exists.
///
/// Returns `None` for recordings made with cursor sampling disabled — the editor
/// treats that as "no overlay data" rather than an error.
#[tauri::command]
fn load_mouse_track(video_path: String) -> Option<input::mouse::MouseTrack> {
    input::mouse::load_sidecar(&input::mouse::sidecar_path(std::path::Path::new(
        &video_path,
    )))
}

/// One monitor's still frame, ready to be shown behind the region picker.
#[derive(serde::Serialize)]
struct MonitorPreview {
    /// `data:image/png;base64,...` of the whole monitor, at preview resolution.
    data_url: String,
    /// Monitor rectangle in virtual-screen coordinates. The picker needs nothing else
    /// about the still: its own `<img>` reports the size it actually decoded at.
    x: i32,
    y: i32,
    monitor_width: u32,
    monitor_height: u32,
}

/// Capture one still of a monitor for the region picker.
///
/// Runs off the IPC thread: the first frame of a fresh WGC session can take a moment
/// to arrive, and blocking the invoke handler for that long would freeze the UI.
#[tauri::command]
async fn capture_monitor_preview(monitor_id: String) -> Result<MonitorPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mon = capture::still::monitor_info(&monitor_id)?;
        let still = capture::still::capture_monitor(&monitor_id)?;
        Ok(MonitorPreview {
            data_url: image::base64::encode_data_url("image/png", &still.preview_png),
            x: mon.x,
            y: mon.y,
            monitor_width: mon.width.max(0) as u32,
            monitor_height: mon.height.max(0) as u32,
        })
    })
    .await
    .map_err(|e| format!("抓帧任务失败：{e}"))?
}

/// Which monitor the picker window is currently covering (empty if none).
#[tauri::command]
fn region_target(ctx: Ctx) -> String {
    ctx.region_target.lock().unwrap().clone()
}

/// Show the region picker over `monitor_id`.
///
/// The window is an ordinary opaque WebView2 window sized to the monitor, not a
/// Win32 overlay: the frontend stays the only thing drawing UI, and the still frame
/// comes from the command above rather than from any screenshot API the webview
/// would otherwise need.
///
/// It is created once in `setup` and only moved and shown here, because creating a
/// webview means pumping this thread's message queue — see the note there.
#[tauri::command]
fn open_region_picker(app: AppHandle, ctx: Ctx, monitor_id: String) -> Result<(), String> {
    let mon = capture::still::monitor_info(&monitor_id)?;
    // Set before the window is shown: the page asks for it on mount, and asking after
    // is a second round trip the user would see as the picker coming up blank.
    *ctx.region_target.lock().unwrap() = monitor_id.clone();

    // Monitor rectangles are physical pixels; `position`/`inner_size` take *logical*
    // units. On a scaled display those differ, and passing the raw numbers would
    // leave the picker short of the screen edges by the scale factor.
    let scale = app
        .monitor_from_point(mon.x as f64, mon.y as f64)
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    let (logical_x, logical_y) = (mon.x as f64 / scale, mon.y as f64 / scale);
    let (logical_w, logical_h) = (
        (mon.width.max(1) as f64 / scale).ceil(),
        (mon.height.max(1) as f64 / scale).ceil(),
    );

    let w = app
        .get_webview_window("region-select")
        .ok_or("区域选择窗口未创建")?;
    let _ = w.set_position(tauri::LogicalPosition::new(logical_x, logical_y));
    let _ = w.set_size(tauri::LogicalSize::new(logical_w, logical_h));
    let _ = w.show();
    let _ = w.set_focus();
    // The page picks up the new still from these; the window itself is long-lived, so
    // "show" alone would leave the previous monitor's frame on screen.
    let _ = app.emit("region-target", monitor_id);
    Ok(())
}

#[tauri::command]
fn close_region_picker(app: AppHandle) {
    // Hidden, not closed: the window is built once in `setup` and reused, so that
    // opening the picker never has to create a webview from inside a command.
    if let Some(w) = app.get_webview_window("region-select") {
        let _ = w.hide();
    }
}

/// Accept the rectangle the user drew in the picker.
///
/// `region` is in absolute virtual-screen coordinates (the picker converts from its
/// own preview pixels using the `scale` it was handed), and `thumbnail` is a small
/// preview the settings panel can show next to the numbers.
#[tauri::command]
fn apply_region(
    app: AppHandle,
    ctx: Ctx,
    region: [i32; 4],
    thumbnail: String,
    monitor_id: String,
) {
    {
        let mut s = ctx.settings.lock().unwrap();
        s.region = region;
        s.region_thumbnail = thumbnail;
        // Picking a rectangle is an explicit choice of what to record, so switch the
        // source over too — leaving it on "screen" would silently ignore the region.
        s.source_kind = "region".into();
        s.source_id = monitor_id;
        settings::save(&app, &s);
    }
    let _ = app.emit("region-selected", region);
    // Hidden rather than closed — the window is reused (see `close_region_picker`).
    if let Some(w) = app.get_webview_window("region-select") {
        let _ = w.hide();
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState {
            recorder: Mutex::new(None),
            settings: Mutex::new(settings::Settings::default()),
            region_target: Mutex::new(String::new()),
            gif_export: Mutex::new(None),
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
            list_microphones,
            open_file,
            read_text_file,
            write_text_file,
            file_exists,
            allow_asset,
            ipc_raw_supported,
            ffmpeg_status,
            export_setup,
            export_push_frame,
            export_finish,
            export_cancel,
            export_img_sticker,
            load_mouse_track,
            capture_monitor_preview,
            region_target,
            open_region_picker,
            close_region_picker,
            apply_region,
            quit_app
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let s = settings::load(&handle);
            *handle.state::<AppState>().settings.lock().unwrap() = s.clone();

            // Region picker, built now and hidden until asked for.
            //
            // Creating a WebView2 window is not something a command can do on demand:
            // `WebviewWindowBuilder::build` reaches wry's `wait_with_pump`, which pumps
            // messages on the calling thread until the controller is ready. A synchronous
            // command runs on the event-loop thread, so that pump nests inside the message
            // dispatch it was invoked from and never returns — the app stops repainting
            // (black window, "not responding") with the webview left on about:blank.
            // Built here instead, before the loop starts, exactly like the toolbar above,
            // where the pump is the only thing running.
            let picker = tauri::WebviewWindowBuilder::new(
                app,
                "region-select",
                tauri::WebviewUrl::App("region-select.html".into()),
            )
            .title("选择录制区域")
            .decorations(false)
            .shadow(false)
            .always_on_top(true)
            .resizable(false)
            .skip_taskbar(true)
            .visible(false)
            // Transparent, like the toolbar: the picker is a dimming sheet over the live
            // desktop, not a picture of it. An opaque window would hide whatever changed
            // between the still and the moment the user drags.
            .transparent(true)
            .background_color(tauri::window::Color(0x00, 0x00, 0x00, 0x00))
            .build();
            match picker {
                Ok(win) => {
                    // Keep it out of any capture even though picking normally happens while
                    // idle: a recording left running would otherwise film the picker covering
                    // the screen.
                    unsafe {
                        use windows::Win32::UI::WindowsAndMessaging::{
                            SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
                        };
                        if let Ok(hwnd) = win.hwnd() {
                            let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
                        }
                    }
                }
                // Not fatal: everything else works, and `open_region_picker` reports the
                // missing window rather than failing silently when the button is pressed.
                Err(e) => eprintln!("[picker] window could not be created: {e}"),
            }

            // floating toolbar (always-on-top, frameless, small) pinned bottom-right,
            // excluded from screen capture so it never appears in recordings
            let toolbar = tauri::WebviewWindowBuilder::new(
                app,
                "toolbar",
                tauri::WebviewUrl::App("toolbar.html".into()),
            )
            .title("Toolbar")
            .inner_size(260.0, 56.0)
            .decorations(false)
            .shadow(false)
            .always_on_top(true)
            .resizable(false)
            .skip_taskbar(true)
            .transparent(true)
            .background_color(tauri::window::Color(0x12, 0x14, 0x1a, 0xff))
            .build();
            if let Ok(tb) = toolbar {
                let _ = pin_bottom_right(&tb);
                let _ = tb.set_focus();
                // WDA_EXCLUDEFROMCAPTURE: keep the toolbar out of recorded frames
                unsafe {
                    use windows::Win32::UI::WindowsAndMessaging::{
                        SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
                    };
                    if let Ok(hwnd) = tb.hwnd() {
                        let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
                    }
                }
            }

            // progress emitter
            let h2 = handle.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(500));
                let rec = h2.state::<AppState>().recorder.lock().unwrap().clone();
                if let Some(rec) = rec {
                    let _ = h2.emit("recording-progress", rec.progress());
                }
            });

            // closing the main window quits the app entirely
            if let Some(main) = app.get_webview_window("main") {
                let handle_for_close = handle.clone();
                main.on_window_event(move |event| {
                    if let tauri::WindowEvent::Destroyed { .. } = event {
                        // main window closed by user → exit everything
                        let _ = handle_for_close;
                        handle_for_close.exit(0);
                    }
                });
            }

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
        let st = app.state::<AppState>();
        let rec_box = st.recorder.lock().unwrap().take();
        if let Some(rec_box) = rec_box {
            eprintln!("[rec] stop requested (hotkey)");
            let h = app.clone();
            tauri::async_runtime::spawn(async move {
                let rec: Recorder = match Arc::try_unwrap(rec_box) {
                    Ok(r) => r,
                    Err(arc) => {
                        let p = arc.result_path.clone();
                        arc.stop_flag().store(true, std::sync::atomic::Ordering::SeqCst);
                        std::mem::forget(arc);
                        let _ = h.emit("recording-saved", p.to_string_lossy().to_string());
                        return;
                    }
                };
                let path = rec
                    .stop()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default();
                eprintln!("[rec] stop finished → {path}");
                let _ = h.emit("recording-saved", path);
            });
        }
    } else {
        let _ = start_recording(app.clone(), app.state());
    }
}

fn toggle_pause(app: &AppHandle) {
    let st = app.state::<AppState>();
    let rec = st.recorder.lock().unwrap().clone();
    if let Some(rec) = rec {
        if rec.progress().state == State::Paused {
            rec.resume();
        } else {
            rec.pause();
        }
    }
}

/// Position a window at the bottom-right of the primary monitor's work area.
fn pin_bottom_right(w: &tauri::WebviewWindow) -> tauri::Result<()> {
    let mon = w
        .current_monitor()?
        .ok_or(tauri::Error::WindowNotFound)?;
    let size = w.outer_size()?;
    let x = mon.position().x + mon.size().width as i32 - size.width as i32 - 48;
    let y = mon.position().y + mon.size().height as i32 - size.height as i32 - 72;
    w.set_position(tauri::PhysicalPosition::new(x, y))
}
