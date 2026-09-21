/**
 * Editor data model.
 *
 * Ported from Recordly's `src/components/video-editor/types.ts`, trimmed to what
 * this editor actually renders. The important part carried over verbatim is the
 * `ClipRegion` shape: `startMs`/`endMs` are *timeline* positions while
 * `sourceStartMs` is a position in the recording, and they only coincide at 1x.
 * Conflating the two is what makes splitting or trimming a sped-up clip silently
 * drop footage.
 */

export interface TrimRegion {
  id: string;
  startMs: number;
  endMs: number;
}

export interface ClipRegion {
  id: string;
  /** Where the clip sits on the timeline. */
  startMs: number;
  /** Where the clip ends on the timeline (`startMs` + source duration / speed). */
  endMs: number;
  /**
   * Where the clip reads from in the recording. Defaults to `startMs`, which is only
   * the same thing while everything before it plays at 1x.
   */
  sourceStartMs?: number;
  speed: number;
  muted?: boolean;
}

export type PlaybackSpeed = 0.25 | 0.5 | 0.75 | 1 | 1.25 | 1.5 | 1.75 | 2;

/**
 * Where a clip's first frame comes from in the recording.
 *
 * Only differs from `startMs` once something plays at a speed other than 1x, which is
 * exactly when assuming they are equal starts dropping footage.
 */
export function getClipSourceStartMs(clip: ClipRegion): number {
  return Number.isFinite(clip.sourceStartMs) ? (clip.sourceStartMs as number) : clip.startMs;
}

/** Where a clip stops reading in the recording. */
export function getClipSourceEndMs(clip: ClipRegion): number {
  const displayDurationMs = Math.max(0, clip.endMs - clip.startMs);
  const speed = Number.isFinite(clip.speed) && clip.speed > 0 ? clip.speed : 1;
  return Math.round(getClipSourceStartMs(clip) + displayDurationMs * speed);
}

export function sortClipRegions(clips: ClipRegion[]): ClipRegion[] {
  return [...clips].sort((left, right) => left.startMs - right.startMs);
}

export const SPEED_OPTIONS: Array<{ speed: PlaybackSpeed; label: string }> = [
  { speed: 0.25, label: "0.25×" },
  { speed: 0.5, label: "0.5×" },
  { speed: 0.75, label: "0.75×" },
  { speed: 1, label: "1×" },
  { speed: 1.25, label: "1.25×" },
  { speed: 1.5, label: "1.5×" },
  { speed: 1.75, label: "1.75×" },
  { speed: 2, label: "2×" },
];

export type ZoomDepth = 1 | 2 | 3 | 4 | 5 | 6;

export const ZOOM_DEPTH_SCALES: Record<ZoomDepth, number> = {
  1: 1.25,
  2: 1.5,
  3: 1.8,
  4: 2.2,
  5: 3.5,
  6: 5.0,
};

export const DEFAULT_ZOOM_DEPTH: ZoomDepth = 3;

/** Normalized horizontal/vertical centre of the zoomed area (0–1). */
export interface ZoomFocus {
  cx: number;
  cy: number;
}

export interface ZoomRegion {
  id: string;
  startMs: number;
  endMs: number;
  depth: ZoomDepth;
  focus: ZoomFocus;
}

export type AnnotationType = "text" | "arrow";

export interface AnnotationPosition {
  /** Normalized 0–1 against the composed frame, so it survives resizing. */
  x: number;
  y: number;
}

export interface AnnotationSize {
  width: number;
  height: number;
}

export interface AnnotationTextStyle {
  color: string;
  backgroundColor: string;
  fontSize: number;
  fontWeight: "normal" | "bold";
  textAlign: "left" | "center" | "right";
}

export interface AnnotationRegion {
  id: string;
  startMs: number;
  endMs: number;
  type: AnnotationType;
  textContent: string;
  position: AnnotationPosition;
  size: AnnotationSize;
  style: AnnotationTextStyle;
  /** Arrow direction in degrees, clockwise from pointing right. */
  rotation: number;
}

export const DEFAULT_ANNOTATION_STYLE: AnnotationTextStyle = {
  color: "#ffffff",
  backgroundColor: "transparent",
  fontSize: 32,
  fontWeight: "bold",
  textAlign: "center",
};

/**
 * Backdrop drawn behind the recording.
 *
 * Recordly exposes far more here (gradients, images, shadow profiles); the subset
 * kept is what the canvas compositor below implements, so nothing in the UI can
 * promise an effect the renderer ignores.
 */
export interface BackgroundStyle {
  /** CSS colour, or `null` for a transparent backdrop. */
  color: string | null;
  gradient: string | null;
  /** Padding around the video as a fraction of frame width (0–0.25). */
  padding: number;
  /** Corner radius as a fraction of frame width (0–0.5). */
  radius: number;
  shadow: boolean;
}

export const DEFAULT_BACKGROUND: BackgroundStyle = {
  color: "#12141a",
  gradient: null,
  padding: 0.04,
  radius: 0.02,
  shadow: true,
};

export const BACKGROUND_PRESETS: Array<{ id: string; label: string; style: BackgroundStyle }> = [
  {
    id: "dark",
    label: "深色",
    style: { color: "#12141a", gradient: null, padding: 0.04, radius: 0.02, shadow: true },
  },
  {
    id: "light",
    label: "浅色",
    style: { color: "#f4f5f7", gradient: null, padding: 0.04, radius: 0.02, shadow: true },
  },
  {
    id: "none",
    label: "无边框",
    style: { color: null, gradient: null, padding: 0, radius: 0, shadow: false },
  },
  {
    id: "sunset",
    label: "渐变 · 日落",
    style: {
      color: null,
      gradient: "linear-gradient(135deg, #ff8a4c 0%, #7c3aed 100%)",
      padding: 0.06,
      radius: 0.03,
      shadow: true,
    },
  },
  {
    id: "ocean",
    label: "渐变 · 海洋",
    style: {
      color: null,
      gradient: "linear-gradient(135deg, #0ea5e9 0%, #0f172a 100%)",
      padding: 0.06,
      radius: 0.03,
      shadow: true,
    },
  },
];
