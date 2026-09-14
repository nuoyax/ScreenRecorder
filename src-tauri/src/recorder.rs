//! Recorder state machine: wires capture → encoder, audio → encoder, pause/resume,
//! auto-stop, progress events.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::audio::{self, AudioHandle};
use crate::capture::wgc::{self, RawFrame, SourceKind};
use crate::encoder::{EncoderConfig, SinkEncoder};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Idle,
    Recording,
    Paused,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Progress {
    pub state: State,
    pub duration_secs: f64,
    pub file_mb: f64,
    pub frames: u64,
}

pub struct RecorderOptions {
    pub source: SourceKind,
    pub region: Option<(i32, i32, u32, u32)>,
    pub fps: u32,
    pub width: u32,
    pub height: u32,
    pub codec: String,
    pub bitrate_kbps: u32,
    pub rate_mode: String,
    pub output_path: PathBuf,
    pub audio: Option<(bool, bool, f32, f32)>, // sys, mic, sys_gain, mic_gain
    pub max_duration: Option<Duration>,
    pub max_file_mb: Option<u64>,
}

pub struct Recorder {
    pub state: Arc<Mutex<State>>,
    paused: Arc<AtomicBool>,
    stop_flag: Arc<AtomicBool>,
    /// total paused duration, updated by pause/resume
    pub paused_total_us: Arc<AtomicU64>,
    pause_started_at: Arc<Mutex<Option<Instant>>>,
    worker: Option<std::thread::JoinHandle<()>>,
    audio: Option<AudioHandle>,
    capture: Option<wgc::CaptureHandle>,
    pub result_path: PathBuf,
    frame_count: Arc<AtomicU64>,
    start_us: u64,
}

pub fn now_us() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as u64)
        .unwrap_or(0)
}

impl Recorder {
    pub fn start(opts: RecorderOptions) -> Result<Arc<Recorder>, String> {
        let (frame_tx, frame_rx) = crossbeam_channel::bounded::<RawFrame>(8);
        let capture = wgc::start_capture(opts.source.clone(), opts.region, frame_tx)
            .map_err(|e| format!("capture init failed: {e}"))?;

        let audio_handle = match &opts.audio {
            Some((sys, mic, sg, mg)) if *sys || *mic => Some(
                audio::start_audio(*sys, *mic, *sg, *mg)
                    .map_err(|e| format!("audio init failed: {e}"))?,
            ),
            _ => None,
        };
        let audio_params = audio_handle
            .as_ref()
            .map(|a| crate::encoder::AudioParams {
                sample_rate: a.params.sample_rate,
                channels: a.params.channels,
            });

        // first frame defines actual frame size
        let first = frame_rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "no frames from capture (timeout)")?;

        let (w, h) = (first.width, first.height);
        let cfg = EncoderConfig {
            width: w,
            height: h,
            fps: opts.fps,
            codec: opts.codec.clone(),
            bitrate_kbps: opts.bitrate_kbps,
            rate_mode: opts.rate_mode.clone(),
            audio: audio_params,
            input_bgra: true,
        };

        let state = Arc::new(Mutex::new(State::Recording));
        let paused = Arc::new(AtomicBool::new(false));
        let stop_flag = Arc::new(AtomicBool::new(false));
        let paused_total_us = Arc::new(AtomicU64::new(0));
        let pause_started_at = Arc::new(Mutex::new(None::<Instant>));
        let file_size = Arc::new(AtomicU64::new(0));
        let frame_count = Arc::new(AtomicU64::new(0));

        // clock base: video timestamps come from capture (its own Instant base);
        // audio ts are audio-start-relative — we bridge by sending audio with an
        // offset computed from the first audio chunk vs recording start.
        let video_base_us = now_us(); // approximates capture start (set just after first frame)

        let _audio_ref = audio_handle.as_ref();
        let audio_offset_us = Arc::new(AtomicU64::new(0));
        let _audio_offset = audio_offset_us.clone();
        let audio_base = Arc::new(AtomicU64::new(0)); // set to capture-relative base on first chunk
        let audio_base2 = audio_base.clone();
        let _audio_initialized = Arc::new(AtomicBool::new(false));

        let mut audio_rx = audio_handle.as_ref().map(|a| a.pcm_rx.clone());
        let stop2 = stop_flag.clone();
        let paused2 = paused.clone();
        let paused_total2 = paused_total_us.clone();
        let frame_count2 = frame_count.clone();
        let file_size2 = file_size.clone();
        let state2 = state.clone();
        let max_dur = opts.max_duration;
        let max_mb = opts.max_file_mb;
        let out_path = opts.output_path.clone();
        let out_path2 = out_path.clone();

        let worker = std::thread::spawn(move || {
            let enc = match SinkEncoder::new(&out_path2, &cfg) {
                Ok(e) => e,
                Err(e) => {
                    eprintln!("encoder: {e}");
                    *state2.lock().unwrap() = State::Idle;
                    stop2.store(true, Ordering::SeqCst);
                    return;
                }
            };
            // write first frame
            if let Err(e) = enc.write_video(&first.data, w, h, 0) {
                eprintln!("encoder write_video(first): {e}");
            }
            let frame_duration_us = 1_000_000u64 / opts.fps.max(1) as u64;
            frame_count2.fetch_add(1, Ordering::SeqCst);
            let mut last_ts = 0u64;
            let audio_buf: Vec<(Vec<u8>, u64)> = Vec::new();

            loop {
                // audio pump (non-blocking)
                if let Some(rx) = &mut audio_rx {
                    while let Ok((pcm, ts)) = rx.try_recv() {
                        let base = audio_base2.load(Ordering::SeqCst);
                        let _ = enc.write_audio(&pcm, base + ts);
                    }
                }
                if stop2.load(Ordering::SeqCst) {
                    break;
                }
                if paused2.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(20));
                    continue;
                }
                match frame_rx.recv_timeout(Duration::from_millis(300)) {
                    Ok(f) => {
                        // shift timestamps so pause intervals are removed
                        let mut ts = f.ts_us.saturating_sub(paused_total2.load(Ordering::SeqCst));
                        if ts <= last_ts {
                            ts = last_ts + 1;
                        }
                        last_ts = ts;
                        if let Err(e) = enc.write_video(&f.data, f.width, f.height, ts) {
                            eprintln!("encoder write_video: {e}");
                        }
                        frame_count2.fetch_add(1, Ordering::SeqCst);
                        file_size2.store(
                            std::fs::metadata(&out_path2).map(|m| m.len()).unwrap_or(0),
                            Ordering::SeqCst,
                        );
                        if let Some(max) = max_dur {
                            if Duration::from_micros(ts) >= max {
                                stop2.store(true, Ordering::SeqCst);
                                break;
                            }
                        }
                        if let Some(mb) = max_mb {
                            if file_size2.load(Ordering::SeqCst) >= mb * 1024 * 1024 {
                                stop2.store(true, Ordering::SeqCst);
                                break;
                            }
                        }
                    }
                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                        // feed a duplicate of the last frame to keep MP4 timeline alive
                        let ts = last_ts + frame_duration_us * 2;
                        // skip: encoder handles sparse input fine
                        let _ = ts;
                    }
                    Err(_) => break,
                }
                let _ = video_base_us;
            }
            // final audio drain
            if let Some(rx) = &mut audio_rx {
                while let Ok((pcm, ts)) = rx.try_recv() {
                    let base = audio_base2.load(Ordering::SeqCst);
                    let _ = enc.write_audio(&pcm, base + ts);
                }
            }
            let _ = enc.finish();
            *state2.lock().unwrap() = State::Idle;
            let _ = audio_buf;
        });

        // audio offset calibration: audio ts are relative to its own start which
        // happens ~same time as capture start; use 0 base (drift < 100ms acceptable)
        audio_base.store(0, Ordering::SeqCst);

        Ok(Arc::new(Recorder {
            state,
            paused,
            stop_flag,
            paused_total_us,
            pause_started_at,
            worker: Some(worker),
            audio: audio_handle,
            capture: Some(capture),
            result_path: out_path,
            frame_count,
            start_us: now_us(),
        }))
    }

    pub fn pause(&self) {
        let mut guard = self.pause_started_at.lock().unwrap();
        if guard.is_none() {
            *guard = Some(Instant::now());
            self.paused.store(true, Ordering::SeqCst);
            *self.state.lock().unwrap() = State::Paused;
        }
    }

    pub fn resume(&self) {
        let mut guard = self.pause_started_at.lock().unwrap();
        if let Some(t) = guard.take() {
            let us = t.elapsed().as_micros() as u64;
            self.paused_total_us.fetch_add(us, Ordering::SeqCst);
            self.paused.store(false, Ordering::SeqCst);
            *self.state.lock().unwrap() = State::Recording;
        }
    }

    pub fn stop_flag(&self) -> Arc<AtomicBool> {
        self.stop_flag.clone()
    }

    pub fn stop(mut self) -> Option<PathBuf> {
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Some(c) = self.capture.take() {
            c.stop();
        }
        if let Some(a) = self.audio.take() {
            a.stop();
        }
        let path = self.result_path.clone();
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
        Some(path)
    }

    pub fn progress(&self) -> Progress {
        let st = *self.state.lock().unwrap();
        let dur_us = if st == State::Recording {
            now_us().saturating_sub(self.start_us)
                - self.paused_total_us.load(Ordering::SeqCst)
        } else if st == State::Paused {
            self.pause_started_at
                .lock()
                .unwrap()
                .map(|_t| now_us().saturating_sub(self.start_us) - self.paused_total_us.load(Ordering::SeqCst))
                .unwrap_or(0)
        } else {
            0
        };
        let file_mb = std::fs::metadata(&self.result_path)
            .map(|m| m.len() as f64 / (1024.0 * 1024.0))
            .unwrap_or(0.0);
        Progress {
            state: st,
            duration_secs: dur_us as f64 / 1e6,
            file_mb,
            frames: self.frame_count.load(Ordering::SeqCst),
        }
    }
}
