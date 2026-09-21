import { describe, expect, it } from "vitest";
import { exportDirFor, exportNameFor, joinPath, splitPath } from "./paths";

describe("splitPath", () => {
  it("splits on either separator", () => {
    expect(splitPath("C:\\vids\\rec.mp4")).toEqual({ dir: "C:\\vids\\", name: "rec.mp4" });
    expect(splitPath("C:/vids/rec.mp4")).toEqual({ dir: "C:/vids/", name: "rec.mp4" });
  });

  /** A path with no separator is a bare file name, not a directory. */
  it("reports no directory for a bare name", () => {
    expect(splitPath("rec.mp4")).toEqual({ dir: "", name: "rec.mp4" });
  });

  /**
   * The extended-length prefix keeps its backslashes; splitting on the forward slash only
   * would leave the whole path as the "name".
   */
  it("handles an extended-length path", () => {
    const { dir, name } = splitPath("\\\\?\\C:\\vids\\rec.mp4");
    expect(name).toBe("rec.mp4");
    expect(dir).toBe("\\\\?\\C:\\vids\\");
  });

  /** The trailing separator is kept, so a drive root survives being rejoined. */
  it("keeps the separator on the directory", () => {
    expect(splitPath("C:\\rec.mp4").dir).toBe("C:\\");
    expect(joinPath(splitPath("C:\\rec.mp4").dir, "out.gif")).toBe("C:\\out.gif");
  });
});

describe("joinPath", () => {
  it("does not double the separator", () => {
    expect(joinPath("C:\\vids\\", "a.gif")).toBe("C:\\vids\\a.gif");
  });

  it("adds one when it is missing", () => {
    expect(joinPath("C:\\vids", "a.gif")).toBe("C:\\vids\\a.gif");
  });

  it("returns the name alone for an empty directory", () => {
    expect(joinPath("", "a.gif")).toBe("a.gif");
  });
});

describe("exportDirFor", () => {
  it("puts an export beside its recording", () => {
    expect(exportDirFor("C:\\vids\\rec.mp4")).toBe("C:\\vids\\");
  });

  /** A bare name has no directory; the current one is the only honest answer. */
  it("falls back to the current directory", () => {
    expect(exportDirFor("rec.mp4")).toBe(".");
  });
});

describe("exportNameFor", () => {
  /** A doubled extension (`holiday.mp4-gif.gif`) looks like a bug every time. */
  it("replaces the source extension", () => {
    expect(exportNameFor("C:\\vids\\holiday.mp4", "-anim", "gif")).toBe("holiday-anim.gif");
  });

  it("keeps a name that has no extension", () => {
    expect(exportNameFor("C:\\vids\\holiday", "-sticker", "png")).toBe("holiday-sticker.png");
  });

  /** Only the last extension goes: a dotted name keeps its earlier dots. */
  it("strips only the final extension", () => {
    expect(exportNameFor("my.holiday.2024.mp4", "-anim", "gif")).toBe("my.holiday.2024-anim.gif");
  });

  /** A leading dot is a hidden file's name, not an extension. */
  it("does not treat a leading dot as an extension", () => {
    expect(exportNameFor("C:\\vids\\.hidden", "-anim", "gif")).toBe(".hidden-anim.gif");
  });
});
