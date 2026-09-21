import { describe, expect, it } from "vitest";
import { packFrame } from "./framePack";

/** Read a packed payload back, mirroring what `export/frame.rs` does in Rust. */
function unpack(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  const version = view.getUint16(4, true);
  const jsonLen = view.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + jsonLen)));
  return { magic, version, header, pixels: bytes.subarray(12 + jsonLen) };
}

const meta = {
  width: 2,
  height: 1,
  delayCs: 8,
  alphaThreshold: 128,
  index: 3,
};

describe("packFrame", () => {
  it("writes the magic, version and a readable header", () => {
    const packed = unpack(packFrame(new Uint8Array(8), meta));
    expect(packed.magic).toBe("SRFR");
    expect(packed.version).toBe(1);
    expect(packed.header.width).toBe(2);
    expect(packed.header.height).toBe(1);
    expect(packed.header.delay_cs).toBe(8);
    expect(packed.header.alpha_threshold).toBe(128);
    expect(packed.header.index).toBe(3);
  });

  /**
   * Rust reads the header with serde's default field names, so the wire keys are
   * snake_case even though the TypeScript interface is camelCase. A mismatch here fails
   * at export time with a JSON error, which is why it is pinned.
   */
  it("uses snake_case keys on the wire", () => {
    const { header } = unpack(packFrame(new Uint8Array(8), meta));
    expect(header).not.toHaveProperty("delayCs");
    expect(header).not.toHaveProperty("alphaThreshold");
  });

  it("carries the pixels verbatim, after the header", () => {
    const pixels = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const packed = unpack(packFrame(pixels, meta));
    expect(Array.from(packed.pixels)).toEqual(Array.from(pixels));
  });

  /**
   * Every byte of a frame matters and none of it may be lost, so the total length is
   * exact rather than "at least".
   */
  it("produces exactly header plus pixels", () => {
    const packed = packFrame(new Uint8Array(8), meta);
    const jsonLen = new DataView(packed.buffer).getUint32(8, true);
    expect(packed.length).toBe(12 + jsonLen + 8);
  });

  /** Trailing bytes in a larger buffer must not be mistaken for pixels. */
  it("copies only the frame's own pixels", () => {
    const oversized = new Uint8Array(32);
    const packed = packFrame(oversized, meta);
    expect(packed.length).toBe(12 + new DataView(packed.buffer).getUint32(8, true) + 8);
  });

  it("refuses a buffer too small for the declared size", () => {
    expect(() => packFrame(new Uint8Array(4), meta)).toThrow(/像素不足/);
  });

  /**
   * Extra header fields pass through, which is how the sticker exporter sends its
   * destination: a raw bytes payload cannot carry command arguments at all.
   */
  it("passes caller-added header fields through", () => {
    const { header } = unpack(
      packFrame(new Uint8Array(8), {
        ...meta,
        path: "C:\\vids\\out.png",
        padding: 32,
        shadow: true,
      }),
    );
    expect(header.path).toBe("C:\\vids\\out.png");
    expect(header.padding).toBe(32);
    expect(header.shadow).toBe(true);
  });
});
