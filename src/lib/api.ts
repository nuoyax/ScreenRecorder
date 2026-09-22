import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type RecState = "idle" | "recording" | "paused";

export type Settings = {
  source_kind: "screen" | "window" | "region" | string;
  source_id: string;
  /** region: x, y, w, h in virtual screen coordinates */
  region: [number, number, number, number];
  /** data URL thumbnail of the last picked region; empty when none was picked */
  region_thumbnail: string;
  fps: number;
  scale_width: number;
  codec: string;
  quality: string;
  bitrate_kbps: number;
  rate_mode: string;
  record_system_audio: boolean;
  record_microphone: boolean;
  /** WASAPI endpoint id; empty string = system default microphone */
  mic_device: string;
  system_volume: number;
  mic_volume: number;
  output_dir: string | null;
  max_duration_secs: number;
  max_file_mb: number;
  show_cursor: boolean;
  click_highlight: boolean;
  countdown_secs: number;
  hotkey_start_stop: string;
  hotkey_pause: string;
};

export type Progress = {
  state: RecState;
  duration_secs: number;
  file_mb: number;
  frames: number;
};

export type MonitorInfo = {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  is_primary: boolean;
};

export type WindowInfo = {
  hwnd: number;
  title: string;
};

export type MicrophoneInfo = {
  id: string;
  name: string;
  is_default: boolean;
};

export type SourceLists = {
  monitors: MonitorInfo[];
  windows: WindowInfo[];
  wgc_supported: boolean;
};

export type HistoryEntry = {
  path: string;
  size_mb: number;
  modified: string;
};

/** One cursor position reading, in virtual-screen coordinates. */
export type MoveSample = {
  t_us: number;
  x: number;
  y: number;
};

export type ClickSample = MoveSample & {
  button: "left" | "right" | string;
};

/**
 * Screen rectangle a recording covers, in virtual-screen coordinates.
 *
 * Cursor samples are absolute; without this the editor cannot tell which part of the
 * screen the frame shows, and would draw the cursor in the wrong place on a region
 * recording or on a multi-monitor setup.
 */
export type SampleRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Cursor + click track recorded next to a video. `interval_us` is the sampling
 * interval, so consumers know the resolution of the samples.
 */
export type MouseTrack = {
  moves: MoveSample[];
  clicks: ClickSample[];
  interval_us: number;
  /** Absent in tracks written before it was recorded. */
  rect?: SampleRect | null;
};

/**
 * A still of one monitor, shown behind the region picker.
 *
 * `x`/`y` are the monitor's origin in virtual-screen coordinates and
 * `monitor_width`/`monitor_height` its real pixel size — together they turn a
 * selection drawn on the preview into an absolute region, whatever size the preview
 * is displayed at.
 */
export type MonitorPreview = {
  data_url: string;
  x: number;
  y: number;
  monitor_width: number;
  monitor_height: number;
};

/** Whether a usable `ffmpeg` was found, and what to tell the user if not. */
export type FfmpegStatus = {
  available: boolean;
  path: string | null;
  version: string | null;
  /** Where it was found: `"PATH"`, `"常见安装位置"`, or the override variable. */
  source: string;
  /** Install instructions, present only when nothing was found. */
  hint: string;
};

/** What an export produced. Reported back so the panel can show real numbers. */
export type ExportResult = {
  path: string;
  bytes: number;
  frames: number;
  /** What the caller said it would send; a shortfall means the render loop gave up. */
  expected_frames: number;
  format: string;
};

/** What a transcode produced. `log` is ffmpeg's own tail, shown rather than swallowed. */
export type TranscodeResult = {
  path: string;
  bytes: number;
  log: string;
};

export const api = {
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) =>
    invoke<void>("save_settings", { settings }),
  listSources: () => invoke<SourceLists>("list_sources"),
  startRecording: () => invoke<string>("start_recording"),
  pauseRecording: () => invoke<void>("pause_recording"),
  resumeRecording: () => invoke<void>("resume_recording"),
  stopRecording: () => invoke<string>("stop_recording"),
  recordingProgress: () => invoke<Progress | null>("recording_progress"),
  listRecordings: () => invoke<HistoryEntry[]>("list_recordings"),
  listMicrophones: () => invoke<MicrophoneInfo[]>("list_microphones"),
  /** `null` when the recording has no cursor track (sampling was off). */
  loadMouseTrack: (videoPath: string) =>
    invoke<MouseTrack | null>("load_mouse_track", { videoPath }),
  openFile: (path: string) => invoke<void>("open_file", { path }),
  /** Read a text file the editor owns (a `.srec.json` project). */
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  writeTextFile: (path: string, contents: string) =>
    invoke<void>("write_text_file", { path, contents }),
  fileExists: (path: string) => invoke<boolean>("file_exists", { path }),
  /** Grant the asset protocol access to one file, so the webview can load it. */
  allowAsset: (path: string) => invoke<void>("allow_asset", { path }),
  /** Still frame of `monitorId`, for the picker backdrop. */
  captureMonitorPreview: (monitorId: string) =>
    invoke<MonitorPreview>("capture_monitor_preview", { monitorId }),
  /** Monitor the picker window is currently covering; empty when none. */
  regionTarget: () => invoke<string>("region_target"),
  openRegionPicker: (monitorId: string) =>
    invoke<void>("open_region_picker", { monitorId }),
  closeRegionPicker: () => invoke<void>("close_region_picker"),
  /** Commit a picked rectangle (absolute virtual-screen coords) + its thumbnail. */
  applyRegion: (
    region: [number, number, number, number],
    thumbnail: string,
    monitorId: string,
  ) => invoke<void>("apply_region", { region, thumbnail, monitorId }),
  onRegionTarget: (handler: (monitorId: string) => void): Promise<UnlistenFn> =>
    listen<string>("region-target", (e) => handler(e.payload)),
  onRegionSelected: (
    handler: (region: [number, number, number, number]) => void,
  ): Promise<UnlistenFn> =>
    listen<[number, number, number, number]>("region-selected", (e) => handler(e.payload)),
  quitApp: () => invoke<void>("quit_app"),
  /**
   * Whether this build's IPC can carry a raw byte payload.
   *
   * The frame-based exports send an `ArrayBuffer`; the command reads the transport and
   * reports what actually arrived, so the answer cannot drift from what the exporters
   * will experience.
   */
  ipcRawSupported: () => invoke<boolean>("ipc_raw_supported", new Uint8Array([0, 0, 0, 0])),
  /** Locate `ffmpeg` for the transcode card. Cached in Rust after the first call. */
  ffmpegStatus: () => invoke<FfmpegStatus>("ffmpeg_status"),
  /**
   * Re-encode an existing MP4 through the user's own `ffmpeg`.
   *
   * Resolves only when the encode finishes — ffmpeg runs for as long as the file takes,
   * so the caller must show that wait rather than a spinner that could mean anything.
   * Rejects with ffmpeg's own stderr when it fails, and with the install hint when there
   * is no ffmpeg to run.
   */
  exportTranscode: (args: {
    input: string;
    output: string;
    bitrateBps: number;
    fps: number;
    codec: string;
  }) => invoke<TranscodeResult>("export_transcode", args),
  /** Open a streaming GIF export. Fails before any rendering if the target is unusable. */
  exportSetup: (args: {
    path: string;
    width: number;
    height: number;
    frames: number;
    delayCs: number;
  }) => invoke<void>("export_setup", args),
  /**
   * Hand one composed frame to the export in progress.
   *
   * The payload is a packed header + RGBA buffer (see `lib/export/framePack.ts`), sent
   * as bytes rather than as a JSON array of numbers. Tauri routes a `Uint8Array`
   * argument straight to the custom-protocol path, which is the only transport that
   * carries a byte body — hence `ipcRawSupported` above.
   */
  exportPushFrame: (payload: Uint8Array) => invoke<number>("export_push_frame", payload),
  /** Write the GIF and report what landed on disk. */
  exportFinish: () => invoke<ExportResult>("export_finish"),
  /** Abandon the export in progress. `false` when there was none. */
  exportCancel: () => invoke<boolean>("export_cancel"),
  /** Write one composed frame as a PNG sticker (framing travels in the payload header). */
  exportImgSticker: (payload: Uint8Array) => invoke<ExportResult>("export_img_sticker", payload),
  onProgress: (handler: (p: Progress) => void): Promise<UnlistenFn> =>
    listen<Progress>("recording-progress", (e) => handler(e.payload)),
  onCodecFallback: (handler: (codec: string) => void): Promise<UnlistenFn> =>
    listen<string>("codec-fallback", (e) => handler(e.payload)),
  /** Emits the remaining seconds (…3, 2, 1) then 0 once capture starts. */
  onCountdown: (handler: (remaining: number) => void): Promise<UnlistenFn> =>
    listen<number>("countdown", (e) => handler(e.payload)),
  onRecordingSaved: (handler: (path: string) => void): Promise<UnlistenFn> =>
    listen<string>("recording-saved", (e) => handler(e.payload)),
};
