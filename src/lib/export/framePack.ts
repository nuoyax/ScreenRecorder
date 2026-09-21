/**
 * Frame transport: canvas pixels to Rust, without the JSON tax.
 *
 * A Tauri command argument that is an `ArrayBuffer` travels as an `opaque` bytes payload
 * rather than a JSON document. The alternative — an array of numbers — turns a 1280x720
 * frame into roughly 15 MB of text, which is several times slower to serialise than to
 * render.
 *
 * A raw payload has no room for named arguments, so the frame settings ride in a short
 * JSON header in front of the pixels. The layout is defined once, in Rust
 * (`src-tauri/src/export/frame.rs`), and mirrored here. The magic and version are the
 * contract between the two: changing either makes an old build refuse the payload with a
 * message rather than misread it as pixels.
 */

/** `"SRFR"`, the header's magic bytes. */
const MAGIC = [0x53, 0x52, 0x46, 0x52];
const VERSION = 1;
const HEADER_LEN = 12;

export interface FrameMeta {
  width: number;
  height: number;
  /** Frame delay in hundredths of a second, as GIF stores it. */
  delayCs: number;
  /**
   * Alpha below this counts as transparent.
   *
   * GIF carries one transparency bit per pixel, so a soft edge has to be assigned to
   * one side. The composed frame is usually fully opaque or fully transparent already
   * (the editor paints its own background), so the exact value rarely matters — but it
   * has to be stated rather than assumed.
   */
  alphaThreshold: number;
  /** Index within the stream, so Rust can report progress. */
  index: number;
  /**
   * Extra header fields for commands whose arguments cannot travel as command
   * arguments.
   *
   * A raw bytes payload has no JSON object for Tauri to read named keys from, so a
   * command like the sticker exporter receives *only* this header. Anything it needs —
   * the destination path, the framing — has to be in here.
   */
  [extra: string]: number | string | boolean;
}

/**
 * Pack one frame into a single payload.
 *
 * The pixels are copied rather than transferred: `getImageData` already returns fresh
 * memory, and detaching that buffer would mean the caller cannot reuse it for the next
 * frame.
 */
export function packFrame(pixels: Uint8ClampedArray | Uint8Array, meta: FrameMeta): Uint8Array {
  const expected = meta.width * meta.height * 4;
  if (pixels.length < expected) {
    throw new Error(`帧像素不足：需要 ${expected} 字节，实际 ${pixels.length}`);
  }
  // Rust reads the payload's header JSON with serde's default field names, so the wire
  // keys stay snake_case even though the TypeScript side is camelCase. Any caller-added
  // fields pass through unchanged, which is how the sticker exporter sends its path.
  const { width, height, delayCs, alphaThreshold, index, ...extra } = meta;
  const header = JSON.stringify({
    width,
    height,
    delay_cs: delayCs,
    alpha_threshold: alphaThreshold,
    index,
    ...extra,
  });
  const headerBytes = new TextEncoder().encode(header);

  const out = new Uint8Array(HEADER_LEN + headerBytes.length + expected);
  out.set(MAGIC, 0);
  const view = new DataView(out.buffer);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, 0, true); // reserved
  view.setUint32(8, headerBytes.length, true);
  out.set(headerBytes, HEADER_LEN);
  // Copy only the frame's own pixels: `getImageData` returns exactly `w*h*4`, but a
  // caller passing a larger buffer must not have the tail treated as pixels.
  out.set(pixels.subarray(0, expected), HEADER_LEN + headerBytes.length);
  return out;
}

/**
 * Read the frame the editor's canvas currently holds.
 *
 * The context is created with `willReadFrequently` because this path reads back every
 * frame; a context made for display would keep the canvas on the GPU and pay a
 * readback stall each time. `getContext` returns the existing context when the canvas
 * already has one, so this only matters when it does not.
 */
export function readCanvasPixels(canvas: HTMLCanvasElement): Uint8ClampedArray {
  const ctx =
    canvas.getContext("2d", { willReadFrequently: true }) ?? canvas.getContext("2d");
  if (!ctx) throw new Error("无法获取画布上下文");
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}
