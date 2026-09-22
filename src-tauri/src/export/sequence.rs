//! MV export: trim, concatenate and re-encode a recording into a new MP4.
//!
//! This is the export the editor's *timeline* produces, as opposed to the GIF and
//! sticker paths, which render the composed canvas. The distinction is the whole point
//! of having both:
//!
//!   * GIF / PNG / sticker — what the preview shows: background, crop, zoom, annotations,
//!     cursor overlay. Written by this app's own encoders.
//!   * MV (here) — the recorded footage itself, cut to the clip sequence and re-encoded.
//!     No background, no zoom, no annotations. Those are *drawn* effects and this path
//!     never draws anything.
//!
//! Saying that plainly in the UI matters more than the feature: an MP4 that silently
//! lacked the annotations the user just placed would look broken.
//!
//! Decoding goes through Media Foundation's source reader — the same stack the recorder
//! already encodes with, so nothing new is linked in and no codec ships with the app.
//! The webview already decodes the source for preview; doing it here instead means MV
//! does not depend on WebCodecs, on `mp4box`, or on the webview staying alive — and it
//! means the export can be verified by a real encode on a machine that has neither.

use std::path::Path;

use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::Variant::{VT_I8, VT_UI8};

use crate::encoder::{AudioParams, EncoderConfig, SinkEncoder};

/// Audio the MV path writes: 48 kHz mono, the same shape the recorder captures in.
const OUT_RATE: u32 = 48_000;
const OUT_CHANNELS: u16 = 1;

/// Output samples handed to the sink writer at a time. Half a second keeps the two
/// streams interleaved without making the per-call overhead dominate.
const AUDIO_CHUNK: usize = (OUT_RATE / 2) as usize;

/// 100-nanosecond units per second, Media Foundation's time base everywhere.
const HNS: f64 = 10_000_000.0;

/// What a recording contains, read from its own header before any decoding.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SourceInfo {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub duration_ms: u64,
    pub has_audio: bool,
    pub audio_sample_rate: u32,
    pub audio_channels: u16,
}

/// One stretch of the recording to decode, and where it lands in the output.
///
/// `source_start_ms..source_end_ms` is a position in the *recording*;
/// `output_start_ms` is where that footage begins in the *export*. They are equal only
/// when nothing before this run was cut and no run plays at another speed.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceRun {
    pub source_start_ms: u64,
    pub source_end_ms: u64,
    pub output_start_ms: u64,
    /// Playback speed. `> 1` consumes source faster than it emits output.
    pub speed: f64,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceOptions {
    pub input: String,
    pub output: String,
    pub fps: u32,
    /// Output size, which this path never changes from the source's.
    pub width: u32,
    pub height: u32,
    pub runs: Vec<SequenceRun>,
    pub with_audio: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SequenceResult {
    pub path: String,
    pub bytes: u64,
    pub frames: u64,
    pub duration_ms: u64,
    /// Frames written black because no clip covered that part of the timeline.
    pub black_frames: u64,
    /// Frames repeated because the source ran out before the run did. A freeze is
    /// visible; a silently short file is not, so the count is reported.
    pub held_frames: u64,
    /// Output audio samples written. 0 with `with_audio` set means audio was dropped.
    pub audio_samples: u64,
}

fn hr<T>(v: windows::core::Result<T>) -> Result<T, String> {
    v.map_err(|e| format!("Media Foundation: {e}"))
}

/// Read a packed `(high, low)` attribute, the layout MF uses for sizes and ratios.
fn unpack_u64(packed: u64) -> (u64, u64) {
    (packed >> 32, packed & 0xffff_ffff)
}

unsafe fn attr_u32(attrs: &IMFAttributes, key: &windows::core::GUID) -> Option<u32> {
    unsafe { attrs.GetUINT32(key) }.ok()
}

unsafe fn attr_u64(attrs: &IMFAttributes, key: &windows::core::GUID) -> Option<u64> {
    unsafe { attrs.GetUINT64(key) }.ok()
}

/// Read a `VT_I8` / `VT_UI8` PROPVARIANT, which is how MF reports durations.
unsafe fn prop_u64(pv: &PROPVARIANT) -> Option<u64> {
    unsafe {
        let inner = &pv.Anonymous.Anonymous;
        let vt = std::ptr::read_unaligned(std::ptr::addr_of!(inner.vt));
        match vt {
            VT_UI8 => Some(std::ptr::read_unaligned(std::ptr::addr_of!(
                inner.Anonymous.uhVal
            ))),
            VT_I8 => {
                let v = std::ptr::read_unaligned(std::ptr::addr_of!(inner.Anonymous.hVal));
                (v >= 0).then_some(v as u64)
            }
            _ => None,
        }
    }
}

/// A `VT_I8` PROPVARIANT holding 100-ns units, for `SetCurrentPosition`.
///
/// The union has no safe constructor in this crate, so the discriminant and the payload
/// are written directly. `VT_I8` is the only variant the source reader reads back.
fn hns_propvariant(units: i64) -> PROPVARIANT {
    let mut pv = PROPVARIANT::default();
    unsafe {
        let inner = &mut *pv.Anonymous.Anonymous;
        inner.vt = VT_I8;
        inner.Anonymous.hVal = units;
    }
    pv
}

/// Put COM and Media Foundation into a state this thread can use.
///
/// Called on whichever thread runs the export, which is not the one that recorded: COM
/// apartments are per-thread, and a source reader created without this fails in a way
/// that reads like a codec problem.
fn init_com_and_mf() {
    unsafe {
        // MTA, matching the capture and audio threads. `RPC_E_CHANGED_MODE` only means
        // this thread already has an apartment — not an error here.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    crate::encoder::mf_init();
}

/// Open a source reader over `path` with the conversions MF is able to insert.
unsafe fn open_reader(path: &str) -> Result<IMFSourceReader, String> {
    unsafe {
        let mut attrs: Option<IMFAttributes> = None;
        hr(MFCreateAttributes(&mut attrs, 4))?;
        let attrs = attrs.ok_or("无法创建读取器属性")?;
        // Lets MF insert a video processor, which is what turns "give me RGB32" into a
        // request the decoder can satisfy rather than a demand it may refuse.
        hr(attrs.SetUINT32(&MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, 1))?;

        let url = windows::core::HSTRING::from(path);
        MFCreateSourceReaderFromURL(&url, &attrs).map_err(|e| format!("无法打开 {path}：{e}"))
    }
}

/// Describe a recording without decoding it.
pub fn probe_source(path: &str) -> Result<SourceInfo, String> {
    if !Path::new(path).is_file() {
        return Err(format!("找不到文件：{path}"));
    }
    init_com_and_mf();
    unsafe {
        let reader = open_reader(path)?;

        let vt = reader
            .GetNativeMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, 0)
            .map_err(|e| format!("文件中没有视频流：{e}"))?;
        let (width, height) = attr_u64(&vt, &MF_MT_FRAME_SIZE)
            .map(|p| {
                let (w, h) = unpack_u64(p);
                (w as u32, h as u32)
            })
            .ok_or("视频流未声明分辨率")?;
        let fps = attr_u64(&vt, &MF_MT_FRAME_RATE)
            .map(|p| {
                let (num, den) = unpack_u64(p);
                if den == 0 {
                    0.0
                } else {
                    num as f64 / den as f64
                }
            })
            .unwrap_or(0.0);
        let duration_ms = reader
            .GetPresentationAttribute(MF_SOURCE_READER_ANY_STREAM.0 as u32, &MF_PD_DURATION)
            .ok()
            .and_then(|pv| prop_u64(&pv))
            .map(|hns| hns / 10_000)
            .unwrap_or(0);

        // Audio is optional: a silent recording is a normal recording.
        let mut has_audio = false;
        let (mut audio_sample_rate, mut audio_channels) = (0u32, 0u16);
        if let Ok(at) = reader.GetNativeMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32, 0) {
            has_audio = true;
            audio_sample_rate = attr_u32(&at, &MF_MT_AUDIO_SAMPLES_PER_SECOND).unwrap_or(OUT_RATE);
            audio_channels = attr_u32(&at, &MF_MT_AUDIO_NUM_CHANNELS).unwrap_or(1) as u16;
        }

        Ok(SourceInfo {
            width,
            height,
            fps,
            duration_ms,
            has_audio,
            audio_sample_rate,
            audio_channels,
        })
    }
}

/// A decoded frame and when it was shown, in seconds from the start of the recording.
struct DecodedFrame {
    ts_sec: f64,
    bgra: Vec<u8>,
}

/// Forward-only decoder for the video stream.
struct VideoReader {
    reader: IMFSourceReader,
    width: u32,
    height: u32,
    /// Bytes per row as MF reports it. Negative means the buffer is bottom-up.
    stride: i32,
}

impl VideoReader {
    fn open(path: &str) -> Result<Self, String> {
        unsafe {
            let reader = open_reader(path)?;
            let native = reader
                .GetNativeMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, 0)
                .map_err(|e| format!("文件中没有视频流：{e}"))?;
            let (width, height) = attr_u64(&native, &MF_MT_FRAME_SIZE)
                .map(|p| {
                    let (w, h) = unpack_u64(p);
                    (w as u32, h as u32)
                })
                .ok_or("视频流未声明分辨率")?;

            // Ask for RGB32. MF's RGB32 is BGRA byte order in memory, which is exactly
            // what the sink writer takes as input, so no conversion happens twice.
            let out = hr(MFCreateMediaType())?;
            hr(out.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video))?;
            hr(out.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32))?;
            reader
                .SetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, None, &out)
                .map_err(|e| format!("无法切换到 RGB32 输出：{e}"))?;

            let current = reader
                .GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32)
                .unwrap_or(out);
            // A missing stride is not "0 bytes per row" — it means MF has no opinion and
            // the packed layout applies.
            let stride = attr_u32(&current, &MF_MT_DEFAULT_STRIDE)
                .map(|s| s as i32)
                .unwrap_or((width * 4) as i32);

            Ok(Self {
                reader,
                width,
                height,
                stride,
            })
        }
    }

    /// Move the decode position.
    ///
    /// MF seeks to the nearest preceding keyframe, so the caller must honour the
    /// timestamps it gets back rather than assume the first frame is the one asked for.
    fn seek_sec(&mut self, sec: f64) -> Result<(), String> {
        let pv = hns_propvariant((sec.max(0.0) * HNS) as i64);
        unsafe {
            self.reader
                .SetCurrentPosition(&windows::core::GUID::zeroed(), &pv)
                .map_err(|e| format!("定位到 {sec:.3}s 失败：{e}"))
        }
    }

    /// Decode the next frame, or `None` at end of stream.
    fn next(&mut self) -> Result<Option<DecodedFrame>, String> {
        loop {
            let mut flags = 0u32;
            let mut ts = 0i64;
            let mut sample: Option<IMFSample> = None;
            unsafe {
                hr(self.reader.ReadSample(
                    MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
                    0,
                    None,
                    Some(&mut flags),
                    Some(&mut ts),
                    Some(&mut sample),
                ))?;
            }
            if flags & (MF_SOURCE_READERF_ENDOFSTREAM.0 as u32) != 0 {
                return Ok(None);
            }
            // A null sample without end-of-stream is a gap in the stream, not the end.
            let Some(sample) = sample else { continue };
            let bgra = self.copy_out(&sample)?;
            return Ok(Some(DecodedFrame {
                ts_sec: ts as f64 / HNS,
                bgra,
            }));
        }
    }

    /// Pull the sample's pixels out as tightly packed, top-down BGRA.
    fn copy_out(&self, sample: &IMFSample) -> Result<Vec<u8>, String> {
        unsafe {
            let buf: IMFMediaBuffer = hr(sample.ConvertToContiguousBuffer())?;
            let mut ptr = std::ptr::null_mut::<u8>();
            let mut len = 0u32;
            hr(buf.Lock(&mut ptr, None, Some(&mut len)))?;
            if ptr.is_null() || len == 0 {
                let _ = buf.Unlock();
                return Err("解码得到的帧为空".to_string());
            }

            let (w, h) = (self.width as usize, self.height as usize);
            let row_bytes = w * 4;
            // A stride too small to hold a row is unusable; the packed layout is the
            // only thing left to assume.
            let stride = if self.stride.unsigned_abs() as usize >= row_bytes {
                self.stride
            } else {
                row_bytes as i32
            };
            let bottom_up = stride < 0;
            let step = stride.unsigned_abs() as usize;

            let mut out = vec![0u8; row_bytes * h];
            let src = std::slice::from_raw_parts(ptr, len as usize);
            for y in 0..h {
                // Bottom-up buffers store the last row first.
                let src_row = if bottom_up { h - 1 - y } else { y };
                let from = src_row * step;
                if from + row_bytes > src.len() {
                    break;
                }
                out[y * row_bytes..(y + 1) * row_bytes]
                    .copy_from_slice(&src[from..from + row_bytes]);
            }
            let _ = buf.Unlock();
            Ok(out)
        }
    }
}

/// Forward-only decoder for the audio stream, normalised to mono f32.
///
/// Forward-only is the whole design: `span` drains and returns, so the buffer cursor
/// only ever moves right. An audio stream is contiguous, so one pass covers a whole
/// export and nothing here needs to seek per clip.
struct AudioReader {
    reader: IMFSourceReader,
    src_rate: u32,
    channels: u16,
    /// Decoded mono samples, beginning at `buf_start_sec`.
    buf: Vec<f32>,
    buf_start_sec: f64,
    eos: bool,
}

impl AudioReader {
    /// `Ok(None)` when the recording has no audio stream, which is not a failure.
    fn open(path: &str) -> Result<Option<Self>, String> {
        init_com_and_mf();
        unsafe {
            let reader = open_reader(path)?;
            let native = match reader.GetNativeMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32, 0)
            {
                Ok(t) => t,
                Err(_) => return Ok(None),
            };
            let src_rate = attr_u32(&native, &MF_MT_AUDIO_SAMPLES_PER_SECOND).unwrap_or(OUT_RATE);
            let channels = attr_u32(&native, &MF_MT_AUDIO_NUM_CHANNELS)
                .unwrap_or(1)
                .max(1) as u16;

            let out = hr(MFCreateMediaType())?;
            hr(out.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio))?;
            hr(out.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM))?;
            hr(out.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16))?;
            hr(out.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, src_rate))?;
            hr(out.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, channels as u32))?;
            let block_align = (channels as u32) * 2;
            hr(out.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, block_align))?;
            hr(out.SetUINT32(
                &MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
                src_rate * block_align,
            ))?;
            reader
                .SetCurrentMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32, None, &out)
                .map_err(|e| format!("无法切换到 PCM 输出：{e}"))?;

            Ok(Some(Self {
                reader,
                src_rate: src_rate.max(1),
                channels,
                buf: Vec::new(),
                buf_start_sec: 0.0,
                eos: false,
            }))
        }
    }

    /// Move the decode position and forget whatever was buffered.
    fn seek_sec(&mut self, sec: f64) -> Result<(), String> {
        let pv = hns_propvariant((sec.max(0.0) * HNS) as i64);
        unsafe {
            self.reader
                .SetCurrentPosition(&windows::core::GUID::zeroed(), &pv)
                .map_err(|e| format!("音频定位到 {sec:.3}s 失败：{e}"))?;
        }
        self.buf.clear();
        self.buf_start_sec = sec.max(0.0);
        self.eos = false;
        Ok(())
    }

    /// Read one more PCM chunk into the buffer. `false` at end of stream.
    fn pump(&mut self) -> Result<bool, String> {
        if self.eos {
            return Ok(false);
        }
        loop {
            let mut flags = 0u32;
            let mut ts = 0i64;
            let mut sample: Option<IMFSample> = None;
            unsafe {
                hr(self.reader.ReadSample(
                    MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32,
                    0,
                    None,
                    Some(&mut flags),
                    Some(&mut ts),
                    Some(&mut sample),
                ))?;
            }
            if flags & (MF_SOURCE_READERF_ENDOFSTREAM.0 as u32) != 0 {
                self.eos = true;
                return Ok(false);
            }
            let Some(sample) = sample else { continue };

            let bytes = unsafe {
                let buf: IMFMediaBuffer = hr(sample.ConvertToContiguousBuffer())?;
                let mut ptr = std::ptr::null_mut::<u8>();
                let mut len = 0u32;
                hr(buf.Lock(&mut ptr, None, Some(&mut len)))?;
                let v = if ptr.is_null() || len == 0 {
                    Vec::new()
                } else {
                    std::slice::from_raw_parts(ptr, len as usize).to_vec()
                };
                let _ = buf.Unlock();
                v
            };
            if bytes.is_empty() {
                continue;
            }
            // The first chunk after a seek fixes the buffer's origin from the stream
            // itself: a seek lands on a packet boundary, which need not be the instant
            // that was asked for.
            if self.buf.is_empty() {
                self.buf_start_sec = ts as f64 / HNS;
            }
            let mono = pcm16_to_mono(&bytes, self.channels);
            self.buf.extend_from_slice(&mono);
            return Ok(true);
        }
    }

    /// Source samples covering `[start_sec, end_sec)`, consuming them from the buffer.
    ///
    /// Returns an empty slice when the stream has ended, which the caller writes as
    /// silence rather than letting the audio stream fall short of the video.
    fn span(&mut self, start_sec: f64, end_sec: f64) -> Result<Vec<f32>, String> {
        let rate = self.src_rate as f64;
        // Drop whatever lies before the span.
        let skip = (((start_sec - self.buf_start_sec) * rate).round()).max(0.0) as usize;
        if skip > 0 {
            if skip >= self.buf.len() {
                self.buf_start_sec += self.buf.len() as f64 / rate;
                self.buf.clear();
            } else {
                self.buf.drain(..skip);
                self.buf_start_sec += skip as f64 / rate;
            }
        }

        // Read ahead until the buffer reaches `end_sec`.
        while self.buf_start_sec + self.buf.len() as f64 / rate < end_sec {
            if !self.pump()? {
                break;
            }
        }

        let want = (((end_sec - self.buf_start_sec) * rate).round()).max(0.0) as usize;
        let n = want.min(self.buf.len());
        Ok(self.buf[..n].to_vec())
    }
}

/// Interleaved 16-bit PCM → mono f32 in `[-1, 1]`.
///
/// Channels are averaged rather than taking the first: a stereo recording with the
/// signal on one side only would otherwise export silent.
pub fn pcm16_to_mono(bytes: &[u8], channels: u16) -> Vec<f32> {
    let ch = channels.max(1) as usize;
    let frames = bytes.len() / (2 * ch);
    let mut out = Vec::with_capacity(frames);
    for f in 0..frames {
        let base = f * 2 * ch;
        let mut acc = 0i32;
        for c in 0..ch {
            let i = base + c * 2;
            acc += i16::from_le_bytes([bytes[i], bytes[i + 1]]) as i32;
        }
        out.push(acc as f32 / (ch as f32 * 32768.0));
    }
    out
}

/// Resample mono audio into a new rate *and* playback speed.
///
/// Linear interpolation, not a windowed sinc: this is screen-recording audio at 48 kHz,
/// where the difference is inaudible, and a polyphase filter here would be a lot of code
/// to get subtly wrong.
///
/// Output length is exactly `out_len`; the last sample is held when the source runs
/// short, so a short read produces a tail rather than a click into silence.
pub fn resample_mono(
    src: &[f32],
    src_rate: u32,
    out_rate: u32,
    speed: f64,
    out_len: usize,
) -> Vec<f32> {
    if out_len == 0 {
        return Vec::new();
    }
    if src.is_empty() || src_rate == 0 || out_rate == 0 {
        return vec![0.0; out_len];
    }
    let speed = if speed.is_finite() && speed > 0.0 { speed } else { 1.0 };
    // Source samples consumed per output sample.
    let step = speed * src_rate as f64 / out_rate as f64;

    let mut out = Vec::with_capacity(out_len);
    let last = src[src.len() - 1];
    for i in 0..out_len {
        let pos = i as f64 * step;
        let i0 = pos.floor();
        if i0 < 0.0 {
            out.push(src[0]);
            continue;
        }
        let i0 = i0 as usize;
        if i0 + 1 >= src.len() {
            out.push(last);
            continue;
        }
        let frac = (pos - i0 as f64) as f32;
        out.push(src[i0] * (1.0 - frac) + src[i0 + 1] * frac);
    }
    out
}

/// f32 mono → s16le bytes, clamped so a hot signal wraps nowhere.
pub fn mono_to_pcm16(samples: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 2);
    for &s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// One run resolved against a frame rate: which output frames it fills, and from where.
#[derive(Debug, Clone, PartialEq)]
struct RunPlan {
    out_frame_start: u64,
    out_frame_end: u64,
    source_start_sec: f64,
    /// Source seconds consumed per output second.
    speed: f64,
}

/// Turn runs into a frame plan, rejecting anything that would produce a bad file.
///
/// Separated from the decode loop because this is where the mistakes that matter are
/// made — negative spans, runs out of order, a speed of zero — and all of them are
/// testable without a file, a codec or a GPU.
fn plan_runs(runs: &[SequenceRun], fps: u32) -> Result<Vec<RunPlan>, String> {
    if fps == 0 {
        return Err("帧率不能为 0".to_string());
    }
    let mut plans: Vec<RunPlan> = Vec::with_capacity(runs.len());
    for (i, run) in runs.iter().enumerate() {
        if run.source_end_ms <= run.source_start_ms {
            return Err(format!("第 {} 段的源区间为空", i + 1));
        }
        if !run.speed.is_finite() || run.speed <= 0.0 {
            return Err(format!("第 {} 段的速度无效（{}）", i + 1, run.speed));
        }
        if !(0.1..=100.0).contains(&run.speed) {
            return Err(format!("第 {} 段的速度 {:.2} 超出支持范围", i + 1, run.speed));
        }
        let out_frame_start = ms_to_frame(run.output_start_ms, fps);
        // A run's length in the output is its source length divided by the speed:
        // playing something at 2x makes it take half as long.
        let out_len_ms = (run.source_end_ms - run.source_start_ms) as f64 / run.speed;
        let out_frames = ms_to_frame(out_len_ms.round() as u64, fps).max(1);
        plans.push(RunPlan {
            out_frame_start,
            out_frame_end: out_frame_start + out_frames,
            source_start_sec: run.source_start_ms as f64 / 1000.0,
            speed: run.speed,
        });
    }
    // Runs must not overlap: two runs writing the same output frame would produce a file
    // whose length disagrees with its own stream layout.
    for w in plans.windows(2) {
        if w[1].out_frame_start < w[0].out_frame_end {
            return Err("片段在时间轴上重叠，请先分开它们".to_string());
        }
    }
    Ok(plans)
}

fn ms_to_frame(ms: u64, fps: u32) -> u64 {
    ((ms as f64 / 1000.0) * fps as f64).round() as u64
}

/// Presentation time of frame `n`, in microseconds, rounded rather than truncated.
///
/// Truncating accumulates up to a frame of drift over a long export, which shows up as
/// audio and video separating towards the end of the file.
fn frame_ts_us(frame: u64, fps: u32) -> u64 {
    let fps = fps.max(1) as u64;
    (frame * 1_000_000 + fps / 2) / fps
}

/// Where the output's frames come from.
///
/// Two modes, one pipeline: the timing, the runs and the audio are identical either way,
/// and only the pixels differ. That is deliberate — the composited export must not have
/// its own notion of where a clip starts, or the two would drift apart.
pub enum FrameSource<'a> {
    /// Decode the recording itself, honouring each run's source span and speed. This is
    /// the MV path: the footage, cut and concatenated.
    Recording,
    /// Ask the caller for each output frame by index, as RGBA.
    ///
    /// Used when the frames carry the editor's own composition — background, crop, zoom,
    /// annotations, cursor — which cannot be re-derived from the file. The webview
    /// renders them and pushes them in.
    Rendered(&'a mut dyn FnMut(u64) -> Result<Vec<u8>, String>),
}

/// Reorder RGBA into the BGRA byte order Media Foundation's RGB32 input expects.
///
/// Not a colour conversion — the same 8-bit values in a different order. Skipping it
/// exports a file whose red and blue channels are swapped, which looks like a tint bug
/// in the editor rather than a byte-order one here.
///
/// A trailing partial pixel is left as it is rather than half-swapped: it is not a pixel,
/// and swapping two of its three bytes would be a strange thing to do to it.
pub fn rgba_to_bgra(rgba: &[u8]) -> Vec<u8> {
    let mut out = rgba.to_vec();
    for px in out.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    out
}

/// Decode, cut and re-encode. `on_progress` is called with `(written, total)`.
pub fn run(
    opts: &SequenceOptions,
    feed: FrameSource<'_>,
    on_progress: &mut dyn FnMut(u64, u64),
) -> Result<SequenceResult, String> {
    init_com_and_mf();

    // The request is validated before the filesystem is touched: a malformed export
    // must fail the same way whether or not the file happens to be there, and the
    // dimension check in particular exists so the user hears about an odd size instead
    // of a Media Foundation error twenty seconds into an encode.
    if opts.runs.is_empty() {
        return Err("时间轴上没有片段".to_string());
    }
    if opts.width == 0 || opts.height == 0 {
        return Err("导出尺寸无效".to_string());
    }
    if opts.width % 2 != 0 || opts.height % 2 != 0 {
        return Err(format!("导出尺寸必须为偶数：{}x{}", opts.width, opts.height));
    }
    let plans = plan_runs(&opts.runs, opts.fps)?;
    let total_frames = plans.last().map(|p| p.out_frame_end).unwrap_or(0);
    if total_frames == 0 {
        return Err("时间轴上没有可导出的帧".to_string());
    }

    // The recording only has to be on disk when something will actually read it: the
    // rendered path takes its pictures from the caller, so a file that is missing there
    // is only a problem if its audio was also asked for.
    let needs_file = matches!(feed, FrameSource::Recording) || opts.with_audio;
    if needs_file && !Path::new(&opts.input).is_file() {
        return Err(format!("找不到源文件：{}", opts.input));
    }
    let out_path = Path::new(&opts.output).to_path_buf();
    if out_path == Path::new(&opts.input) {
        return Err("输出路径不能与源文件相同".to_string());
    }

    let mut video = match feed {
        FrameSource::Recording => Some(VideoReader::open(&opts.input)?),
        FrameSource::Rendered(_) => None,
    };
    let mut rendered: Option<&mut dyn FnMut(u64) -> Result<Vec<u8>, String>> = match feed {
        FrameSource::Rendered(f) => Some(f),
        FrameSource::Recording => None,
    };
    let mut audio = if opts.with_audio {
        AudioReader::open(&opts.input)?
    } else {
        None
    };

    // The audio stream is declared from the start when the source has audio: an MP4
    // whose audio stream appears mid-write is not one most players accept.
    let audio_params = audio.as_ref().map(|_| AudioParams {
        sample_rate: OUT_RATE,
        channels: OUT_CHANNELS,
    });

    if let Some(parent) = out_path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
        }
    }

    let cfg = EncoderConfig {
        width: opts.width,
        height: opts.height,
        fps: opts.fps,
        codec: "h264".to_string(),
        bitrate_kbps: bitrate_for_sequence(opts.width, opts.height, opts.fps),
        rate_mode: "vbr".to_string(),
        audio: audio_params,
        input_bgra: true,
    };
    let encoder = SinkEncoder::new(&out_path, &cfg)?;

    let black = vec![0u8; (opts.width as usize) * (opts.height as usize) * 4];
    let mut st = SequenceState::default();
    // Where the *audio* cursor sits, in output samples. Tracked separately from the
    // frame index because the two streams run at different rates.
    let mut audio_cursor: u64 = 0;

    let outcome = (|| -> Result<(), String> {
        for plan in &plans {
            // ---- the gap before this run: black, and silence ----
            while st.written < plan.out_frame_start {
                encoder.write_video(&black, opts.width, opts.height, frame_ts_us(st.written, opts.fps))?;
                st.written += 1;
                st.black_frames += 1;
            }
            if audio.is_some() {
                audio_cursor = write_silence_until(&encoder, plan.out_frame_start, opts.fps, audio_cursor)?;
            }
            on_progress(st.written, total_frames);

            // ---- the run itself ----
            // Seeking the decoder is pointless when the frames come from the webview: it
            // renders each frame from the project, not from a decode position.
            if let Some(v) = video.as_mut() {
                v.seek_sec(plan.source_start_sec)?;
            }
            if let Some(a) = audio.as_mut() {
                a.seek_sec(plan.source_start_sec)?;
            }

            // `cur` is the last frame at or before the target time, `next` the first one
            // after it. Holding both is what makes a frame-accurate cut possible without
            // a seek per frame: a seek costs milliseconds, and a 30-second export is 900
            // frames.
            let mut cur: Option<DecodedFrame> = None;
            let mut next: Option<DecodedFrame> = None;
            let mut exhausted = false;
            let mut primed = false;

            let run_frames = plan.out_frame_end - plan.out_frame_start;
            // Source seconds this run covers, which is what the audio needs.
            let src_from = plan.source_start_sec;
            let src_to = src_from + run_frames as f64 / opts.fps as f64 * plan.speed;
            // Output samples the run should produce, matching its frame count exactly.
            let run_samples = (run_frames * OUT_RATE as u64 + opts.fps as u64 / 2) / opts.fps as u64;
            let mut run_sample_done: u64 = 0;

            for i in 0..run_frames {
                let target = src_from + i as f64 / opts.fps as f64 * plan.speed;

                // -- pick the pixels --
                let source_frame: Option<Vec<u8>> = match (rendered.as_mut(), video.as_mut()) {
                    // The webview owns the picture: one frame in, one frame out, and the
                    // caller is responsible for having rendered the composition.
                    (Some(f), _) => Some(rgba_to_bgra(&f(st.written)?)),
                    (None, Some(v)) => {
                        if !primed {
                            next = v.next()?;
                            exhausted = next.is_none();
                            primed = true;
                        }
                        while let Some(f) = next.as_ref() {
                            if f.ts_sec > target {
                                break;
                            }
                            cur = next.take();
                            next = v.next()?;
                            exhausted = next.is_none();
                        }
                        cur.as_ref().or(next.as_ref()).map(|f| f.bgra.clone())
                    }
                    (None, None) => None,
                };

                match source_frame {
                    Some(bgra) => {
                        if bgra.len() < (opts.width as usize) * (opts.height as usize) * 4 {
                            return Err(format!(
                                "第 {} 帧的像素不足：{}x{} 需要 {} 字节，实际 {}",
                                st.written + 1,
                                opts.width,
                                opts.height,
                                opts.width as usize * opts.height as usize * 4,
                                bgra.len()
                            ));
                        }
                        encoder.write_video(&bgra, opts.width, opts.height, frame_ts_us(st.written, opts.fps))?;
                        // Nothing further to show: the rest of this run is a freeze.
                        if rendered.is_none() && exhausted && next.is_none() {
                            st.held_frames += 1;
                        }
                    }
                    None => {
                        // Nothing decoded at all for this run — black, and counted.
                        encoder.write_video(&black, opts.width, opts.height, frame_ts_us(st.written, opts.fps))?;
                        st.black_frames += 1;
                    }
                }
                st.written += 1;

                // Audio advances with the frames rather than in one lump at the end, so
                // the two streams stay within a frame of each other without any explicit
                // interleaving pass.
                if let Some(a) = audio.as_mut() {
                    let upto = run_samples * (i + 1) / run_frames;
                    audio_cursor = emit_run_audio(
                        a, &encoder, src_from, src_to, plan.speed,
                        run_sample_done, upto, audio_cursor,
                    )?;
                    run_sample_done = upto;
                }
                if st.written % 30 == 0 || st.written == total_frames {
                    on_progress(st.written, total_frames);
                }
            }

            // Any remainder the per-frame split rounded away.
            if let Some(a) = audio.as_mut() {
                audio_cursor = emit_run_audio(
                    a, &encoder, src_from, src_to, plan.speed,
                    run_sample_done, run_samples, audio_cursor,
                )?;
            }
        }

        // ---- trailing gap ----
        while st.written < total_frames {
            encoder.write_video(&black, opts.width, opts.height, frame_ts_us(st.written, opts.fps))?;
            st.written += 1;
            st.black_frames += 1;
        }
        if audio.is_some() {
            audio_cursor = write_silence_until(&encoder, total_frames, opts.fps, audio_cursor)?;
        }
        on_progress(st.written, total_frames);
        Ok(())
    })();

    // Finalize either way: a half-written file left behind by an error would look like a
    // successful export to anything that only checks that the path exists.
    let finish = encoder.finish();
    outcome?;
    finish?;

    let bytes = std::fs::metadata(&out_path)
        .map_err(|e| format!("导出结束但找不到输出文件：{e}"))?
        .len();
    if bytes == 0 {
        return Err("导出产出了空文件".to_string());
    }

    Ok(SequenceResult {
        path: out_path.to_string_lossy().to_string(),
        bytes,
        frames: st.written,
        duration_ms: st.written * 1000 / opts.fps.max(1) as u64,
        black_frames: st.black_frames,
        held_frames: st.held_frames,
        audio_samples: audio_cursor,
    })
}

/// Decode one frame at `sec` and return it as BGRA, with its dimensions.
///
/// Exists for verification: it is the only way to ask "what is actually in this file at
/// this moment" without a second decoder implementation, and a test that checks its own
/// output through the same reader the export used is still checking that the pixels that
/// reached the disk are the pixels it meant to write.
///
/// Reads forward from the start rather than seeking. Seeking is what the export does,
/// because an export cannot afford to decode a whole recording to reach its first clip —
/// but after a seek the source reader hands back samples from the keyframe it landed on,
/// and the exact sample that covers a given instant is then decided by container
/// timestamp rounding. That is the right trade for an export and the wrong one for a
/// helper whose only job is to say what a file contains: this returns the frame whose
/// presentation time is the last one at or before `sec`, decoding from the beginning, so
/// its answer depends on the file alone.
pub fn frame_at(path: &str, sec: f64) -> Result<(u32, u32, Vec<u8>), String> {
    init_com_and_mf();
    let mut reader = VideoReader::open(path)?;
    let target = sec.max(0.0);
    let mut best: Option<DecodedFrame> = None;
    while let Some(f) = reader.next()? {
        if f.ts_sec <= target + 1e-9 {
            best = Some(f);
        } else {
            break;
        }
    }
    match best {
        Some(f) => Ok((reader.width, reader.height, f.bgra)),
        None => Err(format!("{path} 在 {sec:.3}s 处没有可解码的帧")),
    }
}

/// Average RGB of a BGRA buffer, for comparing two frames without demanding bit equality.
///
/// An H.264 round trip is lossy by design, so a test that wants to know "did the right
/// footage come out" has to ask a question the codec cannot change the answer to.
pub fn average_rgb(bgra: &[u8]) -> [f64; 3] {
    if bgra.len() < 4 {
        return [0.0, 0.0, 0.0];
    }
    let n = bgra.len() / 4;
    let (mut r, mut g, mut b) = (0f64, 0f64, 0f64);
    for px in bgra.chunks_exact(4) {
        // BGRA in memory.
        b += px[0] as f64;
        g += px[1] as f64;
        r += px[2] as f64;
    }
    [r / n as f64, g / n as f64, b / n as f64]
}

/// Which frame of an `fps` sequence an instant falls inside.
///
/// The frame shown at `sec` is the last one whose presentation time is at or before it,
/// never the next one. The half-open interval is the whole point of having this here: get
/// it backwards and every caller that samples a file is shifted by a frame against a
/// player looking at the same file.
pub fn frame_containing(sec: f64, fps: u32) -> u64 {
    let fps = fps.max(1) as f64;
    // The nudge absorbs the rounding in a timestamp that is a hair under its own frame
    // boundary — 0.0333 is frame 0 at 30 fps, not frame 1.
    (sec.max(0.0) * fps + 1e-6).floor() as u64
}

/// Counters the export reports. Grouped so the run loop reads as a list of steps.
#[derive(Default)]
struct SequenceState {
    written: u64,
    black_frames: u64,
    held_frames: u64,
}

/// Write silence covering output samples `[cursor, target_frames * rate / fps)`.
fn write_silence_until(
    encoder: &SinkEncoder,
    target_frames: u64,
    fps: u32,
    cursor: u64,
) -> Result<u64, String> {
    let target = target_frames * OUT_RATE as u64 / fps.max(1) as u64;
    let mut cursor = cursor;
    while cursor < target {
        let want = ((target - cursor) as usize).min(AUDIO_CHUNK);
        encoder.write_audio(
            &vec![0u8; want * 2],
            cursor * 1_000_000 / OUT_RATE as u64,
        )?;
        cursor += want as u64;
    }
    Ok(cursor)
}

/// Emit the output samples of one run from `done` up to `upto`.
///
/// The source span for a given output sample is found by mapping forwards from the run's
/// own start, which is why the whole run's source range is passed in: the mapping is
/// linear and independent of where in the run a chunk boundary happens to fall.
#[allow(clippy::too_many_arguments)]
fn emit_run_audio(
    reader: &mut AudioReader,
    encoder: &SinkEncoder,
    src_from: f64,
    src_to: f64,
    speed: f64,
    done: u64,
    upto: u64,
    cursor: u64,
) -> Result<u64, String> {
    if upto <= done {
        return Ok(cursor);
    }
    let mut at = done;
    let mut cursor = cursor;

    while at < upto {
        let want = ((upto - at) as usize).min(AUDIO_CHUNK);
        // Output sample `at` sits this far into the run; the source is `speed` times
        // further in, because that is what the speed means.
        let from_sec = src_from + (at as f64 / OUT_RATE as f64) * speed;
        let to_sec = src_from + ((at + want as u64) as f64 / OUT_RATE as f64) * speed;
        // Clamped to the run's own source range: a rounding error at the end of a run
        // must not read footage belonging to the next clip.
        let src = reader.span(
            from_sec.clamp(src_from, src_to),
            to_sec.clamp(src_from, src_to),
        )?;
        let samples = resample_mono(&src, reader.src_rate, OUT_RATE, speed, want);
        encoder.write_audio(
            &mono_to_pcm16(&samples),
            cursor * 1_000_000 / OUT_RATE as u64,
        )?;

        at += want as u64;
        cursor += want as u64;
    }
    Ok(cursor)
}

/// Bitrate for the MV path.
///
/// Deliberately generous and resolution-scaled rather than a preset list: this path
/// exists to re-encode footage the user already has, and making it visibly worse than
/// the source would defeat the point. The panel shows the number before the export
/// starts, so this is a floor on quality, not a surprise.
fn bitrate_for_sequence(width: u32, height: u32, fps: u32) -> u32 {
    let pixels = (width as u64 * height as u64).max(1) as f64;
    let ref_pixels = 1920.0 * 1080.0;
    let base = 12_000.0; // kbps at 1080p30
    let scaled = base * (pixels / ref_pixels) * (fps.max(1) as f64 / 30.0).clamp(0.5, 2.5);
    (scaled as u32).clamp(2_000, 240_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_of(start: u64, end: u64, out: u64, speed: f64) -> SequenceRun {
        SequenceRun {
            source_start_ms: start,
            source_end_ms: end,
            output_start_ms: out,
            speed,
        }
    }

    #[test]
    fn a_single_run_at_normal_speed_maps_one_to_one() {
        let plans = plan_runs(&[run_of(0, 4000, 0, 1.0)], 30).unwrap();
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].out_frame_start, 0);
        assert_eq!(plans[0].out_frame_end, 120, "4 s at 30 fps");
    }

    /// A trimmed clip starts partway into the recording but still at the output's start.
    #[test]
    fn a_trimmed_run_keeps_its_output_position() {
        let plans = plan_runs(&[run_of(2000, 4000, 0, 1.0)], 30).unwrap();
        assert_eq!(plans[0].source_start_sec, 2.0);
        assert_eq!(plans[0].out_frame_end, 60, "2 s of source at 30 fps");
    }

    /// Playback speed changes how much output a run produces, not where it starts.
    #[test]
    fn speed_changes_the_output_length_not_the_source_span() {
        let fast = plan_runs(&[run_of(0, 4000, 0, 2.0)], 30).unwrap();
        assert_eq!(fast[0].out_frame_end, 60, "4 s of source at 2x is 2 s of output");
        let slow = plan_runs(&[run_of(0, 4000, 0, 0.5)], 30).unwrap();
        assert_eq!(slow[0].out_frame_end, 240, "4 s of source at 0.5x is 8 s");
    }

    /// A gap between two runs becomes black frames, which the caller counts.
    #[test]
    fn gaps_between_runs_survive_planning() {
        let plans =
            plan_runs(&[run_of(0, 1000, 0, 1.0), run_of(5000, 6000, 3000, 1.0)], 30).unwrap();
        assert_eq!(plans[0].out_frame_end, 30);
        assert_eq!(plans[1].out_frame_start, 90, "3 s in");
        assert!(plans[1].out_frame_start > plans[0].out_frame_end);
    }

    #[test]
    fn overlapping_runs_are_refused() {
        // The second run starts at 1 s of output but the first does not end until 2 s.
        let err = plan_runs(&[run_of(0, 2000, 0, 1.0), run_of(5000, 6000, 1000, 1.0)], 30)
            .expect_err("overlap must be refused");
        assert!(err.contains("重叠"), "{err}");
    }

    #[test]
    fn impossible_runs_are_refused_by_name() {
        assert!(plan_runs(&[run_of(500, 500, 0, 1.0)], 30).unwrap_err().contains("空"));
        assert!(plan_runs(&[run_of(0, 500, 0, 0.0)], 30).unwrap_err().contains("速度"));
        assert!(plan_runs(&[run_of(0, 500, 0, f64::NAN)], 30).unwrap_err().contains("速度"));
        assert!(plan_runs(&[run_of(0, 500, 0, 1000.0)], 30).unwrap_err().contains("范围"));
        assert!(plan_runs(&[run_of(0, 500, 0, 1.0)], 0).unwrap_err().contains("帧率"));
    }

    /// Adjacent runs that share a boundary are contiguous, not overlapping: a split clip
    /// produces exactly this, and refusing it would make splitting unusable.
    #[test]
    fn touching_runs_are_not_an_overlap() {
        let plans =
            plan_runs(&[run_of(0, 1000, 0, 1.0), run_of(1000, 2000, 1000, 1.0)], 30).unwrap();
        assert_eq!(plans[0].out_frame_end, plans[1].out_frame_start);
    }

    #[test]
    fn frame_timestamps_round_instead_of_drifting() {
        assert_eq!(frame_ts_us(0, 30), 0);
        assert_eq!(frame_ts_us(1, 30), 33_333);
        assert_eq!(frame_ts_us(2, 30), 66_667);
        let last = frame_ts_us(30_000, 30);
        assert_eq!(last, 1_000_000_000, "30 000 frames at 30 fps is exactly 1000 s");
    }

    #[test]
    fn pcm_is_averaged_across_channels_not_taken_from_the_first() {
        // left 1000, right -1000 → they must cancel, not export as 1000.
        let bytes = [0xE8u8, 0x03, 0x18, 0xFC];
        let mono = pcm16_to_mono(&bytes, 2);
        assert_eq!(mono.len(), 1);
        assert!(mono[0].abs() < 1e-4, "got {}", mono[0]);
        // Mono passes through unchanged.
        let same = pcm16_to_mono(&bytes[..2], 1);
        assert!((same[0] - 1000.0 / 32768.0).abs() < 1e-4);
    }

    /// A partial trailing frame must not be read as a sample.
    #[test]
    fn pcm_ignores_a_dangling_byte() {
        assert_eq!(pcm16_to_mono(&[0, 0, 5], 1).len(), 1);
        assert_eq!(pcm16_to_mono(&[], 1).len(), 0);
    }

    #[test]
    fn resampling_at_normal_speed_is_identity() {
        let src: Vec<f32> = (0..8).map(|i| i as f32 / 8.0).collect();
        let out = resample_mono(&src, 48_000, 48_000, 1.0, 8);
        assert_eq!(out, src);
    }

    /// Half speed doubles the length, which is what a 0.5x clip needs.
    #[test]
    fn slow_motion_stretches_the_source() {
        let src = vec![0.0f32, 1.0];
        let out = resample_mono(&src, 48_000, 48_000, 0.5, 4);
        assert_eq!(out, vec![0.0, 0.5, 1.0, 1.0]);
    }

    /// A rate change with no speed change still has to resample: 44.1 kHz source into a
    /// 48 kHz output is an interpolation, not a copy.
    #[test]
    fn a_rate_change_resamples_even_at_normal_speed() {
        let src: Vec<f32> = (0..100).map(|i| i as f32 / 100.0).collect();
        let out = resample_mono(&src, 44_100, 48_000, 1.0, 109);
        assert_eq!(out.len(), 109);
        assert!(out[0].abs() < 1e-6);
        assert!(out[108] > 0.9, "the ramp should reach the end");
    }

    /// Running past the end holds the last sample. Filling with zero would put a click
    /// in the audio every time a clip is longer than the footage it names.
    #[test]
    fn a_short_source_holds_its_last_sample() {
        let out = resample_mono(&[0.5, 0.25], 48_000, 48_000, 1.0, 6);
        assert_eq!(out, vec![0.5, 0.25, 0.25, 0.25, 0.25, 0.25]);
    }

    #[test]
    fn resampling_refuses_to_invent_audio_from_nothing() {
        assert!(resample_mono(&[], 48_000, 48_000, 1.0, 0).is_empty());
        assert_eq!(resample_mono(&[], 48_000, 48_000, 1.0, 3), vec![0.0, 0.0, 0.0]);
    }

    #[test]
    fn pcm_round_trip_survives_the_clamp() {
        let samples = vec![0.0f32, 0.5, -0.5, 1.5, -1.5];
        let bytes = mono_to_pcm16(&samples);
        let back = pcm16_to_mono(&bytes, 1);
        assert!((back[1] - 0.5).abs() < 1e-3);
        assert!((back[2] + 0.5).abs() < 1e-3);
        // Out-of-range input is clamped, not wrapped: 1.5 must not become a loud click.
        assert!(back[3] > 0.99 && back[4] < -0.99);
    }

    /// Even dimensions are a hard requirement of yuv420p, and MF's failure for odd ones
    /// is opaque enough that catching it here is worth a check.
    #[test]
    fn the_sequence_path_refuses_odd_dimensions() {
        let opts = SequenceOptions {
            input: "C:\\vids\\a.mp4".into(),
            output: "C:\\vids\\b.mp4".into(),
            fps: 30,
            width: 1279,
            height: 720,
            runs: vec![run_of(0, 1000, 0, 1.0)],
            with_audio: false,
        };
        let err = run(&opts, FrameSource::Recording, &mut |_, _| {}).expect_err("must refuse");
        assert!(err.contains("偶数"), "{err}");
    }

    #[test]
    fn a_missing_source_is_refused_before_any_decoding() {
        let opts = SequenceOptions {
            input: "C:\\definitely\\not\\here.mp4".into(),
            output: "C:\\vids\\b.mp4".into(),
            fps: 30,
            width: 1280,
            height: 720,
            runs: vec![run_of(0, 1000, 0, 1.0)],
            with_audio: false,
        };
        assert!(
            run(&opts, FrameSource::Recording, &mut |_, _| {})
                .unwrap_err()
                .contains("找不到源文件")
        );
    }

    /// The RGBA → BGRA swap has to be exactly a swap: a conversion with any arithmetic in
    /// it would show up as a colour shift that looks like a compositing bug.
    #[test]
    fn rgba_to_bgra_swaps_red_and_blue_only() {
        let rgba = vec![1u8, 2, 3, 4, 250, 251, 252, 253];
        assert_eq!(rgba_to_bgra(&rgba), vec![3, 2, 1, 4, 252, 251, 250, 253]);
        // Applying it twice returns the original.
        assert_eq!(rgba_to_bgra(&rgba_to_bgra(&rgba)), rgba);
    }

    /// A partial pixel at the end must be left untouched rather than half-swapped: it is
    /// not a pixel, and swapping two of its three bytes would be worse than ignoring it.
    /// Alpha is never touched — RGBA and BGRA agree on it, and MF ignores it anyway.
    #[test]
    fn rgba_to_bgra_leaves_a_ragged_tail_alone() {
        assert_eq!(rgba_to_bgra(&[1, 2, 3]), vec![1, 2, 3]);
        assert_eq!(rgba_to_bgra(&[]), Vec::<u8>::new());
    }

    /// The webview-fed path must write exactly as many frames as the plan says, taking
    /// one render per frame — the frame index is what the caller seeks to, so a gap in
    /// the sequence would silently export the wrong footage.
    #[test]
    fn the_rendered_path_asks_for_every_frame_in_order() {
        let opts = SequenceOptions {
            input: "C:\\definitely\\not\\here.mp4".into(),
            output: std::env::temp_dir()
                .join("sr-sequence-rendered-test.mp4")
                .to_string_lossy()
                .to_string(),
            fps: 30,
            width: 320,
            height: 240,
            runs: vec![run_of(0, 1000, 0, 1.0)],
            with_audio: false,
        };
        let mut asked: Vec<u64> = Vec::new();
        let frame = vec![0u8; 320 * 240 * 4];
        let mut feed = |index: u64| -> Result<Vec<u8>, String> {
            asked.push(index);
            Ok(frame.clone())
        };
        let result = run(&opts, FrameSource::Rendered(&mut feed), &mut |_, _| {})
            .expect("the rendered path needs no source file");
        assert_eq!(result.frames, 30);
        assert_eq!(asked, (0..30).collect::<Vec<u64>>());
        assert_eq!(result.black_frames, 0, "the caller supplied every frame");
        assert_eq!(result.held_frames, 0);
        let _ = std::fs::remove_file(&result.path);
    }

    /// A frame that is the wrong size must be refused by name, not written half-empty and
    /// left for a viewer to discover.
    #[test]
    fn the_rendered_path_refuses_a_short_frame() {
        let opts = SequenceOptions {
            input: "C:\\definitely\\not\\here.mp4".into(),
            output: std::env::temp_dir()
                .join("sr-sequence-short-frame-test.mp4")
                .to_string_lossy()
                .to_string(),
            fps: 30,
            width: 320,
            height: 240,
            runs: vec![run_of(0, 500, 0, 1.0)],
            with_audio: false,
        };
        let mut feed = |_: u64| Ok(vec![0u8; 16]);
        let err = run(&opts, FrameSource::Rendered(&mut feed), &mut |_, _| {})
            .expect_err("must refuse");
        assert!(err.contains("像素不足"), "{err}");
        // The failed export must not leave a file behind that looks like a success.
        let _ = std::fs::remove_file(&opts.output);
    }

    /// Asking for audio means reading the recording, so a missing file has to be refused
    /// even on the rendered path rather than silently exporting a silent file.
    #[test]
    fn the_rendered_path_still_needs_the_file_for_audio() {
        let opts = SequenceOptions {
            input: "C:\\definitely\\not\\here.mp4".into(),
            output: "C:\\vids\\b.mp4".into(),
            fps: 30,
            width: 320,
            height: 240,
            runs: vec![run_of(0, 500, 0, 1.0)],
            with_audio: true,
        };
        let mut feed = |_: u64| Ok(vec![0u8; 320 * 240 * 4]);
        let err = run(&opts, FrameSource::Rendered(&mut feed), &mut |_, _| {})
            .expect_err("must refuse");
        assert!(err.contains("找不到源文件"), "{err}");
    }

    #[test]
    fn bitrate_scales_with_the_frame_size_and_never_collapses() {
        let hd = bitrate_for_sequence(1920, 1080, 30);
        let small = bitrate_for_sequence(640, 360, 30);
        assert!(hd > small, "a bigger frame needs more bits");
        assert!(bitrate_for_sequence(16, 16, 1) >= 2_000, "never below the floor");
        assert!(bitrate_for_sequence(7680, 4320, 60) <= 240_000, "never absurd");
    }

    /// The audio a run emits must be exactly as long as the run is at `OUT_RATE` — the
    /// per-frame split and the remainder both have to land on `run_samples`.
    #[test]
    fn the_per_frame_split_covers_the_whole_run() {
        // Mimic the split the run loop performs, for an awkward frame count.
        let run_frames: u64 = 97;
        let fps: u32 = 30;
        let run_samples = (run_frames * OUT_RATE as u64 + fps as u64 / 2) / fps as u64;
        let mut done = 0u64;
        for i in 0..run_frames {
            let upto = run_samples * (i + 1) / run_frames;
            assert!(upto >= done, "the split must not go backwards");
            done = upto;
        }
        assert_eq!(done, run_samples, "the last frame must reach the total");
    }
}
