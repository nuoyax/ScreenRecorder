/**
 * Annotation geometry: resize, rotate, hit-test.
 *
 * Kept out of the React layer because these are the parts worth testing — the
 * component only forwards pointer events. Sizes are fractions of the video box and
 * positions are normalized, so everything here is resolution-independent and the same
 * numbers work for the preview and for an export at any output size.
 */

import type { AnnotationRegion } from "@/lib/timeline/types";

/** Smallest an annotation may be dragged, as a fraction of the video box. */
export const MIN_ANNOTATION_SIZE = 0.02;

/** Corner handle size, as a fraction of the annotation's own width. */
export const HANDLE_FRACTION = 0.18;

export type AnnotationHandle = "nw" | "ne" | "sw" | "se";

export interface Box {
  /** Centre of the annotation. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The annotation's box, as the compositor will draw it. */
export function annotationBox(annotation: AnnotationRegion): Box {
  return {
    x: annotation.position.x,
    y: annotation.position.y,
    width: annotation.size.width,
    height: annotation.size.height,
  };
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Resize by dragging one corner.
 *
 * The *opposite* corner is held fixed, which is what makes a drag feel attached to the
 * pointer: growing from the centre instead would move both edges at once. Centre and
 * size are recomputed from the two corners rather than scaled, so the fixed corner
 * stays put exactly.
 */
export function resizeAnnotation(
  annotation: AnnotationRegion,
  handle: AnnotationHandle,
  dx: number,
  dy: number,
): AnnotationRegion {
  const box = annotationBox(annotation);
  const halfW = box.width / 2;
  const halfH = box.height / 2;

  // Corners in normalized space, clamped into the frame so a drag past the edge stops
  // there rather than pushing the box off-screen.
  const left = clamp01(box.x - halfW);
  const right = clamp01(box.x + halfW);
  const top = clamp01(box.y - halfH);
  const bottom = clamp01(box.y + halfH);

  const movingLeft = handle === "nw" || handle === "sw";
  const movingTop = handle === "nw" || handle === "ne";

  const newLeft = movingLeft ? Math.max(0, Math.min(left + dx, right - MIN_ANNOTATION_SIZE)) : left;
  const newRight = movingLeft ? right : Math.min(1, Math.max(right + dx, left + MIN_ANNOTATION_SIZE));
  const newTop = movingTop ? Math.max(0, Math.min(top + dy, bottom - MIN_ANNOTATION_SIZE)) : top;
  const newBottom = movingTop ? bottom : Math.min(1, Math.max(bottom + dy, top + MIN_ANNOTATION_SIZE));

  const width = Math.max(MIN_ANNOTATION_SIZE, newRight - newLeft);
  const height = Math.max(MIN_ANNOTATION_SIZE, newBottom - newTop);

  // With a floor on the size, the moving corner stops at the fixed one rather than the
  // box drifting once it hits the minimum.
  const centreX = movingLeft ? newRight - width / 2 : newLeft + width / 2;
  const centreY = movingTop ? newBottom - height / 2 : newTop + height / 2;

  return {
    ...annotation,
    position: { x: clamp01(centreX), y: clamp01(centreY) },
    size: { width: Math.min(1, width), height: Math.min(1, height) },
  };
}

/** Move by a normalized delta, keeping the whole box inside the frame. */
export function moveAnnotation(
  annotation: AnnotationRegion,
  dx: number,
  dy: number,
): AnnotationRegion {
  const halfW = Math.min(annotation.size.width, 1) / 2;
  const halfH = Math.min(annotation.size.height, 1) / 2;
  return {
    ...annotation,
    position: {
      x: Math.min(1 - halfW, Math.max(halfW, annotation.position.x + dx)),
      y: Math.min(1 - halfH, Math.max(halfH, annotation.position.y + dy)),
    },
  };
}

/** Rotate to an absolute angle, normalized into `[0, 360)`. */
export function setRotation(annotation: AnnotationRegion, degrees: number): AnnotationRegion {
  return { ...annotation, rotation: normalizeDegrees(degrees) };
}

export function normalizeDegrees(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  return ((degrees % 360) + 360) % 360;
}

/**
 * Whether a point (normalized frame coordinates) is inside the annotation.
 *
 * For a rotated annotation the test runs in the annotation's own space: translating
 * the point by the annotation's centre and un-rotating it turns "is this inside a
 * rotated rectangle" back into a plain bounding-box check.
 */
export function hitTest(annotation: AnnotationRegion, x: number, y: number): boolean {
  const box = annotationBox(annotation);
  const dx = x - box.x;
  const dy = y - box.y;
  const radians = (-annotation.rotation * Math.PI) / 180;
  const localX = dx * Math.cos(radians) - dy * Math.sin(radians);
  const localY = dx * Math.sin(radians) + dy * Math.cos(radians);
  return (
    Math.abs(localX) <= box.width / 2 + HANDLE_FRACTION * box.width &&
    Math.abs(localY) <= box.height / 2 + HANDLE_FRACTION * box.width
  );
}

/**
 * Topmost annotation under a point.
 *
 * Searched from the end because that is the order the compositor draws in, so the one
 * the user sees on top is the one they grab.
 */
export function topmostAt(
  annotations: AnnotationRegion[],
  x: number,
  y: number,
): AnnotationRegion | null {
  for (let i = annotations.length - 1; i >= 0; i -= 1) {
    if (hitTest(annotations[i], x, y)) return annotations[i];
  }
  return null;
}

/** Corner offsets, as multipliers of half-width/half-height, for drawing handles. */
export const HANDLE_OFFSETS: Record<AnnotationHandle, { fx: number; fy: number }> = {
  nw: { fx: -1, fy: -1 },
  ne: { fx: 1, fy: -1 },
  sw: { fx: -1, fy: 1 },
  se: { fx: 1, fy: 1 },
};
