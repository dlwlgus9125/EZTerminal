use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use bytes::Bytes;
use openh264::OpenH264API;
use openh264::encoder::{
    BitRate, Complexity, Encoder, EncoderConfig, FrameRate, IntraFramePeriod, Level, Profile,
    RateControlMode, UsageType, VuiConfig,
};
use openh264::formats::{BgraSliceU8, YUVBuffer};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UdpSocket;
use tokio::sync::mpsc;
use webrtc::api::APIBuilder;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MIME_TYPE_H264, MediaEngine};
use webrtc::api::setting_engine::SettingEngine;
use webrtc::ice::network_type::NetworkType;
use webrtc::ice::udp_mux::{UDPMuxDefault, UDPMuxParams};
use webrtc::ice::udp_network::UDPNetwork;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::media::Sample;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::stats::StatsReportType;
use webrtc::track::track_local::TrackLocal;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;

use crate::capture::{DisplayCapture, DisplayDescriptor, enumerate_displays};
use crate::input::{InputChannel, InputInjector, InputOutcome};
use crate::protocol::{
    MAX_CONTROL_BYTES, MainToTransport, NativeEndReason, NativeErrorCode, NativeHello,
    NativeIceCandidate, QualityTier, RemoteDisplay, ServiceAvailability, TransportMetrics,
    TransportState, TransportToMain, encode_main_message, parse_main_message,
};
use crate::quality::{NetworkSample, QualityController};

const CONTROL_CHANNEL: &str = "ez-control-v1";
const POINTER_CHANNEL: &str = "ez-pointer-v1";

struct PeerSession {
    pc: Arc<RTCPeerConnection>,
    stop: Arc<AtomicBool>,
    input: Arc<Mutex<InputInjector>>,
}

impl PeerSession {
    async fn close(self) -> Result<()> {
        self.stop.store(true, Ordering::Release);
        if let Ok(mut input) = self.input.lock() {
            input.release_all();
        }
        self.pc.close().await?;
        Ok(())
    }
}

pub fn run() -> Result<()> {
    tokio::runtime::Runtime::new()?.block_on(run_async())
}

async fn run_async() -> Result<()> {
    let (output_tx, mut output_rx) = mpsc::channel::<TransportToMain>(64);
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(message) = output_rx.recv().await {
            let encoded = encode_main_message(&message).map_err(anyhow::Error::from)?;
            stdout.write_all(&encoded).await?;
            stdout.flush().await?;
        }
        Ok::<_, anyhow::Error>(())
    });

    output_tx
        .send(TransportToMain::Ready {
            protocol_version: crate::NATIVE_PROTOCOL_VERSION,
            service: crate::service::availability(),
        })
        .await?;

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut hello: Option<NativeHello> = None;
    let mut peer_connection: Option<PeerSession> = None;

    while let Some(line) = lines
        .next_line()
        .await
        .context("reading transport command")?
    {
        let command = match parse_main_message(line.as_bytes()) {
            Ok(command) => command,
            Err(error) => {
                send_error(
                    &output_tx,
                    None,
                    NativeErrorCode::InvalidMessage,
                    error.to_string(),
                )
                .await;
                continue;
            }
        };

        match command {
            MainToTransport::Hello(value) => {
                if hello.is_some() {
                    send_error(
                        &output_tx,
                        Some(value.session_id),
                        NativeErrorCode::InvalidMessage,
                        "hello was already accepted",
                    )
                    .await;
                    continue;
                }
                if crate::service::availability() != ServiceAvailability::Ready {
                    send_error(
                        &output_tx,
                        Some(value.session_id),
                        NativeErrorCode::ServiceUnavailable,
                        "the privileged remote service is not running",
                    )
                    .await;
                    continue;
                }
                hello = Some(value);
            }
            MainToTransport::Offer { session_id, sdp } => {
                let Some(active_hello) = hello.as_ref() else {
                    send_error(
                        &output_tx,
                        Some(session_id),
                        NativeErrorCode::InvalidMessage,
                        "hello must precede the offer",
                    )
                    .await;
                    continue;
                };
                if active_hello.session_id != session_id {
                    send_error(
                        &output_tx,
                        Some(session_id),
                        NativeErrorCode::InvalidMessage,
                        "session id does not match hello",
                    )
                    .await;
                    continue;
                }
                let peer_ip: IpAddr = active_hello.peer_address.parse()?;
                validate_remote_sdp_candidates(&sdp, peer_ip)?;
                let pc = create_peer(active_hello, output_tx.clone()).await?;
                pc.pc
                    .set_remote_description(RTCSessionDescription::offer(sdp)?)
                    .await?;
                let answer = pc.pc.create_answer(None).await?;
                pc.pc.set_local_description(answer).await?;
                let local = pc
                    .pc
                    .local_description()
                    .await
                    .ok_or_else(|| anyhow!("WebRTC answer was not retained"))?;
                output_tx
                    .send(TransportToMain::Answer {
                        session_id,
                        sdp: local.sdp,
                    })
                    .await?;
                peer_connection = Some(pc);
            }
            MainToTransport::Ice {
                session_id,
                candidate,
            } => {
                let Some(active_hello) = hello.as_ref() else {
                    continue;
                };
                if active_hello.session_id != session_id {
                    continue;
                }
                let peer_ip = active_hello.peer_address.parse()?;
                if !candidate_matches_peer(&candidate.candidate, peer_ip) {
                    send_error(
                        &output_tx,
                        Some(session_id),
                        NativeErrorCode::PeerAddressMismatch,
                        "remote ICE candidate is not the authenticated peer",
                    )
                    .await;
                    continue;
                }
                if let Some(pc) = peer_connection.as_ref() {
                    pc.pc
                        .add_ice_candidate(RTCIceCandidateInit {
                            candidate: candidate.candidate,
                            sdp_mid: candidate.sdp_mid,
                            sdp_mline_index: candidate.sdp_mline_index,
                            username_fragment: None,
                        })
                        .await?;
                }
            }
            MainToTransport::Stop { session_id, .. } => {
                if let Some(pc) = peer_connection.take() {
                    pc.close().await?;
                }
                let _ = output_tx
                    .send(TransportToMain::Ended {
                        session_id,
                        reason: NativeEndReason::ClientStop,
                    })
                    .await;
                break;
            }
            MainToTransport::SetDisplay { .. } | MainToTransport::SetQuality { .. } => {
                // Forwarding to the SID-bound capture agent is wired by the service
                // broker. Signaling remains accepted while an agent is restarting.
            }
        }
    }

    if let Some(pc) = peer_connection {
        let _ = pc.close().await;
    }
    drop(output_tx);
    writer.await??;
    Ok(())
}

async fn create_peer(
    hello: &NativeHello,
    output: mpsc::Sender<TransportToMain>,
) -> Result<PeerSession> {
    let local_ip: IpAddr = hello.local_address.parse()?;
    let socket = UdpSocket::bind(SocketAddr::new(local_ip, hello.udp_port))
        .await
        .with_context(|| {
            format!(
                "binding trusted WebRTC UDP address {local_ip}:{}",
                hello.udp_port
            )
        })?;
    let udp_mux = UDPMuxDefault::new(UDPMuxParams::new(socket));

    let mut media_engine = MediaEngine::default();
    media_engine.register_default_codecs()?;
    let registry = register_default_interceptors(Default::default(), &mut media_engine)?;

    let mut settings = SettingEngine::default();
    settings.set_network_types(vec![match local_ip {
        IpAddr::V4(_) => NetworkType::Udp4,
        IpAddr::V6(_) => NetworkType::Udp6,
    }]);
    settings.set_ip_filter(Box::new(move |candidate_ip| candidate_ip == local_ip));
    settings.set_udp_network(UDPNetwork::Muxed(udp_mux));
    settings.set_ice_timeouts(
        Some(Duration::from_secs(5)),
        Some(Duration::from_secs(15)),
        Some(Duration::from_secs(2)),
    );

    let api = APIBuilder::new()
        .with_media_engine(media_engine)
        .with_interceptor_registry(registry)
        .with_setting_engine(settings)
        .build();
    let pc = Arc::new(
        api.new_peer_connection(RTCConfiguration {
            ice_servers: vec![],
            ..Default::default()
        })
        .await?,
    );

    let track = Arc::new(TrackLocalStaticSample::new(
        RTCRtpCodecCapability {
            mime_type: MIME_TYPE_H264.to_owned(),
            clock_rate: 90_000,
            sdp_fmtp_line: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e028"
                .to_owned(),
            ..Default::default()
        },
        "screen".to_owned(),
        "ezterminal".to_owned(),
    ));
    let sender = pc
        .add_track(Arc::clone(&track) as Arc<dyn TrackLocal + Send + Sync>)
        .await?;
    tokio::spawn(async move {
        let mut buffer = vec![0u8; 1500];
        while sender.read(&mut buffer).await.is_ok() {}
    });

    let session_id = hello.session_id;
    let stop = Arc::new(AtomicBool::new(false));
    let connected = Arc::new(AtomicBool::new(false));
    let network_sample = Arc::new(Mutex::new(NetworkSample {
        round_trip_time_ms: 0,
        packet_loss_percent: 0.0,
        send_backlog_ms: 0,
    }));
    spawn_network_stats(
        Arc::clone(&pc),
        Arc::clone(&stop),
        Arc::clone(&network_sample),
    );
    let displays = enumerate_displays()?;
    let selected_display_id = Arc::new(Mutex::new(
        displays
            .iter()
            .find(|display| display.primary)
            .unwrap_or(&displays[0])
            .id
            .clone(),
    ));
    let input = Arc::new(Mutex::new(InputInjector::with_displays(
        session_id,
        displays.clone(),
        Arc::clone(&selected_display_id),
    )));
    spawn_capture(
        session_id,
        Arc::clone(&track),
        Arc::clone(&stop),
        Arc::clone(&connected),
        displays,
        selected_display_id,
        network_sample,
        output.clone(),
    );
    let candidate_output = output.clone();
    pc.on_ice_candidate(Box::new(move |candidate| {
        let candidate_output = candidate_output.clone();
        Box::pin(async move {
            let Some(candidate) = candidate else { return };
            if let Ok(candidate) = candidate.to_json() {
                let _ = candidate_output
                    .send(TransportToMain::Ice {
                        session_id,
                        candidate: NativeIceCandidate {
                            candidate: candidate.candidate,
                            sdp_mid: candidate.sdp_mid,
                            sdp_mline_index: candidate.sdp_mline_index,
                        },
                    })
                    .await;
            }
        })
    }));

    let state_output = output.clone();
    let state_connected = Arc::clone(&connected);
    let state_stop = Arc::clone(&stop);
    pc.on_peer_connection_state_change(Box::new(move |state| {
        let state_output = state_output.clone();
        let state_connected = Arc::clone(&state_connected);
        let state_stop = Arc::clone(&state_stop);
        Box::pin(async move {
            let message = match state {
                RTCPeerConnectionState::New | RTCPeerConnectionState::Connecting => {
                    state_connected.store(false, Ordering::Release);
                    TransportToMain::State {
                        session_id,
                        state: TransportState::Connecting,
                        metrics: None,
                    }
                }
                RTCPeerConnectionState::Connected => {
                    state_connected.store(true, Ordering::Release);
                    TransportToMain::State {
                        session_id,
                        state: TransportState::Active,
                        metrics: None,
                    }
                }
                RTCPeerConnectionState::Disconnected => {
                    state_connected.store(false, Ordering::Release);
                    TransportToMain::State {
                        session_id,
                        state: TransportState::Reconnecting,
                        metrics: None,
                    }
                }
                RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed => {
                    state_connected.store(false, Ordering::Release);
                    state_stop.store(true, Ordering::Release);
                    TransportToMain::Ended {
                        session_id,
                        reason: NativeEndReason::TransportFailed,
                    }
                }
                RTCPeerConnectionState::Unspecified => return,
            };
            let _ = state_output.send(message).await;
        })
    }));

    let channel_input = Arc::clone(&input);
    pc.on_data_channel(Box::new(move |channel| {
        let channel_input = Arc::clone(&channel_input);
        Box::pin(async move {
            let label = channel.label().to_owned();
            if label != CONTROL_CHANNEL && label != POINTER_CHANNEL {
                let _ = channel.close().await;
                return;
            }
            let reply_channel = Arc::clone(&channel);
            if label == CONTROL_CHANNEL {
                let close_input = Arc::clone(&channel_input);
                channel.on_close(Box::new(move || {
                    let close_input = Arc::clone(&close_input);
                    Box::pin(async move {
                        if let Ok(mut injector) = close_input.lock() {
                            injector.release_all();
                        }
                    })
                }));
            }
            channel.on_message(Box::new(move |message| {
                let label = label.clone();
                let channel_input = Arc::clone(&channel_input);
                let reply_channel = Arc::clone(&reply_channel);
                Box::pin(async move {
                    if message.data.len() > MAX_CONTROL_BYTES {
                        send_input_error(&reply_channel, "message-too-large").await;
                        return;
                    }
                    let input_channel = if label == POINTER_CHANNEL {
                        InputChannel::Pointer
                    } else {
                        InputChannel::Reliable
                    };
                    let outcome = channel_input
                        .lock()
                        .map_err(|_| anyhow!("input state poisoned"))
                        .and_then(|mut injector| injector.handle(&message.data, input_channel));
                    match outcome {
                        Ok(InputOutcome::ClipboardText(text)) => {
                            if let Ok(message) = serde_json::to_string(&serde_json::json!({
                                "type": "clipboard-text",
                                "text": text,
                            })) {
                                let _ = reply_channel.send_text(message).await;
                            }
                        }
                        Ok(InputOutcome::None) => {}
                        Err(_) => {
                            send_input_error(&reply_channel, "input-rejected").await;
                        }
                    }
                })
            }));
        })
    }));

    Ok(PeerSession { pc, stop, input })
}

fn spawn_capture(
    session_id: uuid::Uuid,
    track: Arc<TrackLocalStaticSample>,
    stop: Arc<AtomicBool>,
    connected: Arc<AtomicBool>,
    displays: Vec<DisplayDescriptor>,
    selected_display_id: Arc<Mutex<String>>,
    network_sample: Arc<Mutex<NetworkSample>>,
    output: mpsc::Sender<TransportToMain>,
) {
    let runtime = tokio::runtime::Handle::current();
    std::thread::spawn(move || {
        let result = run_capture_loop(
            session_id,
            &track,
            &stop,
            &connected,
            &displays,
            &selected_display_id,
            &network_sample,
            &output,
            &runtime,
        );
        if let Err(error) = result {
            stop.store(true, Ordering::Release);
            let _ = output.blocking_send(TransportToMain::Error {
                session_id: Some(session_id),
                code: NativeErrorCode::CaptureUnavailable,
                message: error.to_string(),
            });
        }
    });
}

fn run_capture_loop(
    session_id: uuid::Uuid,
    track: &TrackLocalStaticSample,
    stop: &AtomicBool,
    connected: &AtomicBool,
    displays: &[DisplayDescriptor],
    selected_display_id: &Mutex<String>,
    network_sample: &Mutex<NetworkSample>,
    output: &mpsc::Sender<TransportToMain>,
    runtime: &tokio::runtime::Handle,
) -> Result<()> {
    let mut quality = QualityController::default();
    let mut tier = quality.tier();
    let mut profile = quality_profile(tier);
    let mut active_display_id = selected_display_id
        .lock()
        .map_err(|_| anyhow!("display selection poisoned"))?
        .clone();
    let active_display = find_display(displays, &active_display_id)?;
    let mut capture = DisplayCapture::new(
        active_display.clone(),
        profile.max_width,
        profile.max_height,
    )?;
    let (width, height) = capture.dimensions();
    output.blocking_send(TransportToMain::Displays {
        session_id,
        displays: remote_displays(displays),
        selected_display_id: Some(active_display_id.clone()),
    })?;
    let mut encoder = make_encoder(profile.bitrate_bps, profile.frames_per_second)?;
    let mut yuv = YUVBuffer::new(width, height);
    let mut sample_started = Instant::now();
    let mut frames = 0u32;
    let mut encoded_bytes = 0u64;

    while !stop.load(Ordering::Acquire) {
        let requested_display_id = selected_display_id
            .lock()
            .map_err(|_| anyhow!("display selection poisoned"))?
            .clone();
        if requested_display_id != active_display_id {
            let next = find_display(displays, &requested_display_id)?;
            capture = DisplayCapture::new(next.clone(), profile.max_width, profile.max_height)?;
            let (next_width, next_height) = capture.dimensions();
            yuv = YUVBuffer::new(next_width, next_height);
            encoder = make_encoder(profile.bitrate_bps, profile.frames_per_second)?;
            active_display_id = requested_display_id;
            output.blocking_send(TransportToMain::Displays {
                session_id,
                displays: remote_displays(displays),
                selected_display_id: Some(active_display_id.clone()),
            })?;
        }
        if !connected.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(20));
            sample_started = Instant::now();
            frames = 0;
            encoded_bytes = 0;
            continue;
        }
        let frame_started = Instant::now();
        let dimensions = capture.dimensions();
        let bgra = capture.capture()?;
        yuv.read_rgb(BgraSliceU8::new(bgra, dimensions));
        let encoded = encoder.encode(&yuv)?.to_vec();
        if !encoded.is_empty() {
            encoded_bytes += encoded.len() as u64;
            let send_started = Instant::now();
            runtime.block_on(track.write_sample(&Sample {
                data: Bytes::from(encoded),
                duration: profile.frame_duration,
                ..Default::default()
            }))?;
            if let Ok(mut sample) = network_sample.lock() {
                sample.send_backlog_ms =
                    send_started.elapsed().as_millis().min(u32::MAX as u128) as u32;
            }
            frames += 1;
        }
        let elapsed = sample_started.elapsed();
        if elapsed >= Duration::from_secs(2) {
            let seconds = elapsed.as_secs_f32().max(0.001);
            let sample = network_sample
                .lock()
                .map(|sample| *sample)
                .unwrap_or(NetworkSample {
                    round_trip_time_ms: 0,
                    packet_loss_percent: 0.0,
                    send_backlog_ms: 0,
                });
            let next_tier = quality.observe(sample);
            let _ = output.blocking_send(TransportToMain::State {
                session_id,
                state: TransportState::Active,
                metrics: Some(TransportMetrics {
                    frames_per_second: frames as f32 / seconds,
                    bitrate_bps: ((encoded_bytes as f64 * 8.0) / seconds as f64) as u32,
                    round_trip_time_ms: sample.round_trip_time_ms,
                    packet_loss_percent: sample.packet_loss_percent,
                    quality_tier: tier,
                }),
            });
            if next_tier != tier {
                tier = next_tier;
                profile = quality_profile(tier);
                let display = find_display(displays, &active_display_id)?;
                capture =
                    DisplayCapture::new(display.clone(), profile.max_width, profile.max_height)?;
                let (next_width, next_height) = capture.dimensions();
                yuv = YUVBuffer::new(next_width, next_height);
                encoder = make_encoder(profile.bitrate_bps, profile.frames_per_second)?;
            }
            sample_started = Instant::now();
            frames = 0;
            encoded_bytes = 0;
        }
        if let Some(remaining) = profile.frame_duration.checked_sub(frame_started.elapsed()) {
            std::thread::sleep(remaining);
        }
    }
    Ok(())
}

async fn send_input_error(channel: &webrtc::data_channel::RTCDataChannel, code: &'static str) {
    let message = serde_json::json!({
        "type": "input-error",
        "code": code,
    });
    let _ = channel.send_text(message.to_string()).await;
}

fn find_display<'a>(displays: &'a [DisplayDescriptor], id: &str) -> Result<&'a DisplayDescriptor> {
    displays
        .iter()
        .find(|display| display.id == id)
        .ok_or_else(|| anyhow!("selected display is unavailable"))
}

fn remote_displays(displays: &[DisplayDescriptor]) -> Vec<RemoteDisplay> {
    displays
        .iter()
        .map(|display| RemoteDisplay {
            id: display.id.clone(),
            name: display.name.clone(),
            width: display.width,
            height: display.height,
            rotation_degrees: display.rotation_degrees,
            primary: display.primary,
        })
        .collect()
}

#[derive(Debug, Clone, Copy)]
struct QualityProfile {
    max_width: u32,
    max_height: u32,
    frames_per_second: f32,
    bitrate_bps: u32,
    frame_duration: Duration,
}

fn quality_profile(tier: QualityTier) -> QualityProfile {
    let (max_width, max_height, frames_per_second, bitrate_bps) = match tier {
        QualityTier::High => (1_920, 1_080, 30.0, 5_500_000),
        QualityTier::Medium => (1_280, 720, 30.0, 3_000_000),
        QualityTier::Low => (960, 540, 24.0, 1_500_000),
        QualityTier::Survival => (640, 360, 15.0, 800_000),
    };
    QualityProfile {
        max_width,
        max_height,
        frames_per_second,
        bitrate_bps,
        frame_duration: Duration::from_secs_f64(1.0 / frames_per_second as f64),
    }
}

fn make_encoder(target_bitrate: u32, frames_per_second: f32) -> Result<Encoder> {
    let config = EncoderConfig::new()
        .usage_type(UsageType::ScreenContentRealTime)
        .bitrate(BitRate::from_bps(target_bitrate))
        .max_frame_rate(FrameRate::from_hz(frames_per_second))
        .rate_control_mode(RateControlMode::Bitrate)
        .profile(Profile::Baseline)
        .level(Level::Level_4_0)
        .complexity(Complexity::Low)
        .intra_frame_period(IntraFramePeriod::from_num_frames(60))
        .vui(VuiConfig::bt709_full())
        .skip_frames(true);
    Ok(Encoder::with_api_config(
        OpenH264API::from_source(),
        config,
    )?)
}

fn spawn_network_stats(
    pc: Arc<RTCPeerConnection>,
    stop: Arc<AtomicBool>,
    sample: Arc<Mutex<NetworkSample>>,
) {
    tokio::spawn(async move {
        while !stop.load(Ordering::Acquire) {
            tokio::time::sleep(Duration::from_secs(2)).await;
            if stop.load(Ordering::Acquire) {
                break;
            }
            let stats = pc.get_stats().await;
            let remote = stats.reports.values().find_map(|report| match report {
                StatsReportType::RemoteInboundRTP(value) if value.kind == "video" => Some(value),
                _ => None,
            });
            let Some(remote) = remote else { continue };
            if let Ok(mut current) = sample.lock() {
                current.round_trip_time_ms = remote
                    .round_trip_time
                    .map(|seconds| (seconds * 1_000.0).clamp(0.0, u32::MAX as f64) as u32)
                    .unwrap_or(0);
                current.packet_loss_percent =
                    (remote.fraction_lost * 100.0).clamp(0.0, 100.0) as f32;
            }
        }
    });
}

fn validate_remote_sdp_candidates(sdp: &str, peer_ip: IpAddr) -> Result<()> {
    for line in sdp.lines().map(str::trim) {
        if let Some(candidate) = line.strip_prefix("a=")
            && candidate.starts_with("candidate:")
            && !candidate_matches_peer(candidate, peer_ip)
        {
            bail!("SDP contains an ICE candidate outside the authenticated peer address")
        }
    }
    Ok(())
}

fn candidate_matches_peer(candidate: &str, peer_ip: IpAddr) -> bool {
    let fields: Vec<&str> = candidate.split_ascii_whitespace().collect();
    fields.len() >= 8
        && fields[2].eq_ignore_ascii_case("udp")
        && fields[4]
            .parse::<IpAddr>()
            .is_ok_and(|value| value == peer_ip)
        && fields[6].eq_ignore_ascii_case("typ")
        && fields[7].eq_ignore_ascii_case("host")
}

async fn send_error(
    output: &mpsc::Sender<TransportToMain>,
    session_id: Option<uuid::Uuid>,
    code: NativeErrorCode,
    message: impl Into<String>,
) {
    let _ = output
        .send(TransportToMain::Error {
            session_id,
            code,
            message: message.into(),
        })
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_accepts_udp_host_candidates_from_the_authenticated_peer() {
        let peer: IpAddr = "100.64.0.2".parse().unwrap();
        assert!(candidate_matches_peer(
            "candidate:1 1 UDP 2122260223 100.64.0.2 51111 typ host",
            peer
        ));
        assert!(!candidate_matches_peer(
            "candidate:1 1 UDP 2122260223 192.168.1.9 51111 typ host",
            peer
        ));
        assert!(!candidate_matches_peer(
            "candidate:1 1 TCP 2122260223 100.64.0.2 9 typ host tcptype active",
            peer
        ));
        assert!(!candidate_matches_peer(
            "candidate:1 1 UDP 2122260223 100.64.0.2 51111 typ srflx",
            peer
        ));
    }

    #[test]
    fn embedded_sdp_candidates_are_fail_closed() {
        let peer = "100.64.0.2".parse().unwrap();
        assert!(
            validate_remote_sdp_candidates(
                "v=0\r\na=candidate:1 1 UDP 1 100.64.0.2 51111 typ host\r\n",
                peer,
            )
            .is_ok()
        );
        assert!(
            validate_remote_sdp_candidates(
                "v=0\r\na=candidate:1 1 UDP 1 10.0.0.9 51111 typ host\r\n",
                peer,
            )
            .is_err()
        );
    }

    #[test]
    fn quality_profiles_match_the_product_ladder() {
        let high = quality_profile(QualityTier::High);
        assert_eq!(
            (high.max_width, high.max_height, high.bitrate_bps),
            (1920, 1080, 5_500_000)
        );
        let medium = quality_profile(QualityTier::Medium);
        assert_eq!(
            (medium.max_width, medium.max_height, medium.bitrate_bps),
            (1280, 720, 3_000_000)
        );
        let low = quality_profile(QualityTier::Low);
        assert_eq!(
            (low.max_width, low.max_height, low.bitrate_bps),
            (960, 540, 1_500_000)
        );
        let survival = quality_profile(QualityTier::Survival);
        assert_eq!(
            (
                survival.max_width,
                survival.max_height,
                survival.bitrate_bps
            ),
            (640, 360, 800_000)
        );
        assert_eq!(survival.frames_per_second, 15.0);
    }
}
