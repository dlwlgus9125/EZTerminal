use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::NATIVE_PROTOCOL_VERSION;

pub const MAX_CONTROL_BYTES: usize = 64 * 1024;
pub const MAX_SDP_BYTES: usize = 256 * 1024;
/// Newline-delimited messages on the parent/transport stdio link may contain
/// SDP. Control/data-channel frames continue to use `MAX_CONTROL_BYTES`.
pub const MAX_STDIO_MESSAGE_BYTES: usize = MAX_SDP_BYTES + (16 * 1024);
pub const MAX_ICE_BYTES: usize = 8 * 1024;
pub const MAX_CLIPBOARD_BYTES: usize = 256 * 1024;
pub const MAX_VIDEO_SAMPLE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_CLIENT_NAME_CHARS: usize = 80;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeHello {
    pub protocol_version: u16,
    pub session_id: Uuid,
    pub client_id: Uuid,
    pub client_name: String,
    pub local_address: String,
    pub peer_address: String,
    pub udp_port: u16,
}

impl NativeHello {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.protocol_version != NATIVE_PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedVersion(self.protocol_version));
        }
        let name_len = self.client_name.chars().count();
        if name_len == 0 || name_len > MAX_CLIENT_NAME_CHARS {
            return Err(ProtocolError::InvalidClientName);
        }
        if self.local_address.parse::<std::net::IpAddr>().is_err()
            || self.peer_address.parse::<std::net::IpAddr>().is_err()
        {
            return Err(ProtocolError::InvalidAddress);
        }
        if self.udp_port == 0 {
            return Err(ProtocolError::InvalidPort);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeIceCandidate {
    pub candidate: String,
    pub sdp_mid: Option<String>,
    pub sdp_mline_index: Option<u16>,
}

impl NativeIceCandidate {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.candidate.is_empty() || self.candidate.len() > MAX_ICE_BYTES {
            return Err(ProtocolError::Oversized("iceCandidate"));
        }
        if self.sdp_mid.as_ref().is_some_and(|value| value.len() > 128) {
            return Err(ProtocolError::Oversized("sdpMid"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum MainToTransport {
    Hello(NativeHello),
    Offer {
        session_id: Uuid,
        sdp: String,
    },
    Ice {
        session_id: Uuid,
        candidate: NativeIceCandidate,
    },
    Stop {
        session_id: Uuid,
        reason: String,
    },
    SetDisplay {
        session_id: Uuid,
        display_id: String,
    },
    SetQuality {
        session_id: Uuid,
        tier: QualityTier,
    },
}

impl MainToTransport {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        match self {
            Self::Hello(hello) => hello.validate(),
            Self::Offer { sdp, .. } => {
                if sdp.is_empty() || sdp.len() > MAX_SDP_BYTES {
                    Err(ProtocolError::Oversized("sdp"))
                } else {
                    Ok(())
                }
            }
            Self::Ice { candidate, .. } => candidate.validate(),
            Self::Stop { reason, .. } if reason.len() > 128 => {
                Err(ProtocolError::Oversized("reason"))
            }
            Self::SetDisplay { display_id, .. } if display_id.len() > 256 => {
                Err(ProtocolError::Oversized("displayId"))
            }
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum TransportToMain {
    Ready {
        protocol_version: u16,
        service: ServiceAvailability,
    },
    Answer {
        session_id: Uuid,
        sdp: String,
    },
    Ice {
        session_id: Uuid,
        candidate: NativeIceCandidate,
    },
    State {
        session_id: Uuid,
        state: TransportState,
        metrics: Option<TransportMetrics>,
    },
    Displays {
        session_id: Uuid,
        displays: Vec<RemoteDisplay>,
        selected_display_id: Option<String>,
    },
    Ended {
        session_id: Uuid,
        reason: NativeEndReason,
    },
    Error {
        session_id: Option<Uuid>,
        code: NativeErrorCode,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QualityTier {
    High,
    Medium,
    Low,
    Survival,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ServiceAvailability {
    Ready,
    Missing,
    Stopped,
    Incompatible,
    Denied,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TransportState {
    Starting,
    Connecting,
    Active,
    Reconnecting,
    Stopping,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportMetrics {
    pub frames_per_second: f32,
    pub bitrate_bps: u32,
    pub round_trip_time_ms: u32,
    pub packet_loss_percent: f32,
    pub quality_tier: QualityTier,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDisplay {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub rotation_degrees: u16,
    pub primary: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NativeEndReason {
    ClientStop,
    LocalDisconnect,
    BridgeDisabled,
    TokenRotated,
    AppQuit,
    PeerTimeout,
    ServiceStopped,
    AgentStopped,
    CaptureFailed,
    EncoderFailed,
    TransportFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NativeErrorCode {
    InvalidMessage,
    UnsupportedVersion,
    ServiceUnavailable,
    ServiceDenied,
    LeaseBusy,
    UdpPortUnavailable,
    PeerAddressMismatch,
    NoDisplay,
    CaptureUnavailable,
    EncoderUnavailable,
    WebRtcFailed,
    Internal,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    #[error("unsupported native protocol version {0}")]
    UnsupportedVersion(u16),
    #[error("invalid client name")]
    InvalidClientName,
    #[error("invalid IP address")]
    InvalidAddress,
    #[error("invalid UDP port")]
    InvalidPort,
    #[error("field exceeds its size limit: {0}")]
    Oversized(&'static str),
    #[error("message exceeds the control frame limit")]
    OversizedMessage,
    #[error("invalid JSON message: {0}")]
    InvalidJson(String),
}

pub fn parse_main_message(line: &[u8]) -> Result<MainToTransport, ProtocolError> {
    if line.len() > MAX_STDIO_MESSAGE_BYTES {
        return Err(ProtocolError::OversizedMessage);
    }
    let message: MainToTransport = serde_json::from_slice(line)
        .map_err(|error| ProtocolError::InvalidJson(error.to_string()))?;
    message.validate()?;
    Ok(message)
}

pub fn encode_main_message(message: &TransportToMain) -> Result<Vec<u8>, ProtocolError> {
    let mut encoded = serde_json::to_vec(message)
        .map_err(|error| ProtocolError::InvalidJson(error.to_string()))?;
    if encoded.len() > MAX_STDIO_MESSAGE_BYTES {
        return Err(ProtocolError::OversizedMessage);
    }
    encoded.push(b'\n');
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hello() -> NativeHello {
        NativeHello {
            protocol_version: NATIVE_PROTOCOL_VERSION,
            session_id: Uuid::nil(),
            client_id: Uuid::from_u128(1),
            client_name: "Galaxy".into(),
            local_address: "100.64.0.1".into(),
            peer_address: "100.64.0.2".into(),
            udp_port: 7422,
        }
    }

    #[test]
    fn hello_rejects_wrong_version_and_invalid_addresses() {
        let mut value = hello();
        value.protocol_version = 2;
        assert_eq!(value.validate(), Err(ProtocolError::UnsupportedVersion(2)));

        let mut value = hello();
        value.peer_address = "not an address".into();
        assert_eq!(value.validate(), Err(ProtocolError::InvalidAddress));
    }

    #[test]
    fn parses_a_bounded_offer() {
        let session_id = Uuid::new_v4();
        let line = serde_json::to_vec(&MainToTransport::Offer {
            session_id,
            sdp: "v=0".into(),
        })
        .unwrap();
        assert_eq!(
            parse_main_message(&line).unwrap(),
            MainToTransport::Offer {
                session_id,
                sdp: "v=0".into()
            }
        );
    }

    #[test]
    fn rejects_oversized_signaling_before_use() {
        let line = serde_json::to_vec(&MainToTransport::Offer {
            session_id: Uuid::nil(),
            sdp: "x".repeat(MAX_SDP_BYTES + 1),
        })
        .unwrap();
        assert_eq!(
            parse_main_message(&line),
            Err(ProtocolError::Oversized("sdp"))
        );
    }

    #[test]
    fn rejects_a_message_larger_than_the_stdio_frame() {
        let line = vec![b'x'; MAX_STDIO_MESSAGE_BYTES + 1];
        assert_eq!(
            parse_main_message(&line),
            Err(ProtocolError::OversizedMessage)
        );
    }
}
