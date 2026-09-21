//! Minimal PNG encoder for RGBA8 images.
//!
//! Scoped to what this app produces: 8-bit RGBA, no interlacing, one IDAT. Writes a
//! real PNG so the OS file manager, browsers, and video tools all read it normally,
//! without pulling in an image codec crate for the handful of bytes involved.

use std::io::Write;

const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

fn crc32(bytes: &[u8]) -> u32 {
    // Table-free CRC-32 (IEEE 802.3) over 4 bits at a time: a few hundred bytes of
    // code buys not carrying a 1 KiB table for images written once per export.
    let mut crc = 0xffff_ffffu32;
    for &b in bytes {
        crc ^= b as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let crc_start = out.len();
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let crc = crc32(&out[crc_start..]);
    out.extend_from_slice(&crc.to_be_bytes());
}

/// Encode an RGBA8 buffer (`w` * `h` * 4 bytes) as a PNG.
///
/// Returns `None` when the dimensions or buffer length do not line up, so callers
/// cannot accidentally emit a truncated image.
pub fn encode_rgba(rgba: &[u8], w: u32, h: u32) -> Option<Vec<u8>> {
    if w == 0 || h == 0 {
        return None;
    }
    let expected = (w as usize).checked_mul(h as usize)?.checked_mul(4)?;
    if rgba.len() < expected {
        return None;
    }

    // IHDR: width, height, bit depth 8, colour type 6 (RGBA), deflate, no filter
    // interlace, no interlacing.
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.push(8);
    ihdr.push(6);
    ihdr.push(0);
    ihdr.push(0);
    ihdr.push(0);

    // Raw scanlines, each prefixed with filter type 0 (None). Filtering would shrink
    // flat regions, but screenshot content is already well-compressed by deflate and
    // a per-row filter search is not worth the code here.
    let stride = w as usize * 4;
    let mut raw = Vec::with_capacity(h as usize * (stride + 1));
    for y in 0..h as usize {
        raw.push(0);
        raw.extend_from_slice(&rgba[y * stride..(y + 1) * stride]);
    }

    let mut idat = Vec::new();
    {
        let mut enc = flate2::write::ZlibEncoder::new(&mut idat, flate2::Compression::fast());
        enc.write_all(&raw).ok()?;
        enc.finish().ok()?;
    }

    let mut out = Vec::with_capacity(SIGNATURE.len() + 57 + idat.len());
    out.extend_from_slice(&SIGNATURE);
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &idat);
    chunk(&mut out, b"IEND", &[]);
    Some(out)
}

/// Dimensions of a PNG produced by [`encode_rgba`], read back from its IHDR.
///
/// Exists so tests and callers can verify a written file without a decoder.
pub fn read_ihdr_size(png: &[u8]) -> Option<(u32, u32)> {
    if png.len() < 24 || png[..8] != SIGNATURE {
        return None;
    }
    if &png[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes(png[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(png[20..24].try_into().ok()?);
    Some((w, h))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_valid_png_header() {
        let rgba = vec![255u8; 4 * 4 * 4];
        let png = encode_rgba(&rgba, 4, 4).expect("encode should succeed");
        assert_eq!(&png[..8], &SIGNATURE);
        assert_eq!(read_ihdr_size(&png), Some((4, 4)));
        assert!(png.ends_with(&[0xae, 0x42, 0x60, 0x82]), "IEND crc");
    }

    #[test]
    fn ihdr_declares_rgba8() {
        let png = encode_rgba(&vec![0u8; 2 * 2 * 4], 2, 2).unwrap();
        assert_eq!(png[24], 8, "bit depth");
        assert_eq!(png[25], 6, "colour type RGBA");
        assert_eq!(png[28], 0, "no interlacing");
    }

    /// A known CRC catches a broken checksum routine, which would otherwise only
    /// show up as a file that every viewer rejects.
    #[test]
    fn crc32_matches_known_value() {
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn rejects_mismatched_buffers_and_dims() {
        assert!(encode_rgba(&[0u8; 8], 2, 2).is_none(), "short buffer");
        assert!(encode_rgba(&[], 0, 0).is_none(), "zero dims");
        assert!(read_ihdr_size(&[0u8; 4]).is_none(), "truncated");
        assert!(read_ihdr_size(b"not a png at all............").is_none());
    }

    #[test]
    fn roundtrips_pixel_data_through_deflate() {
        let mut rgba = Vec::new();
        for i in 0..16u8 {
            rgba.extend_from_slice(&[i, 255 - i, i * 3, 255]);
        }
        let png = encode_rgba(&rgba, 4, 4).unwrap();
        // find IDAT and inflate it back to the raw scanlines
        let idat_at = png.windows(4).position(|w| w == b"IDAT").unwrap();
        let len = u32::from_be_bytes(png[idat_at - 4..idat_at].try_into().unwrap()) as usize;
        let mut z = flate2::read::ZlibDecoder::new(&png[idat_at + 4..idat_at + 4 + len]);
        let mut raw = Vec::new();
        std::io::Read::read_to_end(&mut z, &mut raw).unwrap();
        // each row is filter byte + 16 bytes of pixels
        assert_eq!(raw.len(), 4 * (1 + 16));
        assert_eq!(raw[0], 0, "filter type None");
        assert_eq!(&raw[1..17], &rgba[..16]);
    }
}
