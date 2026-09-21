/**
 * Clip list operations: the timeline ↔ source mapping, splitting, and resizing.
 *
 * Ported from Recordly's `clipTimeline.ts`, `clipSplit.ts` and `clipSpanChange.ts`.
 * The maths is theirs; the types are narrowed to what this editor stores.
 */

import {
  type ClipRegion,
  type TrimRegion,
  getClipSourceEndMs,
  getClipSourceStartMs,
  sortClipRegions,
} from "./types";

export { getClipSourceStartMs, getClipSourceEndMs };

/**
 * A run of source footage that can be decoded in one forward pass.
 *
 * Timeline gaps (from clips moved apart) need no decoding, so a run breaks wherever
 * the source range stops advancing.
 */
export interface DecodeRun {
  /** Source in/out in seconds. */
  startSec: number;
  endSec: number;
  /** Where this run lands on the timeline, in seconds. */
  outputStartSec: number;
  outputEndSec: number;
  speed: number;
}

export function buildDecodeRuns(clips: ClipRegion[]): DecodeRun[][] {
  const runs: DecodeRun[][] = [];
  for (const clip of sortClipRegions(clips)) {
    const run: DecodeRun = {
      startSec: getClipSourceStartMs(clip) / 1000,
      endSec: getClipSourceEndMs(clip) / 1000,
      outputStartSec: clip.startMs / 1000,
      outputEndSec: clip.endMs / 1000,
      speed: clip.speed,
    };
    const last = runs[runs.length - 1];
    // Contiguous in the *source*: the next clip picks up exactly where this one ends.
    if (last && run.startSec >= last[last.length - 1].endSec) last.push(run);
    else runs.push([run]);
  }
  return runs;
}

/** Frames a run contributes at `fps`. */
export function decodeRunFrameCount(run: DecodeRun, fps: number): number {
  return Math.ceil(run.outputEndSec * fps) - Math.ceil(run.outputStartSec * fps);
}

/**
 * Source time for frame `index` within a run.
 *
 * `index` counts frames since the run's *aligned* start, not since its exact output
 * start: the first frame of a run is emitted at the frame boundary at or before its
 * output start, so the offset has to be measured from that same boundary or the run
 * drifts by up to one frame per clip.
 */
export function decodeRunSourceTime(run: DecodeRun, index: number, fps: number): number {
  const outputOffset =
    (Math.ceil(run.outputStartSec * fps) + index) / fps - run.outputStartSec;
  return run.startSec + outputOffset * run.speed;
}

/** Timeline duration, taken from the furthest clip end. */
export function timelineDurationMs(clips: ClipRegion[], sourceDurationMs: number): number {
  if (clips.length === 0) return Math.max(0, Math.round(sourceDurationMs));
  return clips.reduce((max, clip) => Math.max(max, Math.max(0, Math.round(clip.endMs))), 0);
}

export interface ClipSplitPlan {
  targetId: string;
  left: ClipRegion;
  right: ClipRegion;
}

/**
 * Split the clip under the playhead into two clips at `splitMs`.
 *
 * `splitMs` is a timeline position, so the halves stay put on the timeline and only
 * their source in-points differ. At non-1x speed the split consumes more (or less)
 * source than timeline, so the right half reads from `getClipSourceEndMs(left)` —
 * otherwise it re-reads footage the left half already covers and the tail of the
 * recording falls outside every clip.
 */
export function planClipSplit(params: {
  clips: ClipRegion[];
  splitMs: number;
  createId: () => string;
}): ClipSplitPlan | null {
  const { clips, splitMs, createId } = params;
  if (!Number.isFinite(splitMs)) return null;

  const at = Math.round(splitMs);
  const target = clips.find((clip) => at > clip.startMs && at < clip.endMs);
  if (!target) return null;

  const left: ClipRegion = { ...target, id: createId(), endMs: at };
  const right: ClipRegion = {
    ...target,
    id: createId(),
    startMs: at,
    endMs: target.endMs,
    sourceStartMs: getClipSourceEndMs(left),
  };
  return { targetId: target.id, left, right };
}

/**
 * Apply a split produced by [`planClipSplit`], preserving clip order.
 *
 * Replaces the target in place rather than appending, so a split never reorders the
 * timeline.
 */
export function applyClipSplit(clips: ClipRegion[], plan: ClipSplitPlan): ClipRegion[] {
  const out: ClipRegion[] = [];
  for (const clip of clips) {
    if (clip.id === plan.targetId) out.push(plan.left, plan.right);
    else out.push(clip);
  }
  return out;
}

/**
 * Move or resize a clip to `[startMs, endMs]`.
 *
 * A pure move (both edges shifted by the same amount) keeps its source in-point;
 * without that check, dragging a clip would silently re-read different footage.
 * A resize reveals or hides footage, and cannot manufacture source before 0 or
 * after EOF, so both edges are bounded by what the source actually holds.
 */
export function changeClipSpan(
  clip: ClipRegion,
  startMs: number,
  endMs: number,
  sourceDurationMs: number,
): ClipRegion {
  const sourceStart = getClipSourceStartMs(clip);
  const speed = safeSpeed(clip);
  const isMove = startMs - clip.startMs === endMs - clip.endMs;
  // A move leaves the source in-point alone. Writing it back explicitly would turn
  // "unset, and therefore equal to startMs" into a stored number, which reads as a
  // change to anything comparing the clip before and after.
  if (isMove) {
    return clip.sourceStartMs === undefined
      ? { ...clip, startMs, endMs }
      : { ...clip, startMs, endMs, sourceStartMs: sourceStart };
  }

  const start = Math.max(startMs, Math.ceil(clip.startMs - sourceStart / speed));
  const sourceStartMs = Math.round(sourceStart + (start - clip.startMs) * speed);
  const end = Math.min(
    endMs,
    Math.floor(start + (sourceDurationMs - sourceStartMs) / speed),
  );
  return { ...clip, startMs: start, endMs: end, sourceStartMs };
}

export function safeSpeed(clip: ClipRegion): number {
  return Number.isFinite(clip.speed) && clip.speed > 0 ? clip.speed : 1;
}

/**
 * Where a clip's timeline position reads from in the recording.
 *
 * Outside every clip this snaps to the nearest clip edge, so scrubbing into a gap
 * still previews *something* related rather than the wrong end of the recording.
 */
export function timelineToSourceMs(ms: number, clips: ClipRegion[]): number {
  const rounded = Math.round(ms);
  const sorted = sortClipRegions(clips);
  for (const clip of sorted) {
    if (rounded < clip.startMs || rounded >= clip.endMs) continue;
    return Math.round(getClipSourceStartMs(clip) + (rounded - clip.startMs) * safeSpeed(clip));
  }
  if (sorted.length === 0) return rounded;
  return nearestBoundary(rounded, sorted, "timeline");
}

/** Inverse of [`timelineToSourceMs`]. */
export function sourceToTimelineMs(ms: number, clips: ClipRegion[]): number {
  const rounded = Math.round(ms);
  const sorted = sortClipRegions(clips);
  for (const clip of sorted) {
    const from = getClipSourceStartMs(clip);
    const to = getClipSourceEndMs(clip);
    if (rounded < from || rounded >= to) continue;
    return Math.round(clip.startMs + (rounded - from) / safeSpeed(clip));
  }
  if (sorted.length === 0) return rounded;
  return nearestBoundary(rounded, sorted, "source");
}

function nearestBoundary(
  ms: number,
  clips: ClipRegion[],
  from: "timeline" | "source",
): number {
  let best = Math.round(ms);
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const clip of clips) {
    const edges: Array<[number, number]> = [
      [clip.startMs, getClipSourceStartMs(clip)],
      [clip.endMs, getClipSourceEndMs(clip)],
    ];
    for (const [timelineMs, sourceMs] of edges) {
      const candidate = from === "timeline" ? timelineMs : sourceMs;
      const distance = Math.abs(ms - candidate);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = Math.round(from === "timeline" ? sourceMs : timelineMs);
      }
    }
  }
  return best;
}

/**
 * Clip regions (kept segments) → trim regions (gaps to remove).
 *
 * Clips are ordered on the timeline, but a moved clip keeps its source in-point, so
 * timeline order says nothing about source order. Walk the source ranges the clips
 * claim and trim whatever is left uncovered.
 */
export function clipsToTrims(clips: ClipRegion[], totalDurationMs: number): TrimRegion[] {
  if (clips.length === 0) return [];
  const covered = clips
    .map((clip) => ({
      startMs: getClipSourceStartMs(clip),
      endMs: getClipSourceEndMs(clip),
    }))
    .filter((span) => span.endMs > span.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  const trims: TrimRegion[] = [];
  let cursor = 0;
  let id = 1;
  for (const span of covered) {
    if (span.startMs > cursor) {
      trims.push({ id: `trim-gap-${id++}`, startMs: cursor, endMs: span.startMs });
    }
    cursor = Math.max(cursor, span.endMs);
  }
  if (cursor < totalDurationMs) {
    trims.push({ id: `trim-gap-${id++}`, startMs: cursor, endMs: totalDurationMs });
  }
  return trims;
}
