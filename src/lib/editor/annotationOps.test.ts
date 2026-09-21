import { describe, expect, it } from "vitest";
import {
  HANDLE_FRACTION,
  MIN_ANNOTATION_SIZE,
  annotationBox,
  hitTest,
  moveAnnotation,
  normalizeDegrees,
  resizeAnnotation,
  setRotation,
  topmostAt,
  type AnnotationHandle,
} from "./annotationOps";
import { DEFAULT_ANNOTATION_STYLE, type AnnotationRegion } from "@/lib/timeline/types";

function annotation(patch: Partial<AnnotationRegion> = {}): AnnotationRegion {
  return {
    id: "a1",
    startMs: 0,
    endMs: 1000,
    type: "text",
    textContent: "hi",
    position: { x: 0.5, y: 0.5 },
    size: { width: 0.4, height: 0.1 },
    style: { ...DEFAULT_ANNOTATION_STYLE },
    rotation: 0,
    ...patch,
  };
}

describe("resizeAnnotation", () => {
  it("keeps the opposite corner fixed", () => {
    const original = annotation();
    const before = annotationBox(original);
    const resized = resizeAnnotation(original, "se", 0.1, 0.05);
    const after = annotationBox(resized);

    // Drag the south-east corner; the north-west one must not have moved.
    expect(after.x - after.width / 2).toBeCloseTo(before.x - before.width / 2, 6);
    expect(after.y - after.height / 2).toBeCloseTo(before.y - before.height / 2, 6);
    expect(after.width).toBeCloseTo(before.width + 0.1, 6);
    expect(after.height).toBeCloseTo(before.height + 0.05, 6);
  });

  it("holds the south-east corner when the north-west one is dragged", () => {
    const original = annotation();
    const before = annotationBox(original);
    const resized = resizeAnnotation(original, "nw", -0.05, -0.02);
    const after = annotationBox(resized);

    expect(after.x + after.width / 2).toBeCloseTo(before.x + before.width / 2, 6);
    expect(after.y + after.height / 2).toBeCloseTo(before.y + before.height / 2, 6);
  });

  it("stops at the minimum size instead of inverting", () => {
    const resized = resizeAnnotation(annotation(), "se", -5, -5);
    expect(resized.size.width).toBeCloseTo(MIN_ANNOTATION_SIZE, 6);
    expect(resized.size.height).toBeCloseTo(MIN_ANNOTATION_SIZE, 6);
  });

  it("does not let the box leave the frame", () => {
    const resized = resizeAnnotation(annotation(), "se", 5, 5);
    const box = annotationBox(resized);
    expect(box.x + box.width / 2).toBeLessThanOrEqual(1 + 1e-9);
    expect(box.y + box.height / 2).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("handles all four corners without moving the anchor", () => {
    const handles: AnnotationHandle[] = ["nw", "ne", "sw", "se"];
    for (const handle of handles) {
      const before = annotationBox(annotation());
      const after = annotationBox(resizeAnnotation(annotation(), handle, 0.02, 0.02));
      const anchorBefore = {
        x: handle === "nw" || handle === "sw" ? before.x + before.width / 2 : before.x - before.width / 2,
        y: handle === "nw" || handle === "ne" ? before.y + before.height / 2 : before.y - before.height / 2,
      };
      const anchorAfter = {
        x: handle === "nw" || handle === "sw" ? after.x + after.width / 2 : after.x - after.width / 2,
        y: handle === "nw" || handle === "ne" ? after.y + after.height / 2 : after.y - after.height / 2,
      };
      expect(anchorAfter.x).toBeCloseTo(anchorBefore.x, 6);
      expect(anchorAfter.y).toBeCloseTo(anchorBefore.y, 6);
    }
  });
});

describe("moveAnnotation", () => {
  it("adds the delta to the centre", () => {
    const moved = moveAnnotation(annotation(), 0.1, -0.02);
    expect(moved.position.x).toBeCloseTo(0.6, 6);
    expect(moved.position.y).toBeCloseTo(0.48, 6);
  });

  it("stops the box at the frame edge rather than letting the centre leave", () => {
    const moved = moveAnnotation(annotation(), 5, 5);
    expect(moved.position.x).toBeCloseTo(0.8, 6);
    expect(moved.position.y).toBeCloseTo(0.95, 6);
  });

  it("never moves the size", () => {
    const original = annotation();
    const moved = moveAnnotation(original, 0.3, 0.3);
    expect(moved.size).toEqual(original.size);
  });
});

describe("setRotation / normalizeDegrees", () => {
  it("wraps negatives into [0, 360)", () => {
    expect(normalizeDegrees(-90)).toBe(270);
    expect(normalizeDegrees(450)).toBe(90);
  });

  it("treats a non-number as zero rather than NaN", () => {
    expect(normalizeDegrees(Number.NaN)).toBe(0);
    expect(normalizeDegrees(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("stores the normalized angle", () => {
    expect(setRotation(annotation(), -45).rotation).toBe(315);
  });
});

describe("hitTest", () => {
  it("hits the centre and misses well outside", () => {
    const a = annotation();
    expect(hitTest(a, 0.5, 0.5)).toBe(true);
    expect(hitTest(a, 0.05, 0.05)).toBe(false);
  });

  it("accepts a point just outside the box, so the edge is grabbable", () => {
    const a = annotation();
    const outside = 0.5 + a.size.width / 2 + HANDLE_FRACTION * 0.5 * 0.5;
    expect(hitTest(a, outside, 0.5)).toBe(true);
  });

  it("follows the rotation", () => {
    // A long thin box rotated vertical: a point that was outside is now inside.
    const horizontal = annotation({ size: { width: 0.5, height: 0.02 }, rotation: 0 });
    const vertical = annotation({ size: { width: 0.5, height: 0.02 }, rotation: 90 });
    expect(hitTest(horizontal, 0.5, 0.62)).toBe(false);
    expect(hitTest(vertical, 0.5, 0.62)).toBe(true);
  });
});

describe("topmostAt", () => {
  it("returns the last drawn match", () => {
    const bottom = annotation({ id: "bottom" });
    const top = annotation({ id: "top", position: { x: 0.5, y: 0.5 } });
    expect(topmostAt([bottom, top], 0.5, 0.5)?.id).toBe("top");
  });

  it("returns null when nothing is under the point", () => {
    expect(topmostAt([annotation()], 0.01, 0.01)).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(topmostAt([], 0.5, 0.5)).toBeNull();
  });
});
