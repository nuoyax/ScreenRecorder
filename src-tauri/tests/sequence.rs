//! End-to-end checks for the MV export: encode a source, cut it, decode the result.
//!
//! The unit tests next to `export/sequence.rs` cover the timing maths. What they cannot
//! cover is whether the frames that reach the disk are the frames that were asked for — a
//! run loop that seeks wrongly or holds the wrong decoded frame passes every arithmetic test
//! and exports the wrong footage.
//!
//! So this builds a real recording-shaped file, exports from it, and reads the output back
//! through the same decoder. The source is generated rather than borrowed from the user's
//! Videos folder: a test that only passes on one machine's recordings is not a test.
//!
//! Every frame of the source is a flat colour, so "did the right footage come out" is
//! answerable even though H.264 is lossy — the encoder cannot turn a green frame into a red
//! one. The colour changes every [`PHASE_FRAMES`] frames rather than every frame, because
//! 30 fps does not divide an MP4 timescale exactly and a decoded frame can land a tick either
//! side of where it was written. Sampling a block of flat colour makes the answer independent
//! of that; sampling every frame would make this a test of the container's rounding.
//!
//! Three things about the exported file were measured while writing these checks and shape
//! what they assert:
//!
//! * The first sample an encoder writes is routinely late in presentation time (measured: the
//!   second frame lands at 0.0333 s rather than 0.0), so nothing samples frame 0.
//! * An MP4 cannot represent 1/30 s exactly, so a frame's decoded time can be a tick off.
//!   Every sample stays at least two frames away from a colour change.
//! * Once the source runs out, MF's source reader stops handing back new samples — it can
//!   neither confirm nor move past the end — so the tail of an export that reads past the
//!   recording reads as whatever frame was current. Checks stay well inside the source.
//!
//! The source is 640x480 rather than something smaller on purpose. At 160x120 this project's
//! own encoder silently corrupts the picture, which was measured here with `tests/diag_temp.rs`
//! while writing these checks. That is a real finding about `encoder/mod.rs`, written down in
//! the W8 report rather than papered over, and it is why these tests use a size that encodes
//! correctly.

use screen_recorder::encoder::{AudioParams, EncoderConfig, SinkEncoder};
use screen_recorder::export::sequence::{
    average_rgb, frame_at, frame_containing, probe_source, run, FrameSource, SequenceOptions,
    SequenceRun,
};

/// Frames the source holds. At 30 fps this is 2 seconds.
const SRC_FRAMES: u32 = 60;
const SRC_W: u32 = 640;
const SRC_H: u32 = 480;
const SRC_FPS: u32 = 30;
const SRC_KBPS: u32 = 4_000;

/// Frames each colour lasts. See the module doc for why this is not 1.
const PHASE_FRAMES: u32 = 10;

/// Bump this whenever the builder above changes in a way that changes the recording it
/// writes — the palette, the frame count, the size. It is part of the source's file name,
/// so an old recording cannot be mistaken for the current one. See [`source`].
const SRC_BUILD: u32 = 2;

/// The colours, one per block of [`PHASE_FRAMES`] frames.
///
/// Index 0 is the darkest, and deliberately not pure black: the export writes black for a
/// gap in the timeline, and a test that could not tell the two apart could not tell footage
/// from a hole.
const PALETTE: [(f64, f64, f64); 8] = [
    (16.0, 16.0, 16.0),
    (200.0, 20.0, 20.0),
    (20.0, 200.0, 20.0),
    (20.0, 20.0, 200.0),
    (200.0, 200.0, 20.0),
    (20.0, 200.0, 200.0),
    (200.0, 20.0, 200.0),
    (230.0, 230.0, 230.0),
];

/// The block a source frame belongs to, and therefore which colour it carries.
///
/// Rotated so the first block is not the near-black one, so a gap reads as a distinct colour
/// from the recording's opening frames.
fn block_of(frame: u32) -> usize {
    ((frame / PHASE_FRAMES) as usize + 1) % PALETTE.len()
}

fn temp_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join("screen-recorder-sequence-tests");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A frame whose flat colour identifies the block of the source it came from.
fn indexed_frame(index: u32) -> Vec<u8> {
    let (r, g, b) = PALETTE[block_of(index)];
    let mut out = Vec::with_capacity((SRC_W * SRC_H * 4) as usize);
    for _ in 0..(SRC_W * SRC_H) {
        // BGRA, which is what the sink writer takes.
        out.extend_from_slice(&[b as u8, g as u8, r as u8, 255]);
    }
    out
}

/// Which colour a decoded frame is, or `None` when the codec has smeared it too far to say.
fn phase_of(rgb: [f64; 3]) -> Option<usize> {
    let mut best = (PALETTE.len(), f64::MAX);
    for (i, want) in PALETTE.iter().enumerate() {
        let d = (rgb[0] - want.0).abs() + (rgb[1] - want.1).abs() + (rgb[2] - want.2).abs();
        if d < best.1 {
            best = (i, d);
        }
    }
    // Neighbouring palette entries differ by 180 in at least one channel, so this is
    // unambiguous for anything the codec has not ruined.
    if best.1 < 90.0 {
        Some(best.0)
    } else {
        None
    }
}

/// The colours the decoder sees in `path`, sampled at frame midpoints.
///
/// Midpoints because that is where a player shows a frame, and it keeps the sample away from
/// the boundary where the container's rounding decides which of two frames wins.
fn phases_of(path: &str, count: u32) -> String {
    (0..count)
        .map(|k| {
            let sec = (k as f64 + 0.5) / SRC_FPS as f64;
            match frame_at(path, sec) {
                Ok((_, _, px)) => match phase_of(average_rgb(&px)) {
                    Some(p) => (b'0' + p as u8) as char,
                    None => '?',
                },
                Err(_) => '-',
            }
        })
        .collect()
}

/// Every pixel of one frame of `path` must be the single colour `want`.
///
/// An average would hide the failure this is here to catch: a frame that is half the right
/// footage and half something else averages to a plausible number, and a stride or row-order
/// bug produces exactly that.
fn assert_uniform(path: &str, want: usize, at: &str) {
    let (w, h, px) = frame_at(path, 0.2).expect("decode the export");
    assert_eq!(
        px.len(),
        (w as usize) * (h as usize) * 4,
        "{at}: a decoded frame must be w*h*4 bytes"
    );
    let (wr, wg, wb) = PALETTE[want];
    for (i, p) in px.chunks_exact(4).enumerate() {
        let d = (p[2] as f64 - wr).abs() + (p[1] as f64 - wg).abs() + (p[0] as f64 - wb).abs();
        assert!(
            d < 120.0,
            "{at}: pixel {i} of {} is ({}, {}, {}), expected the one colour ({wr}, {wg}, {wb})",
            px.len() / 4,
            p[2],
            p[1],
            p[0]
        );
    }
}

/// Write a source recording with an audio stream, so the audio path carries something real.
fn build_source(path: &std::path::Path) -> Result<(), String> {
    let cfg = EncoderConfig {
        width: SRC_W,
        height: SRC_H,
        fps: SRC_FPS,
        codec: "h264".to_string(),
        bitrate_kbps: SRC_KBPS,
        rate_mode: "vbr".to_string(),
        audio: Some(AudioParams {
            sample_rate: 48_000,
            channels: 1,
        }),
        input_bgra: true,
    };
    let enc = SinkEncoder::new(path, &cfg)?;

    let samples_per_frame = 48_000 / SRC_FPS;
    for i in 0..SRC_FRAMES {
        let ts_us = (i as u64 * 1_000_000) / SRC_FPS as u64;
        enc.write_video(&indexed_frame(i), SRC_W, SRC_H, ts_us)?;

        // A quiet tone rather than silence, so a resample with nothing to resample still has
        // something to get wrong.
        let mut pcm = Vec::with_capacity(samples_per_frame as usize * 2);
        for s in 0..samples_per_frame {
            let t = (i * samples_per_frame + s) as f64 / 48_000.0;
            let v = (t * 440.0 * std::f64::consts::TAU * 0.2).sin();
            pcm.extend_from_slice(&((v * 32_767.0) as i16).to_le_bytes());
        }
        enc.write_audio(&pcm, ts_us)?;
    }
    enc.finish()
}

/// Wait for the source to be usable, then hand back its path.
///
/// The harness runs these checks concurrently, so the first thing one of them does can be
/// the first thing *any* of them does. The lock makes sure the build finishes before anyone
/// is handed the path, and the marker makes an interrupted build visible rather than
/// trusted. See [`source`].
fn source_ready() -> String {
    static READY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    READY
        .get_or_init(|| {
            let path = temp_dir().join(format!("source-v{SRC_BUILD}.mp4"));
            let mark = marker(&path);
            if !(path.is_file() && mark.is_file()) {
                let _ = std::fs::remove_file(&path);
                let _ = std::fs::remove_file(&mark);
                build_source(&path).expect("the source must build");
                let _ = std::fs::write(&mark, b"ok");
            }
            path.to_string_lossy().to_string()
        })
        .clone()
}

/// The source, built once and shared by the whole test binary.
///
/// Every check in this file reads this one file — several of them at the same time, since
/// the harness runs them on separate threads. Two that both found it missing would both
/// start encoding it, one truncating what the other was decoding, and the symptom is not a
/// wrong colour but a decode that never returns. So [`source_ready`] builds it under a lock
/// before anyone can read it.
///
/// The builder version is part of the file name. The palette and the frame count below
/// decide what every assertion in this file expects, and a `source.mp4` left behind by an
/// earlier version of this file would be silently reused — every check here compares against
/// *this* file's constants, so the binary would be testing one recording against another's
/// expectations.
fn source() -> String {
    source_ready()
}

/// Where the "this file finished building" mark for `path` lives.
fn marker(path: &std::path::Path) -> std::path::PathBuf {
    path.with_extension("built")
}

/// Milliseconds at which `frame` starts, without the truncation of `frame * 1000 / 30`.
fn at_frame(frame: u32) -> u64 {
    ((frame as f64 / SRC_FPS as f64) * 1000.0).round() as u64
}

fn sequence_run(src_ms: u64, end_ms: u64, out_ms: u64, speed: f64) -> SequenceRun {
    SequenceRun {
        source_start_ms: src_ms,
        source_end_ms: end_ms,
        output_start_ms: out_ms,
        speed: speed,
    }
}

fn export(name: &str, runs: Vec<SequenceRun>, with_audio: bool) -> (std::path::PathBuf, String) {
    let out = temp_dir().join(name);
    let _ = std::fs::remove_file(&out);
    let src = source();
    let opts = SequenceOptions {
        input: src,
        output: out.to_string_lossy().to_string(),
        fps: SRC_FPS,
        width: SRC_W,
        height: SRC_H,
        runs,
        with_audio,
    };
    run(&opts, FrameSource::Recording, &mut |_, _| {}).expect("the export must succeed");
    let path = out.to_string_lossy().to_string();
    (out, path)
}

#[test]
fn the_source_decodes_to_what_was_written() {
    let info = probe_source(&source()).expect("the source probes");
    assert_eq!((info.width, info.height), (SRC_W, SRC_H), "dimensions round trip");
    assert!((info.fps - 30.0).abs() < 0.5, "fps came back as {}", info.fps);
    assert!(info.has_audio, "the source was written with audio");
    assert_eq!(info.audio_sample_rate, 48_000);
    assert_eq!(info.audio_channels, 1);

    // If the source decoded wrongly, every check below would be measuring the encoder rather
    // than the exporter. So it is checked first, and checked in full: blocks 1..5, with the
    // boundary frames left out for the reason in the module doc.
    let got = phases_of(&source(), SRC_FRAMES);
    let want: String = (0..SRC_FRAMES)
        .map(|i| {
            // The source's own tail is unreliable — the last samples MF hands back repeat —
            // so the expectation stops two blocks before the end.
            if i >= SRC_FRAMES - 2 * PHASE_FRAMES {
                '.'
            } else {
                (b'0' + block_of(i) as u8) as char
            }
        })
        .collect();
    for (i, (g, w)) in got.chars().zip(want.chars()).enumerate() {
        if w == '.' {
            continue;
        }
        // Skipped two frames either side of a colour change, per the module doc.
        let pos = i % (PHASE_FRAMES as usize);
        let last = (PHASE_FRAMES as usize) - 3;
        if pos < 2 || pos > last {
            continue;
        }
        assert_eq!(
            g, w,
            "source frame {i} decoded to '{g}', expected '{w}' ({got} against {want})"
        );
    }
}

/// The point of the whole path: a cut run exports the footage it names and nothing else.
#[test]
fn a_trimmed_export_contains_the_trimmed_footage() {
    // Source frames 20..40 — blocks 3 and 4 — placed at the start of the output.
    let (_, out) = export(
        "trim-out.mp4",
        vec![sequence_run(at_frame(20), at_frame(40), 0, 1.0)],
        true,
    );
    let got = phases_of(&out, 20);
    assert_eq!(&got[1..9], "33333333", "output frame 0 must be source frame 20");
    assert_eq!(
        &got[11..19],
        "44444444",
        "the export must run on through the source, not repeat its first frames"
    );

    // The pixels, not just their average.
    assert_uniform(&out, 3, "the opening frames of the trim");
}

/// A gap in the timeline becomes black, and the count is reported rather than hidden.
#[test]
fn a_gap_between_runs_comes_out_black_and_is_counted() {
    let dir = temp_dir();
    let out = dir.join("gap-out.mp4");
    let _ = std::fs::remove_file(&out);
    let opts = SequenceOptions {
        input: source(),
        output: out.to_string_lossy().to_string(),
        fps: SRC_FPS,
        width: SRC_W,
        height: SRC_H,
        // 10 frames from the start, a 10-frame hole, 10 frames from source frame 40.
        runs: vec![
            sequence_run(0, at_frame(10), 0, 1.0),
            sequence_run(at_frame(40), at_frame(50), at_frame(20), 1.0),
        ],
        with_audio: false,
    };
    let result = run(&opts, FrameSource::Recording, &mut |_, _| {}).expect("the export succeeds");
    assert_eq!(result.frames, 30, "10 + 10 gap + 10");
    assert_eq!(result.black_frames, 10, "the hole must be reported, not silent");
    assert_eq!(result.held_frames, 0, "nothing should have run out of source");

    let out_path = out.to_string_lossy().to_string();
    let got = phases_of(&out_path, 30);
    assert_eq!(&got[1..9], "11111111", "the first run's own footage");
    assert_eq!(&got[12..18], "000000", "the gap is black");
    assert_eq!(
        &got[21..29],
        "55555555",
        "the second run must come from source frame 40, not from where the first run ended"
    );
}

/// Speed is a source-seconds-per-output-second ratio, so the output has to advance through the
/// source faster or a sped-up clip exports at the wrong duration.
#[test]
fn a_two_times_run_exports_half_as_many_frames_of_the_same_footage() {
    let (_, out) = export(
        "speed-out.mp4",
        vec![sequence_run(0, at_frame(40), 0, 2.0)],
        false,
    );
    let got = phases_of(&out, 20);
    // Output frame n shows source frame 2n, so the blocks pass twice as fast: five output
    // frames per ten-frame source block.
    assert_eq!(&got[1..4], "111", "the opening block");
    assert_eq!(&got[6..9], "222", "at 2x the export must already be in the second block");
    assert_eq!(&got[11..14], "333", "and in the third");
    assert_eq!(&got[16..19], "444", "and in the fourth, which 1x would not have reached");
}

/// The composited path takes its pixels from the caller, so what it writes is exactly what it
/// was handed — this is what makes an annotated or zoomed MP4 export possible at all.
#[test]
fn the_rendered_export_writes_the_frames_it_was_given() {
    let dir = temp_dir();
    let out = dir.join("rendered-out.mp4");
    let _ = std::fs::remove_file(&out);
    let opts = SequenceOptions {
        // No source file at all, deliberately: this path's pixels come from the caller, so
        // the export must work without the recording ever being open. It also keeps the
        // one test that never decodes anything from being the one that shares a decode of
        // the shared source with four others running at the same time.
        input: dir.join("no-such-source.mp4").to_string_lossy().to_string(),
        output: out.to_string_lossy().to_string(),
        fps: SRC_FPS,
        width: SRC_W,
        height: SRC_H,
        // One run, so the caller is asked for exactly the sequence's frames.
        runs: vec![sequence_run(0, at_frame(15), 0, 1.0)],
        with_audio: false,
    };

    // A reddish colour the source never uses, so a pass cannot come from having copied the
    // recording through. The green channel steps by block, so a held or repeated frame would
    // change colour as well as index.
    let wanted = |index: u64| -> Vec<u8> {
        let shade = (40 + (index / PHASE_FRAMES as u64) * 60).min(250) as u8;
        let mut frame = Vec::with_capacity((SRC_W * SRC_H * 4) as usize);
        for _ in 0..(SRC_W * SRC_H) {
            // RGBA, as the webview would hand it over.
            frame.extend_from_slice(&[250, shade, 30, 255]);
        }
        frame
    };
    let mut asked: Vec<u64> = Vec::new();
    let mut feed = |index: u64| {
        asked.push(index);
        Ok(wanted(index))
    };
    let result = run(&opts, FrameSource::Rendered(&mut feed), &mut |_, _| {})
        .expect("the export succeeds");

    assert_eq!(result.frames, 15);
    assert_eq!(
        asked,
        (0..15).collect::<Vec<u64>>(),
        "exactly one render per output frame, in order"
    );
    assert_eq!(result.black_frames, 0);
    assert_eq!(result.held_frames, 0);

    // The frame the caller supplied for index 6: red channel high, blue low. If the BGRA swap
    // were skipped, red and blue would arrive the other way round.
    let (_, _, px) = frame_at(&out.to_string_lossy(), 6.5 / SRC_FPS as f64).expect("decode");
    let rgb = average_rgb(&px);
    assert!(
        rgb[0] > 200.0 && rgb[2] < 90.0,
        "the rendered frame must come through reddish, not blue-ish: {rgb:?}"
    );
}

/// Progress must reach the caller in order, and the total must not move under it.
#[test]
fn progress_is_reported_and_ends_at_the_total() {
    let dir = temp_dir();
    let out = dir.join("progress-out.mp4");
    let _ = std::fs::remove_file(&out);
    let opts = SequenceOptions {
        input: source(),
        output: out.to_string_lossy().to_string(),
        fps: SRC_FPS,
        width: SRC_W,
        height: SRC_H,
        runs: vec![sequence_run(0, at_frame(45), 0, 1.0)],
        with_audio: false,
    };
    let mut seen: Vec<(u64, u64)> = Vec::new();
    let result = run(&opts, FrameSource::Recording, &mut |done, total| {
        seen.push((done, total))
    })
    .expect("the export succeeds");

    assert_eq!(result.frames, 45);
    assert!(!seen.is_empty(), "progress must be reported at all");
    assert!(
        seen.windows(2).all(|w| w[1].0 >= w[0].0),
        "progress must not go backwards: {seen:?}"
    );
    assert_eq!(
        seen.last().unwrap().0,
        result.frames,
        "the last report is the final count"
    );
    assert!(
        seen.iter().all(|(_, total)| *total == result.frames),
        "the total must not change mid-export"
    );
}

/// The helper the tests above lean on, pinned so it cannot drift away from a player.
#[test]
fn the_containing_frame_is_the_last_one_at_or_before_an_instant() {
    assert_eq!(frame_containing(0.0, 30), 0);
    assert_eq!(frame_containing(0.0333, 30), 0, "0.0333 s is still frame 0");
    assert_eq!(frame_containing(0.0334, 30), 1);
    assert_eq!(frame_containing(0.0499, 30), 1);
    assert_eq!(frame_containing(0.0500, 30), 1, "frame 1 owns [1/30, 2/30)");
    assert_eq!(frame_containing(0.0667, 30), 2);
    assert_eq!(frame_containing(1.0, 30), 30);
    assert_eq!(frame_containing(-5.0, 30), 0, "a negative instant clamps to the start");
    assert_eq!(frame_containing(0.5, 0), 0, "a frame rate of zero cannot divide");
}
