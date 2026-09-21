/**
 * Frame production for the exporters.
 *
 * The editor preview draws composed frames through `drawFrame`; the exporters need the
 * same pixels and nothing else. Rather than a second renderer that could drift from the
 * first, this drives the same hidden `<video>` and the same canvas, one seek at a time.
 *
 * Seeking is the whole cost of an export. A 30-second 720p30 GIF is 900 seeks, and at
 * roughly 10–20 ms each that is a visible wait — so every step reports progress and can
 * be cancelled between frames, rather than freezing the window for twenty seconds.
 */

import { drawFrame, type FrameSource } from "@/lib/editor/appearance";
import {
  annotationsAt,
  durationMs,
  sourceTimeForPlayhead,
  zoomAt,
  type Project,
} from "@/lib/editor/state";
import { seekTo } from "@/lib/editor/playback";
import type { MouseTrack } from "@/lib/api";

export interface FrameComposerOptions {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  project: Project;
  track: MouseTrack | null;
}

export interface FrameComposer {
  /** The canvas `drawAt` renders into. Exposed so the exporters can read it back. */
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  /** Timeline length being exported, in milliseconds. */
  durationMs: number;
  /** Draw the composed frame at `timelineMs`. */
  drawAt(timelineMs: number): Promise<void>;
}

/**
 * Build a composer over one recording.
 *
 * The caller owns pausing playback: seeking the element mid-playback would fight the
 * editor's own loop for the decoder, and two loops writing the same canvas produce
 * torn frames rather than an error anyone can act on.
 */
export function createFrameComposer(options: FrameComposerOptions): FrameComposer {
  const { video, canvas, project, track } = options;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法获取画布上下文");

  // The cursor track is stamped against the recording, not the timeline, so it is read
  // at the source time. See `AppearanceOptions.sourceTimeMs`.
  const captureOrigin = track?.rect ?? {
    x: 0,
    y: 0,
    width: project.sourceWidth,
    height: project.sourceHeight,
  };

  return {
    canvas,
    width: canvas.width,
    height: canvas.height,
    durationMs: durationMs(project),
    async drawAt(timelineMs: number) {
      const sourceMs = Math.min(
        project.sourceDurationMs,
        sourceTimeForPlayhead(project, timelineMs),
      );
      await seekTo(video, sourceMs);

      const source: FrameSource = {
        image: video,
        imageWidth: video.videoWidth,
        imageHeight: video.videoHeight,
      };
      drawFrame(ctx, canvas.width, canvas.height, source, {
        background: project.background,
        crop: project.crop,
        zoom: zoomAt(project, timelineMs),
        annotations: annotationsAt(project, timelineMs),
        timeMs: timelineMs,
        sourceTimeMs: sourceMs,
        moves: track?.moves ?? [],
        clicks: track?.clicks ?? [],
        captureOrigin,
        // The editor draws its own cursor whenever a track exists, so an export and the
        // preview show the same pointer. Drawing the OS cursor as well would double it.
        showCursor: track !== null,
        clickHighlight: track !== null,
      });
    },
  };
}

/**
 * Timeline positions to sample for a given rate.
 *
 * The last frame is placed one step *before* the end rather than on it: a frame at
 * exactly `durationMs` reads past the end of the timeline and would show the final
 * frame twice.
 */
export function frameTimes(totalMs: number, fps: number, maxFrames: number): number[] {
  if (totalMs <= 0 || fps <= 0) return [];
  const requested = Math.max(2, Math.round((totalMs / 1000) * fps));
  const count = Math.min(requested, Math.max(2, maxFrames));
  const step = totalMs / count;
  return Array.from({ length: count }, (_, i) => i * step);
}

/**
 * The rate with which a GIF can carry a whole export within the frame budget.
 *
 * Exporting a ten-minute recording at 30 fps would be 18,000 frames and a GIF measured
 * in gigabytes. The honest answer is to lower the rate and say so, not to truncate the
 * recording without telling anyone.
 */
export function fitFrameRate(
  totalMs: number,
  fps: number,
  maxFrames: number,
): { fps: number; frames: number; reduced: boolean } {
  const requested = Math.max(2, Math.round((totalMs / 1000) * fps));
  const frames = Math.min(requested, maxFrames);
  const effective = totalMs > 0 ? (frames * 1000) / totalMs : fps;
  return {
    // Two decimals so a 14.29 fps GIF reports as such instead of claiming 15.
    fps: Math.round(effective * 100) / 100,
    frames,
    reduced: frames < requested,
  };
}

/** Hundredths of a second per frame, as GIF stores it. Never 0 — viewers read that as
 *  "no delay" and play the animation at whatever speed they like. */
export function delayCsFor(fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) return 8;
  return Math.max(2, Math.round(100 / fps));
}
