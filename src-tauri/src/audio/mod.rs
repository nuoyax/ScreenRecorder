//! WASAPI capture (mic) + loopback (system audio) → mixed s16le PCM on a channel.
//!
//! Both sources are downmixed to mono, resampled to 48 kHz with linear
//! interpolation, gain-adjusted, mixed, and pushed as (pcm_bytes, ts_us) chunks.
//! ts_us is relative to audio-thread start; the recorder bridges it to the
//! video time base at recording start.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use windows::Win32::Media::Audio::{IAudioCaptureClient, IAudioClient};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
};

#[derive(Debug, Clone, Copy)]
pub struct AudioParams {
    pub sample_rate: u32,
    pub channels: u16,
}

pub struct AudioHandle {
    pub stop: Arc<AtomicBool>,
    pub pcm_rx: crossbeam_channel::Receiver<(Vec<u8>, u64)>, // bytes + ts_us
    pub params: AudioParams,
    join: Vec<std::thread::JoinHandle<()>>,
}

impl AudioHandle {
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        for j in self.join.drain(..) {
            let _ = j.join();
        }
    }
}

const OUT_RATE: u32 = 48_000;

fn com_init() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

fn get_client(loopback: bool) -> windows::core::Result<(IAudioClient, windows::Win32::Media::Audio::WAVEFORMATEX)> {
    unsafe {
        let enumerator: windows::Win32::Media::Audio::IMMDeviceEnumerator =
            CoCreateInstance(&windows::Win32::Media::Audio::MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = if loopback {
            enumerator.GetDefaultAudioEndpoint(
                windows::Win32::Media::Audio::EDataFlow(0), // eRender
                windows::Win32::Media::Audio::ERole(1),     // eConsole (multimedia)
            )?
        } else {
            enumerator.GetDefaultAudioEndpoint(
                windows::Win32::Media::Audio::EDataFlow(1), // eCapture
                windows::Win32::Media::Audio::ERole(1),
            )?
        };
        let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
        let flags = (windows::Win32::Media::Audio::AUDCLNT_STREAMFLAGS_LOOPBACK * (loopback as u32)) | windows::Win32::Media::Audio::AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
        let wf_ptr = client.GetMixFormat()?;
        let wf = *wf_ptr;
        client.Initialize(
            windows::Win32::Media::Audio::AUDCLNT_SHAREMODE_SHARED,
            flags,
            20_000_000, // 2s buffer
            0,
            wf_ptr,
            None,
        )?;
        Ok((client, wf))
    }
}

/// One capture thread: reads PCM from `loopback` (system) or mic, resamples to
/// OUT_RATE mono, applies gain, pushes (sample, ts_us) into `out_tx`.
fn capture_thread(
    loopback: bool,
    gain: f32,
    stop: Arc<AtomicBool>,
    out_tx: crossbeam_channel::Sender<(f32, u64)>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        com_init();
        let _ = run_capture(loopback, gain, stop, out_tx);
        unsafe {
            CoUninitialize();
        }
    })
}

fn run_capture(
    loopback: bool,
    gain: f32,
    stop: Arc<AtomicBool>,
    out_tx: crossbeam_channel::Sender<(f32, u64)>,
) -> windows::core::Result<()> {
    unsafe {
        let (client, wf) = get_client(loopback)?;
        let capture: IAudioCaptureClient = client.GetService()?;
        let event = windows::Win32::System::Threading::CreateEventW(None, false, false, None)?;
        client.SetEventHandle(event)?;
        client.Start()?;

        let src_rate = wf.nSamplesPerSec as f64;
        let src_ch = wf.nChannels as usize;
        let bytes_per_frame = wf.nBlockAlign as usize;

        let mut pos: f64 = 0.0; // output sample position (in input-frame units)
        let mut carry: Vec<f32> = Vec::new(); // input frames as (l, r) f32 pairs

        while !stop.load(Ordering::SeqCst) {
            let wait = windows::Win32::System::Threading::WaitForSingleObject(event, 200);
            if stop.load(Ordering::SeqCst) {
                break;
            }
            if wait == windows::Win32::Foundation::WAIT_TIMEOUT {
                continue;
            }
            loop {
                let packet_size = match capture.GetNextPacketSize() {
                    Ok(n) => n,
                    Err(_) => break,
                };
                if packet_size == 0 {
                    break;
                }
                let mut buffer = std::ptr::null_mut::<u8>();
                let mut frames = 0u32;
                let mut flags = 0u32;
                if capture
                    .GetBuffer(&mut buffer, &mut frames, &mut flags, None, None)
                    .is_err()
                {
                    break;
                }
                let frames = frames as usize;
                let slice = std::slice::from_raw_parts(buffer, frames * bytes_per_frame);
                // shared-mode mix format is float32
                for f in 0..frames {
                    let fb = &slice[f * bytes_per_frame..(f + 1) * bytes_per_frame];
                    let l = f32::from_le_bytes(fb[0..4].try_into().unwrap());
                    let r = if src_ch >= 2 && fb.len() >= 8 {
                        f32::from_le_bytes(fb[4..8].try_into().unwrap())
                    } else {
                        l
                    };
                    carry.push(l);
                    carry.push(r);
                }
                let _ = capture.ReleaseBuffer(frames as u32);
            }
            // linear resample carry → OUT_RATE mono
            let step = src_rate / OUT_RATE as f64;
            let in_frames = carry.len() / 2;
            while pos + step < in_frames as f64 {
                let i0 = (pos as usize) * 2;
                let l = carry.get(i0).copied().unwrap_or(0.0);
                let r = carry.get(i0 + 1).copied().unwrap_or(0.0);
                let sample = (l * 0.5 + r * 0.5) * gain;
                let ts_us = (pos / src_rate * 1e6) as u64;
                if out_tx.send((sample, ts_us)).is_err() {
                    return Ok(());
                }
                pos += step;
            }
            let consumed = (pos as usize) * 2;
            carry.drain(..consumed.min(carry.len()));
            pos -= (consumed / 2) as f64;
        }
        let _ = client.Stop();
    }
    Ok(())
}

/// Mixer thread: combines both sources' mono samples, quantizes to s16le,
/// batches ~20ms chunks.
fn mixer_thread(
    in_rx: crossbeam_channel::Receiver<(f32, u64)>,
    out_tx: crossbeam_channel::Sender<(Vec<u8>, u64)>,
    stop: Arc<AtomicBool>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        const CHUNK: usize = OUT_RATE as usize / 50; // 20ms
        let mut acc: Vec<u8> = Vec::with_capacity(CHUNK * 2);
        let mut chunk_ts: Option<u64> = None;
        loop {
            if stop.load(Ordering::SeqCst) && in_rx.is_empty() {
                if !acc.is_empty() {
                    let _ = out_tx.send((std::mem::take(&mut acc), chunk_ts.unwrap_or(0)));
                }
                break;
            }
            match in_rx.recv_timeout(std::time::Duration::from_millis(100)) {
                Ok((s, ts)) => {
                    if chunk_ts.is_none() {
                        chunk_ts = Some(ts);
                    }
                    let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
                    acc.extend_from_slice(&v.to_le_bytes());
                    if acc.len() >= CHUNK * 2 {
                        let _ = out_tx.send((std::mem::take(&mut acc), chunk_ts.unwrap_or(0)));
                        chunk_ts = None;
                    }
                }
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
                Err(_) => break,
            }
        }
    })
}

/// Start audio capture. `sys_gain`/`mic_gain` in 0.0..2.0.
pub fn start_audio(
    record_system: bool,
    record_mic: bool,
    sys_gain: f32,
    mic_gain: f32,
) -> Result<AudioHandle, String> {
    if !record_system && !record_mic {
        return Err("no audio source enabled".into());
    }
    let stop = Arc::new(AtomicBool::new(false));
    let (sample_tx, sample_rx) = crossbeam_channel::bounded::<(f32, u64)>(OUT_RATE as usize * 4);
    let (pcm_tx, pcm_rx) = crossbeam_channel::bounded::<(Vec<u8>, u64)>(64);

    let mut join = Vec::new();
    if record_system {
        join.push(capture_thread(true, sys_gain, stop.clone(), sample_tx.clone()));
    }
    if record_mic {
        join.push(capture_thread(false, mic_gain, stop.clone(), sample_tx.clone()));
    }
    join.push(mixer_thread(sample_rx, pcm_tx, stop.clone()));
    drop(sample_tx);

    Ok(AudioHandle {
        stop,
        pcm_rx,
        params: AudioParams {
            sample_rate: OUT_RATE,
            channels: 1,
        },
        join,
    })
}
