import { describe, expect, it } from "vitest";
import { MIN_SPAN_MS, coveredMs, fitSpan, moveSpan, resizeSpan, spanContains, spansOverlap } from "./span";

describe("fitSpan", () => {
  it("keeps a span that already fits", () => {
    expect(fitSpan(1000, 2000, 10_000)).toEqual({ startMs: 1000, endMs: 2000 });
  });

  it("orders inverted input instead of producing a negative span", () => {
    expect(fitSpan(2000, 1000, 10_000)).toEqual({ startMs: 1000, endMs: 2000 });
  });

  it("clamps to the recording", () => {
    expect(fitSpan(-500, 500, 10_000)).toEqual({ startMs: 0, endMs: 500 });
    expect(fitSpan(9000, 20_000, 10_000)).toEqual({ startMs: 9000, endMs: 10_000 });
  });

  it("grows a too-short span to the minimum", () => {
    const span = fitSpan(1000, 1010, 10_000)!;
    expect(span.endMs - span.startMs).toBe(MIN_SPAN_MS);
  });

  /** At the very end there is no room after the span, so it must grow backwards. */
  it("grows backwards when the span sits at the end of the recording", () => {
    const span = fitSpan(9950, 9960, 10_000)!;
    expect(span.endMs).toBe(10_000);
    expect(span.startMs).toBe(10_000 - MIN_SPAN_MS);
  });

  it("refuses when the recording is shorter than the minimum", () => {
    expect(fitSpan(0, 50, 100)).toBeNull();
    expect(fitSpan(NaN, 100, 10_000)).toBeNull();
  });
});

describe("moveSpan", () => {
  it("shifts by the delta and keeps the length", () => {
    const moved = moveSpan({ startMs: 1000, endMs: 2000 }, 500, 10_000);
    expect(moved).toEqual({ startMs: 1500, endMs: 2500 });
  });

  it("stops at the start of the recording", () => {
    expect(moveSpan({ startMs: 100, endMs: 600 }, -1000, 10_000)).toEqual({
      startMs: 0,
      endMs: 500,
    });
  });

  it("stops at the end of the recording without shrinking", () => {
    const moved = moveSpan({ startMs: 9000, endMs: 9500 }, 5000, 10_000);
    expect(moved).toEqual({ startMs: 9500, endMs: 10_000 });
  });
});

describe("resizeSpan", () => {
  it("drags the start edge", () => {
    expect(resizeSpan({ startMs: 1000, endMs: 3000 }, "start", 1500, 10_000)).toEqual({
      startMs: 1500,
      endMs: 3000,
    });
  });

  it("drags the end edge", () => {
    expect(resizeSpan({ startMs: 1000, endMs: 3000 }, "end", 2500, 10_000)).toEqual({
      startMs: 1000,
      endMs: 2500,
    });
  });

  /** Dragging one edge past the other would produce an inverted span. */
  it("refuses to invert the span", () => {
    const a = resizeSpan({ startMs: 1000, endMs: 3000 }, "start", 9999, 10_000);
    expect(a.endMs - a.startMs).toBe(MIN_SPAN_MS);
    const b = resizeSpan({ startMs: 1000, endMs: 3000 }, "end", 0, 10_000);
    expect(b.endMs - b.startMs).toBe(MIN_SPAN_MS);
  });

  it("refuses to leave the recording", () => {
    expect(resizeSpan({ startMs: 0, endMs: 1000 }, "start", -500, 10_000).startMs).toBe(0);
    expect(resizeSpan({ startMs: 9000, endMs: 9500 }, "end", 20_000, 10_000).endMs).toBe(
      10_000,
    );
  });
});

describe("spanContains / spansOverlap", () => {
  const span = { startMs: 1000, endMs: 2000 };

  /** The end is exclusive so adjacent spans do not both claim the same instant. */
  it("treats the end as exclusive", () => {
    expect(spanContains(span, 1000)).toBe(true);
    expect(spanContains(span, 1999)).toBe(true);
    expect(spanContains(span, 2000)).toBe(false);
  });

  it("does not report touching spans as overlapping", () => {
    expect(spansOverlap(span, { startMs: 2000, endMs: 3000 })).toBe(false);
    expect(spansOverlap(span, { startMs: 1999, endMs: 3000 })).toBe(true);
  });
});

describe("coveredMs", () => {
  it("is zero for no spans", () => {
    expect(coveredMs([])).toBe(0);
  });

  /** Counting overlapping spans twice would overstate how much is zoomed. */
  it("counts an overlap once", () => {
    expect(
      coveredMs([
        { startMs: 0, endMs: 2000 },
        { startMs: 1000, endMs: 3000 },
      ]),
    ).toBe(3000);
  });

  it("adds disjoint spans", () => {
    expect(
      coveredMs([
        { startMs: 5000, endMs: 6000 },
        { startMs: 0, endMs: 2000 },
      ]),
    ).toBe(3000);
  });

  it("handles a span fully contained in another", () => {
    expect(
      coveredMs([
        { startMs: 0, endMs: 5000 },
        { startMs: 1000, endMs: 2000 },
      ]),
    ).toBe(5000);
  });
});
