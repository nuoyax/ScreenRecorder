import { describe, expect, it } from "vitest";
import { MAX_SPAN_MS, WINDOW_MS, suggestZooms } from "./zoomSuggest";
import type { MoveSample } from "@/lib/api";

const CAPTURE = { x: 0, y: 0, width: 1920, height: 1080 };

/** A track sampled every 100ms, following `fn(i)`. */
function track(count: number, fn: (i: number) => { x: number; y: number }): MoveSample[] {
  return Array.from({ length: count }, (_, i) => ({
    t_us: i * 100_000,
    ...fn(i),
  }));
}

/** A pointer that walks 100px every 100ms: 1000px of travel per second. */
const sweeping = (count: number) => track(count, (i) => ({ x: i * 100, y: 540 }));

/** A pointer that never moves. */
const parked = (count: number) => track(count, () => ({ x: 500, y: 500 }));

/** A pointer drifting 10px every 100ms: 100px per second, under the travel bar. */
const drifting = (count: number) => track(count, (i) => ({ x: 500 + i * 10, y: 500 }));

const base = { capture: CAPTURE };

describe("suggestZooms", () => {
  it("suggests nothing without a track", () => {
    expect(suggestZooms([], { ...base, durationMs: 10_000 })).toEqual([]);
    expect(suggestZooms(parked(1), { ...base, durationMs: 10_000 })).toEqual([]);
  });

  it("suggests nothing when the recording is too short to hold a region", () => {
    expect(suggestZooms(sweeping(10), { ...base, durationMs: 100 })).toEqual([]);
  });

  it("merges a continuous sweep into a single region", () => {
    const out = suggestZooms(sweeping(31), { ...base, durationMs: 3000 });
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe("movement");
    expect(out[0].startMs).toBe(0);
    // Padded past the last sample, then clipped to the recording.
    expect(out[0].endMs).toBe(3000);
  });

  it("suggests a tighter zoom for a pointer that is parked", () => {
    const out = suggestZooms(parked(51), { ...base, durationMs: 5000 });
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe("stillness");
    // A moment the viewer is staring at earns a tighter crop than a fast traversal.
    expect(out[0].depth).toBeGreaterThan(
      suggestZooms(sweeping(31), { ...base, durationMs: 3000 })[0].depth,
    );
  });

  it("stays quiet when the pointer moves a medium amount", () => {
    // Neither "went somewhere" nor "stayed put" — a suggestion here would be noise.
    expect(suggestZooms(drifting(51), { ...base, durationMs: 5000 })).toEqual([]);
  });

  it("caps how long one suggestion may be", () => {
    const out = suggestZooms(sweeping(201), { ...base, durationMs: 20_000 });
    expect(out.length).toBeGreaterThan(1);
    for (const region of out) {
      expect(region.endMs - region.startMs).toBeLessThanOrEqual(MAX_SPAN_MS);
    }
  });

  it("never suggests outside the recording", () => {
    const out = suggestZooms(sweeping(31), { ...base, durationMs: 2000 });
    for (const region of out) {
      expect(region.startMs).toBeGreaterThanOrEqual(0);
      expect(region.endMs).toBeLessThanOrEqual(2000);
    }
  });

  it("focuses inside the capture rectangle", () => {
    const out = suggestZooms(sweeping(31), {
      capture: { x: 1920, y: 0, width: 1920, height: 1080 },
      durationMs: 3000,
    });
    for (const region of out) {
      // The sweep runs from x=0 to x=3000 in a frame starting at x=1920, so it is
      // mostly to the left of the capture and the focus clamps at the edge.
      expect(region.focus.cx).toBeGreaterThanOrEqual(0);
      expect(region.focus.cx).toBeLessThanOrEqual(1);
      expect(region.focus.cy).toBeGreaterThanOrEqual(0);
      expect(region.focus.cy).toBeLessThanOrEqual(1);
    }
  });

  it("splits two moments separated by a long pause", () => {
    // 2s of sweeping, then 3s of nothing, then 2s of sweeping.
    const moves: MoveSample[] = [
      ...track(21, (i) => ({ t_us: i * 100_000, x: i * 100, y: 540 }) as MoveSample),
      ...track(31, (i) => ({ t_us: 2_000_000 + i * 100_000, x: 2000, y: 540 }) as MoveSample),
      ...Array.from({ length: 21 }, (_, i) => ({
        t_us: 5_000_000 + i * 100_000,
        x: 2000 + i * 100,
        y: 540,
      })),
    ];
    const out = suggestZooms(moves, { ...base, durationMs: 8000 });
    // The sweep, the parked stretch and the second sweep are distinct moments, so the
    // output must not collapse into one region spanning the whole recording.
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].endMs).toBeLessThan(8000);
  });

  it("honours caller-supplied thresholds", () => {
    // The same sweep read through a window too short to accumulate travel, and through
    // one that will not call anything movement at all.
    expect(
      suggestZooms(sweeping(31), { ...base, durationMs: 3000, windowMs: WINDOW_MS / 4 }),
    ).toEqual([]);
    expect(
      suggestZooms(sweeping(31), {
        ...base,
        durationMs: 3000,
        travelThresholdPx: 1e9,
        stillThresholdPx: -1,
      }),
    ).toEqual([]);
  });
});
