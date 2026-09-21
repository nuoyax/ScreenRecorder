/**
 * GIF export: drive the composer, hand each frame to Rust, report honest progress.
 *
 * Rust owns the encoder (palette, dithering, LZW); this owns the loop. The split is
 * where the cost is: rendering a frame means seeking a video decoder, which only the
 * webview can do, and encoding it is pure arithmetic, which Rust does without moving a
 * hundred megabytes of RGBA through the IPC boundary.
 *
 * Nothing here truncates silently. When a recording is too long to export at the
 * requested rate, the rate drops and the caller is told — an export that quietly stops
 * halfway is worse than one that says it will be a slideshow.
 */

import { api } from "@/lib/api";
import type { FrameComposer } from "@/lib/export/render";
import { delayCsFor, fitFrameRate } from "@/lib/export/render";
import { packFrame, readCanvasPixels } from "@/lib/export/framePack";

export interface GifOptions {
  path: string;
  fps: number;
  /** Hard ceiling on frames, so a long recording cannot produce a gigabyte GIF. */
  maxFrames?: number;
  alphaThreshold?: number;
}

export interface ExportProgress {
  /** Frames written so far. */
  done: number;
  total: number;
  /** Milliseconds elapsed since the export began. */
  elapsedMs: number;
  /** Estimated milliseconds remaining, or `null` before the first frame lands. */
  etaMs: number | null;
}

export interface GifResult {
  path: string;
  bytes: number;
  frames: number;
  /** The rate actually used. Lower than requested when the frame budget bit. */
  fps: number;
  reduced: boolean;
}

const DEFAULT_MAX_FRAMES = 600;

/** Thrown when the caller cancels. Distinct from a failure so the UI can stay quiet. */
export class ExportCancelled extends Error {
  constructor() {
    super("导出已取消");
    this.name = "ExportCancelled";
  }
}

/**
 * Export the composed timeline as an animated GIF.
 *
 * `shouldCancel` is polled between frames rather than during one: a seek cannot be
 * interrupted, and pretending otherwise would leave the caller waiting for an abort that
 * is not coming.
 */
export async function exportGif(
  composer: FrameComposer,
  options: GifOptions,
  onProgress?: (p: ExportProgress) => void,
  shouldCancel?: () => boolean,
): Promise<GifResult> {
  const maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES;
  const fit = fitFrameRate(composer.durationMs, options.fps, maxFrames);
  if (fit.frames < 2) {
    throw new Error("时间轴太短，至少需要 2 帧才能导出 GIF");
  }
  const delayCs = delayCsFor(fit.fps);
  const alphaThreshold = options.alphaThreshold ?? 128;

  await api.exportSetup({
    path: options.path,
    width: composer.width,
    height: composer.height,
    frames: fit.frames,
    delayCs,
  });

  const startedAt = performance.now();
  try {
    for (let i = 0; i < fit.frames; i++) {
      if (shouldCancel?.()) throw new ExportCancelled();

      // Sample at the *centre* of each frame's slot. Sampling at the boundary puts the
      // seek on a frame edge, where the decoder's rounding can land on either side and
      // produce a one-frame stutter.
      const slot = composer.durationMs / fit.frames;
      const at = Math.min(composer.durationMs, i * slot + slot / 2);
      await composer.drawAt(at);
      await api.exportPushFrame(
        packFrame(readCanvasPixels(composer.canvas), {
          width: composer.width,
          height: composer.height,
          delayCs,
          alphaThreshold,
          index: i,
        }),
      );

      const elapsed = performance.now() - startedAt;
      const done = i + 1;
      onProgress?.({
        done,
        total: fit.frames,
        elapsedMs: elapsed,
        // Straight-line estimate. Frame times are near-constant here (a seek plus a
        // fixed encode), so averaging is honest and a fancy estimator would predict
        // no better.
        etaMs: done > 0 ? (elapsed / done) * (fit.frames - done) : null,
      });
    }

    const result = await api.exportFinish();
    return {
      path: result.path,
      bytes: result.bytes,
      frames: result.frames,
      fps: fit.fps,
      reduced: fit.reduced,
    };
  } catch (e) {
    // Anything short of a clean finish leaves a half-written stream in Rust; drop it so
    // the next export does not append to it.
    await api.exportCancel().catch(() => undefined);
    throw e;
  }
}
