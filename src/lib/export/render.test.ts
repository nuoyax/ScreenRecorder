import { describe, expect, it } from "vitest";
import { delayCsFor, fitFrameRate, frameTimes } from "./render";

describe("frameTimes", () => {
  it("samples the timeline at the requested rate", () => {
    const times = frameTimes(2000, 10, 1000);
    expect(times).toHaveLength(20);
    expect(times[0]).toBe(0);
    // Every sample is inside the timeline; a frame at exactly `totalMs` reads past the
    // end and would show the final frame twice.
    expect(Math.max(...times)).toBeLessThan(2000);
  });

  it("refuses a degenerate request instead of guessing", () => {
    expect(frameTimes(0, 30, 600)).toEqual([]);
    expect(frameTimes(1000, 0, 600)).toEqual([]);
    expect(frameTimes(-5, 30, 600)).toEqual([]);
  });

  /** Two frames is the floor: one frame is a still, and the GIF writer refuses it. */
  it("keeps at least two samples for a very short timeline", () => {
    expect(frameTimes(10, 1, 600)).toHaveLength(2);
  });
});

describe("fitFrameRate", () => {
  it("leaves a short export at the requested rate", () => {
    const fit = fitFrameRate(10_000, 15, 600);
    expect(fit.frames).toBe(150);
    expect(fit.reduced).toBe(false);
    expect(fit.fps).toBe(15);
  });

  /**
   * The whole point of the budget: a long recording gets fewer frames and is told so,
   * rather than being truncated without anyone noticing.
   */
  it("lowers the rate when the frame budget bites", () => {
    const fit = fitFrameRate(120_000, 30, 600);
    expect(fit.frames).toBe(600);
    expect(fit.reduced).toBe(true);
    expect(fit.fps).toBe(5);
  });

  /** The effective rate has to describe the frames actually produced. */
  it("reports a rate that matches the frame count", () => {
    const fit = fitFrameRate(60_000, 30, 600);
    const implied = (fit.frames * 1000) / 60_000;
    expect(fit.fps).toBeCloseTo(implied, 2);
  });

  it("never reports a rate above what was asked for", () => {
    for (const total of [500, 5000, 50_000, 500_000]) {
      expect(fitFrameRate(total, 12, 600).fps).toBeLessThanOrEqual(12);
    }
  });
});

describe("delayCsFor", () => {
  it("converts a rate to hundredths of a second", () => {
    expect(delayCsFor(10)).toBe(10);
    expect(delayCsFor(20)).toBe(5);
    expect(delayCsFor(25)).toBe(4);
  });

  /**
   * Zero means "no delay" to a viewer, which plays the animation at whatever speed the
   * viewer likes — never what was intended.
   */
  it("never returns zero, however high the rate", () => {
    expect(delayCsFor(1000)).toBeGreaterThanOrEqual(2);
    expect(delayCsFor(0)).toBe(8);
    expect(delayCsFor(-1)).toBe(8);
    expect(delayCsFor(Number.NaN)).toBe(8);
  });
});
