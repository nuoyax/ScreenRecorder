# ScreenRecorder

**English** | [中文](README.zh-CN.md)

<div align="center">

**A lightweight, high-performance screen recorder for Windows — built with Rust + Tauri 2**

Capture • Hardware Encode • Edit • Export

![Platform](https://img.shields.io/badge/platform-Windows%2010%201903%2B-blue)
![Rust](https://img.shields.io/badge/rust-1.77%2B-orange)
![Tauri](https://img.shields.io/badge/Tauri-2-24C8D8)
![License](https://img.shields.io/badge/license-MIT-green)

</div>

---

ScreenRecorder captures your screen, a single window, or a custom region via **Windows.Graphics.Capture**, encodes with **Media Foundation hardware encoders** (H.264/H.265 + AAC), and writes compact, playable MP4 files. A built-in timeline editor then trims, zooms, crops and annotates a recording, and exports it as a GIF, a PNG sticker or a transcoded MP4 — no bloated runtime, no watermarks, no telemetry.

## ✨ Features

### 🎥 Capture
- **Three source modes** — full screen (multi-monitor aware), any application window, or a precise custom region
- **Draw-the-region picker** — "选择区域" opens an always-on-top overlay over a frozen still of the target monitor. Drag a rectangle and the live desktop shows through inside it while everything outside dims away; the selection is stored as virtual-screen coordinates plus a thumbnail. Minimum selection: 8 px
- **Floating toolbar** — always-on-top mini control bar pinned to the corner, automatically **excluded from your own recordings** (`WDA_EXCLUDEFROMCAPTURE`)
- **Cursor capture** — mouse pointer included; the yellow WGC capture border is suppressed on Windows 10 2004+ (`SetIsBorderRequired(false)`)

### 🎬 Encoding
- **Hardware acceleration** — Media Foundation H.264 / H.265 (HEVC), with automatic HEVC → H.264 fallback when no HEVC encoder is present
- **Quality presets** — from compact low-bitrate clips up to a "Blu-ray grade" ultra preset; or set the bitrate yourself
- **VBR / CBR** rate control
- **Zero-copy GPU path** — frames stay on the D3D11 pipeline from capture to encoder

### 🔊 Audio
- **System audio** via WASAPI loopback and **microphone**, independently togglable with per-source volume
- **Microphone picker** — the input-device dropdown lists every active capture endpoint (the system default marked *默认*); the choice is persisted as the WASAPI endpoint id
- Both sources are downmixed to mono at 48 kHz, mixed and encoded to AAC inside the same MP4

### ✂️ Timeline Editor
- **Projects** are a reference to a recording plus its edits — never a copy of the media. Autosaved as `<recording>.srec.json` beside the file
- **Clips** — split at the playhead, delete, drag to reorder, trim head/tail, and retime from 0.25× to 2×
- **Zooms** — a time span, a depth (1–6 → 1.25×–5×) and a normalized focus point. Implemented as a *crop* rather than a scaled draw, so zoomed frames keep full output resolution
- **Crop** — spatial crop with full / padded / center-80 presets; composes with zoom (crop picks the base rectangle, zoom searches inside it)
- **Annotations** — text and arrows, with colour, size, background and rotation, each timed by its own start/end
- **Background** — dark / light / none / sunset / ocean presets with padding, corner radius and drop shadow
- **Zoom suggestions** — the editor reads the cursor track and proposes zips over fast movement or long stillness. Suggestions are offered, never applied on their own
- **Undo / redo** (100 steps) and a live 1280×720 canvas preview with frame-accurate scrubbing

### 📤 Export
- **GIF** — 1280×720, written by a hand-rolled GIF89a encoder in Rust (no crate, no ffmpeg): fixed 256-colour cube, ordered dithering, transparent index, loops forever. 8–24 fps; frame rate is lowered rather than truncated on long timelines
- **PNG sticker** — the composed frame at the playhead as RGBA, with transparent padding, rounded corners and a blurred drop shadow
- **MP4 transcode** — runs a `ffmpeg` **you already have on PATH** (never bundled); H.264/H.265, bitrate preset or custom, 24/30/60 fps. It transcodes the *source* recording — editor zoom, annotations and background are **not** in this output
- **MV sequence** — a trim / speed / concatenate re-encode built on the Media Foundation source reader, no ffmpeg involved. Currently exercised by the Rust test suite and not yet surfaced in the UI

> GIF, sticker and region picking work with no external tools. Only MP4 transcode looks for ffmpeg.

### ⏺ Recording Control
- Start / **pause / resume** / stop — the timer freezes correctly during pause
- **Global hotkeys**: `Alt+R` start/stop, `Alt+P` pause/resume — works even when the app is in the background
- **Auto stop** by max duration or max file size
- Non-blocking save: large MP4s are finalized in the background, the UI never freezes

### 🗂 History & Settings
- **Recent recordings** list with file size and date — one click opens it in Explorer, another opens it in the editor
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

By default a sidecar cursor track is written beside it as `<recording>.mp4.mouse.json`; it is skipped only when both cursor drawing and click highlighting are off.

### Editing & exporting

1. In the **recent** list, click **编辑** on a recording to open the editor.
2. Trim, split and reorder clips; add zooms, crop the frame, drop in annotations and pick a background — the preview updates live.
3. Open the **导出** tab and choose a destination:
   - **GIF** — the whole timeline, at the frame rate you pick
   - **贴纸 (PNG)** — the single frame under the playhead
   - **转码为 MP4** — the source recording re-encoded through ffmpeg, at a quality preset and frame rate
4. Edits autosave to `<recording>.srec.json`; the exports land next to the recording as `*-anim.gif`, `*-sticker.png` and `*-transcoded.mp4`.

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
│  cursor sampler ──► <recording>.mp4.mouse.json                        │
│                                                                       │
│  React + antd UI (main window · floating toolbar · region picker)     │
│    └── Tauri IPC commands / events (progress, saved, codec-fallback)  │
│                                                                       │
│  Editor canvas (webview) ──► GIF writer · PNG sticker                 │
│  ffmpeg on PATH ──► transcoded MP4                                    │
│  MF source reader ──► MV sequence                                     │
└───────────────────────────────────────────────────────────────────────┘
```

The canvas is the single compositor: the editor preview and the GIF/sticker
writers all call the same `drawFrame`, so what you see is what those exports
contain. The MP4 transcode and MV sequence deliberately skip it — they operate
on footage only, which is why their output has no zooms or annotations.

| Module | Path | Role |
|--------|------|------|
| Capture | `src-tauri/src/capture/` | WGC frame pool, monitor/window enumeration, region still |
| Encoder | `src-tauri/src/encoder/` | MF SinkWriter wrapper, codec negotiation |
| Audio | `src-tauri/src/audio/` | WASAPI loopback + mic capture, device enumeration, mixing |
| Input | `src-tauri/src/input/` | Cursor/click sampler, sidecar track read/write |
| Recorder | `src-tauri/src/recorder.rs` | State machine (recording/paused/stopped), threading |
| Export | `src-tauri/src/export/` | GIF writer, PNG sticker, ffmpeg probe/transcode, MF sequence |
| Editor | `src/lib/editor/`, `src/lib/timeline/` | Project model, timeline ops, canvas compositor |
| UI | `src/` | React 19 + antd + Tailwind 4 |

## ⌨️ Hotkeys

| Key | Action |
|-----|--------|
| `Alt+R` | Start / stop recording |
| `Alt+P` | Pause / resume |

## 📄 License

[MIT](LICENSE)
