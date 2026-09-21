import { useCallback, useMemo } from "react";

/**
 * The `<video>` a preview or export is reading from, addressed by source path.
 *
 * Frames are taken by seeking this element and drawing it, so scrubbing and export
 * share one decoder and one notion of "the frame at this time". Kept as a small hook
 * rather than a component so the transport controls and the export path can both
 * drive it.
 */

export interface PlaybackHandle {
  /** Seek to a source time (ms) and resolve once the frame is painted. */
  seek: (sourceMs: number, video: HTMLVideoElement | null) => Promise<void>;
}

/**
 * Seek a `<video>` and wait for the frame to actually be available.
 *
 * Resolving on the `seeked` event rather than immediately is the whole point: drawing
 * before it fires captures the *previous* frame, which shows up as a preview that
 * lags one edit behind and an export where every frame is off by one.
 */
export function seekTo(video: HTMLVideoElement | null, sourceMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (!video) {
      resolve();
      return;
    }
    const target = Math.max(0, sourceMs / 1000);
    // Already there (and painted): nothing to wait for.
    if (Math.abs(video.currentTime - target) < 0.0005 && video.readyState >= 2) {
      resolve();
      return;
    }

    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener("seeked", done);
      resolve();
    };
    video.addEventListener("seeked", done);
    video.currentTime = target;
    // A seek to the current position may never fire `seeked`; do not hang on it.
    window.setTimeout(done, 1200);
  });
}

export function usePlayback(): PlaybackHandle {
  const seek = useCallback(
    (sourceMs: number, video: HTMLVideoElement | null) => seekTo(video, sourceMs),
    [],
  );
  return useMemo(() => ({ seek }), [seek]);
}
