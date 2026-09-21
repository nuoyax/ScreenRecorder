import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_HISTORY,
  applyEdit,
  canRedo,
  canUndo,
  durationMs,
  emptyProject,
  initialState,
  nextId,
  ops,
  playbackRateAt,
  redo,
  resetIdCounter,
  sourceTimeForPlayhead,
  undo,
  zoomAt,
} from "./state";
import type { Project } from "./state";

const SOURCE_MS = 10_000;

function project(): Project {
  return emptyProject({
    sourcePath: "C:/tmp/rec.mp4",
    durationMs: SOURCE_MS,
    width: 1920,
    height: 1080,
    fps: 30,
  });
}

beforeEach(() => resetIdCounter());

describe("undo / redo", () => {
  it("starts with nothing to undo or redo", () => {
    const s = initialState(project());
    expect(canUndo(s)).toBe(false);
    expect(canRedo(s)).toBe(false);
  });

  it("walks back and forward through an edit", () => {
    let s = initialState(project());
    s = applyEdit(s, ops.splitAt(4000));
    expect(s.project.clips).toHaveLength(2);
    expect(canUndo(s)).toBe(true);

    s = undo(s);
    expect(s.project.clips).toHaveLength(1);
    expect(canRedo(s)).toBe(true);

    s = redo(s);
    expect(s.project.clips).toHaveLength(2);
  });

  /** A gesture that changed nothing must not consume an undo step. */
  it("ignores an edit that produced the same value", () => {
    let s = initialState(project());
    s = applyEdit(s, (p) => p);
    expect(canUndo(s)).toBe(false);
    // a split that lands outside every clip is also a no-op
    s = applyEdit(s, ops.splitAt(99_999));
    expect(canUndo(s)).toBe(false);
  });

  it("drops the redo stack once a new edit lands", () => {
    let s = initialState(project());
    s = applyEdit(s, ops.splitAt(4000));
    s = undo(s);
    expect(canRedo(s)).toBe(true);
    s = applyEdit(s, ops.addZoom({ startMs: 0, endMs: 1000 }, 3, { cx: 0.5, cy: 0.5 }));
    expect(canRedo(s)).toBe(false);
  });

  it("bounds the history so a long session cannot grow forever", () => {
    let s = initialState(project());
    for (let i = 0; i < MAX_HISTORY + 25; i++) {
      s = applyEdit(s, ops.addZoom({ startMs: i * 10, endMs: i * 10 + 500 }, 3, { cx: 0.5, cy: 0.5 }));
    }
    expect(s.past.length).toBe(MAX_HISTORY);
  });

  it("is a no-op at either end of the history", () => {
    const s = initialState(project());
    expect(undo(s)).toBe(s);
    expect(redo(s)).toBe(s);
  });
});

describe("clip ops", () => {
  it("splits under the playhead and deletes one half", () => {
    let s = initialState(project());
    s = applyEdit(s, ops.splitAt(4000));
    const [left, right] = s.project.clips;
    s = applyEdit(s, ops.deleteClip(left.id));
    expect(s.project.clips).toEqual([right]);
  });

  /** An empty timeline has no duration; every downstream calculation would break. */
  it("refuses to delete the last remaining clip", () => {
    const s = initialState(project());
    expect(ops.deleteClip(s.project.clips[0].id)(s.project)).toBe(s.project);
  });

  it("moves a clip without changing which footage it shows", () => {
    const p = project();
    const moved = ops.moveClip(p.clips[0].id, 2000, 12_000)(p);
    expect(moved.clips[0].startMs).toBe(2000);
    // A pure move keeps the source in-point at 0.
    expect(moved.clips[0].sourceStartMs ?? 0).toBe(0);
  });

  /**
   * `changeClipSpan` returns a fresh object for an unchanged span; the op has to
   * notice, or a click without a drag would register as an undoable edit.
   */
  it("treats an unchanged span as no edit", () => {
    const p = project();
    expect(ops.moveClip(p.clips[0].id, 0, SOURCE_MS)(p)).toBe(p);
  });

  it("applies a speed change to one clip only", () => {
    const p = project();
    let s = initialState(p);
    s = applyEdit(s, ops.splitAt(4000));
    const first = s.project.clips[0];
    s = applyEdit(s, ops.setClipSpeed(first.id, 2));
    expect(s.project.clips[0].speed).toBe(2);
    expect(s.project.clips[1].speed).toBe(1);
  });

  it("ignores a non-positive speed", () => {
    const p = project();
    expect(ops.setClipSpeed(p.clips[0].id, 0)(p)).toBe(p);
    expect(ops.setClipSpeed(p.clips[0].id, -1)(p)).toBe(p);
  });

  it("trims the recording down to a source range", () => {
    const trimmed = ops.trimTo(2000, 6000)(project());
    expect(trimmed.clips).toHaveLength(1);
    expect(trimmed.clips[0].sourceStartMs).toBe(2000);
    expect(durationMs(trimmed)).toBe(4000);
  });
});

describe("zoom ops", () => {
  it("adds a zoom and finds it at the right time", () => {
    const p = ops.addZoom({ startMs: 1000, endMs: 3000 }, 4, { cx: 0.2, cy: 0.8 })(project());
    expect(zoomAt(p, 2000)?.depth).toBe(4);
    expect(zoomAt(p, 3500)).toBeNull();
  });

  it("clamps a zoom to the timeline instead of rejecting it", () => {
    const p = ops.addZoom({ startMs: -1000, endMs: 99_000 }, 3, { cx: 0.5, cy: 0.5 })(project());
    expect(p.zooms[0].startMs).toBe(0);
    expect(p.zooms[0].endMs).toBe(SOURCE_MS);
  });

  it("moves and resizes a zoom within the timeline", () => {
    let p = ops.addZoom({ startMs: 1000, endMs: 3000 }, 3, { cx: 0.5, cy: 0.5 })(project());
    const id = p.zooms[0].id;
    p = ops.moveZoom(id, 5000)(p);
    expect(p.zooms[0].startMs).toBe(6000);
    expect(p.zooms[0].endMs).toBe(8000);
    p = ops.resizeZoom(id, "end", 99_000)(p);
    expect(p.zooms[0].endMs).toBe(SOURCE_MS);
  });

  /** Overlapping zooms are ambiguous; the most recently added one wins. */
  it("prefers the last zoom added when regions overlap", () => {
    let p = ops.addZoom({ startMs: 0, endMs: 5000 }, 2, { cx: 0.5, cy: 0.5 })(project());
    p = ops.addZoom({ startMs: 1000, endMs: 2000 }, 5, { cx: 0.5, cy: 0.5 })(p);
    expect(zoomAt(p, 1500)?.depth).toBe(5);
    expect(zoomAt(p, 4000)?.depth).toBe(2);
  });

  it("removes a zoom and treats a missing id as no edit", () => {
    const p = ops.addZoom({ startMs: 0, endMs: 1000 }, 3, { cx: 0.5, cy: 0.5 })(project());
    expect(ops.removeZoom(p.zooms[0].id)(p).zooms).toHaveLength(0);
    expect(ops.removeZoom("nope")(p)).toBe(p);
  });
});

describe("annotation ops", () => {
  const base = {
    type: "text" as const,
    textContent: "hello",
    startMs: 0,
    endMs: 2000,
    position: { x: 0.5, y: 0.5 },
    size: { width: 0.3, height: 0.1 },
    style: {
      color: "#fff",
      backgroundColor: "transparent",
      fontSize: 24,
      fontWeight: "bold" as const,
      textAlign: "center" as const,
    },
    rotation: 0,
  };

  it("adds, updates and removes", () => {
    let p = ops.addAnnotation(base)(project());
    const id = p.annotations[0].id;
    p = ops.updateAnnotation(id, { textContent: "changed" })(p);
    expect(p.annotations[0].textContent).toBe("changed");
    expect(ops.removeAnnotation(id)(p).annotations).toHaveLength(0);
    expect(ops.removeAnnotation("nope")(p)).toBe(p);
  });

  it("clamps a new annotation's span to the timeline", () => {
    const p = ops.addAnnotation({ ...base, startMs: 9000, endMs: 20_000 })(project());
    expect(p.annotations[0].endMs).toBe(SOURCE_MS);
  });
});

describe("crop", () => {
  it("starts as the whole frame", () => {
    expect(project().crop).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("patches only the fields given", () => {
    expect(ops.setCrop({ x: 0.1 })(project()).crop).toEqual({
      x: 0.1,
      y: 0,
      width: 1,
      height: 1,
    });
  });

  it("leaves the clips alone, so cropping is not a cut", () => {
    const before = project();
    const after = ops.setCrop({ x: 0.25, width: 0.5 })(before);
    expect(after.clips).toEqual(before.clips);
    expect(durationMs(after)).toBe(durationMs(before));
  });
});

describe("playhead helpers", () => {
  it("reads the source time through the clip mapping", () => {
    const p = project();
    expect(sourceTimeForPlayhead(p, 1500)).toBe(1500);
  });

  it("clamps the source time to the recording", () => {
    const p = ops.trimTo(2000, 6000)(project());
    // The timeline ends at 4000 and reads from source 6000; asking past the end must
    // not seek beyond the file.
    expect(sourceTimeForPlayhead(p, 999_999)).toBeLessThanOrEqual(SOURCE_MS);
  });

  it("reports the playback rate of the clip under the playhead", () => {
    const p = project();
    expect(playbackRateAt(p, 1000)).toBe(1);
    const sped = ops.setClipSpeed(p.clips[0].id, 2)(p);
    expect(playbackRateAt(sped, 1000)).toBe(2);
  });
});

describe("nextId", () => {
  it("produces unique ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => nextId("zoom")));
    expect(ids.size).toBe(50);
  });

  it("prefixes ids so their origin is readable in a project file", () => {
    expect(nextId("ann").startsWith("ann-")).toBe(true);
  });
});
