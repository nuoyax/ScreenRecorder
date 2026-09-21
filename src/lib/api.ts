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
 * Cursor + click track recorded next to a video. `interval_us` is the sampling
 * interval, so consumers know the resolution of the samples.
 */
export type MouseTrack = {
  moves: MoveSample[];
  clicks: ClickSample[];
  interval_us: number;
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
