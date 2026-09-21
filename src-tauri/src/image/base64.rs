//! Base64 encoding for handing binary images to the webview.
//!
//! The region picker needs to *see* a monitor before the user can draw on it. The
//! still frame is captured in Rust, and a `data:` URL is the shortest path from there
//! into an `<img>`: no temp file to clean up, and no asset-protocol scope to widen.

const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Encode bytes as a `data:<mime>;base64,...` URL ready for an `<img src>`.
pub fn encode_data_url(mime: &str, bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() / 3 * 4 + 32);
    out.push_str("data:");
    out.push_str(mime);
    out.push_str(";base64,");

    for chunk in bytes.chunks(3) {
        // Pad the tail with zero bytes; the `=` characters below record how many of
        // them were real, which is what lets the decoder drop them again.
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 4648's own vectors — the ones every base64 implementation is checked against.
    #[test]
    fn matches_rfc4648_vectors() {
        let cases: &[(&[u8], &str)] = &[
            (b"", ""),
            (b"f", "Zg=="),
            (b"fo", "Zm8="),
            (b"foo", "Zm9v"),
            (b"foob", "Zm9vYg=="),
            (b"fooba", "Zm9vYmE="),
            (b"foobar", "Zm9vYmFy"),
        ];
        for (input, expected) in cases {
            let got = encode_data_url("image/png", input);
            assert_eq!(
                got,
                format!("data:image/png;base64,{expected}"),
                "encoding {input:?}"
            );
        }
    }

    #[test]
    fn emits_the_requested_mime_type() {
        assert!(encode_data_url("image/jpeg", b"x").starts_with("data:image/jpeg;base64,"));
    }

    /// A real still frame goes through this path, so it must survive intact and stay
    /// decodable by anything else — verified here with an independent decoder.
    #[test]
    fn roundtrips_an_encoded_png() {
        let png = crate::image::png::encode_rgba(&[9u8; 4 * 2 * 2], 2, 2).unwrap();
        let url = encode_data_url("image/png", &png);
        let payload = url.strip_prefix("data:image/png;base64,").unwrap();

        // Decode by hand: 4 chars -> 3 bytes, stopping at padding.
        let mut back = Vec::new();
        let mut acc = 0u32;
        let mut bits = 0u32;
        for c in payload.bytes() {
            if c == b'=' {
                break;
            }
            let v = ALPHABET.iter().position(|&a| a == c).expect("valid alphabet") as u32;
            acc = (acc << 6) | v;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                back.push((acc >> bits) as u8);
            }
        }
        assert_eq!(back, png);
    }
}
