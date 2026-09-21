//! Box-filter downscale of a BGRA buffer.
//!
//! Only downscaling is supported: `output_size()` in `settings.rs` never produces a
//! target wider than the source, and box averaging is both cheaper and less ringy
//! than a separable filter for UI content (crisp edges, flat colour fields).

/// Box-filter `src` (BGRA8, `sw`x`sh`) down to `dw`x`dh`.
///
/// Returns `None` when the target is larger than the source or the buffer is short —
/// callers fall back to the original frame rather than scaling up.
pub fn bgra_box(src: &[u8], sw: u32, sh: u32, dw: u32, dh: u32) -> Option<Vec<u8>> {
    if dw == 0 || dh == 0 || sw == 0 || sh == 0 {
        return None;
    }
    if dw > sw || dh > sh {
        return None;
    }
    if src.len() < (sw as usize) * (sh as usize) * 4 {
        return None;
    }
    if dw == sw && dh == sh {
        return Some(src.to_vec());
    }

    let mut out = vec![0u8; (dw as usize) * (dh as usize) * 4];
    // Accumulate in u32: worst case is 4 channels * 255 * (sw/dw * sh/dh) pixels,
    // which stays far below u32::MAX for any realistic screen resolution.
    for dy in 0..dh as usize {
        let y0 = dy * sh as usize / dh as usize;
        let y1 = ((dy + 1) * sh as usize / dh as usize).max(y0 + 1);
        for dx in 0..dw as usize {
            let x0 = dx * sw as usize / dw as usize;
            let x1 = ((dx + 1) * sw as usize / dw as usize).max(x0 + 1);
            let mut acc = [0u32; 4];
            let mut n = 0u32;
            for y in y0..y1.min(sh as usize) {
                let row = y * sw as usize;
                for x in x0..x1.min(sw as usize) {
                    let p = (row + x) * 4;
                    acc[0] += src[p] as u32;
                    acc[1] += src[p + 1] as u32;
                    acc[2] += src[p + 2] as u32;
                    acc[3] += src[p + 3] as u32;
                    n += 1;
                }
            }
            let o = (dy * dw as usize + dx) * 4;
            if n == 0 {
                continue;
            }
            out[o] = (acc[0] / n) as u8;
            out[o + 1] = (acc[1] / n) as u8;
            out[o + 2] = (acc[2] / n) as u8;
            out[o + 3] = (acc[3] / n) as u8;
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Solid-colour frames must survive resampling unchanged (box averaging of a
    /// constant is that constant), which catches channel-order and stride bugs.
    #[test]
    fn solid_colour_is_preserved() {
        let (w, h) = (8u32, 4u32);
        let mut src = Vec::new();
        for _ in 0..w * h {
            src.extend_from_slice(&[10, 20, 30, 255]);
        }
        let out = bgra_box(&src, w, h, 4, 2).expect("scale should succeed");
        assert_eq!(out.len(), 4 * 2 * 4);
        for px in out.chunks_exact(4) {
            assert_eq!(px, [10, 20, 30, 255]);
        }
    }

    #[test]
    fn averages_a_two_by_two_block() {
        let src = vec![
            0, 0, 0, 255, /**/ 100, 100, 100, 255, //
            200, 200, 200, 255, /**/ 44, 44, 44, 255,
        ];
        let out = bgra_box(&src, 2, 2, 1, 1).expect("scale should succeed");
        // mean of 0, 100, 200, 44 = 86
        assert_eq!(out, vec![86, 86, 86, 255]);
    }

    #[test]
    fn identity_scale_copies() {
        let src = vec![1u8, 2, 3, 4, 5, 6, 7, 8];
        assert_eq!(bgra_box(&src, 2, 1, 2, 1).unwrap(), src);
    }

    #[test]
    fn refuses_upscale_and_short_buffers() {
        let src = vec![0u8; 16];
        assert!(bgra_box(&src, 2, 2, 4, 4).is_none(), "upscale must be refused");
        assert!(bgra_box(&src, 4, 4, 2, 2).is_none(), "short buffer must be refused");
        assert!(bgra_box(&src, 0, 0, 0, 0).is_none(), "zero dims must be refused");
    }

    /// Non-integer ratios must still cover every source pixel without panicking.
    #[test]
    fn handles_non_integer_ratios() {
        let (w, h) = (1000u32, 1001u32);
        let src = vec![7u8; (w as usize) * (h as usize) * 4];
        let out = bgra_box(&src, w, h, 333, 333).expect("scale should succeed");
        assert_eq!(out.len(), 333 * 333 * 4);
        assert!(out.iter().all(|&b| b == 7 || b == 0));
    }
}
