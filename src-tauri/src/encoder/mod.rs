//! MF SinkWriter encoder: BGRA frames + audio → MP4 (H.264/H.265 + AAC).

use std::path::Path;
use windows::Win32::Media::MediaFoundation::*;

#[derive(Debug, Clone, Copy)]
pub struct AudioParams {
    pub sample_rate: u32,
    pub channels: u16,
}

pub struct EncoderConfig {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub codec: String,      // "h264" | "h265"
    pub bitrate_kbps: u32,
    pub rate_mode: String,  // "vbr" | "cbr"
    pub audio: Option<AudioParams>,
}

pub struct SinkEncoder {
    writer: IMFSinkWriter,
    video_stream: u32,
    audio_stream: u32,
    frame_duration: i64, // 100ns units
}

unsafe impl Send for SinkEncoder {}
unsafe impl Sync for SinkEncoder {}

fn hr<T>(v: windows::core::Result<T>) -> Result<T, String> {
    v.map_err(|e| format!("MF error: {e}"))
}

pub fn mf_init() {
    unsafe {
        let _ = MFStartup(MF_VERSION, 0);
    }
}

pub fn mf_shutdown() {
    unsafe {
        let _ = MFShutdown();
    }
}

/// pack (num, den) into the UINT64 layout MF uses for size/ratio attributes
fn pack_u64(hi: u64, lo: u64) -> u64 {
    (hi << 32) | (lo & 0xffff_ffff)
}

impl SinkEncoder {
    pub fn new(path: &Path, cfg: &EncoderConfig) -> Result<Self, String> {
        mf_init();
        unsafe {
            let mut attrs_opt: Option<IMFAttributes> = None;
            hr(MFCreateAttributes(&mut attrs_opt, 10)).map_err(|e| e.clone())?;
            let attrs = attrs_opt.unwrap();
            let _ = attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1);

            let path_w: Vec<u16> = path
                .to_string_lossy()
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            let writer: IMFSinkWriter = hr(MFCreateSinkWriterFromURL(
                &windows::core::HSTRING::from_wide(&path_w),
                None,
                Some(&attrs),
            ))
            .map_err(|e| e.clone())?;

            // ---------- video output type ----------
            let vt_out: IMFMediaType = hr(MFCreateMediaType()).map_err(|e| e.clone())?;
            let video_sub = if cfg.codec == "h265" { MFVideoFormat_HEVC } else { MFVideoFormat_H264 };
            hr(vt_out.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)).map_err(|e| e.clone())?;
            hr(vt_out.SetGUID(&MF_MT_SUBTYPE, &video_sub)).map_err(|e| e.clone())?;
            hr(vt_out.SetUINT32(&MF_MT_AVG_BITRATE, cfg.bitrate_kbps * 1000)).map_err(|e| e.clone())?;
            hr(vt_out.SetUINT64(&MF_MT_FRAME_SIZE, pack_u64(cfg.width as u64, cfg.height as u64)))
                .map_err(|e| e.clone())?;
            hr(vt_out.SetUINT64(&MF_MT_FRAME_RATE, pack_u64(cfg.fps as u64, 1)))
                .map_err(|e| e.clone())?;
            hr(vt_out.SetUINT32(&MF_MT_INTERLACE_MODE, 2 /* progressive */))
                .map_err(|e| e.clone())?;
            hr(vt_out.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack_u64(1, 1)))
                .map_err(|e| e.clone())?;

            let video_stream: u32 = hr(writer.AddStream(&vt_out)).map_err(|e| e.clone())?;

            // ---------- video input type (BGRA) ----------
            let vt_in: IMFMediaType = hr(MFCreateMediaType()).map_err(|e| e.clone())?;
            hr(vt_in.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)).map_err(|e| e.clone())?;
            // BGRA = MFVideoFormat_ARGB32 subtype for uncompressed input
            hr(vt_in.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_ARGB32)).map_err(|e| e.clone())?;
            hr(vt_in.SetUINT64(&MF_MT_FRAME_SIZE, pack_u64(cfg.width as u64, cfg.height as u64)))
                .map_err(|e| e.clone())?;
            hr(vt_in.SetUINT64(&MF_MT_FRAME_RATE, pack_u64(cfg.fps as u64, 1)))
                .map_err(|e| e.clone())?;
            hr(vt_in.SetUINT32(&MF_MT_INTERLACE_MODE, 2)).map_err(|e| e.clone())?;
            hr(vt_in.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack_u64(1, 1)))
                .map_err(|e| e.clone())?;
            hr(vt_in.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1)).map_err(|e| e.clone())?;
            hr(writer.SetInputMediaType(video_stream, &vt_in, None)).map_err(|e| e.clone())?;

            // ---------- audio (optional, AAC) ----------
            let mut audio_stream: u32 = u32::MAX;
            if let Some(ap) = &cfg.audio {
                let at_out: IMFMediaType = hr(MFCreateMediaType()).map_err(|e| e.clone())?;
                hr(at_out.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)).map_err(|e| e.clone())?;
                hr(at_out.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)).map_err(|e| e.clone())?;
                hr(at_out.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)).map_err(|e| e.clone())?;
                hr(at_out.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, ap.sample_rate))
                    .map_err(|e| e.clone())?;
                hr(at_out.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, ap.channels as u32))
                    .map_err(|e| e.clone())?;
                let bytes_sec = if ap.channels == 2 { 16000 } else { 8000 };
                hr(at_out.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, bytes_sec))
                    .map_err(|e| e.clone())?;
                let s: u32 = hr(writer.AddStream(&at_out)).map_err(|e| e.clone())?;
                audio_stream = s;

                let at_in: IMFMediaType = hr(MFCreateMediaType()).map_err(|e| e.clone())?;
                hr(at_in.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)).map_err(|e| e.clone())?;
                hr(at_in.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)).map_err(|e| e.clone())?;
                hr(at_in.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)).map_err(|e| e.clone())?;
                hr(at_in.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, ap.sample_rate))
                    .map_err(|e| e.clone())?;
                hr(at_in.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, ap.channels as u32))
                    .map_err(|e| e.clone())?;
                hr(writer.SetInputMediaType(audio_stream, &at_in, None)).map_err(|e| e.clone())?;
            }

            hr(writer.BeginWriting()).map_err(|e| e.clone())?;

            Ok(SinkEncoder {
                writer,
                video_stream,
                audio_stream,
                frame_duration: 10_000_000i64 / cfg.fps as i64,
            })
        }
    }

    /// Write one BGRA frame at ts_us (capture-start-relative).
    pub fn write_video(&self, bgra: &[u8], width: u32, height: u32, ts_us: u64) -> Result<(), String> {
        unsafe {
            let buf_size = (width * height * 4) as usize;
            if bgra.len() < buf_size {
                return Err("frame buffer too small".into());
            }
            let media_buf: IMFMediaBuffer =
                hr(MFCreateMemoryBuffer(buf_size as u32)).map_err(|e| e.to_string())?;
            let mut ptr = std::ptr::null_mut::<u8>();
            media_buf
                .Lock(&mut ptr, None, None)
                .map_err(|e| e.to_string())?;
            std::ptr::copy_nonoverlapping(bgra.as_ptr(), ptr, buf_size);
            media_buf.Unlock().map_err(|e| e.to_string())?;
            media_buf.SetCurrentLength(buf_size as u32).map_err(|e| e.to_string())?;

            let sample: IMFSample = hr(MFCreateSample()).map_err(|e| e.to_string())?;
            sample.AddBuffer(&media_buf).map_err(|e| e.to_string())?;
            let ts = (ts_us / 10) as i64;
            sample.SetSampleTime(ts).map_err(|e| e.to_string())?;
            sample.SetSampleDuration(self.frame_duration).map_err(|e| e.to_string())?;
            self.writer
                .WriteSample(self.video_stream, &sample)
                .map_err(|e| e.to_string())
        }
    }

    /// Write interleaved s16le PCM. `ts_us` relative to capture start.
    pub fn write_audio(&self, pcm: &[u8], ts_us: u64) -> Result<(), String> {
        if self.audio_stream == u32::MAX {
            return Ok(());
        }
        unsafe {
            let media_buf: IMFMediaBuffer =
                hr(MFCreateMemoryBuffer(pcm.len() as u32)).map_err(|e| e.to_string())?;
            let mut ptr = std::ptr::null_mut::<u8>();
            media_buf.Lock(&mut ptr, None, None).map_err(|e| e.to_string())?;
            std::ptr::copy_nonoverlapping(pcm.as_ptr(), ptr, pcm.len());
            media_buf.Unlock().map_err(|e| e.to_string())?;
            media_buf.SetCurrentLength(pcm.len() as u32).map_err(|e| e.to_string())?;

            let sample: IMFSample = hr(MFCreateSample()).map_err(|e| e.to_string())?;
            sample.AddBuffer(&media_buf).map_err(|e| e.to_string())?;
            sample.SetSampleTime((ts_us / 10) as i64).map_err(|e| e.to_string())?;
            self.writer
                .WriteSample(self.audio_stream, &sample)
                .map_err(|e| e.to_string())
        }
    }

    pub fn finish(self) -> Result<(), String> {
        unsafe {
            self.writer.Flush(self.video_stream).map_err(|e| e.to_string())?;
            if self.audio_stream != u32::MAX {
                let _ = self.writer.Flush(self.audio_stream);
            }
            self.writer.Finalize().map_err(|e| e.to_string())?;
        }
        mf_shutdown();
        Ok(())
    }
}
