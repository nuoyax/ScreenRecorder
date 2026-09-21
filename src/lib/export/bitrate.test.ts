import { describe, expect, it } from "vitest";
import {
  EXPORT_QUALITIES,
  exportBitrateBps,
  formatBitrate,
  isQualitySuperior,
  sourceBitrateBps,
} from "./bitrate";

const SOURCE_1080P = { width: 1920, height: 1080 };

describe("sourceBitrateBps", () => {
  it("steps by resolution class", () => {
    expect(sourceBitrateBps(1280, 720)).toBe(8_000_000);
    expect(sourceBitrateBps(1920, 1080)).toBe(12_000_000);
    expect(sourceBitrateBps(3840, 2160)).toBe(45_000_000);
  });

  it("interpolates between 1080p and 4K instead of jumping", () => {
    const mid = sourceBitrateBps(2560, 1440);
    expect(mid).toBeGreaterThan(12_000_000);
    expect(mid).toBeLessThan(45_000_000);
  });

  it("never divides by zero on an empty frame", () => {
    expect(sourceBitrateBps(0, 0)).toBe(8_000_000);
  });
});

describe("isQualitySuperior", () => {
  it("accepts more pixels at the same bitrate", () => {
    expect(
      isQualitySuperior(
        { width: 1920, height: 1080, bitrateBps: 12_000_000 },
        { width: 1280, height: 720, bitrateBps: 12_000_000 },
      ),
    ).toBe(true);
  });

  it("rejects more pixels at a lower bitrate", () => {
    expect(
      isQualitySuperior(
        { width: 1920, height: 1080, bitrateBps: 5_000_000 },
        { width: 1280, height: 720, bitrateBps: 12_000_000 },
      ),
    ).toBe(false);
  });

  /** Same resolution only counts as an upgrade if it actually carries more data. */
  it("requires a strictly higher bitrate at equal resolution", () => {
    const same = { width: 1920, height: 1080 };
    expect(isQualitySuperior({ ...same, bitrateBps: 12_000_000 }, { ...same, bitrateBps: 12_000_000 })).toBe(false);
    expect(isQualitySuperior({ ...same, bitrateBps: 13_000_000 }, { ...same, bitrateBps: 12_000_000 })).toBe(true);
  });
});

describe("exportBitrateBps", () => {
  it("scales with pixel count at a fixed preset", () => {
    const hd = exportBitrateBps({
      width: 1920,
      height: 1080,
      fps: 30,
      quality: "high",
      source: SOURCE_1080P,
    });
    const qhd = exportBitrateBps({
      width: 2560,
      height: 1440,
      fps: 30,
      quality: "high",
      source: { width: 2560, height: 1440 },
    });
    expect(qhd).toBeGreaterThan(hd);
  });

  /**
   * √fps, not fps: a linear scale would double the file for no visible gain. Compared
   * at 30→60 with a source that keeps both ends clear of the source floor and the
   * output ceiling, so the frame-rate term is what is actually being measured.
   */
  it("scales with the square root of the frame rate", () => {
    const at = (fps: number) =>
      exportBitrateBps({
        width: 1920,
        height: 1080,
        fps,
        quality: "high",
        source: { width: 1280, height: 720 },
      });
    const ratio = at(60) / at(30);
    expect(ratio).toBeCloseTo(Math.SQRT2, 2);
    expect(ratio).toBeLessThan(2);
  });

  /**
   * The point of the ported rule: naming a low preset must not silently halve the
   * detail of a recording that already has more.
   */
  it("never encodes below what the source already carries", () => {
    const bps = exportBitrateBps({
      width: 1920,
      height: 1080,
      fps: 30,
      quality: "low",
      source: SOURCE_1080P,
    });
    expect(bps).toBeGreaterThanOrEqual(sourceBitrateBps(1920, 1080));
  });

  /** ...but a genuinely downscaled export may legitimately carry less. */
  it("allows a downscaled export to carry less than a 4K source", () => {
    const source = { width: 3840, height: 2160 };
    const bps = exportBitrateBps({
      width: 1280,
      height: 720,
      fps: 30,
      quality: "medium",
      source,
    });
    expect(bps).toBeLessThan(sourceBitrateBps(3840, 2160));
    expect(bps).toBeGreaterThanOrEqual(2_000_000);
  });

  it("returns the source rate for the source preset", () => {
    expect(
      exportBitrateBps({
        width: 1920,
        height: 1080,
        fps: 60,
        quality: "source",
        source: SOURCE_1080P,
      }),
    ).toBe(12_000_000);
  });

  it("honours an explicitly supplied source bitrate", () => {
    const bps = exportBitrateBps({
      width: 1920,
      height: 1080,
      fps: 30,
      quality: "source",
      source: { ...SOURCE_1080P, bitrateBps: 30_000_000 },
    });
    expect(bps).toBe(30_000_000);
  });

  it("keeps every preset inside sane bounds", () => {
    for (const preset of EXPORT_QUALITIES) {
      for (const [w, h] of [
        [640, 360],
        [1920, 1080],
        [7680, 4320],
      ]) {
        const bps = exportBitrateBps({
          width: w,
          height: h,
          fps: 144,
          quality: preset.id,
          source: { width: w, height: h },
        });
        expect(bps).toBeGreaterThanOrEqual(2_000_000);
        expect(bps).toBeLessThanOrEqual(160_000_000);
      }
    }
  });
});

describe("formatBitrate", () => {
  it("uses Mbps above a megabit and kbps below", () => {
    expect(formatBitrate(12_000_000)).toBe("12.0 Mbps");
    expect(formatBitrate(500_000)).toBe("500 kbps");
  });
});
