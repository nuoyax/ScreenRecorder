/**
 * Sticker export: one composed frame, framed for a slide or a chat window.
 *
 * Rust does the framing (padding, rounding, shadow, PNG encode). This decides which
 * moment to take and what to ask for — and it deliberately exports the frame *at the
 * playhead*, not at the start: a sticker is usually the frame the user is looking at,
 * with the arrow or zoom they aimed at it.
 *
 * The destination and the framing travel *inside* the payload header rather than as
 * command arguments. A raw bytes body has no JSON object for Tauri to read named keys
 * from, so a `path` argument would simply never arrive.
 */

import { api } from "@/lib/api";
import type { FrameComposer } from "@/lib/export/render";
import { packFrame, readCanvasPixels } from "@/lib/export/framePack";

export interface StickerOptions {
  path: string;
  /** Timeline position to take the frame from. */
  atMs: number;
  /** Transparent margin around the content, in pixels. */
  padding: number;
  /** Corner radius in pixels. */
  radius: number;
  shadow: boolean;
}

export interface StickerResult {
  path: string;
  bytes: number;
}

/** Default framing, sized against a 720p composition rather than a thumbnail. */
export const DEFAULT_STICKER: Omit<StickerOptions, "path" | "atMs"> = {
  padding: 32,
  radius: 18,
  shadow: true,
};

/**
 * Export the frame at `timelineMs` as a PNG sticker.
 *
 * Not the GIF path with a frame count of one: a PNG this app writes is full RGBA at the
 * composition's own resolution, so nothing is quantised to 256 colours on the way out.
 */
export async function exportSticker(
  composer: FrameComposer,
  options: StickerOptions,
): Promise<StickerResult> {
  const at = Math.max(0, Math.min(composer.durationMs, options.atMs));
  await composer.drawAt(at);
  const payload = packFrame(readCanvasPixels(composer.canvas), {
    width: composer.width,
    height: composer.height,
    // A still has no delay, so this is never read; it is part of the shared header.
    delayCs: 0,
    alphaThreshold: 128,
    index: 0,
    // Sticker-only fields. `path` is here because a raw payload cannot carry command
    // arguments — see the note at the top of this file.
    path: options.path,
    padding: options.padding,
    radius: options.radius,
    shadow: options.shadow,
  });
  const result = await api.exportImgSticker(payload);
  return { path: result.path, bytes: result.bytes };
}
