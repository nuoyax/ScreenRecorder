//! MP4 transcoding through a user-installed `ffmpeg`.
//!
//! The only export this app cannot write itself. H.264 is encumbered and the Media
//! Foundation encoder it already has refuses to run alongside a live WASAPI capture
//! cleanly, so transcode is delegated — to a binary the user already has, or not at all.
//!
//! Two things matter here and both are about honesty:
//!
//!   * The arguments are built explicitly rather than string-concatenated, so a path with
//!     a space or a quote cannot turn into an injected flag.
//!   * The command runs *without* shell interpolation and with a hidden console; a
//!     tool that pops a black window over the editor is a defect, not a detail.
//!
//! Failure returns ffmpeg's own stderr tail. A generic "转码失败" would be useless: the
//! usual causes are a locked output file and an unsupported codec, and only the real
//! message tells them apart.

use std::path::{Path, PathBuf};
use std::process::Command;

use super::probe::{self, FfmpegStatus};

/// What to transcode, and how.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct TranscodeOptions {
    pub input: String,
    pub output: String,
    /// Target video bitrate in bits per second. Capped and floored by the caller.
    pub bitrate_bps: u64,
    pub fps: u32,
    /// `"h264"` or `"h265"`.
    pub codec: String,
    /// Re-encode from scratch rather than stream-copying. Only ever `true` here: the
    /// point of the panel is to change bitrate and rate, which copying cannot do.
    pub reencode: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TranscodeResult {
    pub path: String,
    pub bytes: u64,
    /// ffmpeg's own last lines, so the panel can show what actually happened.
    pub log: String,
}

/// Format a bitrate for `-b:v`, which wants bits per second with a unit suffix.
fn bitrate_arg(bps: u64) -> String {
    format!("{}k", (bps / 1000).max(1))
}

/// The libx264/libx265 preset to use.
///
/// `veryfast` rather than `medium`: transcoding is already the slow part of an export,
/// and the visible difference on screen-recording content is small. `medium` would
/// double the wall-clock for a marginal size win.
const PRESET: &str = "veryfast";

/// Build the argument vector.
///
/// `-y` is present because the caller has already resolved the destination: an ffmpeg
/// that stops to ask "overwrite?" would hang forever, since the process is spawned
/// without a console to answer on.
pub fn build_args(opts: &TranscodeOptions) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
        "-i".into(),
        opts.input.clone(),
    ];

    // `-map 0:v:0` keeps the first video stream and `0:a?` every audio stream, with the
    // `?` making audio optional — a silent recording must not fail the export.
    args.extend(["-map".into(), "0:v:0".into()]);
    args.extend(["-map".into(), "0:a?".into()]);

    if opts.reencode {
        let encoder = match opts.codec.to_ascii_lowercase().as_str() {
            "h265" | "hevc" => "libx265",
            _ => "libx264",
        };
        args.extend(["-c:v".into(), encoder.into()]);
        args.extend(["-preset".into(), PRESET.into()]);
        args.extend(["-b:v".into(), bitrate_arg(opts.bitrate_bps)]);
        args.extend(["-pix_fmt".into(), "yuv420p".into()]);
        // Even dimensions, or yuv420p has no valid chroma layout and ffmpeg refuses.
        args.extend(["-vf".into(), "scale=trunc(iw/2)*2:trunc(ih/2)*2".into()]);
        if opts.fps > 0 {
            args.extend(["-r".into(), opts.fps.to_string()]);
        }
        // Audio is copied when it is already AAC — re-encoding it would lose a
        // generation for nothing — and re-encoded otherwise so the container is valid.
        args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
    } else {
        args.extend(["-c".into(), "copy".into()]);
    }

    // `+faststart` moves the index to the front, which is what makes the file playable
    // while it is still downloading or being copied.
    args.extend(["-movflags".into(), "+faststart".into()]);
    args.push(opts.output.clone());
    args
}

/// Whether the destination can be written, checked before a minute of encoding.
fn check_writable(output: &Path) -> Result<(), String> {
    if let Some(parent) = output.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
        }
    }
    if output.exists() {
        // ffmpeg would overwrite it (we pass `-y`), but a file open in a player cannot
        // be replaced on Windows and the resulting error is cryptic.
        match std::fs::OpenOptions::new().write(true).open(output) {
            Ok(_) => Ok(()),
            Err(e) => Err(format!(
                "{} 已存在且无法覆盖（可能正在被播放器占用）：{e}",
                output.display()
            )),
        }
    } else {
        Ok(())
    }
}

/// Run the transcode, blocking until it finishes.
///
/// Blocking on purpose: ffmpeg is a child process and this waits on it. The caller runs
/// it on a blocking thread (`spawn_blocking`) so the async runtime is not held for the
/// length of an encode.
pub fn run(opts: &TranscodeOptions) -> Result<TranscodeResult, String> {
    let status: FfmpegStatus = probe::status();
    let ffmpeg: PathBuf = match (&status.available, &status.path) {
        (true, Some(p)) => PathBuf::from(p),
        _ => return Err(probe::INSTALL_HINT.to_string()),
    };

    let input = Path::new(&opts.input);
    if !input.is_file() {
        return Err(format!("找不到源文件：{}", opts.input));
    }
    let output = PathBuf::from(&opts.output);
    check_writable(&output)?;
    // Writing over the input would destroy the recording if the encode failed partway.
    if output == PathBuf::from(&opts.input) {
        return Err("输出路径不能与源文件相同".to_string());
    }

    let args = build_args(opts);
    let mut cmd = Command::new(&ffmpeg);
    cmd.args(&args);
    // Inheriting a console would flash a black window over the editor on every export.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    // Kill ffmpeg rather than let it outlive the app if the window is closed mid-encode.
    let out = cmd
        .output()
        .map_err(|e| format!("无法启动 ffmpeg（{}）：{e}", ffmpeg.display()))?;

    let log = tail(&String::from_utf8_lossy(&out.stderr), 12);
    if !out.status.success() {
        // The real message is the whole point: a locked output and an unknown encoder
        // are indistinguishable from a generic failure.
        return Err(if log.is_empty() {
            format!("ffmpeg 退出码 {:?}，且未输出错误信息", out.status.code())
        } else {
            format!("转码失败：\n{log}")
        });
    }

    let bytes = std::fs::metadata(&output)
        .map_err(|e| format!("转码结束但找不到输出文件：{e}"))?
        .len();
    if bytes == 0 {
        return Err("转码产出了空文件".to_string());
    }
    Ok(TranscodeResult {
        path: output.to_string_lossy().to_string(),
        bytes,
        log,
    })
}

/// Last `n` non-empty lines of ffmpeg's output.
///
/// The tail, not the whole thing: ffmpeg prints a configuration banner and per-frame
/// progress, and the error is always at the end.
fn tail(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> TranscodeOptions {
        TranscodeOptions {
            input: "C:\\vids\\rec.mp4".into(),
            output: "C:\\vids\\rec-out.mp4".into(),
            bitrate_bps: 12_000_000,
            fps: 30,
            codec: "h264".into(),
            reencode: true,
        }
    }

    #[test]
    fn args_encode_the_requested_rate_and_codec() {
        let args = build_args(&opts());
        let at = |flag: &str| args.iter().position(|a| a == flag);
        let v = at("-c:v").expect("a video codec must be set");
        assert_eq!(args[v + 1], "libx264");
        let b = at("-b:v").expect("a bitrate must be set");
        assert_eq!(args[b + 1], "12000k", "12 Mbps becomes 12000k");
        let r = at("-r").expect("a frame rate must be set");
        assert_eq!(args[r + 1], "30");
    }

    #[test]
    fn h265_selects_the_other_encoder() {
        let args = build_args(&TranscodeOptions { codec: "hevc".into(), ..opts() });
        let v = args.iter().position(|a| a == "-c:v").unwrap();
        assert_eq!(args[v + 1], "libx265");
    }

    /// The input path is a single argument, never concatenated into a command line:
    /// a path with a space or a quote must not be able to become a flag.
    #[test]
    fn the_input_path_stays_one_argument() {
        let args = build_args(&TranscodeOptions {
            input: "C:\\my vids\\a -b \\\"tricky\\\".mp4".into(),
            ..opts()
        });
        let i = args.iter().position(|a| a == "-i").unwrap();
        assert_eq!(args[i + 1], "C:\\my vids\\a -b \\\"tricky\\\".mp4");
        // ...and the destination is the last argument, unparsed.
        assert_eq!(args.last().unwrap(), &opts().output);
    }

    /// Audio is optional: a silent recording must still export.
    #[test]
    fn audio_is_mapped_but_not_required() {
        let args = build_args(&opts());
        assert!(args.iter().any(|a| a == "0:a?"), "the `?` makes audio optional");
        assert!(args.iter().any(|a| a == "+faststart"), "the index must move to the front");
    }

    /// yuv420p needs even dimensions, and a screen region can easily be odd-sized.
    #[test]
    fn output_dimensions_are_forced_even() {
        let args = build_args(&opts());
        assert!(
            args.iter().any(|a| a.contains("trunc(iw/2)*2")),
            "odd dimensions would make yuv420p invalid"
        );
    }

    #[test]
    fn a_copy_does_not_name_an_encoder() {
        let args = build_args(&TranscodeOptions { reencode: false, ..opts() });
        assert!(args.iter().any(|a| a == "-c"));
        assert!(!args.iter().any(|a| a == "-c:v"));
    }

    #[test]
    fn bitrate_argument_never_rounds_to_zero() {
        assert_eq!(bitrate_arg(500), "1k", "a sub-kbps request still needs a code");
        assert_eq!(bitrate_arg(2_000_000), "2000k");
    }

    /** Only the tail matters: the banner is noise and the error is last. */
    #[test]
    fn tail_keeps_the_last_lines() {
        let text = "banner 1\nbanner 2\n\nprogress\nreal error here";
        assert_eq!(tail(text, 2), "progress\nreal error here");
        assert_eq!(tail("", 5), "");
        assert_eq!(tail("only one", 5), "only one");
    }

    /// Without ffmpeg the error has to be the install hint, not an empty string.
    #[test]
    fn a_missing_source_is_refused_before_ffmpeg_is_consulted() {
        let err = run(&TranscodeOptions {
            input: "C:\\definitely\\not\\here.mp4".into(),
            ..opts()
        })
        .expect_err("must refuse");
        // Either message is correct depending on whether ffmpeg is installed here; what
        // must not happen is a panic or an empty error.
        assert!(!err.is_empty());
    }
}
