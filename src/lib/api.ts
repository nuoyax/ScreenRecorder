import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type RecState = "idle" | "recording" | "paused";

export type Settings = {
  source_kind: "screen" | "window" | "region" | string;
  source_id: string;
  region: [number, number, number, number];
  fps: number;
  scale_width: number;
  codec: string;
  quality: string;
  bitrate_kbps: number;
  rate_mode: string;
  record_system_audio: boolean;
  record_microphone: boolean;
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
  openFile: (path: string) => invoke<void>("open_file", { path }),
  quitApp: () => invoke<void>("quit_app"),
  onProgress: (handler: (p: Progress) => void): Promise<UnlistenFn> =>
    listen<Progress>("recording-progress", (e) => handler(e.payload)),
};
