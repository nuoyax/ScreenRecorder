//! Finding `ffmpeg.exe` on this machine, without bundling it.
//!
//! Transcoding is the one export path this app cannot implement itself in a reasonable
//! amount of code (H.264 is patent-encumbered and the Media Foundation encoder here is
//! already in use for recording). Rather than ship a 70 MB binary that most users
//! already have, the app looks for one:
//!
//!   * `SCREEN_RECORDER_FFMPEG` — an explicit override, for a portable install
//!   * `PATH`
//!   * the usual winget / Chocolatey / scoop / manual-build locations
//!
//! The result is cached, because the answer only changes if the user installs something
//! while the app is running, and re-running `where.exe` on every render of the export
//! panel would be a subprocess per keystroke.
//!
//! Everything else — GIF, PNG, stickers — works without this. The panel greys out the
//! transcode card and shows the install hint instead of failing at the end of a long
//! render.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

#[derive(Debug, Clone, serde::Serialize)]
pub struct FfmpegStatus {
    /// Whether a usable `ffmpeg` was found.
    pub available: bool,
    /// Full path, when found.
    pub path: Option<String>,
    /// First line of `ffmpeg -version`, so the UI can show what it found.
    pub version: Option<String>,
    /// Where it was found, for a message like "found on PATH".
    pub source: String,
    /// What to tell the user when nothing was found. Always present so the UI never has
    /// to invent its own wording — the two would drift.
    pub hint: String,
}

/// Known install locations, in preference order.
///
/// winget and Chocolatey put a shim on `PATH`, so they normally need no entry here —
/// but a shim is a `.exe` that re-launches the real one, and it is worth preferring the
/// real binary when both exist.
fn known_locations() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        out.push(PathBuf::from(&local).join("Microsoft/WinGet/Links/ffmpeg.exe"));
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        out.push(PathBuf::from(&pf).join("ffmpeg/bin/ffmpeg.exe"));
    }
    if let Ok(pf86) = std::env::var("ProgramFiles(x86)") {
        out.push(PathBuf::from(&pf86).join("ffmpeg/bin/ffmpeg.exe"));
    }
    if let Ok(home) = std::env::var("USERPROFILE") {
        out.push(PathBuf::from(&home).join("scoop/shims/ffmpeg.exe"));
        out.push(PathBuf::from(&home).join("chocolatey/bin/ffmpeg.exe"));
    }
    out.push(PathBuf::from("C:/ffmpeg/bin/ffmpeg.exe"));
    out
}

/// Look for `ffmpeg.exe` on `PATH` via `where.exe`.
///
/// `where.exe` rather than reading `PATH` by hand: the shell's view of `PATH` includes
/// the same entries, but `where` also applies `PATHEXT` and the per-user `App Paths`
/// registry keys, which is what makes winget-installed tools discoverable.
fn on_path() -> Option<PathBuf> {
    let mut cmd = Command::new("where.exe");
    cmd.arg("ffmpeg.exe");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    // `where` may return several; the first is the one the shell would run.
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(PathBuf::from)
}

/// Run `ffmpeg -version` and take the first line.
///
/// A file named `ffmpeg.exe` that is not one (a stub, a broken shim) must not be
/// reported as available — running it is the only way to tell.
fn probe_version(path: &Path) -> Option<String> {
    let mut cmd = Command::new(path);
    cmd.arg("-version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .find(|l| l.trim().to_ascii_lowercase().starts_with("ffmpeg version"))
        .map(|l| l.trim().to_string())
        .or_else(|| text.lines().next().map(|l| l.trim().to_string()))
}

fn locate() -> FfmpegStatus {
    let candidates: Vec<(PathBuf, &str)> = std::env::var("SCREEN_RECORDER_FFMPEG")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(|v| vec![(PathBuf::from(v), "SCREEN_RECORDER_FFMPEG")])
        .unwrap_or_else(|| {
            let mut c: Vec<(PathBuf, &str)> = Vec::new();
            if let Some(p) = on_path() {
                c.push((p, "PATH"));
            }
            for p in known_locations() {
                c.push((p, "常见安装位置"));
            }
            c
        });

    for (path, source) in candidates {
        if !path.is_file() {
            continue;
        }
        if let Some(version) = probe_version(&path) {
            return FfmpegStatus {
                available: true,
                path: Some(path.to_string_lossy().to_string()),
                version: Some(version),
                source: source.to_string(),
                hint: String::new(),
            };
        }
    }
    FfmpegStatus {
        available: false,
        path: None,
        version: None,
        source: String::new(),
        hint: INSTALL_HINT.to_string(),
    }
}

/// Cached lookup. The environment does not change under a running app in any way worth
/// re-scanning for, and the scan costs a subprocess.
pub fn status() -> FfmpegStatus {
    static CACHE: OnceLock<FfmpegStatus> = OnceLock::new();
    CACHE.get_or_init(locate).clone()
}

/// The install hint shown when nothing was found. Kept next to the search so the two
/// cannot drift apart.
pub const INSTALL_HINT: &str =
    "未找到 ffmpeg。可用 winget install Gyan.FFmpeg 或 scoop install ffmpeg 安装；\
     也可设置环境变量 SCREEN_RECORDER_FFMPEG 指向 ffmpeg.exe。\
     其余导出（GIF / PNG / 贴纸）不依赖 ffmpeg。";

#[cfg(test)]
mod tests {
    use super::*;

    /// The cache must be stable: a second call has to return the same answer rather
    /// than re-running the probe.
    #[test]
    fn status_is_cached_and_self_consistent() {
        let a = status();
        let b = status();
        assert_eq!(a.available, b.available);
        assert_eq!(a.path, b.path);
        // An available status must name a file that exists and a version string; a
        // missing one must carry neither, or the UI would show a path it cannot use.
        if a.available {
            let p = a.path.as_ref().expect("available status must carry a path");
            assert!(Path::new(p).is_file(), "{p} should exist");
            assert!(a.version.is_some(), "available status must carry a version");
        } else {
            assert!(a.path.is_none());
            assert!(a.version.is_none());
        }
    }

    /// The hint has to mention the env var the probe actually reads, or following it
    /// would do nothing.
    #[test]
    fn install_hint_names_the_override_variable() {
        assert!(INSTALL_HINT.contains("SCREEN_RECORDER_FFMPEG"));
        assert!(INSTALL_HINT.contains("winget"), "should name at least one installer");
    }

    #[test]
    fn known_locations_are_absolute_paths() {
        for p in known_locations() {
            assert!(p.is_absolute(), "{p:?} should be absolute");
            assert_eq!(
                p.file_name().and_then(|n| n.to_str()),
                Some("ffmpeg.exe"),
                "{p:?} should name ffmpeg.exe"
            );
        }
    }
}
