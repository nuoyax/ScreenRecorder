/**
 * Suggest zoom regions from where the cursor actually went.
 *
 * Ported in spirit from Recordly's cursor-activity suggestions, simplified to the part
 * that is defensible without a UI to tune it: a stretch where the pointer moved a long
 * way in a short time is the stretch worth zooming into, and a stretch where it barely
 * moved is worth zooming into too — that is a moment where the viewer is staring at one
 * spot. Everything between is left alone, because suggesting a zoom for every second of
 * a recording is the same as suggesting none.
 *
 * The output is *suggestions*, never edits: the caller shows them and the user accepts.
 */

import type { MoveSample } from "@/lib/api";
import type { ZoomDepth, ZoomFocus } from "@/lib/timeline/types";
import { MIN_SPAN_MS } from "@/lib/timeline/span";

/** Window the activity is measured over. */
export const WINDOW_MS = 1000;

/** Distance in pixels that counts as "the pointer went somewhere" in one window. */
export const TRAVEL_THRESHOLD_PX = 220;

/** Distance below which the pointer counts as parked. */
export const STILL_THRESHOLD_PX = 12;

/** Gap that ends a run; a pause in the recording should not bridge two moments. */
export const GAP_MS = 400;

/** Suggested regions are padded by this much so the zoom does not start mid-gesture. */
export const PAD_MS = 300;

/**
 * Longest a single suggestion may be.
 *
 * Without a cap, a recording where nothing happened for two minutes collapses into one
 * two-minute zoom — technically a correct answer and useless as a suggestion. Capping
 * splits it into a few regions the user can accept or ignore individually.
 */
export const MAX_SPAN_MS = 6000;

export interface ZoomSuggestion {
  startMs: number;
  endMs: number;
  depth: ZoomDepth;
  focus: ZoomFocus;
  /** Why this was suggested, for the UI to show. */
  reason: "movement" | "stillness";
  /** Total pointer travel inside the span, in pixels. */
  travelPx: number;
}

export interface SuggestOptions {
  /** Recording rectangle, to turn sample coordinates into normalized focus. */
  capture: { x: number; y: number; width: number; height: number };
  /** Timeline length; suggestions are clipped to it. */
  durationMs: number;
  windowMs?: number;
  travelThresholdPx?: number;
  stillThresholdPx?: number;
  gapMs?: number;
  padMs?: number;
}

/**
 * Walk the track with a sliding window and emit one suggestion per qualifying stretch.
 *
 * Overlapping windows are merged rather than emitted separately: a long flurry of
 * movement is one moment to zoom into, not seven.
 */
export function suggestZooms(
  moves: MoveSample[],
  options: SuggestOptions,
): ZoomSuggestion[] {
  const { capture, durationMs } = options;
  const windowMs = options.windowMs ?? WINDOW_MS;
  const travelThreshold = options.travelThresholdPx ?? TRAVEL_THRESHOLD_PX;
  const stillThreshold = options.stillThresholdPx ?? STILL_THRESHOLD_PX;
  const gapMs = options.gapMs ?? GAP_MS;
  const padMs = options.padMs ?? PAD_MS;

  if (durationMs < MIN_SPAN_MS || moves.length < 2) return [];

  const candidates: ZoomSuggestion[] = [];
  let i = 0;
  while (i < moves.length) {
    const windowStartUs = moves[i].t_us;
    const windowEndUs = windowStartUs + windowMs * 1000;

    // Advance to the last sample inside the window.
    let j = i;
    while (j + 1 < moves.length && moves[j + 1].t_us <= windowEndUs) j += 1;
    if (j === i) {
      i += 1;
      continue;
    }

    let travel = 0;
    let minX = moves[i].x;
    let maxX = moves[i].x;
    let minY = moves[i].y;
    let maxY = moves[i].y;
    for (let k = i + 1; k <= j; k += 1) {
      travel += Math.hypot(moves[k].x - moves[k - 1].x, moves[k].y - moves[k - 1].y);
      minX = Math.min(minX, moves[k].x);
      maxX = Math.max(maxX, moves[k].x);
      minY = Math.min(minY, moves[k].y);
      maxY = Math.max(maxY, moves[k].y);
    }

    const reason: ZoomSuggestion["reason"] | null =
      travel >= travelThreshold ? "movement" : travel <= stillThreshold ? "stillness" : null;

    if (reason) {
      // Focus on the middle of where the pointer was, not where it happened to be at
      // the last sample — for a still stretch those are the same, for a moving one the
      // middle is what stays in frame.
      const cx = ((minX + maxX) / 2 - capture.x) / Math.max(1, capture.width);
      const cy = ((minY + maxY) / 2 - capture.y) / Math.max(1, capture.height);
      const startMs = Math.max(0, windowStartUs / 1000 - padMs);
      const endMs = Math.min(durationMs, windowEndUs / 1000 + padMs);
      if (endMs - startMs >= MIN_SPAN_MS) {
        candidates.push({
          startMs: Math.round(startMs),
          endMs: Math.round(endMs),
          // A parking spot is worth a tighter look than a fast traversal.
          depth: reason === "stillness" ? 4 : 3,
          focus: { cx: clamp01(cx), cy: clamp01(cy) },
          reason,
          travelPx: Math.round(travel),
        });
      }
    }
    i = j;
  }

  return merge(candidates, gapMs);
}

/**
 * Merge suggestions that touch or nearly touch.
 *
 * A gap shorter than `gapMs` is not a moment the user could act on separately, so
 * offering two regions there would just be two adjacent zooms with a visible snap
 * between them.
 */
function merge(suggestions: ZoomSuggestion[], gapMs: number): ZoomSuggestion[] {
  if (suggestions.length === 0) return [];
  const sorted = [...suggestions].sort((a, b) => a.startMs - b.startMs);
  const out: ZoomSuggestion[] = [{ ...sorted[0] }];
  for (const next of sorted.slice(1)) {
    const last = out[out.length - 1];
    const wouldExceedCap = Math.max(last.endMs, next.endMs) - last.startMs > MAX_SPAN_MS;
    if (next.startMs - last.endMs > gapMs || wouldExceedCap) {
      out.push({ ...next });
      continue;
    }
    last.endMs = Math.max(last.endMs, next.endMs);
    last.travelPx += next.travelPx;
    // The merged region spans both moments, so it focuses between them.
    last.focus = {
      cx: clamp01((last.focus.cx + next.focus.cx) / 2),
      cy: clamp01((last.focus.cy + next.focus.cy) / 2),
    };
    // Keep the stronger reason: a stretch that had real movement is a movement one.
    if (next.reason === "movement") last.reason = "movement";
    last.depth = next.depth > last.depth ? next.depth : last.depth;
  }
  return out;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0.5));
}
