/**
 * Time and frame conversions for the timeline.
 *
 * Every clip boundary in the editor is a millisecond on a timeline, but playback,
 * seeking and export all work in frames. Converting between them in one place means
 * the playhead and the exported frame grid cannot disagree about which frame a given
 * moment belongs to.
 */

/** A timeline position in milliseconds. */
export type Ms = number;

/**
 * Which frame `ms` falls in, at `fps`.
 *
 * Floor, not round: a moment partway into frame 3 is *in* frame 3, and rounding
 * would jump the playhead ahead to a frame the user has not reached yet.
 */
export function frameFromMs(ms: Ms, fps: number): number {
  if (!Number.isFinite(ms) || fps <= 0) return 0;
  return Math.floor((ms / 1000) * fps);
}

/** Start of frame `frame`, in milliseconds. */
export function msFromFrame(frame: number, fps: number): Ms {
  if (!Number.isFinite(frame) || fps <= 0) return 0;
  return (frame / fps) * 1000;
}

/**
 * Snap `ms` to the start of its frame.
 *
 * Used whenever a pointer position becomes a stored boundary, so a boundary always
 * lands on a frame the exporter can actually emit.
 */
export function snapToFrame(ms: Ms, fps: number): Ms {
  return msFromFrame(frameFromMs(ms, fps), fps);
}

/** Total frames spanned by `[0, durationMs)`. */
export function frameCount(durationMs: Ms, fps: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || fps <= 0) return 0;
  // Ceil: a duration that ends mid-frame still needs that final frame emitted.
  return Math.ceil((durationMs / 1000) * fps);
}

/** `mm:ss` for short recordings, `h:mm:ss` once past an hour. */
export function formatTimecode(ms: Ms): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** `mm:ss.mmm`, for readouts that need to show sub-second precision. */
export function formatTimecodeMs(ms: Ms): string {
  const clamped = Math.max(0, ms);
  // Split before formatting: `formatTimecode` floors to whole seconds, so passing it
  // the fractional value would discard the milliseconds this variant exists to show.
  const wholeSecondsMs = Math.floor(clamped / 1000) * 1000;
  const millis = Math.round(clamped - wholeSecondsMs);
  return `${formatTimecode(wholeSecondsMs)}.${String(millis).padStart(3, "0")}`;
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}
