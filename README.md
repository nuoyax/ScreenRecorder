# ScreenRecorder

**English** | [中文](README.zh-CN.md)

<div align="center">

**A lightweight, high-performance screen recorder for Windows — built with Rust + Tauri 2**

Capture • Hardware Encode • Zero Bloat

![Platform](https://img.shields.io/badge/platform-Windows%2010%201903%2B-blue)
![Rust](https://img.shields.io/badge/rust-1.77%2B-orange)
![Tauri](https://img.shields.io/badge/Tauri-2-24C8D8)
![License](https://img.shields.io/badge/license-MIT-green)

</div>

---

ScreenRecorder captures your screen, a single window, or a custom region via **Windows.Graphics.Capture**, encodes with **Media Foundation hardware encoders** (H.264/H.265 + AAC), and writes compact, playable MP4 files — no bloated runtime, no watermarks, no telemetry.

## ✨ Features

### 🎥 Capture
- **Three source modes** — full screen (multi-monitor aware), any application window, or a precise custom region
- **Floating toolbar** — always-on-top mini control bar pinned to the corner, automatically **excluded from your own recordings** (`WDA_EXCLUDEFROMCAPTURE`)
- **Cursor capture** — mouse pointer included; the yellow recording border is suppressed on supported systems

### 🎬 Encoding
- **Hardware acceleration** — Media Foundation H.264 / H.265 (HEVC), with automatic HEVC → H.264 fallback when no HEVC encoder is present
- **Quality presets** — from compact low-bitrate clips up to a "Blu-ray grade" ultra preset; or set the bitrate yourself
- **VBR / CBR** rate control
- **Zero-copy GPU path** — frames stay on the D3D11 pipeline from capture to encoder

### 🔊 Audio
- **System audio** via WASAPI loopback and **microphone**, independently togglable with per-source volume
- Both sources mixed and encoded to AAC inside the same MP4

### ⏺ Recording Control
- Start / **pause / resume** / stop — the timer freezes correctly during pause
- **Global hotkeys**: `Alt+R` start/stop, `Alt+P` pause/resume — works even when the app is in the background
- **Auto stop** by max duration or max file size
- Non-blocking save: large MP4s are finalized in the background, the UI never freezes

### 🗂 History & Settings
- **Recent recordings** list with file size and date — one click opens it in Explorer
- All settings persisted as JSON, restored on launch

## 📦 Install & Build

### Prerequisites
- Windows 10 1903+ (Windows.Graphics.Capture API)
- [Rust](https://rustup.rs) (MSVC toolchain recommended) & Node.js 18+
- WebView2 (preinstalled on Windows 11)

```bash
# install frontend deps
npm install

# build the release binary
npm run tauri build

# or run in dev mode (hot reload)
npm run tauri dev
```

The binary is produced at `src-tauri/target/release/screen-recorder.exe`.

> **GNU toolchain note**: `windres` requires a working C preprocessor — put `mingw64/bin` on PATH, or build with MSVC instead.

## 🚀 Usage

1. Launch `screen-recorder.exe` — a small toolbar appears at the bottom-right of your screen, and the main window gives you full settings.
2. Pick a source and quality, then hit **Alt+R** or the ● button to start.
3. **Alt+P** to pause/resume, **Alt+R** again (or ■) to stop and save.

Default output: `Videos\ScreenRecord\recording_YYYYMMDD_HHMMSS.mp4`

### Quality presets (bitrate guidance at 1080p/30fps)

| Preset | ~Bitrate | Notes |
|--------|----------|-------|
| Low    | ~6 Mbps  | smallest files |
| Medium | ~13 Mbps | balanced |
| High   | ~25 Mbps | recommended, near-lossless for UI content |
| Ultra  | ~55 Mbps | Blu-ray grade, maximum quality |
| Custom | user-set | full control |

> H.265 reaches the same visual quality as H.264 at ~65% of the bitrate.

## 🏗 Architecture

```
┌──────────────────────────── Tauri 2 (Rust) ───────────────────────────┐
│                                                                       │
│  WGC capture ──► D3D11 texture ──► MF SinkWriter ──► MP4 (H.264/265)  │
│       │                                   ▲                           │
│  WASAPI loopback ──► AAC encoder ─────────┘                           │
│  WASAPI microphone ───────────────────────┘                           │
│                                                                       │
│  React + antd UI (main window + floating toolbar)                     │
│    └── Tauri IPC commands / events (progress, saved, codec-fallback)  │
└───────────────────────────────────────────────────────────────────────┘
```

| Module | Path | Role |
|--------|------|------|
| Capture | `src-tauri/src/capture/` | WGC frame pool, monitor/window enumeration |
| Encoder | `src-tauri/src/encoder/` | MF SinkWriter wrapper, codec negotiation |
| Audio | `src-tauri/src/audio/` | WASAPI loopback + mic capture, resampling, mixing |
| Recorder | `src-tauri/src/recorder.rs` | State machine (recording/paused/stopped), threading |
| UI | `src/` | React 19 + antd + Tailwind 4 |

## ⌨️ Hotkeys

| Key | Action |
|-----|--------|
| `Alt+R` | Start / stop recording |
| `Alt+P` | Pause / resume |

## 📄 License

[MIT](LICENSE)
