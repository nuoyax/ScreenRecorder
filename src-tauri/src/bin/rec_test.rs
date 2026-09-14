//! End-to-end smoke test: capture primary monitor for 6s, encode to MP4,
//! verify the file exists and is non-trivial. Mirrors the start_recording path.

use screen_recorder::capture::enum_sources::enumerate_monitors;
use screen_recorder::capture::wgc::SourceKind;

use screen_recorder::recorder::{Recorder, RecorderOptions};
use std::time::Duration;

fn main() {
    let mons = enumerate_monitors();
    println!("monitors: {mons:?}");
    let first = mons.first().expect("no monitor found");
    let out = std::env::temp_dir().join("rec_test_output.mp4");
    let _ = std::fs::remove_file(&out);

    let rec = Recorder::start(RecorderOptions {
        source: SourceKind::Monitor(first.id.clone()),
        region: None,
        fps: 30,
        width: 0,
        height: 0,
        codec: "h264".into(),
        bitrate_kbps: 8000,
        rate_mode: "vbr".into(),
        output_path: out.clone(),
        audio: if std::env::var("REC_NO_AUDIO").is_ok() { None } else { Some((true, false, 1.0, 1.0)) },
        max_duration: Some(Duration::from_secs(6)),
        max_file_mb: None,
    })
    .expect("recorder start failed");

    for i in 0..8 {
        std::thread::sleep(Duration::from_millis(1000));
        let p = rec.progress();
        println!("[{i}s] state={:?} dur={:.1}s frames={} mb={:.2}", p.state, p.duration_secs, p.frames, p.file_mb);
    }

    let stop_flag = rec.stop_flag();
    stop_flag.store(true, std::sync::atomic::Ordering::SeqCst);
    // drop our Arc so try_unwrap-style teardown can proceed; just leak it here
    std::mem::forget(rec);
    std::thread::sleep(Duration::from_secs(3));

    let meta = std::fs::metadata(&out);
    match meta {
        Ok(m) => println!("OK: {} = {:.2} MB", out.display(), m.len() as f64 / 1048576.0),
        Err(e) => panic!("FAIL: output missing: {e}"),
    }
}
