/**
 * Span arithmetic shared by zoom and annotation regions.
 *
 * Both are time-ranged overlays over the recording: they have no source in-point and
 * no speed, so their only invariant is that they stay inside the recording and never
 * invert. Kept separate from `clips.ts`, where a span *does* carry a source mapping.
 */

export interface Span {
  startMs: number;
  endMs: number;
}

/** Shortest span the UI allows a region to become, so it cannot be dragged away. */
export const MIN_SPAN_MS = 200;

/**
 * Fit `[startMs, endMs]` inside `[0, durationMs]` without inverting it.
 *
 * Returns `null` when the recording is shorter than [`MIN_SPAN_MS`], where no valid
 * span exists and callers should refuse to create the region at all.
 */
export function fitSpan(
  startMs: number,
  endMs: number,
  durationMs: number,
): Span | null {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || durationMs < MIN_SPAN_MS) {
    return null;
  }
  let start = Math.max(0, Math.min(startMs, endMs));
  let end = Math.min(durationMs, Math.max(startMs, endMs));
  if (end - start < MIN_SPAN_MS) {
    // Grow to the minimum, spilling away from whichever edge has room.
    if (start + MIN_SPAN_MS <= durationMs) end = start + MIN_SPAN_MS;
    else {
      end = durationMs;
      start = Math.max(0, end - MIN_SPAN_MS);
    }
  }
  return { startMs: Math.round(start), endMs: Math.round(end) };
}

/** Move a span by `deltaMs`, keeping its length and staying inside the recording. */
export function moveSpan(span: Span, deltaMs: number, durationMs: number): Span {
  const length = span.endMs - span.startMs;
  const maxStart = Math.max(0, durationMs - length);
  const start = Math.max(0, Math.min(span.startMs + deltaMs, maxStart));
  return { startMs: Math.round(start), endMs: Math.round(start + length) };
}

/** Drag one edge of a span, refusing to invert or leave the recording. */
export function resizeSpan(
  span: Span,
  edge: "start" | "end",
  ms: number,
  durationMs: number,
): Span {
  if (edge === "start") {
    const start = Math.max(0, Math.min(ms, span.endMs - MIN_SPAN_MS));
    return { startMs: Math.round(start), endMs: span.endMs };
  }
  const end = Math.min(durationMs, Math.max(ms, span.startMs + MIN_SPAN_MS));
  return { startMs: span.startMs, endMs: Math.round(end) };
}

export function spanContains(span: Span, ms: number): boolean {
  return ms >= span.startMs && ms < span.endMs;
}

/** True when two spans share any time at all. */
export function spansOverlap(a: Span, b: Span): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

/**
 * Total time covered by `spans`, counting overlaps only once.
 *
 * Used for the "how much of this recording is zoomed" readout, where double-counting
 * overlapping suggestions would overstate the answer.
 */
export function coveredMs(spans: Span[]): number {
  if (spans.length === 0) return 0;
  const sorted = [...spans].sort((a, b) => a.startMs - b.startMs);
  let total = 0;
  let cursorStart = sorted[0].startMs;
  let cursorEnd = sorted[0].endMs;
  for (const span of sorted.slice(1)) {
    if (span.startMs > cursorEnd) {
      total += cursorEnd - cursorStart;
      cursorStart = span.startMs;
      cursorEnd = span.endMs;
    } else {
      cursorEnd = Math.max(cursorEnd, span.endMs);
    }
  }
  return total + (cursorEnd - cursorStart);
}
