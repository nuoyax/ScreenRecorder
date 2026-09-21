/**
 * Reading and writing `.srec.json` project files.
 *
 * A project is a *reference* to a recording plus the edits applied to it, not a copy
 * of the media: the file stays small and re-editing never re-encodes. Everything
 * loaded from disk is treated as untrusted — a project file is text a user can hand
 * to a colleague, and a stale or hand-edited one must not crash the editor, so
 * `sanitize` rebuilds a valid project field by field and drops what it cannot read.
 */

import {
  type AnnotationRegion,
  type BackgroundStyle,
  type ClipRegion,
  type ZoomRegion,
  DEFAULT_ANNOTATION_STYLE,
  DEFAULT_BACKGROUND,
} from "@/lib/timeline/types";
import { FULL_CROP, PROJECT_VERSION, type CropRect, type Project } from "./state";

const KNOWN_VERSIONS = new Set([1]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Keeps `value` inside `[min, max]`, falling back when it is not a number at all. */
function clamped(value: unknown, min: number, max: number, fallback: number): number {
  const n = num(value, NaN);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizeClips(raw: unknown, sourceDurationMs: number): ClipRegion[] {
  const list = Array.isArray(raw) ? raw : [];
  const clips: ClipRegion[] = [];
  for (const entry of list) {
    if (!isObject(entry)) continue;
    const startMs = Math.max(0, Math.round(num(entry.startMs, 0)));
    const endMs = Math.round(num(entry.endMs, 0));
    if (endMs <= startMs) continue;
    const speed = clamped(entry.speed, 0.1, 10, 1);
    const clip: ClipRegion = {
      id: str(entry.id, `clip-${clips.length + 1}`),
      startMs,
      endMs,
      speed,
    };
    // Only keep a source in-point that is a real number in range; an absent or bogus
    // one must stay absent so `getClipSourceStartMs` falls back to `startMs`.
    const sourceStart = num(entry.sourceStartMs, NaN);
    if (!Number.isNaN(sourceStart) && sourceStart >= 0 && sourceStart <= sourceDurationMs) {
      clip.sourceStartMs = Math.round(sourceStart);
    }
    if (bool(entry.muted, false)) clip.muted = true;
    clips.push(clip);
  }
  if (clips.length === 0) {
    clips.push({ id: "clip-1", startMs: 0, endMs: sourceDurationMs, speed: 1 });
  }
  return clips;
}

function sanitizeZooms(raw: unknown, durationMs: number): ZoomRegion[] {
  const list = Array.isArray(raw) ? raw : [];
  const zooms: ZoomRegion[] = [];
  for (const entry of list) {
    if (!isObject(entry)) continue;
    const startMs = Math.max(0, Math.round(num(entry.startMs, 0)));
    const endMs = Math.min(durationMs, Math.round(num(entry.endMs, 0)));
    if (endMs <= startMs) continue;
    const depth = Math.round(clamped(entry.depth, 1, 6, 3));
    const focus = isObject(entry.focus) ? entry.focus : {};
    zooms.push({
      id: str(entry.id, `zoom-${zooms.length + 1}`),
      startMs,
      endMs,
      depth: depth as ZoomRegion["depth"],
      focus: {
        cx: clamped(focus.cx, 0, 1, 0.5),
        cy: clamped(focus.cy, 0, 1, 0.5),
      },
    });
  }
  return zooms;
}

function sanitizeAnnotations(raw: unknown, durationMs: number): AnnotationRegion[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: AnnotationRegion[] = [];
  for (const entry of list) {
    if (!isObject(entry)) continue;
    const startMs = Math.max(0, Math.round(num(entry.startMs, 0)));
    const endMs = Math.min(durationMs, Math.round(num(entry.endMs, 0)));
    if (endMs <= startMs) continue;
    const position = isObject(entry.position) ? entry.position : {};
    const size = isObject(entry.size) ? entry.size : {};
    const style = isObject(entry.style) ? entry.style : {};
    const type = entry.type === "arrow" ? "arrow" : "text";
    out.push({
      id: str(entry.id, `ann-${out.length + 1}`),
      startMs,
      endMs,
      type,
      textContent: str(entry.textContent, ""),
      position: {
        x: clamped(position.x, 0, 1, 0.5),
        y: clamped(position.y, 0, 1, 0.5),
      },
      size: {
        width: clamped(size.width, 0.02, 1, 0.3),
        height: clamped(size.height, 0.02, 1, 0.12),
      },
      style: {
        color: str(style.color, DEFAULT_ANNOTATION_STYLE.color),
        backgroundColor: str(style.backgroundColor, DEFAULT_ANNOTATION_STYLE.backgroundColor),
        fontSize: clamped(style.fontSize, 8, 200, DEFAULT_ANNOTATION_STYLE.fontSize),
        fontWeight: style.fontWeight === "normal" ? "normal" : "bold",
        textAlign:
          style.textAlign === "left" || style.textAlign === "right"
            ? style.textAlign
            : "center",
      },
      rotation: num(entry.rotation, 0),
    });
  }
  return out;
}

function sanitizeBackground(raw: unknown): BackgroundStyle {
  if (!isObject(raw)) return DEFAULT_BACKGROUND;
  const color = typeof raw.color === "string" ? raw.color : null;
  const gradient = typeof raw.gradient === "string" ? raw.gradient : null;
  return {
    color,
    gradient,
    padding: clamped(raw.padding, 0, 0.25, DEFAULT_BACKGROUND.padding),
    radius: clamped(raw.radius, 0, 0.5, DEFAULT_BACKGROUND.radius),
    shadow: bool(raw.shadow, DEFAULT_BACKGROUND.shadow),
  };
}

/**
 * Spatial crop of the source frame.
 *
 * Clamped so the kept rectangle can never collapse to nothing or leave the frame: a
 * zero-width crop would divide by zero in the compositor's cursor mapping, and a crop
 * hanging off the edge would ask `drawImage` for pixels that are not there.
 */
function sanitizeCrop(raw: unknown): CropRect {
  if (!isObject(raw)) return { ...FULL_CROP };
  const width = clamped(raw.width, 0.05, 1, 1);
  const height = clamped(raw.height, 0.05, 1, 1);
  return {
    width,
    height,
    x: clamped(raw.x, 0, 1 - width, 0),
    y: clamped(raw.y, 0, 1 - height, 0),
  };
}

/**
 * Coerce parsed JSON into a usable project, or `null` when it cannot be one.
 *
 * Returns `null` rather than throwing: the caller shows "this file is not a project"
 * and stays where it is, which is more useful than an exception in a file dialog.
 */
export function sanitize(raw: unknown): Project | null {
  if (!isObject(raw)) return null;
  const version = num(raw.version, 0);
  if (!KNOWN_VERSIONS.has(version)) return null;

  const sourcePath = raw.sourcePath;
  if (typeof sourcePath !== "string" || sourcePath.length === 0) return null;

  const sourceDurationMs = Math.max(0, Math.round(num(raw.sourceDurationMs, 0)));
  if (sourceDurationMs === 0) return null;

  const project: Project = {
    version: PROJECT_VERSION,
    sourcePath,
    sourceDurationMs,
    sourceWidth: Math.max(0, Math.round(num(raw.sourceWidth, 1920))),
    sourceHeight: Math.max(0, Math.round(num(raw.sourceHeight, 1080))),
    fps: Math.round(clamped(raw.fps, 1, 240, 30)),
    clips: sanitizeClips(raw.clips, sourceDurationMs),
    zooms: [],
    annotations: [],
    background: sanitizeBackground(raw.background),
    crop: sanitizeCrop(raw.crop),
  };

  // Clamped against the *timeline* duration, which is what the regions are drawn on.
  const timelineMs = project.clips.reduce((max, c) => Math.max(max, Math.round(c.endMs)), 0);
  project.zooms = sanitizeZooms(raw.zooms, timelineMs);
  project.annotations = sanitizeAnnotations(raw.annotations, timelineMs);
  return project;
}

export function serialize(project: Project): string {
  return JSON.stringify(project, null, 2);
}

/** Project file path for a recording: `recording_1234.mp4` → `recording_1234.srec.json`. */
export function projectPathFor(mediaPath: string): string {
  const withoutExt = mediaPath.replace(/\.[^./\\]+$/, "");
  return `${withoutExt}.srec.json`;
}
