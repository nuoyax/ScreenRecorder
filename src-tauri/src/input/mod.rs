//! Read-only input observation.
//!
//! Everything here *observes* input state through polling getters. Nothing in this
//! module injects input events, installs global hooks, or otherwise drives the
//! cursor or keyboard — see `rules/safety-no-hid.md`.

pub mod mouse;
