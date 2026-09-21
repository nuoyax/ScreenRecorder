//! End-to-end smoke test: capture primary monitor for 6s, encode to MP4,
//! verify the file exists and is non-trivial. Mirrors the start_recording path.

use screen_recorder::capture::enum_sources::enumerate_monitors;
use screen_recorder::capture::wgc::SourceKind;

use screen_recorder::recorder::{Recorder, RecorderOptions};
use std::time::Duration;

fn main() {
    let mons = enumerate_monitors();
    println!("monitors: {mons:?}");
    let mics = screen_recorder::audio::list_microphones();
    println!("microphones: {} found", mics.len());
    for m in &mics {
        println!(
            "  - {}{} [{}]",
            m.name,
            if m.is_default { " (default)" } else { "" },
            &m.id[..m.id.len().min(48)]
        );
    }
    if mics.is_empty() {
        panic!("FAIL: no capture endpoints enumerated");
    }
    if mics.iter().any(|m| m.name.is_empty()) {
        panic!("FAIL: a microphone came back with an empty name");
    }
    if mics.iter().filter(|m| m.is_default).count() != 1 {
        panic!("FAIL: expected exactly one default microphone");
    }

    let first = mons.first().expect("no monitor found");

    // The region picker's still frame is what the user aims with, so its geometry
    // must be self-consistent: preview size, scale factor, and the monitor rectangle
    // it claims to cover all have to agree, or every picked region would be offset.
    let still = screen_recorder::capture::still::capture_monitor(&first.id)
        .expect("FAIL: monitor still capture failed");
    let (png_w, png_h) = screen_recorder::image::png::read_ihdr_size(&still.preview_png)
        .expect("FAIL: still is not a readable PNG");
    if (png_w, png_h) != (still.preview_width, still.preview_height) {
        panic!(
            "FAIL: still reports {}x{} but the PNG is {}x{}",
            still.preview_width, still.preview_height, png_w, png_h
        );
    }
    let round_w = still.preview_width as f64 * still.scale;
    let round_h = still.preview_height as f64 * still.scale;
    if (round_w - first.width as f64).abs() > 1.0 || (round_h - first.height as f64).abs() > 1.0 {
        panic!(
            "FAIL: preview {}x{} at scale {} does not map back to the monitor {}x{}",
            still.preview_width, still.preview_height, still.scale, first.width, first.height
        );
    }
    println!(
        "STILL: {}x{} png ({} bytes), scale={:.3}, monitor={}x{} @ {},{}",
        still.preview_width,
        still.preview_height,
        still.preview_png.len(),
        still.scale,
        first.width,
        first.height,
        first.x,
        first.y
    );

    let out = std::env::temp_dir().join("rec_test_output.mp4");
    let _ = std::fs::remove_file(&out);

    let rec = Recorder::start(RecorderOptions {
        source: SourceKind::Monitor(first.id.clone()),
        region: None,
        fps: 30,
        width: 0,
        height: 0,
        // REC_SCALE_WIDTH=1280 exercises the output downscale path end to end.
        scale_width: std::env::var("REC_SCALE_WIDTH")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0),
        codec: "h264".into(),
        bitrate_kbps: 8000,
        rate_mode: "vbr".into(),
        output_path: out.clone(),
        audio: if std::env::var("REC_NO_AUDIO").is_ok() { None } else { Some((true, false, 1.0, 1.0)) },
        mic_device: None,
        // REC_NO_CURSOR=1 records without the OS cursor, mirroring the UI toggle.
        show_cursor: std::env::var("REC_NO_CURSOR").is_err(),
        sample_mouse: true,
        // The rectangle the recording covers, so the sidecar's absolute samples can be
        // placed on frames. A full-monitor recording, which is what this test takes.
        sample_rect: screen_recorder::input::mouse::SampleRect {
            x: first.x,
            y: first.y,
            width: first.width as u32,
            height: first.height as u32,
        },
        max_duration: Some(Duration::from_secs(6)),
        max_file_mb: None,
    })
    .expect("recorder start failed");

    for i in 0..8 {
        std::thread::sleep(Duration::from_millis(1000));
        let p = rec.progress();
        println!("[{i}s] state={:?} dur={:.1}s frames={} mb={:.2}", p.state, p.duration_secs, p.frames, p.file_mb);
    }

    // Drive the real teardown path so the smoke test covers what stop_recording does
    // in the app: finalize the MP4 and write the mouse sidecar.
    let rec = std::sync::Arc::try_unwrap(rec).unwrap_or_else(|_| {
        panic!("FAIL: recorder Arc still shared; drop other handles before stopping")
    });
    match rec.stop() {
        Some(p) => println!("STOPPED: {}", p.display()),
        None => panic!("FAIL: stop() returned no path"),
    }

    let meta = std::fs::metadata(&out);
    match meta {
        Ok(m) => println!("OK: {} = {:.2} MB", out.display(), m.len() as f64 / 1048576.0),
        Err(e) => panic!("FAIL: output missing: {e}"),
    }

    let sidecar = screen_recorder::input::mouse::sidecar_path(&out);
    match screen_recorder::input::mouse::load_sidecar(&sidecar) {
        Some(t) => {
            if t.moves.is_empty() {
                panic!("FAIL: sidecar has no cursor samples");
            }
            let mut last = 0u64;
            for m in &t.moves {
                if m.t_us < last {
                    panic!("FAIL: sidecar timestamps not monotonic");
                }
                last = m.t_us;
            }
            println!(
                "MOUSE: {} moves, {} clicks, interval={}us, span={:.1}s → {}",
                t.moves.len(),
                t.clicks.len(),
                t.interval_us,
                last as f64 / 1e6,
                sidecar.display()
            );
        }
        None => panic!("FAIL: no sidecar at {}", sidecar.display()),
    }
}
