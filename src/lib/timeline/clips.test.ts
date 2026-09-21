import { describe, expect, it } from "vitest";
import {
  changeClipSpan,
  clipsToTrims,
  planClipSplit,
  applyClipSplit,
  sourceToTimelineMs,
  timelineDurationMs,
  timelineToSourceMs,
} from "./clips";
import { getClipSourceEndMs, type ClipRegion } from "./types";

const SOURCE_MS = 10_000;

const clip = (over: Partial<ClipRegion> = {}): ClipRegion => ({
  id: "c1",
  startMs: 0,
  endMs: 4000,
  speed: 1,
  ...over,
});

describe("timelineToSourceMs / sourceToTimelineMs", () => {
  it("is the identity at 1x with one full clip", () => {
    const clips = [clip({ endMs: SOURCE_MS })];
    expect(timelineToSourceMs(1500, clips)).toBe(1500);
    expect(sourceToTimelineMs(1500, clips)).toBe(1500);
  });

  it("applies the clip's speed in both directions", () => {
    // 4s of timeline showing 8s of source: a 2x clip.
    const clips = [clip({ startMs: 0, endMs: 4000, speed: 2 })];
    expect(timelineToSourceMs(1000, clips)).toBe(2000);
    expect(sourceToTimelineMs(2000, clips)).toBe(1000);
  });

  it("reads from the source in-point, not the timeline position", () => {
    // Clip sits at 2s on the timeline but reads from 6s of the recording.
    const clips = [clip({ startMs: 2000, endMs: 4000, sourceStartMs: 6000 })];
    expect(timelineToSourceMs(2500, clips)).toBe(6500);
    expect(sourceToTimelineMs(6500, clips)).toBe(2500);
  });

  /** Scrubbing into a gap must not report a wildly unrelated source position. */
  it("snaps to the nearest clip edge outside every clip", () => {
    const clips = [
      clip({ id: "a", startMs: 0, endMs: 1000 }),
      clip({ id: "b", startMs: 5000, endMs: 6000, sourceStartMs: 1000 }),
    ];
    expect(timelineToSourceMs(3000, clips)).toBe(1000);
    expect(timelineToSourceMs(-500, clips)).toBe(0);
  });

  it("round-trips every frame inside a multi-clip timeline", () => {
    const clips = [
      clip({ id: "a", startMs: 0, endMs: 1000 }),
      clip({ id: "b", startMs: 1000, endMs: 3000, sourceStartMs: 4000, speed: 2 }),
    ];
    for (let ms = 0; ms < 3000; ms += 50) {
      const source = timelineToSourceMs(ms, clips);
      expect(sourceToTimelineMs(source, clips)).toBe(ms);
    }
  });
});

describe("planClipSplit", () => {
  it("puts both halves where the original was", () => {
    const clips = [clip({ startMs: 0, endMs: 4000 })];
    const plan = planClipSplit({ clips, splitMs: 1500, createId: idFactory() })!;
    expect(plan.left.startMs).toBe(0);
    expect(plan.left.endMs).toBe(1500);
    expect(plan.right.startMs).toBe(1500);
    expect(plan.right.endMs).toBe(4000);
  });

  /**
   * At 2x the left half consumes twice its timeline length from the source, so the
   * right half must start there — otherwise it re-reads footage the left half already
   * showed and the tail of the recording is never emitted.
   */
  it("advances the right half's source in-point at non-1x speed", () => {
    const clips = [clip({ startMs: 0, endMs: 4000, speed: 2 })];
    const plan = planClipSplit({ clips, splitMs: 1000, createId: idFactory() })!;
    expect(getClipSourceEndMs(plan.left)).toBe(2000);
    expect(plan.right.sourceStartMs).toBe(2000);
  });

  it("covers the same source range as before the split", () => {
    const before = clip({ startMs: 0, endMs: 4000, speed: 2 });
    const plan = planClipSplit({ clips: [before], splitMs: 1000, createId: idFactory() })!;
    expect(plan.left.sourceStartMs ?? plan.left.startMs).toBe(0);
    expect(getClipSourceEndMs(plan.right)).toBe(getClipSourceEndMs(before));
  });

  it("refuses a split that lands on or outside a clip edge", () => {
    const clips = [clip({ startMs: 0, endMs: 4000 })];
    expect(planClipSplit({ clips, splitMs: 0, createId: idFactory() })).toBeNull();
    expect(planClipSplit({ clips, splitMs: 4000, createId: idFactory() })).toBeNull();
    expect(planClipSplit({ clips, splitMs: 9000, createId: idFactory() })).toBeNull();
    expect(planClipSplit({ clips, splitMs: NaN, createId: idFactory() })).toBeNull();
  });

  it("applies in place without reordering the timeline", () => {
    const clips = [
      clip({ id: "a", startMs: 0, endMs: 1000 }),
      clip({ id: "b", startMs: 1000, endMs: 3000 }),
      clip({ id: "c", startMs: 3000, endMs: 4000 }),
    ];
    const plan = planClipSplit({ clips, splitMs: 2000, createId: idFactory() })!;
    const out = applyClipSplit(clips, plan);
    expect(out.map((c) => c.startMs)).toEqual([0, 1000, 2000, 3000]);
  });
});

describe("changeClipSpan", () => {
  it("keeps the source in-point when the clip is only moved", () => {
    const before = clip({ startMs: 1000, endMs: 3000, sourceStartMs: 5000 });
    const after = changeClipSpan(before, 2000, 4000, SOURCE_MS);
    expect(after.sourceStartMs).toBe(5000);
    expect(after.endMs - after.startMs).toBe(before.endMs - before.startMs);
  });

  it("moves the source in-point when the left edge is dragged", () => {
    const before = clip({ startMs: 1000, endMs: 3000, sourceStartMs: 1000 });
    const after = changeClipSpan(before, 1500, 3000, SOURCE_MS);
    expect(after.sourceStartMs).toBe(1500);
  });

  it("scales the source in-point by speed when the left edge is dragged", () => {
    const before = clip({ startMs: 0, endMs: 4000, speed: 2 });
    const after = changeClipSpan(before, 500, 4000, SOURCE_MS);
    expect(after.sourceStartMs).toBe(1000);
  });

  /** A left edge cannot be dragged back past the start of the recording. */
  it("will not reveal source before the recording starts", () => {
    const before = clip({ startMs: 2000, endMs: 5000, sourceStartMs: 0 });
    const after = changeClipSpan(before, 0, 5000, SOURCE_MS);
    expect(after.startMs).toBe(2000);
    expect(after.sourceStartMs).toBe(0);
  });

  it("will not extend past the end of the recording", () => {
    const before = clip({ startMs: 0, endMs: 4000, sourceStartMs: 6000 });
    const after = changeClipSpan(before, 0, 9000, SOURCE_MS);
    // only 4000ms of source remains after the 6000ms in-point
    expect(getClipSourceEndMs(after)).toBeLessThanOrEqual(SOURCE_MS);
  });
});

describe("timelineDurationMs", () => {
  it("falls back to the source duration when there are no clips", () => {
    expect(timelineDurationMs([], SOURCE_MS)).toBe(SOURCE_MS);
  });

  it("takes the furthest clip end, not the sum", () => {
    const clips = [
      clip({ id: "a", startMs: 0, endMs: 2000 }),
      clip({ id: "b", startMs: 3000, endMs: 4000 }),
    ];
    expect(timelineDurationMs(clips, SOURCE_MS)).toBe(4000);
  });
});

describe("clipsToTrims", () => {
  /** Each clip claims 1s of source, so everything between and after them is a gap. */
  it("trims everything the clips do not cover", () => {
    const clips = [
      clip({ id: "a", startMs: 0, endMs: 1000, sourceStartMs: 2000 }),
      clip({ id: "b", startMs: 1000, endMs: 2000, sourceStartMs: 5000 }),
    ];
    expect(clipsToTrims(clips, SOURCE_MS)).toEqual([
      { id: "trim-gap-1", startMs: 0, endMs: 2000 },
      { id: "trim-gap-2", startMs: 3000, endMs: 5000 },
      { id: "trim-gap-3", startMs: 6000, endMs: SOURCE_MS },
    ]);
  });

  it("returns nothing when a single clip covers the whole recording", () => {
    expect(clipsToTrims([clip({ endMs: SOURCE_MS })], SOURCE_MS)).toEqual([]);
  });

  /**
   * Source order is what matters, not timeline order: a clip dragged later on the
   * timeline can still read from earlier in the recording. Here the clip at the front
   * of the timeline reads from the end of the recording, so the gaps are the middle
   * and the tail — not the head.
   */
  it("walks source order even when the timeline order is reversed", () => {
    const clips = [
      clip({ id: "late", startMs: 1000, endMs: 2000, sourceStartMs: 0 }),
      clip({ id: "early", startMs: 0, endMs: 1000, sourceStartMs: 8000 }),
    ];
    expect(clipsToTrims(clips, SOURCE_MS)).toEqual([
      { id: "trim-gap-1", startMs: 1000, endMs: 8000 },
      { id: "trim-gap-2", startMs: 9000, endMs: SOURCE_MS },
    ]);
  });
});

function idFactory(): () => string {
  let n = 0;
  return () => `new-${++n}`;
}
