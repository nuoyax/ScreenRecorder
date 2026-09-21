//! Frame transport between the editor canvas and the exporters.
//!
//! Every export path — GIF, sticker, sequence — starts with the same thing: pixels
//! produced by `drawFrame` in the webview, handed to Rust. Sending them as a JSON
//! array of numbers would inflate a 1280x720 frame to roughly 15 MB of text and make
//! the IPC layer the bottleneck; Tauri's raw payload path (`InvokeBody::Raw`, which is
//! what an `ArrayBuffer` argument becomes on the wire) carries the same frame as
//! 3.5 MB of bytes.
//!
//! A raw payload has no room for named arguments, so the settings ride in a short JSON
//! header in front of the pixels:
//!
//! ```text
//! offset 0   magic      b"SRFR"
//! offset 4   version    u16 LE
//! offset 6   reserved   u16 LE
//! offset 8   json_len   u32 LE
//! offset 12  json       utf-8, `json_len` bytes
//! offset 12+json_len     RGBA8 pixels, top row first
//! ```
//!
//! The magic and version are checked before the header is parsed, so a payload that is
//! not ours — or one from a future build this one does not understand — is refused with
//! a message naming the problem rather than being silently misread as pixels.

use serde::Deserialize;

pub const MAGIC: &[u8; 4] = b"SRFR";
pub const VERSION: u16 = 1;
const HEADER_LEN: usize = 12;

/// Settings the exporters need, carried in the payload header.
///
/// `Serialize` as well as `Deserialize` so the format has exactly one definition: the
/// tests build payloads with it, and a future Rust-side producer would too, rather than
/// each writer hand-rolling the same JSON.
#[derive(Debug, Clone, serde::Serialize, Deserialize)]
#[serde(default)]
pub struct FrameMeta {
    pub width: u32,
    pub height: u32,
    /// Frame delay in hundredths of a second, as GIF stores it.
    pub delay_cs: u16,
    /// Alpha below this counts as transparent. GIF has one transparency bit, so a
    /// soft edge has to be assigned to one side.
    pub alpha_threshold: u8,
    /// Frame index within the stream, so the exporter can report progress.
    pub index: u32,
}

impl Default for FrameMeta {
    fn default() -> Self {
        Self {
            width: 0,
            height: 0,
            delay_cs: 8,
            alpha_threshold: 128,
            index: 0,
        }
    }
}

/// One decoded frame: what it is, and its pixels.
#[derive(Debug, Clone)]
pub struct Frame {
    pub meta: FrameMeta,
    pub rgba: Vec<u8>,
}

/// Split a packed payload into its header and pixels, checking the frame against its
/// own declared size.
///
/// The GIF path uses this: a frame whose buffer is shorter than its header claims would
/// otherwise be encoded half-empty, which is not an error any viewer reports.
pub fn unpack(bytes: &[u8]) -> Result<Frame, String> {
    let (meta, rgba) = unpack_json::<FrameMeta>(bytes)?;
    let pixels = frame_pixels(meta.width, meta.height, &rgba)?;
    Ok(Frame {
        meta,
        rgba: pixels.to_vec(),
    })
}

/// Split a packed payload into an arbitrary JSON header and the pixels, unchecked.
///
/// The sticker path uses this because its header carries its own framing fields *and*
/// the dimensions. Anything that uses it must call [`frame_pixels`] before encoding.
pub fn unpack_json<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<(T, Vec<u8>), String> {
    if bytes.len() < HEADER_LEN {
        return Err(format!("帧数据过短：{} 字节，不足 {HEADER_LEN}", bytes.len()));
    }
    if &bytes[0..4] != MAGIC {
        return Err("帧数据头部标识不匹配".to_string());
    }
    let version = u16::from_le_bytes([bytes[4], bytes[5]]);
    if version != VERSION {
        return Err(format!("帧数据版本 {version} 不受支持（本版本支持 {VERSION}）"));
    }
    let json_len = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
    let pixels_at = HEADER_LEN
        .checked_add(json_len)
        .ok_or_else(|| "帧数据头部长度溢出".to_string())?;
    if pixels_at > bytes.len() {
        return Err(format!(
            "帧数据声明头部 {json_len} 字节，但只有 {} 字节",
            bytes.len() - HEADER_LEN
        ));
    }
    let header: T = serde_json::from_slice(&bytes[HEADER_LEN..pixels_at])
        .map_err(|e| format!("帧数据头部不是有效 JSON：{e}"))?;
    Ok((header, bytes[pixels_at..].to_vec()))
}

/// Dimensions a header declares, and the pixels that must accompany them.
///
/// Kept separate from the header types so both commands check their frame the same way:
/// a header whose claimed size is larger than the bytes that arrived would otherwise be
/// encoded half-empty.
pub fn frame_pixels(
    width: u32,
    height: u32,
    rgba: &[u8],
) -> Result<&[u8], String> {
    if width == 0 || height == 0 {
        return Err("帧数据未声明宽高".to_string());
    }
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|n| n.checked_mul(4))
        .ok_or_else(|| "帧尺寸溢出".to_string())?;
    if rgba.len() < expected {
        return Err(format!(
            "帧像素不足：{width}x{height} 需要 {expected} 字节，实际 {}",
            rgba.len()
        ));
    }
    Ok(&rgba[..expected])
}

/// Apply the alpha threshold, producing an opaque RGB buffer for the MP4 path.
///
/// Transparent pixels become the backdrop colour rather than black: the editor already
/// composited a background, so anything still transparent is padding the user chose,
/// and black corners on a light page would look like a bug.
pub fn flatten_to_rgb(rgba: &[u8], backdrop: [u8; 3]) -> Vec<u8> {
    let mut out = Vec::with_capacity(rgba.len() / 4 * 3);
    for px in rgba.chunks_exact(4) {
        let a = px[3] as u32;
        let inv = 255 - a;
        out.push(((px[0] as u32 * a + backdrop[0] as u32 * inv) / 255) as u8);
        out.push(((px[1] as u32 * a + backdrop[1] as u32 * inv) / 255) as u8);
        out.push(((px[2] as u32 * a + backdrop[2] as u32 * inv) / 255) as u8);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack(meta: FrameMeta, pixels: &[u8]) -> Vec<u8> {
        let json = serde_json::to_vec(&meta).unwrap();
        let mut out = Vec::new();
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&VERSION.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&(json.len() as u32).to_le_bytes());
        out.extend_from_slice(&json);
        out.extend_from_slice(pixels);
        out
    }

    #[test]
    fn unpacks_a_frame_written_by_the_packer() {
        let meta = FrameMeta {
            width: 2,
            height: 1,
            delay_cs: 5,
            alpha_threshold: 200,
            index: 9,
        };
        let frame = unpack(&pack(meta.clone(), &[1, 2, 3, 4, 5, 6, 7, 8])).expect("should unpack");
        assert_eq!(frame.meta.width, 2);
        assert_eq!(frame.meta.height, 1);
        assert_eq!(frame.meta.delay_cs, 5);
        assert_eq!(frame.meta.alpha_threshold, 200);
        assert_eq!(frame.meta.index, 9);
        assert_eq!(frame.rgba, vec![1, 2, 3, 4, 5, 6, 7, 8]);
    }

    /// Trailing bytes beyond the declared frame are ignored, not appended: a payload
    /// may be padded for transport and the header is the authority on size.
    #[test]
    fn ignores_padding_after_the_declared_frame() {
        let meta = FrameMeta { width: 1, height: 1, ..Default::default() };
        let frame = unpack(&pack(meta, &[9, 9, 9, 9, 0, 0, 0, 0])).unwrap();
        assert_eq!(frame.rgba, vec![9, 9, 9, 9]);
    }

    #[test]
    fn refuses_frames_that_are_not_ours() {
        assert!(unpack(b"XX").is_err(), "short");
        assert!(unpack(b"NOTSRFR............").is_err(), "wrong magic");
    }

    /// A version bump must be refused loudly; reading newer pixels as older settings
    /// would silently export a mangled image.
    #[test]
    fn refuses_an_unknown_version() {
        let mut bytes = pack(FrameMeta { width: 1, height: 1, ..Default::default() }, &[0; 4]);
        bytes[4] = 99;
        let err = unpack(&bytes).expect_err("should refuse");
        assert!(err.contains("版本"), "message should name the version: {err}");
    }

    #[test]
    fn refuses_a_truncated_or_oversized_header() {
        let mut bytes = pack(FrameMeta { width: 1, height: 1, ..Default::default() }, &[0; 4]);
        bytes[8] = 200; // claim a 200-byte header
        assert!(unpack(&bytes).is_err());

        // A zero-sized frame has to be refused by `frame_pixels`, which is where the
        // dimensions are interpreted — `unpack_json` on its own does not judge them.
        let no_dims = pack(FrameMeta { width: 0, height: 0, ..Default::default() }, &[]);
        assert!(unpack(&no_dims).is_err(), "width/height are required");
        assert!(
            unpack_json::<FrameMeta>(&no_dims).is_ok(),
            "the header itself parses; it is the frame that is invalid"
        );
    }

    /// The declared size is checked against the pixels, so a frame that would be drawn
    /// half-empty is rejected instead.
    #[test]
    fn refuses_pixels_shorter_than_the_declared_size() {
        let meta = FrameMeta { width: 4, height: 4, ..Default::default() };
        let err = unpack(&pack(meta, &[0u8; 16])).expect_err("should refuse");
        assert!(err.contains("像素不足"), "{err}");
    }

    #[test]
    fn flattens_transparency_onto_the_backdrop() {
        // opaque red, then fully transparent
        let rgba = vec![255, 0, 0, 255, 10, 20, 30, 0];
        let rgb = flatten_to_rgb(&rgba, [255, 255, 255]);
        assert_eq!(&rgb[0..3], &[255, 0, 0]);
        assert_eq!(&rgb[3..6], &[255, 255, 255], "transparent pixels take the backdrop");
    }

    #[test]
    fn flattens_half_transparency_proportionally() {
        let rgba = vec![0, 0, 0, 128];
        // 0*128/255 + 255*127/255 = 127
        assert_eq!(flatten_to_rgb(&rgba, [255, 255, 255]), vec![127, 127, 127]);
    }
}
