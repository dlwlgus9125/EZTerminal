use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow};
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

use crate::broker::BrokerErrorCode;
use crate::capture::{DisplayCapture, DisplayDescriptor, enumerate_displays};
use crate::input::{InputChannel, InputInjector, InputOutcome};
use crate::local_broker::{BrokerClientError, BrokerLeaseClient};
use crate::protocol::{
    MAX_CONTROL_BYTES, MainToTransport, NativeEndReason, NativeErrorCode, NativeHello,
    NativeIceCandidate, QualityTier, RemoteDisplay, StreamViewport, TransportMetrics,
    TransportState, TransportToMain, encode_main_message, parse_main_message,
};
use crate::quality::{NetworkSample, QualityController};

const CONTROL_CHANNEL: &str = "ez-control-v1";
const POINTER_CHANNEL: &str = "ez-pointer-v1";
const MAX_PENDING_REMOTE_ICE_CANDIDATES: usize = 64;
const CAPABILITY_RELEASE_WAIT_TIMEOUT: Duration = Duration::from_millis(2_500);
const TRANSPORT_RUNTIME_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(400);

#[derive(Clone)]
struct SessionAuthority {
    stop: Arc<AtomicBool>,
    input_gate: Arc<Mutex<()>>,
}

impl SessionAuthority {
    fn new() -> Self {
        Self {
            stop: Arc::new(AtomicBool::new(false)),
            input_gate: Arc::new(Mutex::new(())),
        }
    }

    fn is_stopped(&self) -> bool {
        self.stop.load(Ordering::Acquire)
    }

    fn stop_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.stop)
    }

    fn enter_input(&self) -> Option<std::sync::MutexGuard<'_, ()>> {
        let permit = self
            .input_gate
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (!self.is_stopped()).then_some(permit)
    }

    fn revoke(&self) -> bool {
        let _permit = self
            .input_gate
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        !self.stop.swap(true, Ordering::AcqRel)
    }
}

struct PeerSession {
    pc: Arc<RTCPeerConnection>,
    authority: SessionAuthority,
    input: Arc<Mutex<InputInjector>>,
}

struct CapabilityLease {
    client: Arc<BrokerLeaseClient>,
    authority: SessionAuthority,
    released: Arc<AtomicBool>,
    heartbeat_abort: tokio::task::AbortHandle,
}

impl CapabilityLease {
    fn new(
        client: BrokerLeaseClient,
        session_id: uuid::Uuid,
        output: mpsc::Sender<TransportToMain>,
    ) -> Self {
        let heartbeat_interval = client.heartbeat_interval();
        let client = Arc::new(client);
        let authority = SessionAuthority::new();
        let released = Arc::new(AtomicBool::new(false));
        let heartbeat_client = Arc::clone(&client);
        let heartbeat_authority = authority.clone();
        let heartbeat_task = tokio::spawn(async move {
            loop {
                tokio::time::sleep(heartbeat_interval).await;
                if heartbeat_authority.is_stopped() {
                    break;
                }
                let client = Arc::clone(&heartbeat_client);
                let heartbeat = tokio::task::spawn_blocking(move || client.heartbeat()).await;
                if matches!(heartbeat, Ok(Ok(()))) {
                    continue;
                }
                if heartbeat_authority.revoke() {
                    let _ = output
                        .send(TransportToMain::Error {
                            session_id: Some(session_id),
                            code: NativeErrorCode::ServiceUnavailable,
                            message: "the supervised session-agent capability lease was lost"
                                .into(),
                        })
                        .await;
                    let _ = output
                        .send(TransportToMain::Ended {
                            session_id,
                            reason: NativeEndReason::AgentStopped,
                        })
                        .await;
                }
                break;
            }
        });
        let heartbeat_abort = heartbeat_task.abort_handle();
        drop(heartbeat_task);
        Self {
            client,
            authority,
            released,
            heartbeat_abort,
        }
    }

    fn session_authority(&self) -> SessionAuthority {
        self.authority.clone()
    }

    async fn close(&self) {
        self.authority.revoke();
        self.heartbeat_abort.abort();
        if self.released.swap(true, Ordering::AcqRel) {
            return;
        }
        let client = Arc::clone(&self.client);
        let release = tokio::task::spawn_blocking(move || client.release());
        let _ = tokio::time::timeout(CAPABILITY_RELEASE_WAIT_TIMEOUT, release).await;
    }
}

impl Drop for CapabilityLease {
    fn drop(&mut self) {
        self.authority.revoke();
        self.heartbeat_abort.abort();
        if self.released.swap(true, Ordering::AcqRel) {
            return;
        }
        let client = Arc::clone(&self.client);
        let _ = std::thread::Builder::new()
            .name("ez-remote-lease-release".into())
            .spawn(move || {
                let _ = client.release();
            });
    }
}

impl PeerSession {
    async fn close(self) -> Result<()> {
        self.authority.revoke();
        if let Ok(mut input) = self.input.lock() {
            input.release_all();
        }
        self.pc.close().await?;
        Ok(())
    }
}

pub fn run() -> Result<()> {
    let runtime = tokio::runtime::Runtime::new()?;
    let result = runtime.block_on(run_async());
    runtime.shutdown_timeout(TRANSPORT_RUNTIME_SHUTDOWN_TIMEOUT);
    result
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

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut hello: Option<NativeHello> = None;
    let mut peer_connection: Option<PeerSession> = None;
    let mut capability_lease: Option<CapabilityLease> = None;
    let mut pending_remote_ice = Vec::new();

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
                let remote_session_id = value.session_id;
                let acquisition = tokio::task::spawn_blocking(move || {
                    BrokerLeaseClient::acquire(remote_session_id)
                })
                .await;
                let client = match acquisition {
                    Ok(Ok(client)) => client,
                    Ok(Err(error)) => {
                        let (code, message) = broker_error(&error);
                        send_error(&output_tx, Some(value.session_id), code, message).await;
                        continue;
                    }
                    Err(error) => {
                        send_error(
                            &output_tx,
                            Some(value.session_id),
                            NativeErrorCode::Internal,
                            format!("capability broker task failed: {error}"),
                        )
                        .await;
                        continue;
                    }
                };
                capability_lease = Some(CapabilityLease::new(
                    client,
                    value.session_id,
                    output_tx.clone(),
                ));
                hello = Some(value);
                output_tx
                    .send(TransportToMain::Ready {
                        protocol_version: crate::NATIVE_PROTOCOL_VERSION,
                        service: crate::service::availability(),
                    })
                    .await?;
            }
            MainToTransport::Offer { session_id, sdp } => {
                let active_hello = match validate_offer_state(
                    hello.as_ref(),
                    session_id,
                    peer_connection.is_some(),
                ) {
                    Ok(active_hello) => active_hello,
                    Err(message) => {
                        send_error(
                            &output_tx,
                            Some(session_id),
                            NativeErrorCode::InvalidMessage,
                            message,
                        )
                        .await;
                        continue;
                    }
                };
                let peer_ip: IpAddr = active_hello.peer_address.parse()?;
                let sdp = constrain_remote_sdp_candidates(&sdp, peer_ip);
                let Some(lease) = capability_lease.as_ref() else {
                    send_error(
                        &output_tx,
                        Some(session_id),
                        NativeErrorCode::ServiceUnavailable,
                        "the privileged capability lease is unavailable",
                    )
                    .await;
                    continue;
                };
                if lease.authority.is_stopped() {
                    send_error(
                        &output_tx,
                        Some(session_id),
                        NativeErrorCode::ServiceUnavailable,
                        "the privileged capability lease has expired",
                    )
                    .await;
                    continue;
                }
                let pc =
                    create_peer(active_hello, output_tx.clone(), lease.session_authority()).await?;
                pc.pc
                    .set_remote_description(RTCSessionDescription::offer(sdp)?)
                    .await?;
                for candidate in pending_remote_ice.drain(..) {
                    pc.pc.add_ice_candidate(candidate).await?;
                }
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
                let Some(constrained_candidate) =
                    constrain_remote_candidate(&candidate.candidate, peer_ip)
                else {
                    continue;
                };
                let candidate = RTCIceCandidateInit {
                    candidate: constrained_candidate,
                    sdp_mid: candidate.sdp_mid,
                    sdp_mline_index: candidate.sdp_mline_index,
                    username_fragment: None,
                };
                if let Some(pc) = peer_connection.as_ref() {
                    pc.pc.add_ice_candidate(candidate).await?;
                } else if pending_remote_ice.len() < MAX_PENDING_REMOTE_ICE_CANDIDATES {
                    pending_remote_ice.push(candidate);
                }
            }
            MainToTransport::Stop { session_id, .. } => {
                if let Err(message) = validate_stop_session(hello.as_ref(), session_id) {
                    send_error(
                        &output_tx,
                        Some(session_id),
                        NativeErrorCode::InvalidMessage,
                        message,
                    )
                    .await;
                    continue;
                }
                if let Some(pc) = peer_connection.take() {
                    pc.close().await?;
                }
                if let Some(lease) = capability_lease.as_ref() {
                    lease.close().await;
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
    if let Some(lease) = capability_lease.as_ref() {
        lease.close().await;
    }
    drop(output_tx);
    writer.await??;
    Ok(())
}

async fn create_peer(
    hello: &NativeHello,
    output: mpsc::Sender<TransportToMain>,
    authority: SessionAuthority,
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
    let connected = Arc::new(AtomicBool::new(false));
    let network_sample = Arc::new(Mutex::new(NetworkSample::default()));
    spawn_network_stats(
        Arc::clone(&pc),
        authority.stop_flag(),
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
    let stream_viewport = Arc::new(Mutex::new(hello.viewport));
    let input = Arc::new(Mutex::new(InputInjector::with_desktop_state(
        session_id,
        displays.clone(),
        Arc::clone(&selected_display_id),
        Arc::clone(&stream_viewport),
        Arc::clone(&network_sample),
    )));
    spawn_input_revocation(authority.stop_flag(), Arc::clone(&input));
    spawn_capture(CaptureTask {
        session_id,
        track: Arc::clone(&track),
        authority: authority.clone(),
        connected: Arc::clone(&connected),
        displays,
        selected_display_id,
        stream_viewport,
        network_sample,
        output: output.clone(),
    });
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
    let state_authority = authority.clone();
    pc.on_peer_connection_state_change(Box::new(move |state| {
        let state_output = state_output.clone();
        let state_connected = Arc::clone(&state_connected);
        let state_authority = state_authority.clone();
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
                    state_authority.revoke();
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
    let channel_authority = authority.clone();
    pc.on_data_channel(Box::new(move |channel| {
        let channel_input = Arc::clone(&channel_input);
        let channel_authority = channel_authority.clone();
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
                let channel_authority = channel_authority.clone();
                let reply_channel = Arc::clone(&reply_channel);
                Box::pin(async move {
                    if channel_authority.is_stopped() {
                        send_input_error(&reply_channel, "capability-unavailable").await;
                        return;
                    }
                    if message.data.len() > MAX_CONTROL_BYTES {
                        send_input_error(&reply_channel, "message-too-large").await;
                        return;
                    }
                    let input_channel = if label == POINTER_CHANNEL {
                        InputChannel::Pointer
                    } else {
                        InputChannel::Reliable
                    };
                    let Some(_permit) = channel_authority.enter_input() else {
                        send_input_error(&reply_channel, "capability-unavailable").await;
                        return;
                    };
                    let outcome = channel_input
                        .lock()
                        .map_err(|_| anyhow!("input state poisoned"))
                        .and_then(|mut injector| injector.handle(&message.data, input_channel));
                    drop(_permit);
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

    Ok(PeerSession {
        pc,
        authority,
        input,
    })
}

fn spawn_input_revocation(stop: Arc<AtomicBool>, input: Arc<Mutex<InputInjector>>) {
    tokio::spawn(async move {
        loop {
            if stop.load(Ordering::Acquire) {
                if let Ok(mut injector) = input.lock() {
                    injector.release_all();
                }
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    });
}

struct CaptureTask {
    session_id: uuid::Uuid,
    track: Arc<TrackLocalStaticSample>,
    authority: SessionAuthority,
    connected: Arc<AtomicBool>,
    displays: Vec<DisplayDescriptor>,
    selected_display_id: Arc<Mutex<String>>,
    stream_viewport: Arc<Mutex<Option<StreamViewport>>>,
    network_sample: Arc<Mutex<NetworkSample>>,
    output: mpsc::Sender<TransportToMain>,
}

fn spawn_capture(task: CaptureTask) {
    let runtime = tokio::runtime::Handle::current();
    std::thread::spawn(move || {
        let result = run_capture_loop(&task, &runtime);
        if let Err(error) = result {
            task.authority.revoke();
            let _ = task.output.blocking_send(TransportToMain::Error {
                session_id: Some(task.session_id),
                code: NativeErrorCode::CaptureUnavailable,
                message: error.to_string(),
            });
        }
    });
}

fn run_capture_loop(task: &CaptureTask, runtime: &tokio::runtime::Handle) -> Result<()> {
    let session_id = task.session_id;
    let track = &task.track;
    let stop = &task.authority.stop;
    let connected = &task.connected;
    let displays = &task.displays;
    let selected_display_id = &task.selected_display_id;
    let stream_viewport = &task.stream_viewport;
    let network_sample = &task.network_sample;
    let output = &task.output;
    let mut quality = QualityController::default();
    let mut tier = quality.tier();
    let mut profile = quality_profile(tier);
    let mut active_display_id = selected_display_id
        .lock()
        .map_err(|_| anyhow!("display selection poisoned"))?
        .clone();
    let active_display = find_display(displays, &active_display_id)?;
    let mut active_viewport = *stream_viewport
        .lock()
        .map_err(|_| anyhow!("stream viewport poisoned"))?;
    let (max_width, max_height) = capture_limits(active_display, profile, active_viewport);
    let mut capture = DisplayCapture::new(active_display.clone(), max_width, max_height)?;
    let (width, height) = capture.dimensions();
    output.blocking_send(TransportToMain::Displays {
        session_id,
        displays: remote_displays(displays),
        selected_display_id: Some(active_display_id.clone()),
    })?;
    let mut encoder = make_encoder(
        target_bitrate(profile, width, height),
        profile.frames_per_second,
    )?;
    let mut yuv = YUVBuffer::new(width, height);
    let mut sample_started = Instant::now();
    let mut frames = 0u32;
    let mut attempted_frames = 0u32;
    let mut encoded_bytes = 0u64;
    let mut pipeline_work = Duration::ZERO;

    while !stop.load(Ordering::Acquire) {
        let requested_display_id = selected_display_id
            .lock()
            .map_err(|_| anyhow!("display selection poisoned"))?
            .clone();
        let requested_viewport = *stream_viewport
            .lock()
            .map_err(|_| anyhow!("stream viewport poisoned"))?;
        if requested_display_id != active_display_id || requested_viewport != active_viewport {
            let next = find_display(displays, &requested_display_id)?;
            let (max_width, max_height) = capture_limits(next, profile, requested_viewport);
            capture = DisplayCapture::new(next.clone(), max_width, max_height)?;
            let (next_width, next_height) = capture.dimensions();
            yuv = YUVBuffer::new(next_width, next_height);
            encoder = make_encoder(
                target_bitrate(profile, next_width, next_height),
                profile.frames_per_second,
            )?;
            active_display_id = requested_display_id;
            active_viewport = requested_viewport;
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
            attempted_frames = 0;
            encoded_bytes = 0;
            pipeline_work = Duration::ZERO;
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
        attempted_frames += 1;
        pipeline_work += frame_started.elapsed();
        let elapsed = sample_started.elapsed();
        if elapsed >= Duration::from_secs(2) {
            let seconds = elapsed.as_secs_f32().max(0.001);
            if let Ok(mut sample) = network_sample.lock() {
                let frame_budget_seconds =
                    attempted_frames as f32 * profile.frame_duration.as_secs_f32();
                sample.pipeline_utilization_percent = if frame_budget_seconds > 0.0 {
                    (pipeline_work.as_secs_f32() / frame_budget_seconds) * 100.0
                } else {
                    0.0
                };
            }
            let sample = network_sample
                .lock()
                .map(|sample| *sample)
                .unwrap_or_default();
            let next_tier = quality.observe(sample);
            let (stream_width, stream_height) = capture.dimensions();
            let _ = output.blocking_send(TransportToMain::State {
                session_id,
                state: TransportState::Active,
                metrics: Some(TransportMetrics {
                    frames_per_second: frames as f32 / seconds,
                    bitrate_bps: ((encoded_bytes as f64 * 8.0) / seconds as f64) as u32,
                    round_trip_time_ms: sample.round_trip_time_ms,
                    packet_loss_percent: sample.packet_loss_percent,
                    quality_tier: tier,
                    stream_width: stream_width as u32,
                    stream_height: stream_height as u32,
                }),
            });
            if next_tier != tier {
                tier = next_tier;
                profile = quality_profile(tier);
                let display = find_display(displays, &active_display_id)?;
                let (max_width, max_height) = capture_limits(display, profile, active_viewport);
                capture = DisplayCapture::new(display.clone(), max_width, max_height)?;
                let (next_width, next_height) = capture.dimensions();
                yuv = YUVBuffer::new(next_width, next_height);
                encoder = make_encoder(
                    target_bitrate(profile, next_width, next_height),
                    profile.frames_per_second,
                )?;
            }
            sample_started = Instant::now();
            frames = 0;
            attempted_frames = 0;
            encoded_bytes = 0;
            pipeline_work = Duration::ZERO;
        }
        if let Some(remaining) = profile.frame_duration.checked_sub(frame_started.elapsed()) {
            std::thread::sleep(remaining);
        }
    }
    Ok(())
}

fn capture_limits(
    display: &DisplayDescriptor,
    profile: QualityProfile,
    viewport: Option<StreamViewport>,
) -> (u32, u32) {
    let (tier_width, tier_height) = if display.height > display.width {
        (profile.max_height, profile.max_width)
    } else {
        (profile.max_width, profile.max_height)
    };
    match viewport {
        Some(viewport) => (
            tier_width.min(viewport.pixel_width),
            tier_height.min(viewport.pixel_height),
        ),
        None => (tier_width, tier_height),
    }
}

fn target_bitrate(profile: QualityProfile, width: usize, height: usize) -> u32 {
    const MIN_STREAM_BITRATE_BPS: u32 = 400_000;
    let profile_pixels = (profile.max_width as u64 * profile.max_height as u64).max(1);
    let stream_pixels = width as u64 * height as u64;
    let scaled = (profile.bitrate_bps as u64 * stream_pixels / profile_pixels)
        .min(profile.bitrate_bps as u64) as u32;
    scaled.max(MIN_STREAM_BITRATE_BPS.min(profile.bitrate_bps))
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

fn validate_offer_state(
    hello: Option<&NativeHello>,
    session_id: uuid::Uuid,
    peer_exists: bool,
) -> Result<&NativeHello, &'static str> {
    let Some(hello) = hello else {
        return Err("hello must precede the offer");
    };
    if hello.session_id != session_id {
        return Err("session id does not match hello");
    }
    if peer_exists {
        return Err("an offer was already accepted");
    }
    Ok(hello)
}

fn validate_stop_session(
    hello: Option<&NativeHello>,
    session_id: uuid::Uuid,
) -> Result<(), &'static str> {
    let Some(hello) = hello else {
        return Err("hello must precede stop");
    };
    if hello.session_id != session_id {
        return Err("stop session id does not match hello");
    }
    Ok(())
}

fn constrain_remote_sdp_candidates(sdp: &str, peer_ip: IpAddr) -> String {
    let had_trailing_newline = sdp.ends_with('\n');
    let mut lines = Vec::new();
    for line in sdp.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(candidate) = line.strip_prefix("a=candidate:") {
            if let Some(candidate) =
                constrain_remote_candidate(&format!("candidate:{candidate}"), peer_ip)
            {
                lines.push(format!("a={candidate}"));
            }
            continue;
        }
        lines.push(line.to_owned());
    }
    let mut constrained = lines.join("\r\n");
    if had_trailing_newline {
        constrained.push_str("\r\n");
    }
    constrained
}

fn constrain_remote_candidate(candidate: &str, peer_ip: IpAddr) -> Option<String> {
    let mut fields: Vec<&str> = candidate.split_ascii_whitespace().collect();
    if fields.len() < 8
        || fields[0]
            .strip_prefix("candidate:")
            .is_none_or(str::is_empty)
        || fields[1] != "1"
        || !fields[2].eq_ignore_ascii_case("udp")
        || fields[3].parse::<u32>().is_err()
        || !fields[5].parse::<u16>().is_ok_and(|port| port != 0)
        || !fields[6].eq_ignore_ascii_case("typ")
        || !fields[7].eq_ignore_ascii_case("host")
    {
        return None;
    }
    let authenticated_address = peer_ip.to_string();
    fields[4] = &authenticated_address;
    Some(fields.join(" "))
}

fn broker_error(error: &BrokerClientError) -> (NativeErrorCode, String) {
    let code = match error {
        BrokerClientError::Rejected(BrokerErrorCode::LeaseBusy) => NativeErrorCode::LeaseBusy,
        BrokerClientError::Rejected(BrokerErrorCode::CallerDenied) => {
            NativeErrorCode::ServiceDenied
        }
        BrokerClientError::Rejected(BrokerErrorCode::IncompatibleProtocol) => {
            NativeErrorCode::UnsupportedVersion
        }
        BrokerClientError::Rejected(BrokerErrorCode::CapabilityUnavailable) => {
            NativeErrorCode::CaptureUnavailable
        }
        _ => NativeErrorCode::ServiceUnavailable,
    };
    (code, error.to_string())
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

    fn hello_for(session_id: uuid::Uuid) -> NativeHello {
        NativeHello {
            protocol_version: crate::NATIVE_PROTOCOL_VERSION,
            session_id,
            client_id: uuid::Uuid::new_v4(),
            client_name: "test client".into(),
            local_address: "127.0.0.1".into(),
            peer_address: "127.0.0.1".into(),
            udp_port: 7422,
            viewport: None,
        }
    }

    #[test]
    fn accepts_only_bounded_udp_host_candidates() {
        let peer: IpAddr = "100.64.0.2".parse().unwrap();
        assert_eq!(
            constrain_remote_candidate(
                "candidate:1 1 UDP 2122260223 100.64.0.2 51111 typ host",
                peer,
            ),
            Some("candidate:1 1 UDP 2122260223 100.64.0.2 51111 typ host".into()),
        );
        assert_eq!(
            constrain_remote_candidate(
                "candidate:1 1 TCP 2122260223 100.64.0.2 9 typ host tcptype active",
                peer,
            ),
            None,
        );
        assert_eq!(
            constrain_remote_candidate(
                "candidate:1 1 UDP 2122260223 100.64.0.2 51111 typ srflx",
                peer,
            ),
            None,
        );
        assert_eq!(
            constrain_remote_candidate(
                "candidate:1 1 UDP not-a-priority 100.64.0.2 51111 typ host",
                peer,
            ),
            None,
        );
    }

    #[test]
    fn constrains_multihomed_host_candidates_to_the_authenticated_peer() {
        let peer: IpAddr = "100.64.0.2".parse().unwrap();
        assert_eq!(
            constrain_remote_candidate(
                "candidate:1 1 UDP 2122260223 192.168.1.9 51111 typ host generation 0",
                peer,
            ),
            Some("candidate:1 1 UDP 2122260223 100.64.0.2 51111 typ host generation 0".into(),),
        );
        assert_eq!(
            constrain_remote_candidate(
                "candidate:2 1 udp 2122260223 device-id.local 51112 typ host",
                peer,
            ),
            Some("candidate:2 1 udp 2122260223 100.64.0.2 51112 typ host".into()),
        );
        assert_eq!(
            constrain_remote_candidate(
                "candidate:3 1 TCP 2122260223 192.168.1.9 9 typ host tcptype active",
                peer,
            ),
            None,
        );
        assert_eq!(
            constrain_remote_candidate(
                "candidate:4 1 UDP 2122260223 192.168.1.9 51113 typ srflx",
                peer,
            ),
            None,
        );
    }

    #[test]
    fn embedded_sdp_candidates_are_constrained_to_the_authenticated_peer() {
        let peer = "100.64.0.2".parse().unwrap();
        assert_eq!(
            constrain_remote_sdp_candidates(
                concat!(
                    "v=0\r\n",
                    "a=candidate:1 1 UDP 1 10.0.0.9 51111 typ host\r\n",
                    "a=candidate:2 1 TCP 1 10.0.0.9 9 typ host tcptype active\r\n",
                ),
                peer,
            ),
            "v=0\r\na=candidate:1 1 UDP 1 100.64.0.2 51111 typ host\r\n",
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

    #[test]
    fn capture_limits_follow_viewport_orientation_and_tier() {
        let landscape = DisplayDescriptor {
            id: "landscape".into(),
            name: "Landscape".into(),
            x: 0,
            y: 0,
            width: 2_560,
            height: 1_440,
            rotation_degrees: 0,
            primary: true,
        };
        let portrait = DisplayDescriptor {
            width: 1_440,
            height: 2_560,
            ..landscape.clone()
        };
        let viewport = Some(StreamViewport {
            pixel_width: 1_080,
            pixel_height: 1_920,
        });
        assert_eq!(
            capture_limits(&landscape, quality_profile(QualityTier::High), viewport),
            (1_080, 1_080)
        );
        assert_eq!(
            capture_limits(&portrait, quality_profile(QualityTier::High), viewport),
            (1_080, 1_920)
        );
        assert_eq!(
            capture_limits(&portrait, quality_profile(QualityTier::Low), viewport),
            (540, 960)
        );
    }

    #[test]
    fn bitrate_scales_down_with_the_encoded_pixel_count() {
        let high = quality_profile(QualityTier::High);
        assert_eq!(target_bitrate(high, 1_920, 1_080), high.bitrate_bps);
        let mobile = target_bitrate(high, 960, 540);
        assert!(mobile >= 400_000);
        assert!(mobile < high.bitrate_bps);
    }

    #[test]
    fn broker_rejections_map_to_existing_native_error_contract() {
        let (code, _) = broker_error(&BrokerClientError::Rejected(BrokerErrorCode::LeaseBusy));
        assert_eq!(code, NativeErrorCode::LeaseBusy);
        let (code, _) = broker_error(&BrokerClientError::Rejected(BrokerErrorCode::CallerDenied));
        assert_eq!(code, NativeErrorCode::ServiceDenied);
        let (code, _) = broker_error(&BrokerClientError::Rejected(
            BrokerErrorCode::IncompatibleProtocol,
        ));
        assert_eq!(code, NativeErrorCode::UnsupportedVersion);
    }

    #[test]
    fn offer_state_rejects_renegotiation_and_unbound_sessions() {
        let session_id = uuid::Uuid::new_v4();
        let hello = hello_for(session_id);
        assert!(validate_offer_state(Some(&hello), session_id, false).is_ok());
        assert_eq!(
            validate_offer_state(Some(&hello), session_id, true),
            Err("an offer was already accepted")
        );
        assert_eq!(
            validate_offer_state(Some(&hello), uuid::Uuid::new_v4(), false),
            Err("session id does not match hello")
        );
        assert_eq!(
            validate_offer_state(None, session_id, false),
            Err("hello must precede the offer")
        );
    }

    #[test]
    fn stop_requires_the_accepted_hello_session() {
        let session_id = uuid::Uuid::new_v4();
        let hello = hello_for(session_id);
        assert!(validate_stop_session(Some(&hello), session_id).is_ok());
        assert_eq!(
            validate_stop_session(Some(&hello), uuid::Uuid::new_v4()),
            Err("stop session id does not match hello")
        );
        assert_eq!(
            validate_stop_session(None, session_id),
            Err("hello must precede stop")
        );
    }

    #[test]
    fn input_authority_linearizes_revocation_and_rejects_late_work() {
        let authority = SessionAuthority::new();
        let permit = authority.enter_input().expect("authority starts active");
        let revoker = authority.clone();
        let (revoked_tx, revoked_rx) = std::sync::mpsc::sync_channel(1);
        let worker = std::thread::spawn(move || {
            let changed = revoker.revoke();
            revoked_tx.send(changed).unwrap();
        });

        assert!(
            revoked_rx.recv_timeout(Duration::from_millis(50)).is_err(),
            "revocation must wait for the already-authorized input operation"
        );
        drop(permit);
        assert!(
            revoked_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("revocation completes after input")
        );
        worker.join().unwrap();
        assert!(authority.enter_input().is_none());
    }

    #[test]
    fn release_wait_and_runtime_shutdown_budget_is_under_three_seconds() {
        assert!(
            CAPABILITY_RELEASE_WAIT_TIMEOUT + TRANSPORT_RUNTIME_SHUTDOWN_TIMEOUT
                < Duration::from_secs(3)
        );
    }
}
