import { describe, expect, it } from "vitest";
import { clamp, formatTimecode, formatTimecodeMs, frameCount, frameFromMs, msFromFrame, snapToFrame } from "./time";

describe("frameFromMs / msFromFrame", () => {
  it("round-trips a frame boundary", () => {
    for (const fps of [15, 30, 60]) {
      for (const frame of [0, 1, 29, 100, 1234]) {
        expect(frameFromMs(msFromFrame(frame, fps), fps)).toBe(frame);
      }
    }
  });

  /** Partway into frame 3 is still frame 3; rounding would skip ahead. */
  it("floors instead of rounding", () => {
    expect(frameFromMs(33.4, 30)).toBe(1);
    expect(frameFromMs(33.2, 30)).toBe(0);
    expect(frameFromMs(999, 30)).toBe(29);
  });

  it("treats a non-positive fps as frame 0 rather than dividing by zero", () => {
    expect(frameFromMs(1000, 0)).toBe(0);
    expect(frameFromMs(NaN, 30)).toBe(0);
    expect(msFromFrame(10, -1)).toBe(0);
  });
});

describe("snapToFrame", () => {
  it("lands exactly on a frame boundary", () => {
    const fps = 30;
    for (const ms of [0, 7, 16.6, 33.3, 12345]) {
      const snapped = snapToFrame(ms, fps);
      expect(snapped).toBe(msFromFrame(frameFromMs(snapped, fps), fps));
    }
  });

  it("never moves a boundary forward past its own frame", () => {
    expect(snapToFrame(35, 30)).toBeCloseTo(33.333, 2);
  });
});

describe("frameCount", () => {
  it("counts the frames a duration needs", () => {
    expect(frameCount(1000, 30)).toBe(30);
    expect(frameCount(0, 30)).toBe(0);
  });

  /** A duration ending mid-frame still needs that final frame emitted. */
  it("rounds up for a partial final frame", () => {
    expect(frameCount(1010, 30)).toBe(31);
    expect(frameCount(1, 30)).toBe(1);
  });
});

describe("formatTimecode", () => {
  it("formats under an hour as mm:ss", () => {
    expect(formatTimecode(0)).toBe("00:00");
    expect(formatTimecode(65_000)).toBe("01:05");
    expect(formatTimecode(3_599_000)).toBe("59:59");
  });

  it("adds hours only once there are hours", () => {
    expect(formatTimecode(3_600_000)).toBe("1:00:00");
    expect(formatTimecode(3_725_000)).toBe("1:02:05");
  });

  it("clamps negatives rather than printing a minus sign", () => {
    expect(formatTimecode(-5000)).toBe("00:00");
  });

  it("keeps milliseconds in the ms variant", () => {
    expect(formatTimecodeMs(1500)).toBe("00:01.500");
  });
});

describe("clamp", () => {
  it("bounds a value and resolves NaN to the minimum", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(NaN, 2, 10)).toBe(2);
  });
});
