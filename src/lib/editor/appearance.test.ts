import { describe, expect, it } from "vitest";
import { drawFrame, sampleAt, type AppearanceOptions } from "./appearance";
import { DEFAULT_BACKGROUND, ZOOM_DEPTH_SCALES } from "@/lib/timeline/types";
import type { MoveSample } from "@/lib/api";

/**
 * A recording stub that records what was drawn instead of rasterizing.
 *
 * Canvas has no DOM in this environment, and the values that matter here — where the
 * source rectangle came from, in what order things were painted — are all visible in
 * the call sequence rather than in pixels.
 */
function fakeContext() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const record =
    (op: string) =>
    (...args: unknown[]) => {
      calls.push({ op, args });
    };
  const ctx = {
    save: record("save"),
    restore: record("restore"),
    clearRect: record("clearRect"),
    fillRect: record("fillRect"),
    beginPath: record("beginPath"),
    closePath: record("closePath"),
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    arcTo: record("arcTo"),
    arc: record("arc"),
    fill: record("fill"),
    stroke: record("stroke"),
    clip: record("clip"),
    translate: record("translate"),
    rotate: record("rotate"),
    measureText: (text: string) => ({ width: text.length * 10 }),
    fillText: record("fillText"),
    drawImage: record("drawImage"),
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    lineCap: "",
    font: "",
    textAlign: "",
    textBaseline: "",
    shadowColor: "",
    shadowBlur: 0,
    globalAlpha: 1,
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const image = { width: 1920, height: 1080 } as unknown as CanvasImageSource;

function baseOptions(over: Partial<AppearanceOptions> = {}): AppearanceOptions {
  return {
    background: { ...DEFAULT_BACKGROUND, color: "#000000", shadow: false },
    crop: { x: 0, y: 0, width: 1, height: 1 },
    zoom: null,
    annotations: [],
    timeMs: 0,
    sourceTimeMs: 0,
    moves: [],
    clicks: [],
    captureOrigin: { x: 0, y: 0, width: 1920, height: 1080 },
    showCursor: false,
    clickHighlight: false,
    ...over,
  };
}

const SOURCE = { image, imageWidth: 1920, imageHeight: 1080 };

function draws(calls: Array<{ op: string; args: unknown[] }>) {
  return calls.filter((c) => c.op === "drawImage");
}

describe("drawFrame", () => {
  it("paints the background before the video", () => {
    const { ctx, calls } = fakeContext();
    drawFrame(ctx, 1920, 1080, SOURCE, baseOptions());
    const bg = calls.findIndex((c) => c.op === "fillRect");
    const video = calls.findIndex((c) => c.op === "drawImage");
    expect(bg).toBeGreaterThanOrEqual(0);
    expect(video).toBeGreaterThan(bg);
  });

  it("draws the video inset by the background padding", () => {
    const { ctx, calls } = fakeContext();
    drawFrame(ctx, 1000, 1000, SOURCE, baseOptions({
      background: { ...DEFAULT_BACKGROUND, padding: 0.1, shadow: false },
    }));
    // Drawn with the source-rect form, so the destination is args[5..8].
    const [draw] = draws(calls);
    expect(draw.args[5]).toBeCloseTo(100);
    expect(draw.args[6]).toBeCloseTo(100);
    expect(draw.args[7]).toBeCloseTo(800);
    expect(draw.args[8]).toBeCloseTo(800);
  });

  /** Zoom is a crop of the source, not a scaled-up draw, so the scale stays real. */
  it("crops the source rectangle when zoomed", () => {
    const { ctx, calls } = fakeContext();
    const depth = 4;
    drawFrame(ctx, 1920, 1080, SOURCE, baseOptions({
      zoom: { id: "z", startMs: 0, endMs: 1000, depth, focus: { cx: 0.5, cy: 0.5 } },
    }));
    const [draw] = draws(calls);
    const scale = ZOOM_DEPTH_SCALES[depth];
    expect(draw.args[3]).toBeCloseTo(1920 / scale);
    expect(draw.args[4]).toBeCloseTo(1080 / scale);
    // centred on the focus point
    expect(Number(draw.args[1]) + Number(draw.args[3]) / 2).toBeCloseTo(960);
    expect(Number(draw.args[2]) + Number(draw.args[4]) / 2).toBeCloseTo(540);
  });

  it("keeps a zoomed crop inside the source when the focus is at an edge", () => {
    const { ctx, calls } = fakeContext();
    drawFrame(ctx, 1920, 1080, SOURCE, baseOptions({
      zoom: { id: "z", startMs: 0, endMs: 1000, depth: 4, focus: { cx: 0, cy: 1 } },
    }));
    const [draw] = draws(calls);
    expect(Number(draw.args[1])).toBeGreaterThanOrEqual(0);
    expect(Number(draw.args[2])).toBeGreaterThanOrEqual(0);
    expect(Number(draw.args[1]) + Number(draw.args[3])).toBeLessThanOrEqual(1920.01);
    expect(Number(draw.args[2]) + Number(draw.args[4])).toBeLessThanOrEqual(1080.01);
  });

  it("draws the whole source when unzoomed", () => {
    const { ctx, calls } = fakeContext();
    // No padding, so the destination box is the whole canvas.
    drawFrame(ctx, 1920, 1080, SOURCE, baseOptions({
      background: { ...DEFAULT_BACKGROUND, padding: 0, shadow: false },
    }));
    const [draw] = draws(calls);
    expect(draw.args.slice(5, 9)).toEqual([0, 0, 1920, 1080]);
  });

  /**
   * An uncropped, unzoomed frame passes the source rectangle explicitly rather than
   * using the 5-argument form. Not just a style choice: the two forms are equivalent
   * only when the crop happens to cover the whole image, and spelling it out keeps the
   * cursor mapping below honest about which sub-rectangle the frame is showing.
   */
  it("names the source rectangle even when it is the whole image", () => {
    const { ctx, calls } = fakeContext();
    drawFrame(ctx, 1920, 1080, SOURCE, baseOptions());
    expect(draws(calls)[0].args.slice(1, 5)).toEqual([0, 0, 1920, 1080]);
  });

  /** A crop reads a sub-rectangle out of the source and stretches it to the box. */
  it("reads the cropped sub-rectangle out of the source", () => {
    const { ctx, calls } = fakeContext();
    drawFrame(ctx, 1920, 1080, SOURCE, baseOptions({
      background: { ...DEFAULT_BACKGROUND, padding: 0, shadow: false },
      crop: { x: 0.25, y: 0.1, width: 0.5, height: 0.5 },
    }));
    const [draw] = draws(calls);
    expect(draw.args[1]).toBeCloseTo(480);
    expect(draw.args[2]).toBeCloseTo(108);
    expect(draw.args[3]).toBeCloseTo(960);
    expect(draw.args[4]).toBeCloseTo(540);
    expect(draw.args.slice(5, 9)).toEqual([0, 0, 1920, 1080]);
  });

  it("skips the video entirely when the source has no size yet", () => {
    const { ctx, calls } = fakeContext();
    drawFrame(ctx, 1920, 1080, { ...SOURCE, imageWidth: 0, imageHeight: 0 }, baseOptions());
    expect(draws(calls)).toHaveLength(0);
  });

  it("draws an annotation after the video", () => {
    const { ctx, calls } = fakeContext();
    drawFrame(ctx, 1920, 1080, SOURCE, baseOptions({
      annotations: [
        {
          id: "a",
          startMs: 0,
          endMs: 1000,
          type: "text",
          textContent: "hi",
          position: { x: 0.5, y: 0.5 },
          size: { width: 0.3, height: 0.1 },
          style: {
            color: "#fff",
            backgroundColor: "transparent",
            fontSize: 32,
            fontWeight: "bold",
            textAlign: "center",
          },
          rotation: 0,
        },
      ],
    }));
    const video = calls.findIndex((c) => c.op === "drawImage");
    const text = calls.findIndex((c) => c.op === "fillText");
    expect(text).toBeGreaterThan(video);
  });

  it("draws a cursor glyph only when the cursor is enabled", () => {
    const moves: MoveSample[] = [{ t_us: 0, x: 960, y: 540 }];
    const off = fakeContext();
    drawFrame(off.ctx, 1920, 1080, SOURCE, baseOptions({ moves, timeMs: 0, showCursor: false }));
    const on = fakeContext();
    drawFrame(on.ctx, 1920, 1080, SOURCE, baseOptions({ moves, timeMs: 0, showCursor: true }));
    expect(draws(off.calls)).toHaveLength(1);
    expect(draws(on.calls)).toHaveLength(1);
    // the glyph is a filled path, so it shows up as an extra `fill`
    expect(on.calls.filter((c) => c.op === "fill").length).toBeGreaterThan(
      off.calls.filter((c) => c.op === "fill").length,
    );
  });

  /** A cursor outside the recorded rectangle has no valid place in the frame. */
  it("skips a cursor sample outside the recorded rectangle", () => {
    const { ctx, calls } = fakeContext();
    drawFrame(ctx, 1920, 1080, SOURCE, baseOptions({
      moves: [{ t_us: 0, x: 5000, y: 5000 }],
      timeMs: 0,
      showCursor: true,
    }));
    expect(calls.filter((c) => c.op === "arc")).toHaveLength(0);
  });

  it("draws a click ripple inside its window and not after it", () => {
    const clicks = [{ t_us: 0, x: 960, y: 540, button: "left" }];
    const during = fakeContext();
    drawFrame(during.ctx, 1920, 1080, SOURCE, baseOptions({
      clicks,
      timeMs: 200,
      sourceTimeMs: 200,
      showCursor: true,
      clickHighlight: true,
    }));
    const after = fakeContext();
    drawFrame(after.ctx, 1920, 1080, SOURCE, baseOptions({
      clicks,
      timeMs: 5000,
      sourceTimeMs: 5000,
      showCursor: true,
      clickHighlight: true,
    }));
    expect(during.calls.some((c) => c.op === "arc")).toBe(true);
    expect(after.calls.some((c) => c.op === "arc")).toBe(false);
  });

  /**
   * The cursor track is stamped against the recording, so after a trim the timeline
   * position and the source position are different numbers. Reading the track at the
   * timeline position would slide every click by however much was trimmed off the front
   * — here, a click two seconds in is simply outside a frame taken at source time zero.
   */
  it("reads the cursor track at the source time, not the timeline time", () => {
    // 2 s into the recording, in the track's own microsecond clock.
    const clicks = [{ t_us: 2_000_000, x: 960, y: 540, button: "left" }];
    const timedToTimeline = fakeContext();
    drawFrame(timedToTimeline.ctx, 1920, 1080, SOURCE, baseOptions({
      clicks,
      timeMs: 2000,
      sourceTimeMs: 0,
      showCursor: true,
      clickHighlight: true,
    }));
    const timedToSource = fakeContext();
    drawFrame(timedToSource.ctx, 1920, 1080, SOURCE, baseOptions({
      clicks,
      timeMs: 0,
      sourceTimeMs: 2000,
      showCursor: true,
      clickHighlight: true,
    }));
    expect(timedToTimeline.calls.some((c) => c.op === "arc")).toBe(false);
    expect(timedToSource.calls.some((c) => c.op === "arc")).toBe(true);
  });

  /** A cursor that the crop cut away must not be drawn floating at the frame edge. */
  it("skips a cursor sample outside the crop", () => {
    const { ctx, calls } = fakeContext();
    drawFrame(ctx, 1920, 1080, SOURCE, baseOptions({
      // Top-left of the source, which a right-half crop does not show.
      moves: [{ t_us: 0, x: 100, y: 100 }],
      timeMs: 0,
      sourceTimeMs: 0,
      showCursor: true,
      crop: { x: 0.5, y: 0, width: 0.5, height: 1 },
    }));
    expect(calls.filter((c) => c.op === "fill").length).toBe(0);
  });

  it("does not draw ripples when click highlighting is off", () => {
    const { ctx, calls } = fakeContext();
    drawFrame(ctx, 1920, 1080, SOURCE, baseOptions({
      clicks: [{ t_us: 0, x: 960, y: 540, button: "left" }],
      timeMs: 100,
      showCursor: true,
      clickHighlight: false,
    }));
    expect(calls.some((c) => c.op === "arc")).toBe(false);
  });

  it("leaves the context stack balanced", () => {
    const { ctx, calls } = fakeContext();
    drawFrame(ctx, 1920, 1080, SOURCE, baseOptions());
    const saves = calls.filter((c) => c.op === "save").length;
    const restores = calls.filter((c) => c.op === "restore").length;
    expect(saves).toBe(restores);
  });
});

describe("sampleAt", () => {
  const moves: MoveSample[] = [
    { t_us: 0, x: 0, y: 0 },
    { t_us: 8000, x: 1, y: 1 },
    { t_us: 16_000, x: 2, y: 2 },
    { t_us: 24_000, x: 3, y: 3 },
  ];

  it("returns null for an empty track", () => {
    expect(sampleAt([], 100)).toBeNull();
  });

  /** The sample at or before the moment is the position the cursor was last at. */
  it("finds the sample at or before the time", () => {
    expect(sampleAt(moves, 0)?.x).toBe(0);
    expect(sampleAt(moves, 8)?.x).toBe(1);
    expect(sampleAt(moves, 15.9)?.x).toBe(1);
    expect(sampleAt(moves, 16)?.x).toBe(2);
  });

  it("clamps outside the track instead of returning null", () => {
    expect(sampleAt(moves, -100)?.x).toBe(0);
    expect(sampleAt(moves, 99_999)?.x).toBe(3);
  });

  it("stays correct on a large track", () => {
    const big: MoveSample[] = Array.from({ length: 5000 }, (_, i) => ({
      t_us: i * 8000,
      x: i,
      y: i,
    }));
    expect(sampleAt(big, 1000)?.x).toBe(125);
    expect(sampleAt(big, 0)?.x).toBe(0);
    expect(sampleAt(big, 4999 * 8)?.x).toBe(4999);
  });
});
