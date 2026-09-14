# Screen Record

**English** | [中文](README.zh-CN.md)

A lightweight Windows screen recorder built with Rust + Tauri 2. Captures screens, windows, or regions via Windows.Graphics.Capture, encodes with Media Foundation (hardware H.264/H.265 + AAC), and writes compact MP4 files.

## Features

- **Capture sources**: full screen (multi-monitor), any window, or a custom region
- **High quality**: H.264 / H.265 (HEVC) hardware encoding, VBR/CBR, quality presets or custom bitrate
- **Audio**: system audio (WASAPI loopback) and microphone, independently togglable with volume control, mixed to AAC
- **Recording control**: start/pause/resume/stop, global hotkeys (Alt+R, Alt+P)
- **Auto stop**: by max duration or max file size
- **Cursor capture** enabled (border suppressed where supported)
- **Recording history**: file list with size/date, quick open in Explorer
- **Settings persisted** to JSON

## Requirements

- Windows 10 1903+ (Windows.Graphics.Capture)
- Rust (MSYS2/MinGW or MSVC toolchain)

## Build

```bash
cd src-tauri
cargo build --release
```

> Note: on the GNU toolchain, `windres` needs a working C preprocessor — run cargo with `mingw64/bin` on PATH.

## Usage

Launch `screen-record.exe`, pick a source, tune quality, then press **Alt+R** (or the UI button) to record. Default output: `Videos\ScreenRecord\recording_YYYYMMDD_HHMMSS.mp4`.

### Quality presets (bitrate guidance at 1080p/30fps)

| Preset | ~Bitrate | Notes |
|--------|----------|-------|
| Low    | ~6 Mbps  | smallest files |
| Medium | ~13 Mbps | balanced |
| High   | ~25 Mbps | recommended, near-lossless for UI |
| Custom | user-set | full control |

H.265 uses ~65% of the H.264 bitrate for the same visual quality.

## License

MIT
