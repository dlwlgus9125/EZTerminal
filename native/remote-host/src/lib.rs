#[cfg(all(windows, feature = "windows-host"))]
pub mod capture;
#[cfg(all(windows, feature = "windows-host"))]
pub mod input;
pub mod lease;
pub mod protocol;
pub mod quality;

#[cfg(all(windows, feature = "windows-host"))]
pub mod service;
#[cfg(all(windows, feature = "windows-host"))]
pub mod session_agent;
#[cfg(all(windows, feature = "windows-host"))]
pub mod transport;

pub const NATIVE_PROTOCOL_VERSION: u16 = 1;
pub const SERVICE_NAME: &str = "EZTerminalRemoteHost";
