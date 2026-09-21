//! Cursor position and click sampling by polling.
//!
//! The sampler polls `GetCursorPos` and `GetAsyncKeyState` on a fixed interval and
//! records the samples that matter. Polling is deliberate: it needs no global hook,
//! no privilege, and no cleanup if the process dies mid-recording.
//!
//! Accuracy trade-off: a click shorter than one poll interval can be missed. At the
//! default 8 ms interval that is well under a frame at 60 fps, so a visible click
//! cannot be dropped from the recording it belongs to.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use windows::Win32::Foundation::POINT;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

/// One cursor position reading, in virtual-screen coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct MoveSample {
    pub t_us: u64,
    pub x: i32,
    pub y: i32,
}

/// One button press. `button` is `"left"` or `"right"`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ClickSample {
    pub t_us: u64,
    pub x: i32,
    pub y: i32,
    pub button: String,
}

/// Everything the sampler observed, as written next to the recording.
#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct MouseTrack {
    pub moves: Vec<MoveSample>,
    pub clicks: Vec<ClickSample>,
    /// Poll interval the samples were taken at, so consumers know the resolution.
    pub interval_us: u64,
    /// Rectangle of the screen that was recorded, in virtual-screen coordinates.
    ///
    /// Samples are absolute and the recording is not, so without this a consumer cannot
    /// tell which part of the screen the frame covers — and would draw the cursor in the
    /// wrong place on a region recording, or on a multi-monitor setup where the primary
    /// display does not start at (0,0). Absent in tracks written before it was recorded;
    /// a missing value means "assume the samples are already frame-relative".
    pub rect: Option<SampleRect>,
}

/// Screen rectangle a recording covers, in virtual-screen coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SampleRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

const DEFAULT_INTERVAL_US: u64 = 8_000;

/// Downloads a recorded mouse track from disk. The file is optional: recordings made
/// before this existed, or with sampling disabled, simply have none.
pub fn load_sidecar(path: &std::path::Path) -> Option<MouseTrack> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Sidecar path for a recording: `recording_x.mp4` → `recording_x.mp4.mouse.json`.
pub fn sidecar_path(recording: &std::path::Path) -> std::path::PathBuf {
    let mut s = recording.as_os_str().to_os_string();
    s.push(".mouse.json");
    std::path::PathBuf::from(s)
}

pub struct MouseSampler {
    stop: Arc<AtomicBool>,
    track: Arc<Mutex<MouseTrack>>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl MouseSampler {
    /// Start sampling against the recording's shared `origin` clock.
    ///
    /// `rect` records *which* screen rectangle these samples are relative to. The
    /// samples themselves stay absolute (that is what `GetCursorPos` gives), so the
    /// consumer needs the rectangle to map them onto a frame — the alternative,
    /// subtracting the origin here, would silently bake one recording's framing into a
    /// sidecar that is meant to be read alongside any of them.
    pub fn start(origin: Instant, rect: SampleRect) -> MouseSampler {
        let stop = Arc::new(AtomicBool::new(false));
        let track = Arc::new(Mutex::new(MouseTrack {
            interval_us: DEFAULT_INTERVAL_US,
            rect: Some(rect),
            ..Default::default()
        }));
        let stop2 = stop.clone();
        let track2 = track.clone();

        let join = std::thread::spawn(move || {
            let interval = std::time::Duration::from_micros(DEFAULT_INTERVAL_US);
            let mut last: Option<(i32, i32)> = None;
            let mut left_down = false;
            let mut right_down = false;
            // Sleep in short slices so stop() is responsive even though the sampling
            // interval is only 8 ms.
            loop {
                if stop2.load(Ordering::SeqCst) {
                    break;
                }
                std::thread::sleep(interval);
                let t_us = origin.elapsed().as_micros() as u64;

                let mut p = POINT::default();
                // SAFETY: GetCursorPos only writes into the POINT we own; it has no
                // side effects on the system.
                if unsafe { GetCursorPos(&mut p) }.is_err() {
                    continue;
                }
                let (x, y) = (p.x, p.y);
                if last != Some((x, y)) {
                    last = Some((x, y));
                    track2.lock().unwrap().moves.push(MoveSample { t_us, x, y });
                }

                // GetAsyncKeyState returns the high bit set while the key is down.
                let l = unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } as u16 & 0x8000 != 0;
                let r = unsafe { GetAsyncKeyState(VK_RBUTTON.0 as i32) } as u16 & 0x8000 != 0;
                let mut clicks = track2.lock().unwrap();
                if l && !left_down {
                    clicks.clicks.push(ClickSample { t_us, x, y, button: "left".into() });
                }
                if r && !right_down {
                    clicks.clicks.push(ClickSample { t_us, x, y, button: "right".into() });
                }
                left_down = l;
                right_down = r;
            }
        });

        MouseSampler {
            stop,
            track,
            join: Some(join),
        }
    }

    /// Stop sampling and return what was observed.
    pub fn stop(mut self) -> MouseTrack {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
        self.track.lock().unwrap().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_path_appends_extension() {
        let p = sidecar_path(std::path::Path::new("C:\\vids\\recording_1.mp4"));
        assert_eq!(
            p.to_string_lossy(),
            "C:\\vids\\recording_1.mp4.mouse.json",
            "sidecar must sit beside the recording and keep the mp4 name readable"
        );
    }

    #[test]
    fn load_sidecar_returns_none_for_missing_file() {
        let missing = std::env::temp_dir().join("definitely_not_here.mouse.json");
        let _ = std::fs::remove_file(&missing);
        assert!(load_sidecar(&missing).is_none());
    }

    #[test]
    fn sidecar_roundtrips_through_json() {
        let track = MouseTrack {
            moves: vec![MoveSample {
                t_us: 1_500,
                x: 10,
                y: -20,
            }],
            clicks: vec![ClickSample {
                t_us: 2_000,
                x: 10,
                y: -20,
                button: "left".into(),
            }],
            interval_us: 8_000,
            rect: Some(SampleRect {
                x: 1920,
                y: -120,
                width: 2560,
                height: 1440,
            }),
        };
        let path = std::env::temp_dir().join("mouse_roundtrip.mouse.json");
        std::fs::write(&path, serde_json::to_vec(&track).unwrap()).unwrap();
        let back = load_sidecar(&path).expect("sidecar should parse");
        assert_eq!(back.moves, track.moves);
        assert_eq!(back.clicks.len(), 1);
        assert_eq!(back.clicks[0].button, "left");
        assert_eq!(back.clicks[0].y, -20, "negative coords must survive");
        assert_eq!(back.rect, track.rect, "the recorded rectangle must survive");
        let _ = std::fs::remove_file(&path);
    }

    /// A truncated or absent field must not make the whole track unreadable — the
    /// JSON is written next to a user's video and may predate a schema change.
    #[test]
    fn sidecar_tolerates_missing_fields() {
        let path = std::env::temp_dir().join("mouse_partial.mouse.json");
        std::fs::write(&path, br#"{"moves":[{"t_us":5,"x":1,"y":2}]}"#).unwrap();
        let back = load_sidecar(&path).expect("partial sidecar should parse");
        assert_eq!(back.moves.len(), 1);
        assert!(back.clicks.is_empty());
        assert_eq!(back.interval_us, 0);
        // Written before the rectangle was recorded: absent, not a bogus zero rectangle.
        assert!(back.rect.is_none());
        let _ = std::fs::remove_file(&path);
    }

    /// The sampler must produce monotonic timestamps and actually observe a moving
    /// cursor; a frozen clock or an unregistered thread would break overlays silently.
    #[test]
    fn sampler_records_monotonic_samples_then_stops() {
        let origin = Instant::now();
        let rect = SampleRect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let sampler = MouseSampler::start(origin, rect);
        std::thread::sleep(std::time::Duration::from_millis(60));
        let track = sampler.stop();
        assert_eq!(track.rect, Some(rect), "the sampler must record its rectangle");
        for w in track.moves.windows(2) {
            assert!(
                w[1].t_us >= w[0].t_us,
                "timestamps must be monotonic: {:?} then {:?}",
                w[0],
                w[1]
            );
        }
        for c in &track.clicks {
            assert!(c.t_us <= origin.elapsed().as_micros() as u64 + 1_000);
        }
    }
}
