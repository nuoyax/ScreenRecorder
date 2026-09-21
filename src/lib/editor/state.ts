/**
 * Editor project state and the operations that change it.
 *
 * The whole editing session is one plain value plus a history stack, and every edit
 * goes through `applyEdit`. Keeping the mutations in one place is what makes undo
 * trustworthy: an edit either produces a new state value or nothing changed.
 */

import {
  type AnnotationRegion,
  type BackgroundStyle,
  type ClipRegion,
  type ZoomRegion,
  DEFAULT_BACKGROUND,
} from "@/lib/timeline/types";
import {
  applyClipSplit,
  changeClipSpan,
  planClipSplit,
  safeSpeed,
  timelineDurationMs,
  timelineToSourceMs,
} from "@/lib/timeline/clips";
import { type Span, fitSpan, moveSpan, resizeSpan } from "@/lib/timeline/span";

/**
 * Which part of the source frame is shown at all, as fractions of it.
 *
 * Kept separate from `BackgroundStyle.padding`, which insets the *composed* frame for
 * the backdrop: this one picks a rectangle out of the recording, and everything else —
 * zoom focus, annotations, exports — works inside whatever it leaves.
 */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const FULL_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };

export interface Project {
  /** Bumped when the stored shape changes; `projects.ts` migrates on load. */
  version: number;
  /** Absolute path of the recording this project edits. */
  sourcePath: string;
  sourceDurationMs: number;
  sourceWidth: number;
  sourceHeight: number;
  fps: number;
  clips: ClipRegion[];
  zooms: ZoomRegion[];
  annotations: AnnotationRegion[];
  background: BackgroundStyle;
  crop: CropRect;
}

export const PROJECT_VERSION = 1;

export function emptyProject(init: {
  sourcePath: string;
  durationMs: number;
  width: number;
  height: number;
  fps: number;
}): Project {
  return {
    version: PROJECT_VERSION,
    sourcePath: init.sourcePath,
    sourceDurationMs: Math.max(0, Math.round(init.durationMs)),
    sourceWidth: init.width,
    sourceHeight: init.height,
    fps: init.fps,
    clips: [{ id: "clip-1", startMs: 0, endMs: Math.max(0, Math.round(init.durationMs)), speed: 1 }],
    zooms: [],
    annotations: [],
    background: DEFAULT_BACKGROUND,
    crop: { ...FULL_CROP },
  };
}

/** Timeline length, which is *not* the source length once clips are moved or cut. */
export function durationMs(project: Project): number {
  return timelineDurationMs(project.clips, project.sourceDurationMs);
}

export interface EditorState {
  project: Project;
  /** Undo stack, oldest first. The current project is not in here. */
  past: Project[];
  /** Redo stack, most recently undone last. */
  future: Project[];
  /** Playhead position on the timeline. */
  playheadMs: number;
}

/** Bounded so a long editing session cannot grow memory without limit. */
export const MAX_HISTORY = 100;

export function initialState(project: Project): EditorState {
  return { project, past: [], future: [], playheadMs: 0 };
}

/**
 * Apply an edit and push the previous value onto the undo stack.
 *
 * Returns the state unchanged when `edit` produces the same value, so a no-op drag
 * does not consume an undo step — otherwise the user would have to press undo
 * several times to get past a gesture that did nothing.
 */
export function applyEdit(
  state: EditorState,
  edit: (project: Project) => Project,
): EditorState {
  const next = edit(state.project);
  if (next === state.project) return state;
  const past = [...state.past, state.project];
  if (past.length > MAX_HISTORY) past.shift();
  return { ...state, project: next, past, future: [] };
}

export function undo(state: EditorState): EditorState {
  const previous = state.past[state.past.length - 1];
  if (previous === undefined) return state;
  return {
    ...state,
    project: previous,
    past: state.past.slice(0, -1),
    future: [...state.future, state.project],
  };
}

export function redo(state: EditorState): EditorState {
  const next = state.future[state.future.length - 1];
  if (next === undefined) return state;
  return {
    ...state,
    project: next,
    past: [...state.past, state.project],
    future: state.future.slice(0, -1),
  };
}

export function canUndo(state: EditorState): boolean {
  return state.past.length > 0;
}

export function canRedo(state: EditorState): boolean {
  return state.future.length > 0;
}

let idCounter = 0;

/**
 * Unique-enough id for a new region.
 *
 * Deliberately not random: ids appear in saved project files, and a counter mixed
 * with the clock keeps them stable and diffable while still being unique within a
 * session. The `p-` prefix marks ids minted here rather than loaded from a file.
 */
export function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

/** Test-only: reset the counter so ids are predictable across test cases. */
export function resetIdCounter() {
  idCounter = 0;
}

export const ops = {
  /** Split the clip under `ms`. A no-op when `ms` is not inside a clip. */
  splitAt: (ms: number) => (project: Project): Project => {
    const plan = planClipSplit({ clips: project.clips, splitMs: ms, createId: () => nextId("clip") });
    if (!plan) return project;
    return { ...project, clips: applyClipSplit(project.clips, plan) };
  },

  deleteClip: (id: string) => (project: Project): Project => {
    // Refuse to leave zero clips: an empty timeline has no duration and every
    // downstream calculation (playhead, export range) would have to special-case it.
    if (project.clips.length <= 1) return project;
    const clips = project.clips.filter((c) => c.id !== id);
    return clips.length === project.clips.length ? project : { ...project, clips };
  },

  moveClip: (id: string, startMs: number, endMs: number) => (project: Project): Project => {
    const clips = project.clips.map((clip) => {
      if (clip.id !== id) return clip;
      const next = changeClipSpan(clip, startMs, endMs, project.sourceDurationMs);
      // `changeClipSpan` returns a fresh object even for an unchanged span; compare
      // the fields so a click without a drag does not register as an edit.
      return next.startMs === clip.startMs &&
        next.endMs === clip.endMs &&
        next.sourceStartMs === clip.sourceStartMs
        ? clip
        : next;
    });
    return clips.some((c, i) => c !== project.clips[i]) ? { ...project, clips } : project;
  },

  setClipSpeed: (id: string, speed: number) => (project: Project): Project => {
    if (!Number.isFinite(speed) || speed <= 0) return project;
    const clips = project.clips.map((clip) => (clip.id === id ? { ...clip, speed } : clip));
    return { ...project, clips };
  },

  /** Cut everything outside `[startMs, endMs]` by narrowing the one clip covering it. */
  trimTo: (startMs: number, endMs: number) => (project: Project): Project => {
    if (endMs - startMs < 1) return project;
    const clips = [
      {
        ...project.clips[0],
        startMs: 0,
        endMs: Math.round(endMs - startMs),
        sourceStartMs: Math.round(startMs),
        speed: 1,
      },
    ];
    return { ...project, clips };
  },

  addZoom: (span: Span, depth: ZoomRegion["depth"], focus: ZoomRegion["focus"]) => (
    project: Project,
  ): Project => {
    const fitted = fitSpan(span.startMs, span.endMs, durationMs(project));
    if (!fitted) return project;
    const zoom: ZoomRegion = { id: nextId("zoom"), ...fitted, depth, focus };
    return { ...project, zooms: [...project.zooms, zoom] };
  },

  moveZoom: (id: string, deltaMs: number) => (project: Project): Project => {
    const zooms = project.zooms.map((zoom) =>
      zoom.id === id ? { ...zoom, ...moveSpan(zoom, deltaMs, durationMs(project)) } : zoom,
    );
    return { ...project, zooms };
  },

  resizeZoom: (id: string, edge: "start" | "end", ms: number) => (
    project: Project,
  ): Project => {
    const zooms = project.zooms.map((zoom) =>
      zoom.id === id ? { ...zoom, ...resizeSpan(zoom, edge, ms, durationMs(project)) } : zoom,
    );
    return { ...project, zooms };
  },

  removeZoom: (id: string) => (project: Project): Project => {
    const zooms = project.zooms.filter((z) => z.id !== id);
    return zooms.length === project.zooms.length ? project : { ...project, zooms };
  },

  addAnnotation: (annotation: Omit<AnnotationRegion, "id">) => (project: Project): Project => {
    const fitted = fitSpan(annotation.startMs, annotation.endMs, durationMs(project));
    if (!fitted) return project;
    return {
      ...project,
      annotations: [...project.annotations, { ...annotation, ...fitted, id: nextId("ann") }],
    };
  },

  updateAnnotation: (id: string, patch: Partial<AnnotationRegion>) => (
    project: Project,
  ): Project => {
    const annotations = project.annotations.map((a) => (a.id === id ? { ...a, ...patch } : a));
    return { ...project, annotations };
  },

  removeAnnotation: (id: string) => (project: Project): Project => {
    const annotations = project.annotations.filter((a) => a.id !== id);
    return annotations.length === project.annotations.length
      ? project
      : { ...project, annotations };
  },

  setBackground: (patch: Partial<BackgroundStyle>) => (project: Project): Project => ({
    ...project,
    background: { ...project.background, ...patch },
  }),

  setCrop: (patch: Partial<CropRect>) => (project: Project): Project => ({
    ...project,
    crop: { ...project.crop, ...patch },
  }),
};

/**
 * Whether a frame at `ms` should be shown zoomed, and by how much.
 *
 * Returns the deepest zoom covering `ms`; overlapping regions are ambiguous, and
 * taking the last one added matches what the user most recently asked for.
 */
export function zoomAt(project: Project, ms: number): ZoomRegion | null {
  let found: ZoomRegion | null = null;
  for (const zoom of project.zooms) {
    if (ms >= zoom.startMs && ms < zoom.endMs) found = zoom;
  }
  return found;
}

/** Annotations visible at `ms`, in draw order (later entries on top). */
export function annotationsAt(project: Project, ms: number): AnnotationRegion[] {
  return project.annotations.filter((a) => ms >= a.startMs && ms < a.endMs);
}

/**
 * Where a clip's playback currently reads from, for seeking the `<video>`.
 *
 * Clamped to the source so a caller cannot seek past the end of the file when the
 * playhead sits in a timeline gap.
 */
export function sourceTimeForPlayhead(project: Project, ms: number): number {
  return Math.max(0, Math.min(project.sourceDurationMs, timelineToSourceMs(ms, project.clips)));
}

/** Playback rate at `ms`, taken from the clip covering it. */
export function playbackRateAt(project: Project, ms: number): number {
  const clip = project.clips.find((c) => ms >= c.startMs && ms < c.endMs);
  return clip ? safeSpeed(clip) : 1;
}
