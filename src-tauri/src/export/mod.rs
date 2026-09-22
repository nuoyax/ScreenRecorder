//! Export paths: GIF, still stickers, and the frame transport they share.
//!
//! Nothing here needs a GPU, a plugin, or a bundled binary. The frame the user sees in
//! the editor preview is produced by the canvas compositor in the webview; these modules
//! take those pixels, encode them, and write a file.
//!
//! Three formats, three reasons:
//!
//!   * [`gif`] — an animation, self-contained, plays anywhere. Fixed 3-2-3 colour cube
//!     with ordered dithering, hand-written LZW.
//!   * [`png`](crate::image::png) — a single frame at full fidelity.
//!   * [`img`] — a single frame *framed* as a sticker: padding, rounding, shadow.
//!
//! [`probe`] covers the one format that cannot be written here (MP4 transcoding) by
//! finding an `ffmpeg` the user already has, and saying so plainly when there is none.
//! [`transcode`] is what runs it once it has been found.
//!
//! [`sequence`] is the other MP4 path, and the one that needs nothing external: it cuts
//! and concatenates the recording itself through Media Foundation's source reader, the
//! same stack the recorder encodes with.

pub mod frame;
pub mod gif;
pub mod img;
pub mod probe;
pub mod sequence;
pub mod transcode;
