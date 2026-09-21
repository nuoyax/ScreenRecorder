//! End-to-end export checks: encode real frames, write real files, read them back.
//!
//! The unit tests next to each encoder check its arithmetic. What they cannot check is
//! whether the bytes that reach the disk are a file anything else can open — a GIF whose
//! header is right but whose sub-blocks are framed wrong, or a PNG whose CRC was
//! computed over the wrong span, both pass the module tests and fail in every viewer.
//!
//! So these tests write to a temp directory and verify what actually landed.

use screen_recorder::export::frame::{FrameMeta, MAGIC, VERSION};
use screen_recorder::export::gif::GifWriter;
use screen_recorder::export::img::{build_sticker, StickerOptions};
use screen_recorder::image::png::{encode_rgba, read_ihdr_size};

/// A frame with a gradient and a moving band, so no two frames are identical and a
/// broken encoder cannot pass by accident.
fn frame(width: u32, height: u32, step: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        for x in 0..width {
            let band = ((x + step * 7) % width) < width / 8;
            let (r, g, b) = if band {
                (255u8, 64u8, 32u8)
            } else {
                (
                    (x * 255 / width.max(1)) as u8,
                    (y * 255 / height.max(1)) as u8,
                    128,
                )
            };
            out.extend_from_slice(&[r, g, b, 255]);
        }
    }
    out
}

fn temp_path(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join("screen-recorder-export-tests");
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(name)
}

/// Read a GIF's logical screen descriptor, and walk its blocks to count image
/// descriptors. A decoder this crude still catches the failures that matter: wrong
/// dimensions, missing trailer, and image data whose sub-blocks do not terminate.
fn inspect_gif(bytes: &[u8]) -> (u16, u16, usize, bool) {
    assert_eq!(&bytes[..6], b"GIF89a", "signature");
    let width = u16::from_le_bytes([bytes[6], bytes[7]]);
    let height = u16::from_le_bytes([bytes[8], bytes[9]]);
    let flags = bytes[10];
    assert_eq!(flags & 0x80, 0x80, "a global colour table must be declared");
    let table_len = 3 * (1usize << ((flags & 0x07) + 1));
    assert_eq!(table_len, 768, "the global table must hold 256 entries");

    let mut i = 13 + table_len;
    let mut frames = 0usize;
    let mut saw_trailer = false;
    while i < bytes.len() {
        match bytes[i] {
            0x3B => {
                saw_trailer = true;
                break;
            }
            0x21 => {
                // extension: label, then sub-blocks
                i += 2;
                i = skip_sub_blocks(bytes, i);
            }
            0x2C => {
                frames += 1;
                // introducer, 9-byte descriptor, then the LZW minimum code size byte.
                // Stepping 10 would leave the walker sitting on that code size and read
                // it as a sub-block length.
                i += 11;
                i = skip_sub_blocks(bytes, i);
            }
            other => panic!("unexpected block 0x{other:02x} at {i}"),
        }
    }
    (width, height, frames, saw_trailer)
}

/// Walk a chain of length-prefixed sub-blocks, returning the offset after the terminator.
fn skip_sub_blocks(bytes: &[u8], mut i: usize) -> usize {
    loop {
        assert!(i < bytes.len(), "sub-block chain ran off the end");
        let n = bytes[i] as usize;
        i += 1;
        if n == 0 {
            return i;
        }
        assert!(i + n <= bytes.len(), "sub-block claims {n} bytes past the end");
        i += n;
    }
}

#[test]
fn gif_export_writes_a_file_a_decoder_can_walk() {
    let (w, h) = (64u32, 48u32);
    let mut writer = GifWriter::new(w as u16, h as u16);
    for step in 0..40 {
        writer.push_frame(&frame(w, h, step), 8, 128);
    }
    assert_eq!(writer.frames(), 40, "every pushed frame must be counted");

    let path = temp_path("export.gif");
    let bytes = writer.finish();
    std::fs::write(&path, &bytes).unwrap();

    let on_disk = std::fs::read(&path).unwrap();
    assert_eq!(on_disk.len(), bytes.len(), "the file must be what was built");
    assert!(on_disk.len() > 1000, "a 40-frame GIF must not be a stub");

    let (gw, gh, frames, trailer) = inspect_gif(&on_disk);
    assert_eq!((gw, gh), (w as u16, h as u16), "logical screen descriptor");
    assert_eq!(frames, 40, "one image descriptor per frame");
    assert!(trailer, "the trailer must be present or viewers reject the file");
    assert_eq!(*on_disk.last().unwrap(), 0x3B, "trailer is the final byte");
}

/// The loop extension is what makes an animation loop rather than show one frame.
#[test]
fn gif_export_declares_a_loop() {
    let mut writer = GifWriter::new(8, 8);
    writer.push_frame(&frame(8, 8, 0), 8, 128);
    writer.push_frame(&frame(8, 8, 1), 8, 128);
    let bytes = writer.finish();
    let netscape = bytes
        .windows(11)
        .position(|w| w == b"NETSCAPE2.0")
        .expect("a looping GIF needs the NETSCAPE2.0 application extension");
    // ...followed by the sub-block that carries the loop count.
    assert_eq!(bytes[netscape + 11], 0x03);
    assert_eq!(bytes[netscape + 12], 0x01, "sub-block id 1 = loop count");
    assert_eq!(
        u16::from_le_bytes([bytes[netscape + 13], bytes[netscape + 14]]),
        0,
        "0 loops means forever"
    );
}

/// A flat frame is the case where a broken LZW would show up as an absurdly large file.
#[test]
fn gif_export_compresses_a_flat_frame() {
    let mut writer = GifWriter::new(128, 128);
    for _ in 0..10 {
        writer.push_frame(&vec![200u8; 128 * 128 * 4], 8, 128);
    }
    let bytes = writer.finish();
    // 10 frames x 16 KiB of RGBA. Anything close to that means LZW did nothing.
    assert!(
        bytes.len() < 20_000,
        "10 flat 128x128 frames compressed to {} bytes",
        bytes.len()
    );
}

#[test]
fn sticker_export_writes_a_png_of_the_requested_size() {
    let (w, h) = (300u32, 200u32);
    let opts = StickerOptions { padding: 20, radius: 12, shadow: true };
    let (rgba, sw, sh) = build_sticker(&frame(w, h, 0), w, h, opts).expect("sticker builds");
    assert!(sw > w + 40 && sh > h + 40, "padding and shadow must add room");

    let png = encode_rgba(&rgba, sw, sh).expect("png encodes");
    let path = temp_path("sticker.png");
    std::fs::write(&path, &png).unwrap();

    let on_disk = std::fs::read(&path).unwrap();
    assert_eq!(&on_disk[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a], "signature");
    assert_eq!(
        read_ihdr_size(&on_disk),
        Some((sw, sh)),
        "the IHDR must declare the sticker's own size, not the source's"
    );
    assert!(on_disk.len() > 200, "a 300x200 sticker must not be a stub");
}

/// Without padding or shadow the sticker is exactly the source frame, which is what a
/// caller asking for "just round the corners" expects.
#[test]
fn sticker_without_framing_matches_the_source_size() {
    let (w, h) = (120u32, 90u32);
    let opts = StickerOptions { padding: 0, radius: 8, shadow: false };
    let (rgba, sw, sh) = build_sticker(&frame(w, h, 2), w, h, opts).unwrap();
    assert_eq!((sw, sh), (w, h));
    let png = encode_rgba(&rgba, sw, sh).unwrap();
    assert_eq!(read_ihdr_size(&png), Some((w, h)));
}

/// The payload contract between the webview and the exporters, checked against a real
/// packed buffer rather than the abstract description in the header comment.
#[test]
fn frame_payload_round_trips_through_the_shared_header() {
    let meta = FrameMeta {
        width: 2,
        height: 2,
        delay_cs: 5,
        alpha_threshold: 200,
        index: 7,
    };
    let pixels = frame(2, 2, 1);
    let mut payload = Vec::new();
    payload.extend_from_slice(MAGIC);
    payload.extend_from_slice(&VERSION.to_le_bytes());
    payload.extend_from_slice(&0u16.to_le_bytes());
    let header = serde_json::to_vec(&meta).unwrap();
    payload.extend_from_slice(&(header.len() as u32).to_le_bytes());
    payload.extend_from_slice(&header);
    payload.extend_from_slice(&pixels);

    let parsed = screen_recorder::export::frame::unpack(&payload).expect("payload must parse");
    assert_eq!(parsed.meta.width, 2);
    assert_eq!(parsed.meta.index, 7);
    assert_eq!(parsed.rgba.len(), pixels.len());
    assert_eq!(parsed.rgba, pixels);
}

/// The version is a contract: a payload from a different build must be refused, not
/// reinterpreted as pixels that happen to parse.
#[test]
fn frame_payload_honours_the_version_check() {
    let mut payload = Vec::new();
    payload.extend_from_slice(MAGIC);
    payload.extend_from_slice(&(VERSION + 1).to_le_bytes());
    payload.extend_from_slice(&0u16.to_le_bytes());
    payload.extend_from_slice(&2u32.to_le_bytes());
    payload.extend_from_slice(b"{}");
    let err = screen_recorder::export::frame::unpack(&payload).expect_err("must refuse");
    assert!(err.contains("版本"), "the message should name the version: {err}");
}
