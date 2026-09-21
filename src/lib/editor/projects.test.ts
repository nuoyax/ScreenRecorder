import { describe, expect, it } from "vitest";
import { projectPathFor, sanitize, serialize } from "./projects";
import { emptyProject, type Project } from "./state";

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

describe("projectPathFor", () => {
  it("swaps the media extension for the project one", () => {
    expect(projectPathFor("C:/tmp/recording_1.mp4")).toBe("C:/tmp/recording_1.srec.json");
  });

  it("only strips the final extension", () => {
    expect(projectPathFor("C:/my.folder/clip.v2.mp4")).toBe("C:/my.folder/clip.v2.srec.json");
  });

  it("handles windows separators", () => {
    expect(projectPathFor("C:\\tmp\\a.mp4")).toBe("C:\\tmp\\a.srec.json");
  });
});

describe("serialize / sanitize round trip", () => {
  it("restores what it wrote", () => {
    const original: Project = {
      ...project(),
      zooms: [{ id: "z1", startMs: 1000, endMs: 3000, depth: 4, focus: { cx: 0.2, cy: 0.7 } }],
    };
    expect(sanitize(JSON.parse(serialize(original)))).toEqual(original);
  });

  /** A project file is text a user can hand around; a bad one must not be fatal. */
  it("returns null for input that cannot be a project", () => {
    expect(sanitize(null)).toBeNull();
    expect(sanitize([])).toBeNull();
    expect(sanitize("nope")).toBeNull();
    expect(sanitize({})).toBeNull();
  });

  it("rejects an unknown format version rather than guessing", () => {
    expect(sanitize({ ...project(), version: 99 })).toBeNull();
    expect(sanitize({ ...project(), version: "1" })).toBeNull();
  });

  it("rejects a project with no usable source", () => {
    expect(sanitize({ ...project(), sourcePath: "" })).toBeNull();
    expect(sanitize({ ...project(), sourceDurationMs: 0 })).toBeNull();
    expect(sanitize({ ...project(), sourceDurationMs: "long" })).toBeNull();
  });
});

describe("sanitize repairs a damaged project", () => {
  it("drops clips with an inverted or empty span", () => {
    const p = sanitize({
      ...project(),
      clips: [
        { id: "a", startMs: 0, endMs: 1000, speed: 1 },
        { id: "b", startMs: 5000, endMs: 4000, speed: 1 },
        { id: "c", startMs: 2000, endMs: 2000, speed: 1 },
      ],
    })!;
    expect(p.clips.map((c) => c.id)).toEqual(["a"]);
  });

  /** An unusable clip list must fall back to a full-length clip, not an empty one. */
  it("falls back to one full-length clip when none survive", () => {
    const p = sanitize({ ...project(), clips: "garbage" })!;
    expect(p.clips).toEqual([{ id: "clip-1", startMs: 0, endMs: SOURCE_MS, speed: 1 }]);
  });

  it("clamps a bogus speed instead of leaving it at zero", () => {
    const p = sanitize({
      ...project(),
      clips: [{ id: "a", startMs: 0, endMs: 1000, speed: 0 }],
    })!;
    expect(p.clips[0].speed).toBeGreaterThan(0);
  });

  /** A stale project may name a source in-point the recording no longer has. */
  it("drops a source in-point outside the recording", () => {
    const p = sanitize({
      ...project(),
      clips: [{ id: "a", startMs: 0, endMs: 1000, speed: 1, sourceStartMs: 999_999 }],
    })!;
    expect(p.clips[0].sourceStartMs).toBeUndefined();
  });

  it("keeps a valid source in-point", () => {
    const p = sanitize({
      ...project(),
      clips: [{ id: "a", startMs: 0, endMs: 1000, speed: 1, sourceStartMs: 4000 }],
    })!;
    expect(p.clips[0].sourceStartMs).toBe(4000);
  });

  /**
   * A zero or out-of-frame crop would divide by zero in the compositor's cursor mapping
   * or ask `drawImage` for pixels that are not there, so it is repaired rather than
   * trusted.
   */
  it("repairs a crop that would collapse or leave the frame", () => {
    const collapsed = sanitize({ ...project(), crop: { x: 0, y: 0, width: 0, height: 0 } })!;
    expect(collapsed.crop.width).toBeGreaterThan(0);
    expect(collapsed.crop.height).toBeGreaterThan(0);

    const escaped = sanitize({ ...project(), crop: { x: 9, y: 9, width: 0.5, height: 0.5 } })!;
    expect(escaped.crop.x).toBeLessThanOrEqual(1 - escaped.crop.width + 1e-9);
    expect(escaped.crop.y).toBeLessThanOrEqual(1 - escaped.crop.height + 1e-9);
  });

  it("defaults a missing crop to the whole frame", () => {
    expect(sanitize(project())!.crop).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("clamps zoom depth and focus into range", () => {
    const p = sanitize({
      ...project(),
      zooms: [
        { id: "z", startMs: 0, endMs: 1000, depth: 99, focus: { cx: -3, cy: 7 } },
      ],
    })!;
    expect(p.zooms[0].depth).toBe(6);
    expect(p.zooms[0].focus).toEqual({ cx: 0, cy: 1 });
  });

  it("drops zoom and annotation regions that sit outside the timeline", () => {
    const p = sanitize({
      ...project(),
      zooms: [{ id: "z", startMs: 20_000, endMs: 30_000, depth: 3, focus: { cx: 0.5, cy: 0.5 } }],
      annotations: [
        {
          id: "a",
          startMs: 500,
          endMs: 1500,
          type: "text",
          textContent: "hi",
          position: { x: 0.5, y: 0.5 },
          size: { width: 0.3, height: 0.1 },
          style: {},
        },
      ],
    })!;
    expect(p.zooms).toHaveLength(0);
    expect(p.annotations).toHaveLength(1);
  });

  it("fills in a missing annotation style rather than leaving undefined fields", () => {
    const p = sanitize({
      ...project(),
      annotations: [
        {
          id: "a",
          startMs: 0,
          endMs: 1000,
          type: "text",
          textContent: "hi",
          position: { x: 0.5, y: 0.5 },
          size: { width: 0.3, height: 0.1 },
        },
      ],
    })!;
    expect(p.annotations[0].style.fontSize).toBeGreaterThan(0);
    expect(p.annotations[0].style.fontWeight).toBe("bold");
    expect(p.annotations[0].style.textAlign).toBe("center");
  });

  it("treats an unknown annotation type as text", () => {
    const p = sanitize({
      ...project(),
      annotations: [
        {
          id: "a",
          startMs: 0,
          endMs: 1000,
          type: "lava",
          textContent: "hi",
          position: { x: 0.5, y: 0.5 },
          size: { width: 0.3, height: 0.1 },
        },
      ],
    })!;
    expect(p.annotations[0].type).toBe("text");
  });

  it("clamps background padding and radius", () => {
    const p = sanitize({
      ...project(),
      background: { color: "#000", gradient: "#fff", padding: 9, radius: 9, shadow: true },
    })!;
    expect(p.background.padding).toBe(0.25);
    expect(p.background.radius).toBe(0.5);
  });

  it("repairs a non-numeric fps", () => {
    expect(sanitize({ ...project(), fps: "fast" })!.fps).toBe(30);
    expect(sanitize({ ...project(), fps: 9999 })!.fps).toBe(240);
  });
});
