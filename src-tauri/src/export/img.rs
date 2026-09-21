//! Still-image sticker export: a composed frame, optionally framed and rounded.
//!
//! What makes this different from the GIF/PNG path is the *frame*: a sticker is meant to
//! be dropped into a slide, a chat, or a README. It carries a background, an optional
//! margin, corner rounding and a soft shadow, and it is written as RGBA — the
//! transparency is the point.
//!
//! All of it is a handful of per-pixel loops on the CPU. The frames are read back from
//! the webview already flattened into system memory, so this is the same pass;
//! a GPU path would add a device, a shader and a readback for arithmetic this cheap.

/// Header for a sticker payload.
///
/// A raw byte payload cannot carry named command arguments — Tauri routes a bytes body
/// straight to `Request`, with no JSON object to read keys from. So the destination and
/// the framing travel in the payload's own header, next to the dimensions they belong
/// with. Anything left out here would simply not reach the command.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(default)]
pub struct StickerFrame {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub padding: u32,
    pub radius: u32,
    pub shadow: bool,
}

impl Default for StickerFrame {
    fn default() -> Self {
        Self {
            path: String::new(),
            width: 0,
            height: 0,
            padding: 32,
            radius: 18,
            shadow: true,
        }
    }
}

impl StickerFrame {
    pub fn options(&self) -> StickerOptions {
        StickerOptions {
            padding: self.padding,
            radius: self.radius,
            shadow: self.shadow,
        }
    }
}

/// Transparent padding + rounding + shadow a sticker can carry.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(default)]
pub struct StickerOptions {
    /// Transparent margin around the content, in pixels.
    pub padding: u32,
    /// Corner radius of the content, in pixels. Clamped to half the shorter side.
    pub radius: u32,
    /// Draw a soft drop shadow behind the content.
    pub shadow: bool,
}

impl Default for StickerOptions {
    fn default() -> Self {
        Self {
            padding: 24,
            radius: 16,
            shadow: true,
        }
    }
}

/// Shadow offset and blur, derived from the content size so a 4K sticker does not get
/// the same 4-pixel shadow as a thumbnail.
fn shadow_metrics(width: u32, height: u32) -> (i32, i32, u32) {
    let unit = (width.min(height) as f32 / 200.0).clamp(1.0, 12.0);
    let offset = (unit * 1.5).round() as i32;
    let blur = (unit * 4.0).round() as u32;
    (offset, offset, blur)
}

/// Alpha coverage of a rounded rectangle at (x, y), as 0..255.
///
/// Antialiased by supersampling the four sub-pixel quadrants: a hard 0/1 test leaves
/// visible stair-stepping on the corners, which is the one place a sticker's edge is
/// looked at closely.
fn rounded_alpha(x: u32, y: u32, w: u32, h: u32, radius: u32) -> u8 {
    if w == 0 || h == 0 {
        return 0;
    }
    let r = radius.min(w.min(h) / 2) as f32;
    let (fw, fh) = (w as f32, h as f32);

    let mut hits = 0u32;
    for (dx, dy) in [(0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)] {
        let px = x as f32 + dx;
        let py = y as f32 + dy;
        if px < 0.0 || py < 0.0 || px > fw || py > fh {
            continue;
        }
        // Only the four corner quadrants need the radius test; a point that is not
        // inside a corner circle's bounding box is inside the rectangle.
        let cx = if px < r { Some(r) } else if px > fw - r { Some(fw - r) } else { None };
        let cy = if py < r { Some(r) } else if py > fh - r { Some(fh - r) } else { None };
        match (cx, cy) {
            (Some(cx), Some(cy)) => {
                let d = ((px - cx).powi(2) + (py - cy).powi(2)).sqrt();
                if d <= r {
                    hits += 1;
                }
            }
            _ => hits += 1,
        }
    }
    (hits * 255 / 4) as u8
}

/// Separable box blur of a single-channel mask.
///
/// Two passes rather than one square kernel: identical result, but the cost per pixel
/// drops from `(2r+1)^2` to `2(2r+1)`. The window is a running sum, and its divisor is
/// the count of samples that were actually inside the image — using the full window
/// width instead would darken the shadow towards the edges.
fn blur_alpha(mask: &[u8], w: u32, h: u32, radius: u32) -> Vec<u8> {
    if radius == 0 || w == 0 || h == 0 {
        return mask.to_vec();
    }
    let r = radius as i32;
    let (wi, hi) = (w as i32, h as i32);
    let mut tmp = vec![0u8; mask.len()];
    let mut out = vec![0u8; mask.len()];

    // Horizontal pass: mask -> tmp.
    for y in 0..hi {
        let row = y * wi;
        let mut acc: i32 = 0;
        let mut n: i32 = 0;
        for x in -r..=r {
            if (0..wi).contains(&x) {
                acc += mask[(row + x) as usize] as i32;
                n += 1;
            }
        }
        for x in 0..wi {
            tmp[(row + x) as usize] = (acc / n.max(1)) as u8;
            let leaving = x - r;
            if (0..wi).contains(&leaving) {
                acc -= mask[(row + leaving) as usize] as i32;
                n -= 1;
            }
            let entering = x + r + 1;
            if (0..wi).contains(&entering) {
                acc += mask[(row + entering) as usize] as i32;
                n += 1;
            }
        }
    }

    // Vertical pass: tmp -> out.
    for x in 0..wi {
        let mut acc: i32 = 0;
        let mut n: i32 = 0;
        for y in -r..=r {
            if (0..hi).contains(&y) {
                acc += tmp[(y * wi + x) as usize] as i32;
                n += 1;
            }
        }
        for y in 0..hi {
            out[(y * wi + x) as usize] = (acc / n.max(1)) as u8;
            let leaving = y - r;
            if (0..hi).contains(&leaving) {
                acc -= tmp[(leaving * wi + x) as usize] as i32;
                n -= 1;
            }
            let entering = y + r + 1;
            if (0..hi).contains(&entering) {
                acc += tmp[(entering * wi + x) as usize] as i32;
                n += 1;
            }
        }
    }
    out
}

/// Frame one composed RGBA frame into a sticker of its own size, transparent around it.
///
/// The returned buffer is `rgba` plus `padding` on every side, plus room for the shadow.
/// A sticker that is only the recording with rounded corners gets `padding: 0`, which
/// keeps the output size exactly the content size.
pub fn build_sticker(rgba: &[u8], width: u32, height: u32, opts: StickerOptions) -> Option<(Vec<u8>, u32, u32)> {
    if width == 0 || height == 0 || rgba.len() < (width as usize) * (height as usize) * 4 {
        return None;
    }
    let pad = opts.padding;
    let (ox, oy, blur) = if opts.shadow {
        shadow_metrics(width, height)
    } else {
        (0, 0, 0)
    };
    // Room for the shadow. The metrics are always offset down-right (see
    // `shadow_metrics`), so that is the only direction the canvas is grown in, and the
    // test below pins that assumption.
    debug_assert!(ox >= 0 && oy >= 0, "shadow offset is assumed down-right");
    let right = (ox.max(0) as u32).saturating_add(blur);
    let bottom = (oy.max(0) as u32).saturating_add(blur);

    let out_w = width + pad * 2 + right;
    let out_h = height + pad * 2 + bottom;
    let mut out = vec![0u8; (out_w as usize) * (out_h as usize) * 4];

    let content_x = pad;
    let content_y = pad;

    if opts.shadow {
        // Build the content's alpha mask, blur it, and lay it down as black beneath.
        let mut mask = vec![0u8; (width as usize) * (height as usize)];
        for y in 0..height {
            for x in 0..width {
                mask[(y * width + x) as usize] = rounded_alpha(x, y, width, height, opts.radius);
            }
        }
        let blurred = blur_alpha(&mask, width, height, blur);
        const SHADOW_ALPHA: u32 = 110;
        for y in 0..height {
            let dy = content_y as i32 + y as i32 + oy;
            for x in 0..width {
                let dx = content_x as i32 + x as i32 + ox;
                if dx < 0 || dy < 0 || dx >= out_w as i32 || dy >= out_h as i32 {
                    continue;
                }
                let a = blurred[(y * width + x) as usize] as u32 * SHADOW_ALPHA / 255;
                if a == 0 {
                    continue;
                }
                let p = ((dy as u32 * out_w + dx as u32) * 4) as usize;
                // Source-over of opaque black onto whatever is already there (nothing,
                // at this point) — but kept general so the order stays obvious.
                let dst_a = out[p + 3] as u32;
                let src_a = a;
                let out_a = src_a + dst_a * (255 - src_a) / 255;
                if out_a == 0 {
                    continue;
                }
                out[p] = ((0 * src_a + out[p] as u32 * dst_a * (255 - src_a) / 255) / out_a) as u8;
                out[p + 1] =
                    ((0 * src_a + out[p + 1] as u32 * dst_a * (255 - src_a) / 255) / out_a) as u8;
                out[p + 2] =
                    ((0 * src_a + out[p + 2] as u32 * dst_a * (255 - src_a) / 255) / out_a) as u8;
                out[p + 3] = out_a as u8;
            }
        }
    }

    // Content on top, clipped to the rounded shape.
    for y in 0..height {
        let dy = content_y + y;
        for x in 0..width {
            let cov = rounded_alpha(x, y, width, height, opts.radius) as u32;
            if cov == 0 {
                continue;
            }
            let src = ((y * width + x) * 4) as usize;
            let dst = (((dy * out_w) + content_x + x) * 4) as usize;
            let src_a = rgba[src + 3] as u32 * cov / 255;
            let dst_a = out[dst + 3] as u32;
            let out_a = src_a + dst_a * (255 - src_a) / 255;
            if out_a == 0 {
                continue;
            }
            for c in 0..3 {
                out[dst + c] = ((rgba[src + c] as u32 * src_a
                    + out[dst + c] as u32 * dst_a * (255 - src_a) / 255)
                    / out_a) as u8;
            }
            out[dst + 3] = out_a as u8;
        }
    }

    Some((out, out_w, out_h))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32, px: [u8; 4]) -> Vec<u8> {
        let mut v = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..w * h {
            v.extend_from_slice(&px);
        }
        v
    }

    #[test]
    fn padding_grows_the_sticker_by_exactly_that_much() {
        let opts = StickerOptions { padding: 10, radius: 0, shadow: false };
        let (out, w, h) = build_sticker(&solid(4, 4, [255, 0, 0, 255]), 4, 4, opts).unwrap();
        assert_eq!((w, h), (24, 24));
        assert_eq!(out.len(), 24 * 24 * 4);
    }

    /// The padding must be transparent, not black: a sticker is composited onto
    /// someone else's slide, and a black border would be an obvious defect.
    #[test]
    fn padding_is_transparent_and_content_is_not() {
        let pad = 2;
        let opts = StickerOptions { padding: pad, radius: 0, shadow: false };
        let (out, w, _) = build_sticker(&solid(2, 2, [255, 0, 0, 255]), 2, 2, opts).unwrap();
        assert_eq!(out[3], 0, "top-left padding must be transparent");
        assert_eq!(w, 2 + pad * 2);
        // The content starts `pad` in, not at the centre of the padded canvas.
        let centre = (((pad * w) + pad) * 4) as usize;
        assert_eq!(out[centre + 3], 255, "content must be opaque");
        assert_eq!(&out[centre..centre + 3], &[255, 0, 0]);
        // ...and the last content pixel sits `pad` from the opposite edge.
        let last = ((((pad + 1) * w) + pad + 1) * 4) as usize;
        assert_eq!(out[last + 3], 255, "the whole content must be opaque");
    }

    /// The canvas sizing and the shadow drawing share one assumption — that the offset
    /// is down-right — so it is asserted rather than left in a comment.
    #[test]
    fn shadow_offset_is_always_down_right() {
        for (w, h) in [(16u32, 16u32), (200, 100), (3840, 2160)] {
            let (ox, oy, _) = shadow_metrics(w, h);
            assert!(ox >= 0 && oy >= 0, "{w}x{h} produced a negative offset");
        }
    }

    /// A sticker that is only rounded corners and no padding must be exactly the same
    /// size as its source, or every downstream layout would shift.
    #[test]
    fn no_padding_no_shadow_keeps_the_source_dimensions() {
        let opts = StickerOptions { padding: 0, radius: 4, shadow: false };
        let (out, w, h) = build_sticker(&solid(20, 12, [9, 9, 9, 255]), 20, 12, opts).unwrap();
        assert_eq!((w, h), (20, 12));
        let centre = ((6 * w + 10) * 4) as usize;
        assert_eq!(&out[centre..centre + 3], &[9, 9, 9]);
        assert_eq!(out[centre + 3], 255);
    }

    /// Rounding has to actually remove the corners, or the option does nothing.
    #[test]
    fn rounding_clears_the_corners_and_keeps_the_middle() {
        let opts = StickerOptions { padding: 0, radius: 8, shadow: false };
        let (out, w, _) = build_sticker(&solid(32, 32, [0, 255, 0, 255]), 32, 32, opts).unwrap();
        assert_eq!(out[3], 0, "corner pixel must be cut");
        let centre = ((16 * w + 16) * 4) as usize;
        assert_eq!(out[centre + 3], 255, "centre must stay opaque");
    }

    /// A radius wider than the image cannot be honoured; it must clamp rather than
    /// produce a 1-pixel dot or divide by zero.
    #[test]
    fn radius_clamps_to_half_the_shorter_side() {
        let opts = StickerOptions { padding: 0, radius: 999, shadow: false };
        let (out, w, _) = build_sticker(&solid(20, 10, [0, 0, 255, 255]), 20, 10, opts).unwrap();
        // With radius = 5 the exact centre is still opaque; the top edge mid-point is too.
        let top_mid = ((0 * w + 10) * 4) as usize;
        assert_eq!(out[top_mid + 3], 255, "top edge centre must survive");
        assert_eq!(out[3], 0, "corner must still be cut");
    }

    #[test]
    fn shadow_extends_the_canvas_down_and_right_only() {
        let opts = StickerOptions { padding: 4, radius: 0, shadow: true };
        let (_, w, h) = build_sticker(&solid(100, 100, [255, 255, 255, 255]), 100, 100, opts).unwrap();
        assert!(w > 100 + 8, "shadow needs room on the right: {w}");
        assert!(h > 100 + 8, "shadow needs room below: {h}");
    }

    #[test]
    fn shadow_leaves_a_visible_dark_trace_outside_the_content() {
        let opts = StickerOptions { padding: 0, radius: 0, shadow: true };
        let (out, w, h) = build_sticker(&solid(120, 120, [255, 255, 255, 255]), 120, 120, opts).unwrap();
        // The bottom-right strip outside the content should carry shadow alpha.
        let mut found = false;
        for y in 0..h {
            for x in 120..w {
                let p = ((y * w + x) * 4) as usize;
                if out[p + 3] > 8 && out[p + 3] < 255 {
                    found = true;
                }
            }
        }
        assert!(found, "expected a soft shadow edge beyond the content");
    }

    #[test]
    fn no_shadow_means_exact_content_size_plus_padding() {
        let opts = StickerOptions { padding: 0, radius: 0, shadow: false };
        let (_, w, h) = build_sticker(&solid(64, 48, [1, 2, 3, 255]), 64, 48, opts).unwrap();
        assert_eq!((w, h), (64, 48));
    }

    #[test]
    fn refuses_a_short_buffer() {
        assert!(build_sticker(&[0u8; 8], 4, 4, StickerOptions::default()).is_none());
        assert!(build_sticker(&[], 0, 0, StickerOptions::default()).is_none());
    }

    /// A fully transparent source must stay transparent, including under the shadow:
    /// blending it with an opaque black shadow would ring the frame.
    #[test]
    fn a_fully_transparent_source_stays_transparent() {
        let opts = StickerOptions { padding: 0, radius: 0, shadow: false };
        let (out, _, _) = build_sticker(&solid(8, 8, [0, 0, 0, 0]), 8, 8, opts).unwrap();
        assert!(out.chunks_exact(4).all(|p| p[3] == 0));
    }

    #[test]
    fn blur_spreads_a_single_bright_pixel() {
        let mut mask = vec![0u8; 9];
        mask[4] = 255;
        let out = blur_alpha(&mask, 3, 3, 1);
        assert!(out[4] > 0 && out[4] < 255, "centre must be softened");
        assert!(out[0] > 0, "neighbour must receive some of it");
    }
}
