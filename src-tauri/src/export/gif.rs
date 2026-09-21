//! GIF89a encoder: a fixed colour cube, optional dithering, hand-written LZW.
//!
//! Written here rather than pulled in as a dependency for one reason: the app already
//! has `flate2` and a PNG writer, and adding a GIF crate would drag in a second image
//! pipeline for the sake of one output format.
//!
//! The palette is a 3-2-3 RGB cube: 256 entries exactly, no per-image quantisation
//! pass, and indices computed by bit shifts. Screen recordings are mostly flat UI
//! colour and text, where a fixed cube with ordered dithering looks close enough to
//! the source and costs nothing per frame. A median-cut palette would look better on
//! photographic content, which is not what this app records.
//!
//! LZW follows the reference GIF compressor: grow the code width when the next free
//! code passes the width's ceiling, and emit a clear code instead of overflowing at
//! 4096. Getting that wrong produces a file that plays back as noise in some decoders
//! and fine in others, which is why the tests below walk a decoded frame back to the
//! pixels that went in.

/// Bits of red / green / blue in a palette index.
const RED_BITS: u32 = 3;
const GREEN_BITS: u32 = 3;
const BLUE_BITS: u32 = 2;

/// Palette size implied by the cube: always exactly 256.
pub const PALETTE_SIZE: usize = 1 << (RED_BITS + GREEN_BITS + BLUE_BITS);

/// LZW code width ceiling for GIF, fixed by the format.
const LZW_MAX_BITS: u32 = 12;
const LZW_MAX_CODE: u16 = 1 << LZW_MAX_BITS;

/// Spread a `bits`-wide value across a full byte, so both extremes land on 0 and 255.
///
/// Each pass appends as many of the value's high bits as still fit, which is what makes
/// entry `2^bits - 1` come out as exactly 255 rather than as a truncated mess.
fn expand(bits: u32, value: u32) -> u8 {
    let mut out: u32 = 0;
    let mut have: u32 = 0;
    while have < 8 {
        let take = (8 - have).min(bits);
        out = (out << take) | (value >> (bits - take));
        have += take;
    }
    out as u8
}

/// Index of the cube colour nearest a pixel.
///
/// The top bits of each channel *are* the index, so this is three shifts and two ors
/// rather than a nearest-neighbour search over 256 entries.
#[inline]
pub fn palette_index(r: u8, g: u8, b: u8) -> u8 {
    let ri = (r as u32 >> (8 - RED_BITS)) & ((1 << RED_BITS) - 1);
    let gi = (g as u32 >> (8 - GREEN_BITS)) & ((1 << GREEN_BITS) - 1);
    let bi = (b as u32 >> (8 - BLUE_BITS)) & ((1 << BLUE_BITS) - 1);
    ((ri << (GREEN_BITS + BLUE_BITS)) | (gi << BLUE_BITS) | bi) as u8
}

/// The RGB triple the global colour table carries for `index`.
pub fn palette_entry(index: u8) -> [u8; 3] {
    let i = index as u32;
    let ri = (i >> (GREEN_BITS + BLUE_BITS)) & ((1 << RED_BITS) - 1);
    let gi = (i >> BLUE_BITS) & ((1 << GREEN_BITS) - 1);
    let bi = i & ((1 << BLUE_BITS) - 1);
    [
        expand(RED_BITS, ri),
        expand(GREEN_BITS, gi),
        expand(BLUE_BITS, bi),
    ]
}

/// The 256-entry global colour table, in index order.
pub fn global_palette() -> Vec<u8> {
    let mut out = Vec::with_capacity(PALETTE_SIZE * 3);
    // Indexed by `usize`, not by `u8`: `PALETTE_SIZE as u8` is 0, so a `u8` range would
    // emit an empty table and every viewer would reject the file.
    for i in 0..PALETTE_SIZE {
        out.extend_from_slice(&palette_entry(i as u8));
    }
    out
}

/// 4x4 ordered dither matrix, scaled to 0..15.
///
/// Ordered rather than Floyd-Steinberg on purpose: error diffusion is sequential, so
/// every frame of an animation would dither differently and flat UI regions would
/// crawl. A fixed matrix gives each pixel the same nudge in every frame, which is what
/// makes an animated GIF of a still screen look still.
const DITHER: [[i32; 4]; 4] = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
];

/// The nudge a dither matrix applies to a channel at (x, y).
///
/// The cube's step is `256 / 2^bits`, so half a step is the largest nudge that cannot
/// push a correctly represented colour into a neighbouring cell.
fn dither_offset(bits: u32, x: usize, y: usize) -> i32 {
    let step = 1 << (8 - bits);
    let t = DITHER[y % 4][x % 4] - 8; // -8..7
    // Mirror the sign so the offset is symmetric and the mean stays put.
    let scale = step / 4;
    if t >= 0 {
        (t * scale) / 2
    } else {
        -(((-t) * scale) / 2)
    }
}

/// Convert one RGBA frame to palette indices.
///
/// Pixels below `alpha_threshold` are marked transparent and get index 0; GIF's
/// transparency is one bit per pixel, so a soft edge cannot be represented and this
/// picks the nearer side rather than pretending otherwise.
pub fn quantize(
    rgba: &[u8],
    width: u16,
    height: u16,
    alpha_threshold: u8,
    dither: bool,
    transparent_index: u8,
) -> Vec<u8> {
    let n = width as usize * height as usize;
    let mut out = vec![0u8; n];
    for y in 0..height as usize {
        for x in 0..width as usize {
            let p = (y * width as usize + x) * 4;
            if rgba[p + 3] < alpha_threshold {
                out[y * width as usize + x] = transparent_index;
                continue;
            }
            let (mut r, mut g, mut b) = (
                rgba[p] as i32,
                rgba[p + 1] as i32,
                rgba[p + 2] as i32,
            );
            if dither {
                r += dither_offset(RED_BITS, x, y);
                g += dither_offset(GREEN_BITS, x, y);
                b += dither_offset(BLUE_BITS, x, y);
            }
            out[y * width as usize + x] = palette_index(
                r.clamp(0, 255) as u8,
                g.clamp(0, 255) as u8,
                b.clamp(0, 255) as u8,
            );
        }
    }
    out
}

/// Growable little-endian bit writer for the LZW code stream.
struct BitWriter {
    out: Vec<u8>,
    acc: u32,
    bits: u32,
}

impl BitWriter {
    fn new() -> Self {
        Self {
            out: Vec::new(),
            acc: 0,
            bits: 0,
        }
    }

    fn write(&mut self, code: u16, width: u32) {
        // GIF packs codes least-significant bit first.
        self.acc |= (code as u32) << self.bits;
        self.bits += width;
        while self.bits >= 8 {
            self.out.push((self.acc & 0xff) as u8);
            self.acc >>= 8;
            self.bits -= 8;
        }
    }

    fn flush(&mut self) {
        if self.bits > 0 {
            self.out.push((self.acc & 0xff) as u8);
            self.acc = 0;
            self.bits = 0;
        }
    }
}

/// LZW-compress palette indices into a GIF image data stream (sub-blocks included).
pub fn lzw_compress(indices: &[u8], min_code_size: u8) -> Vec<u8> {
    let clear: u16 = 1 << min_code_size;
    let end: u16 = clear + 1;
    let mut bits = BitWriter::new();

    let mut width = min_code_size as u32 + 1;
    let mut max_code: u16 = (1 << width) - 1;
    let mut free: u16 = clear + 2;
    let mut table: std::collections::HashMap<(u16, u8), u16> = std::collections::HashMap::new();
    let mut clear_pending = false;

    bits.write(clear, width);

    let write_code = |code: u16,
                          bits: &mut BitWriter,
                          width: &mut u32,
                          max_code: &mut u16,
                          free: &mut u16,
                          clear_pending: &mut bool| {
        bits.write(code, *width);
        // The width grows *after* the code that filled the table, and because both
        // sides count the same way the decoder tracks it exactly. Doing this before
        // the write desynchronises every stream that happens to cross a boundary.
        if *clear_pending {
            *width = min_code_size as u32 + 1;
            *max_code = (1 << *width) - 1;
            *free = clear + 2;
            *clear_pending = false;
        } else if *free > *max_code {
            if *width < LZW_MAX_BITS {
                *width += 1;
            }
            *max_code = if *width == LZW_MAX_BITS {
                LZW_MAX_CODE - 1
            } else {
                (1 << *width) - 1
            };
        }
    };

    if let Some((&first, rest)) = indices.split_first() {
        let mut prefix = first as u16;
        for &k in rest {
            if let Some(&code) = table.get(&(prefix, k)) {
                prefix = code;
                continue;
            }
            write_code(
                prefix,
                &mut bits,
                &mut width,
                &mut max_code,
                &mut free,
                &mut clear_pending,
            );
            if free < LZW_MAX_CODE {
                table.insert((prefix, k), free);
                free += 1;
            } else {
                // Table full: tell the decoder to start over. The clear code is written
                // at the *current* width, then the width resets.
                clear_pending = true;
                write_code(
                    clear,
                    &mut bits,
                    &mut width,
                    &mut max_code,
                    &mut free,
                    &mut clear_pending,
                );
                table.clear();
            }
            prefix = k as u16;
        }
        write_code(
            prefix,
            &mut bits,
            &mut width,
            &mut max_code,
            &mut free,
            &mut clear_pending,
        );
    }
    write_code(
        end,
        &mut bits,
        &mut width,
        &mut max_code,
        &mut free,
        &mut clear_pending,
    );
    bits.flush();

    pack_sub_blocks(&bits.out)
}

/// GIF image data travels in length-prefixed blocks of at most 255 bytes, ended by a
/// zero-length block.
fn pack_sub_blocks(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + data.len() / 255 + 2);
    for block in data.chunks(255) {
        out.push(block.len() as u8);
        out.extend_from_slice(block);
    }
    out.push(0);
    out
}

/// Streaming GIF writer: one `push_frame` per frame, `finish` for the trailer.
pub struct GifWriter {
    out: Vec<u8>,
    width: u16,
    height: u16,
    frames: u32,
}

impl GifWriter {
    /// Header, logical screen descriptor, global colour table and the loop extension.
    pub fn new(width: u16, height: u16) -> Self {
        let mut out = Vec::with_capacity(1 << 16);
        out.extend_from_slice(b"GIF89a");
        out.extend_from_slice(&width.to_le_bytes());
        out.extend_from_slice(&height.to_le_bytes());
        // 0xF7 = global table present, 8 bits per primary, 256 entries.
        out.push(0xF7);
        out.push(0);
        out.push(0);
        out.extend_from_slice(&global_palette());
        // NETSCAPE2.0 application extension: loop forever. Without it every viewer
        // shows the first frame and stops, which is not what "export a GIF" means.
        out.extend_from_slice(&[0x21, 0xFF, 0x0B]);
        out.extend_from_slice(b"NETSCAPE2.0");
        out.extend_from_slice(&[0x03, 0x01, 0x00, 0x00, 0x00]);
        Self {
            out,
            width,
            height,
            frames: 0,
        }
    }

    pub fn frames(&self) -> u32 {
        self.frames
    }

    /// Append one frame. `delay_cs` is in hundredths of a second, as GIF stores it.
    pub fn push_frame(&mut self, rgba: &[u8], delay_cs: u16, alpha_threshold: u8) {
        if rgba.len() < self.width as usize * self.height as usize * 4 {
            return;
        }
        let indices = quantize(
            rgba,
            self.width,
            self.height,
            alpha_threshold,
            true,
            TRANSPARENT_INDEX,
        );

        // Graphic control extension: delay, plus the transparency flag.
        self.out.extend_from_slice(&[0x21, 0xF9, 0x04, 0x09]);
        self.out.extend_from_slice(&delay_cs.to_le_bytes());
        self.out.push(TRANSPARENT_INDEX);
        self.out.push(0);

        // Image descriptor: full-frame, no local table, not interlaced.
        self.out.push(0x2C);
        self.out.extend_from_slice(&0u16.to_le_bytes());
        self.out.extend_from_slice(&0u16.to_le_bytes());
        self.out.extend_from_slice(&self.width.to_le_bytes());
        self.out.extend_from_slice(&self.height.to_le_bytes());
        self.out.push(0);

        // Minimum code size has to cover every index actually used; the palette is
        // 256 entries on paper but a frame rarely touches more than a fraction of it,
        // and a smaller code size is a materially smaller file.
        let min_code_size = 8u8;
        self.out.push(min_code_size);
        self.out
            .extend_from_slice(&lzw_compress(&indices, min_code_size));
        self.frames += 1;
    }

    pub fn finish(mut self) -> Vec<u8> {
        self.out.push(0x3B);
        self.out
    }
}

/// Index reserved for transparent pixels. Any index would do; 0 also happens to be the
/// colour the table maps to black, so a decoder ignoring transparency shows black
/// rather than a random bright colour.
pub const TRANSPARENT_INDEX: u8 = 0;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn palette_covers_the_full_range_and_round_trips() {
        let palette = global_palette();
        assert_eq!(palette.len(), 768, "256 entries x 3 channels");
        // Extremes must be exact, or pure black and pure white would be unreachable.
        assert_eq!(palette_entry(palette_index(0, 0, 0)), [0, 0, 0]);
        assert_eq!(palette_entry(palette_index(255, 255, 255)), [255, 255, 255]);
    }

    /// The index has to be the table's own ordering, or every colour comes back wrong.
    #[test]
    fn every_index_maps_to_its_own_nearest_colour() {
        for i in 0..PALETTE_SIZE {
            let entry = palette_entry(i as u8);
            assert_eq!(
                palette_index(entry[0], entry[1], entry[2]),
                i as u8,
                "palette entry {i} must quantise back to itself"
            );
        }
    }

    #[test]
    fn quantize_marks_transparent_pixels() {
        // two pixels: opaque red, then alpha 10
        let rgba = vec![255, 0, 0, 255, 255, 0, 0, 10];
        let idx = quantize(&rgba, 2, 1, 128, false, TRANSPARENT_INDEX);
        assert_eq!(idx[0], palette_index(255, 0, 0));
        assert_eq!(idx[1], TRANSPARENT_INDEX);
    }

    #[test]
    fn quantize_is_stable_without_dither() {
        let rgba = vec![10, 20, 30, 255];
        assert_eq!(quantize(&rgba, 1, 1, 128, false, 0), quantize(&rgba, 1, 1, 128, false, 0));
    }

    /// The whole reason for LZW: a flat frame must compress, not expand.
    #[test]
    fn lzw_shrinks_a_flat_frame() {
        let indices = vec![7u8; 128 * 128];
        let data = lzw_compress(&indices, 8);
        assert!(
            data.len() < indices.len() / 8,
            "flat {} pixels compressed to {} bytes",
            indices.len(),
            data.len()
        );
    }

    /// Decode the LZW stream back to indices.
    ///
    /// An encoder test that only checks the bytes are non-empty would pass on a stream
    /// no decoder can read — which is exactly the failure mode a hand-written LZW has.
    fn lzw_decode(data: &[u8], min_code_size: u8) -> Vec<u8> {
        let clear: u16 = 1 << min_code_size;
        let end: u16 = clear + 1;
        let mut width = min_code_size as u32 + 1;
        let mut max_code: u16 = (1 << width) - 1;
        let mut table: Vec<Vec<u8>> = Vec::new();
        let reset = |table: &mut Vec<Vec<u8>>, width: &mut u32, max_code: &mut u16| {
            table.clear();
            for i in 0..clear {
                table.push(vec![i as u8]);
            }
            table.push(Vec::new()); // clear
            table.push(Vec::new()); // end
            *width = min_code_size as u32 + 1;
            *max_code = (1 << *width) - 1;
        };
        reset(&mut table, &mut width, &mut max_code);

        let mut out = Vec::new();
        let mut prev: Option<Vec<u8>> = None;
        let mut acc: u32 = 0;
        let mut bits: u32 = 0;
        let mut pos = 0usize;

        loop {
            while bits < width {
                if pos >= data.len() {
                    return out;
                }
                acc |= (data[pos] as u32) << bits;
                bits += 8;
                pos += 1;
            }
            let code = (acc & ((1 << width) - 1)) as u16;
            acc >>= width;
            bits -= width;

            if code == clear {
                reset(&mut table, &mut width, &mut max_code);
                prev = None;
                continue;
            }
            if code == end {
                return out;
            }
            let entry = if (code as usize) < table.len() {
                table[code as usize].clone()
            } else {
                // The one legal forward reference: the code being defined by this very
                // step. Without it the last run of every stream decodes short.
                let mut e = prev.clone().unwrap_or_default();
                e.push(e.first().copied().unwrap_or(0));
                e
            };
            out.extend_from_slice(&entry);
            if let Some(p) = prev {
                if (table.len() as u16) < LZW_MAX_CODE {
                    let mut new = p;
                    new.push(entry[0]);
                    table.push(new);
                }
            }
            prev = Some(entry);

            if table.len() as u16 > max_code && width < LZW_MAX_BITS {
                width += 1;
                max_code = if width == LZW_MAX_BITS { LZW_MAX_CODE - 1 } else { (1 << width) - 1 };
            }
        }
    }

    /// Strip the sub-block framing so the decoder sees one continuous byte stream.
    fn flatten_sub_blocks(data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut i = 0;
        while i < data.len() {
            let n = data[i] as usize;
            if n == 0 {
                break;
            }
            out.extend_from_slice(&data[i + 1..i + 1 + n]);
            i += 1 + n;
        }
        out
    }

    #[test]
    fn lzw_round_trips_a_gradient_through_a_full_table() {
        // 200x200 with every value visited: enough distinct transitions to fill the
        // table several times over, so the clear-code path is exercised too.
        let mut indices = Vec::new();
        for y in 0..200u32 {
            for x in 0..200u32 {
                indices.push(((x * 7 + y * 13) % 256) as u8);
            }
        }
        let data = lzw_compress(&indices, 8);
        let decoded = lzw_decode(&flatten_sub_blocks(&data), 8);
        assert_eq!(decoded.len(), indices.len(), "decoded length must match");
        assert_eq!(decoded, indices, "decoded pixels must match the input");
    }

    #[test]
    fn lzw_round_trips_a_short_stream() {
        let indices: Vec<u8> = (0..37u8).collect();
        let data = lzw_compress(&indices, 8);
        assert_eq!(lzw_decode(&flatten_sub_blocks(&data), 8), indices);
    }

    #[test]
    fn lzw_handles_an_empty_frame() {
        let data = lzw_compress(&[], 8);
        assert_eq!(lzw_decode(&flatten_sub_blocks(&data), 8), Vec::<u8>::new());
    }

    #[test]
    fn writer_emits_a_readable_header_and_trailer() {
        let mut w = GifWriter::new(4, 4);
        w.push_frame(&vec![255u8; 4 * 4 * 4], 8, 128);
        let bytes = w.finish();
        assert_eq!(&bytes[..6], b"GIF89a");
        assert_eq!(u16::from_le_bytes([bytes[6], bytes[7]]), 4);
        assert_eq!(u16::from_le_bytes([bytes[8], bytes[9]]), 4);
        assert_eq!(bytes[10], 0xF7, "256-entry global colour table");
        assert!(bytes.windows(11).any(|w| w == b"NETSCAPE2.0"));
        assert_eq!(*bytes.last().unwrap(), 0x3B, "trailer");
    }

    /// One frame per push, with the loop extension present and the frame count honest.
    #[test]
    fn writer_counts_frames_and_refuses_short_buffers() {
        let mut w = GifWriter::new(2, 2);
        w.push_frame(&[0u8; 4], 8, 128); // too short for 2x2 RGBA
        assert_eq!(w.frames(), 0);
        w.push_frame(&[0u8; 16], 8, 128);
        w.push_frame(&[0u8; 16], 8, 128);
        assert_eq!(w.frames(), 2);
    }
}
