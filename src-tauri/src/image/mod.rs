//! CPU frame resizing for BGRA buffers.
//!
//! Output scaling is applied here rather than on the GPU: the capture path already
//! reads frames back to system memory for the encoder, so resampling in the same
//! pass avoids a second readback and keeps the D3D11 pipeline untouched.

pub mod resize;
