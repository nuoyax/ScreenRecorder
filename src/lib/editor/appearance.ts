/**
 * Canvas compositor for the editor preview.
 *
 * One function draws a whole frame, and the export path calls the same one — so what
 * the user sees in the preview is what lands in the GIF, rather than two renderers
 * that drift apart. Draw order is background → video → annotations → cursor → click.
 */

import type { AnnotationRegion, BackgroundStyle, ZoomRegion } from "@/lib/timeline/types";
import { ZOOM_DEPTH_SCALES } from "@/lib/timeline/types";
import type { CropRect } from "@/lib/editor/state";
import type { ClickSample, MoveSample } from "@/lib/api";

export interface FrameSource {
  /** The `<video>` (or any canvas source) currently showing the right moment. */
  image: CanvasImageSource;
  /** Intrinsic size of `image`, used to map the crop region. */
  imageWidth: number;
  imageHeight: number;
}

export interface AppearanceOptions {
  background: BackgroundStyle;
  /** Spatial crop of the source frame, as fractions. `{0,0,1,1}` shows all of it. */
  crop: CropRect;
  zoom: ZoomRegion | null;
  annotations: AnnotationRegion[];
  /** Where the playhead is on the *timeline*; zoom and annotations are keyed to this. */
  timeMs: number;
  /**
   * Where this frame comes from in the *recording*.
   *
   * Separate from `timeMs` because a trim or a speed change makes the two different
   * numbers, and the cursor track is stamped against the recording's own clock — using
   * the timeline position would slide every click and cursor by the amount trimmed.
   */
  sourceTimeMs: number;
  moves: MoveSample[];
  clicks: ClickSample[];
  /** Recording rectangle in virtual-screen coordinates, to place the cursor. */
  captureOrigin: { x: number; y: number; width: number; height: number };
  showCursor: boolean;
  clickHighlight: boolean;
}

/** How long a click ripple stays visible. */
const CLICK_RIPPLE_MS = 500;

/**
 * Draw one composed frame into `ctx`, filling `width` x `height`.
 *
 * The canvas is assumed to be already sized in device pixels; everything here works
 * in those units so a HiDPI preview and a 1:1 export produce the same output.
 */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  source: FrameSource,
  opts: AppearanceOptions,
): void {
  ctx.save();
  ctx.clearRect(0, 0, width, height);

  drawBackground(ctx, width, height, opts.background);

  // Inset the video by the background padding, then zoom inside that box.
  const pad = opts.background.padding * width;
  const box = { x: pad, y: pad, w: Math.max(1, width - pad * 2), h: Math.max(1, height - pad * 2) };
  const radius = opts.background.radius * width;

  ctx.save();
  roundedRect(ctx, box.x, box.y, box.w, box.h, radius);
  ctx.clip();
  if (opts.background.shadow) {
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = width * 0.02;
  }
  drawZoomedVideo(ctx, box, source, opts.crop, opts.zoom);
  ctx.restore();

  // Annotations and cursor are drawn over the video but inside the same frame, so
  // they are positioned in normalized frame coordinates and survive resizing.
  for (const annotation of opts.annotations) {
    drawAnnotation(ctx, box, annotation);
  }
  if (opts.showCursor) {
    drawCursor(ctx, box, opts);
  }
  ctx.restore();
}

function drawBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  background: BackgroundStyle,
): void {
  if (background.gradient) {
    // A CSS gradient string cannot be handed to canvas directly, so the two endpoint
    // colours are parsed out of it. Anything unparseable falls through to the solid
    // colour, which is visible rather than silently transparent.
    const stops = parseGradient(background.gradient);
    if (stops) {
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      for (const [offset, color] of stops) gradient.addColorStop(offset, color);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      return;
    }
  }
  if (background.color) {
    ctx.fillStyle = background.color;
    ctx.fillRect(0, 0, width, height);
  }
}

/** Pull `#rrggbb` stops out of a `linear-gradient(...)` string, in order. */
function parseGradient(css: string): Array<[number, string]> | null {
  const body = /linear-gradient\(([^)]*)\)/.exec(css)?.[1];
  if (!body) return null;
  const parts = body.split(",").map((p) => p.trim());
  // The first part is the angle/direction; the rest are colour stops.
  const stops: Array<[number, string]> = [];
  for (const part of parts.slice(1)) {
    const match = /(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))\s*(\d+%)?/.exec(part);
    if (!match) continue;
    const offset = match[2] ? Number.parseInt(match[2], 10) / 100 : stops.length / 2;
    stops.push([Math.min(1, Math.max(0, offset)), match[1]]);
  }
  return stops.length >= 2 ? stops : null;
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * Draw the video, cropped to `zoom` when one covers this moment.
 *
 * Zoom is applied by drawing a *smaller source rectangle* into the same destination
 * box, which is a crop rather than a scale — that is what keeps the zoomed result at
 * full output resolution instead of magnifying compressed pixels. The spatial crop
 * composes the same way: it picks the base rectangle, and zoom picks a smaller one
 * inside it, so the two never fight over the same pixels.
 */
function drawZoomedVideo(
  ctx: CanvasRenderingContext2D,
  box: { x: number; y: number; w: number; h: number },
  source: FrameSource,
  crop: CropRect,
  zoom: ZoomRegion | null,
): void {
  const { image, imageWidth, imageHeight } = source;
  if (imageWidth <= 0 || imageHeight <= 0) return;

  // The crop, in source pixels, clamped so a bogus stored rect cannot read past the end.
  const cropW = Math.max(1, imageWidth * clamp(crop.width, 0.01, 1));
  const cropH = Math.max(1, imageHeight * clamp(crop.height, 0.01, 1));
  const cropX = clamp(imageWidth * crop.x, 0, imageWidth - cropW);
  const cropY = clamp(imageHeight * crop.y, 0, imageHeight - cropH);

  if (!zoom) {
    ctx.drawImage(image, cropX, cropY, cropW, cropH, box.x, box.y, box.w, box.h);
    return;
  }

  const scale = ZOOM_DEPTH_SCALES[zoom.depth] ?? 1.8;
  const sw = cropW / scale;
  const sh = cropH / scale;

  // The focus point is the centre of the crop *inside the cropped rectangle*, so a zoom
  // still lands on the same spot after the frame has been cropped.
  const focusX = cropX + zoom.focus.cx * cropW;
  const focusY = cropY + zoom.focus.cy * cropH;
  const sx = clamp(focusX - sw / 2, cropX, cropX + cropW - sw);
  const sy = clamp(focusY - sh / 2, cropY, cropY + cropH - sh);

  ctx.drawImage(image, sx, sy, sw, sh, box.x, box.y, box.w, box.h);
}

function drawAnnotation(
  ctx: CanvasRenderingContext2D,
  box: { x: number; y: number; w: number; h: number },
  annotation: AnnotationRegion,
): void {
  const w = annotation.size.width * box.w;
  const h = annotation.size.height * box.h;
  const cx = box.x + annotation.position.x * box.w;
  const cy = box.y + annotation.position.y * box.h;

  ctx.save();
  if (annotation.type === "arrow") {
    drawArrow(ctx, cx, cy, w, h, annotation);
  } else {
    drawText(ctx, cx, cy, w, h, annotation);
  }
  ctx.restore();
}

function drawText(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  h: number,
  annotation: AnnotationRegion,
): void {
  const { style, textContent } = annotation;
  // Font size is stored in "preview pixels" at a 1080p-wide composition, so it scales
  // with the output rather than being a fixed pixel count.
  const fontSize = Math.max(6, (style.fontSize / 1920) * (w / Math.max(annotation.size.width, 1e-6)));
  ctx.font = `${style.fontWeight} ${fontSize}px ${FONT_STACK}`;
  ctx.textAlign = style.textAlign;
  ctx.textBaseline = "middle";

  const padding = fontSize * 0.25;
  if (style.backgroundColor && style.backgroundColor !== "transparent") {
    ctx.fillStyle = style.backgroundColor;
    const metrics = ctx.measureText(textContent);
    const textW = Math.min(metrics.width + padding * 2, w * 4);
    const left =
      style.textAlign === "left" ? cx : style.textAlign === "right" ? cx - textW : cx - textW / 2;
    roundedRect(ctx, left, cy - h / 2, textW, h, fontSize * 0.3);
    ctx.fill();
  }

  ctx.fillStyle = style.color;
  // A shadow keeps light text readable over a light recording without a background.
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = fontSize * 0.2;
  ctx.fillText(textContent, cx, cy);
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  h: number,
  annotation: AnnotationRegion,
): void {
  ctx.translate(cx, cy);
  ctx.rotate((annotation.rotation * Math.PI) / 180);
  const length = w;
  const head = Math.min(h, length * 0.45);
  const stroke = Math.max(2, h * 0.18);

  ctx.strokeStyle = annotation.style.color;
  ctx.fillStyle = annotation.style.color;
  ctx.lineWidth = stroke;
  ctx.lineCap = "round";

  ctx.beginPath();
  ctx.moveTo(-length / 2, 0);
  ctx.lineTo(length / 2 - head, 0);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(length / 2, 0);
  ctx.lineTo(length / 2 - head, -head * 0.5);
  ctx.lineTo(length / 2 - head, head * 0.5);
  ctx.closePath();
  ctx.fill();
}

/** The font stack annotations render in, matching the preview's CSS. */
export const FONT_STACK =
  '"Segoe UI Variable", "Segoe UI", system-ui, -apple-system, sans-serif';

function drawCursor(
  ctx: CanvasRenderingContext2D,
  box: { x: number; y: number; w: number; h: number },
  opts: AppearanceOptions,
): void {
  const { width, height } = opts.captureOrigin;
  if (width <= 0 || height <= 0) return;

  if (opts.clickHighlight) {
    drawClickRipples(ctx, box, opts);
  }

  const move = sampleAt(opts.moves, opts.sourceTimeMs);
  const at = cursorAt(move, opts.captureOrigin, opts.crop);
  if (!at) return;

  drawCursorGlyph(ctx, box.x + at.nx * box.w, box.y + at.ny * box.h, Math.max(8, box.w * 0.016));
}

/**
 * Where a sample lands in the composed frame, or `null` when it is outside what is shown.
 *
 * The crop matters here: a cursor over the browser chrome that the user cropped away must
 * not be drawn floating at the edge of the frame. Normalizing against the cropped
 * rectangle instead of the whole recording puts it where it belongs when it *is* inside,
 * and rejects it when it is not.
 */
function cursorAt(
  sample: MoveSample | null,
  capture: { x: number; y: number; width: number; height: number },
  crop: CropRect,
): { nx: number; ny: number } | null {
  if (!sample) return null;
  const nx = (sample.x - capture.x) / capture.width;
  const ny = (sample.y - capture.y) / capture.height;
  const inX = (nx - crop.x) / Math.max(0.01, crop.width);
  const inY = (ny - crop.y) / Math.max(0.01, crop.height);
  if (inX < 0 || inX > 1 || inY < 0 || inY > 1) return null;
  return { nx: inX, ny: inY };
}

/**
 * Ripples for clicks near this moment, each at its own recorded position.
 *
 * A click carries its own coordinates, so ripples do not depend on the move track
 * having a nearby sample — which matters because the sampler records a move only when
 * the position changed, so a click without movement has no move sample at all.
 */
function drawClickRipples(
  ctx: CanvasRenderingContext2D,
  box: { x: number; y: number; w: number; h: number },
  opts: AppearanceOptions,
): void {
  for (const click of opts.clicks) {
    const ageMs = opts.sourceTimeMs - click.t_us / 1000;
    if (ageMs < 0 || ageMs > CLICK_RIPPLE_MS) continue;
    const at = cursorAt(click, opts.captureOrigin, opts.crop);
    if (!at) continue;

    const progress = ageMs / CLICK_RIPPLE_MS;
    const radius = box.w * 0.012 * (0.4 + progress * 1.6);
    ctx.save();
    ctx.globalAlpha = 1 - progress;
    ctx.strokeStyle = "#ff3b30";
    ctx.lineWidth = Math.max(1.5, box.w * 0.003);
    ctx.beginPath();
    ctx.arc(box.x + at.nx * box.w, box.y + at.ny * box.h, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawCursorGlyph(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  size: number,
): void {
  // A simple arrow, drawn rather than loaded so no asset has to ship with the app.
  ctx.save();
  ctx.translate(px, py);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, size);
  ctx.lineTo(size * 0.28, size * 0.76);
  ctx.lineTo(size * 0.5, size * 1.15);
  ctx.lineTo(size * 0.68, size * 1.05);
  ctx.lineTo(size * 0.46, size * 0.68);
  ctx.lineTo(size * 0.78, size * 0.62);
  ctx.closePath();
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "rgba(0,0,0,0.75)";
  ctx.lineWidth = Math.max(1, size * 0.08);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/**
 * Nearest cursor sample at or before `timeMs`.
 *
 * Binary search rather than a scan: this runs once per rendered frame over a track
 * that can hold tens of thousands of samples, and a linear scan would dominate the
 * preview's frame time on a long recording.
 */
export function sampleAt(samples: MoveSample[], timeMs: number): MoveSample | null {
  if (samples.length === 0) return null;
  const targetUs = timeMs * 1000;
  let low = 0;
  let high = samples.length - 1;
  if (targetUs <= samples[0].t_us) return samples[0];
  if (targetUs >= samples[high].t_us) return samples[high];

  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (samples[mid].t_us <= targetUs) low = mid;
    else high = mid - 1;
  }
  return samples[low];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
