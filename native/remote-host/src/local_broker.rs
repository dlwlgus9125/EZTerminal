use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::mem::size_of;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use uuid::Uuid;
use windows::Win32::Foundation::{
    CloseHandle, ERROR_INVALID_PARAMETER, ERROR_NO_DATA, ERROR_PIPE_CONNECTED,
    ERROR_PIPE_LISTENING, HANDLE, HLOCAL, INVALID_HANDLE_VALUE, LocalFree, STILL_ACTIVE,
    WAIT_TIMEOUT,
};
use windows::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows::Win32::Security::{
    GetLengthSid, GetTokenInformation, IsValidSid, PSECURITY_DESCRIPTOR, RevertToSelf,
    SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenSessionId, TokenUser,
};
use windows::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId, GetNamedPipeServerProcessId,
    ImpersonateNamedPipeClient, PIPE_NOWAIT, PIPE_READMODE_MESSAGE, PIPE_REJECT_REMOTE_CLIENTS,
    PIPE_TYPE_MESSAGE, PeekNamedPipe,
};
use windows::Win32::System::RemoteDesktop::{
    ProcessIdToSessionId, WTS_CONNECTSTATE_CLASS, WTSActive, WTSConnectState, WTSFreeMemory,
    WTSQuerySessionInformationW, WTSQueryUserToken,
};
use windows::Win32::System::Threading::{
    CREATE_NO_WINDOW, CreateProcessAsUserW, GetCurrentProcessId, GetCurrentThread,
    GetExitCodeProcess, OpenProcess, OpenProcessToken, OpenThreadToken, PROCESS_INFORMATION,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
    STARTUPINFOW, TerminateProcess, WaitForSingleObject,
};
use windows::core::{BOOL, PCWSTR, PWSTR};

use crate::broker::{
    AGENT_HANDSHAKE_TIMEOUT, AGENT_RPC_TIMEOUT, AgentCommand, AgentHello, AgentResponse,
    BROKER_ACQUIRE_CONNECT_TIMEOUT, BROKER_ACQUIRE_RESPONSE_TIMEOUT,
    BROKER_HEARTBEAT_CONNECT_TIMEOUT, BROKER_HEARTBEAT_RESPONSE_TIMEOUT, BROKER_PIPE_NAME,
    BROKER_RELEASE_CONNECT_TIMEOUT, BROKER_RELEASE_RESPONSE_TIMEOUT, BROKER_REQUEST_TIMEOUT,
    BrokerCore, BrokerError, BrokerErrorCode, BrokerRequest, BrokerResponse, CallerIdentity,
    CapabilitySet, GrantedLease, LEASE_HEARTBEAT_INTERVAL, LEASE_TTL, MAX_BROKER_MESSAGE_BYTES,
    decode_bounded, encode_bounded,
};

const PIPE_POLL_INTERVAL: Duration = Duration::from_millis(20);
const CLIENT_RETRY_INTERVAL: Duration = Duration::from_millis(50);
const AGENT_PIPE_PREFIX: &str = r"\\.\pipe\EZTerminalRemoteHost-agent-v1";
const SERVICE_PIPE_SDDL: &str = "D:P(A;;GA;;;SY)(A;;GRGW;;;BA)(A;;GRGW;;;IU)";

pub struct BrokerLeaseClient {
    remote_session_id: Uuid,
    lease_id: Uuid,
    process_id: u32,
    expires_in: Duration,
    rpc_lock: std::sync::Mutex<()>,
    closed: AtomicBool,
}

#[derive(Debug, thiserror::Error)]
pub enum BrokerClientError {
    #[error("remote capability broker rejected the request: {0:?}")]
    Rejected(BrokerErrorCode),
    #[error("remote capability broker returned an invalid response")]
    InvalidResponse,
    #[error("remote capability lease is closed")]
    Closed,
    #[error(transparent)]
    Transport(#[from] anyhow::Error),
}

impl BrokerLeaseClient {
    pub fn acquire(remote_session_id: Uuid) -> Result<Self, BrokerClientError> {
        let process_id = unsafe { GetCurrentProcessId() };
        let response = call_service(&BrokerRequest::Acquire {
            protocol_version: crate::NATIVE_PROTOCOL_VERSION,
            remote_session_id,
            process_id,
            requested: CapabilitySet::REMOTE_DESKTOP,
        })?;
        match response {
            BrokerResponse::Granted {
                protocol_version,
                remote_session_id: granted_session_id,
                lease_id,
                expires_in_ms,
                capabilities,
            } if protocol_version == crate::NATIVE_PROTOCOL_VERSION
                && granted_session_id == remote_session_id
                && capabilities.satisfies(CapabilitySet::REMOTE_DESKTOP) =>
            {
                let expires_in = Duration::from_millis(expires_in_ms);
                if expires_in < Duration::from_secs(3) || expires_in > LEASE_TTL.saturating_mul(2) {
                    return Err(BrokerClientError::InvalidResponse);
                }
                Ok(Self {
                    remote_session_id,
                    lease_id,
                    process_id,
                    expires_in,
                    rpc_lock: std::sync::Mutex::new(()),
                    closed: AtomicBool::new(false),
                })
            }
            BrokerResponse::Rejected { code, .. } => Err(BrokerClientError::Rejected(code)),
            _ => Err(BrokerClientError::InvalidResponse),
        }
    }

    pub fn heartbeat(&self) -> Result<(), BrokerClientError> {
        let _rpc = self
            .rpc_lock
            .lock()
            .map_err(|_| BrokerClientError::Transport(anyhow!("broker RPC lock is poisoned")))?;
        if self.closed.load(Ordering::Acquire) {
            return Err(BrokerClientError::Closed);
        }
        match call_service(&BrokerRequest::Heartbeat {
            protocol_version: crate::NATIVE_PROTOCOL_VERSION,
            remote_session_id: self.remote_session_id,
            process_id: self.process_id,
            lease_id: self.lease_id,
        })? {
            BrokerResponse::Ack {
                expires_in_ms: Some(_),
            } => Ok(()),
            BrokerResponse::Rejected { code, .. } => Err(BrokerClientError::Rejected(code)),
            _ => Err(BrokerClientError::InvalidResponse),
        }
    }

    pub fn release(&self) -> Result<(), BrokerClientError> {
        let _rpc = self
            .rpc_lock
            .lock()
            .map_err(|_| BrokerClientError::Transport(anyhow!("broker RPC lock is poisoned")))?;
        if self.closed.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        match call_service(&BrokerRequest::Release {
            protocol_version: crate::NATIVE_PROTOCOL_VERSION,
            remote_session_id: self.remote_session_id,
            process_id: self.process_id,
            lease_id: self.lease_id,
        })? {
            BrokerResponse::Ack {
                expires_in_ms: None,
            } => Ok(()),
            BrokerResponse::Rejected { code, .. } => Err(BrokerClientError::Rejected(code)),
            _ => Err(BrokerClientError::InvalidResponse),
        }
    }

    pub fn heartbeat_interval(&self) -> Duration {
        (self.expires_in / 3)
            .min(LEASE_HEARTBEAT_INTERVAL)
            .max(Duration::from_secs(1))
    }
}

pub fn serve(
    shutdown: Arc<AtomicBool>,
    startup: std::sync::mpsc::SyncSender<Result<(), String>>,
) -> Result<()> {
    let security = match PipeSecurity::new() {
        Ok(security) => security,
        Err(error) => {
            let _ = startup.send(Err(error.to_string()));
            return Err(error);
        }
    };
    let mut service = BrokerService::default();
    service.core.set_ready();
    let listener = match ListeningPipe::new(BROKER_PIPE_NAME, &security, true) {
        Ok(listener) => {
            let _ = startup.send(Ok(()));
            listener
        }
        Err(error) => {
            let _ = startup.send(Err(error.to_string()));
            return Err(error);
        }
    };
    let mut startup_listener = Some(listener);

    while !shutdown.load(Ordering::Acquire) {
        service.core.expire(Instant::now());
        let listener = match startup_listener.take() {
            Some(listener) => listener,
            None => ListeningPipe::new(BROKER_PIPE_NAME, &security, true)?,
        };
        let Some(mut connection) = listener.accept(&shutdown, None, Duration::from_millis(250))?
        else {
            continue;
        };
        let preauthenticated = match connected_process_identity(&connection) {
            Ok(caller) => caller,
            Err(_) => {
                let _ = write_message(
                    &mut connection,
                    &BrokerResponse::Rejected {
                        code: BrokerErrorCode::CallerDenied,
                        retry_after_ms: None,
                    },
                );
                continue;
            }
        };
        let response = match read_message::<BrokerRequest>(&mut connection, BROKER_REQUEST_TIMEOUT)
        {
            Ok(request) if request.process_id() == preauthenticated.process_id => {
                match caller_identity(&connection, request.process_id()) {
                    Ok(caller) if same_bound_identity(&preauthenticated, &caller) => {
                        service.handle(request, &connection, caller)
                    }
                    _ => BrokerResponse::Rejected {
                        code: BrokerErrorCode::CallerDenied,
                        retry_after_ms: None,
                    },
                }
            }
            Ok(_) => BrokerResponse::Rejected {
                code: BrokerErrorCode::CallerDenied,
                retry_after_ms: None,
            },
            Err(_) => BrokerResponse::Rejected {
                code: BrokerErrorCode::InvalidMessage,
                retry_after_ms: None,
            },
        };
        let _ = write_message(&mut connection, &response);
    }

    service.core.begin_stopping();
    service.stop_agent();
    service.core.set_stopped();
    Ok(())
}

#[derive(Default)]
struct BrokerService {
    core: BrokerCore,
    agent: Option<AgentProcess>,
    agent_sequence: u64,
}

impl BrokerService {
    fn handle(
        &mut self,
        request: BrokerRequest,
        pipe: &File,
        caller: CallerIdentity,
    ) -> BrokerResponse {
        let requested_process_id = request.process_id();
        let now = Instant::now();
        self.core.expire(now);

        match request {
            BrokerRequest::Acquire {
                protocol_version,
                remote_session_id,
                requested,
                ..
            } => {
                if protocol_version != crate::NATIVE_PROTOCOL_VERSION {
                    return rejected(BrokerError::IncompatibleProtocol);
                }
                if !caller.is_active_interactive_user() {
                    return rejected(BrokerError::CallerDenied);
                }
                if let Some(bound_process_id) = self.core.active_lease_process_id()
                    && bound_process_id != caller.process_id
                    && !process_is_running(bound_process_id)
                {
                    self.core.revoke_lease_for_process(bound_process_id);
                }
                if let Err(error) = self.core.preflight_acquire(
                    protocol_version,
                    remote_session_id,
                    &caller,
                    Instant::now(),
                ) {
                    return rejected(error);
                }
                let started_agent = match self.ensure_agent(
                    remote_session_id,
                    &caller,
                    requested,
                    Instant::now(),
                ) {
                    Ok(started_agent) => started_agent,
                    Err(error) => return rejected(error),
                };
                let refreshed_caller = match active_caller_identity(pipe, requested_process_id) {
                    Ok(caller) => caller,
                    Err(error) => {
                        if started_agent {
                            self.stop_agent();
                        }
                        return rejected(error);
                    }
                };
                let result = self.core.acquire(
                    protocol_version,
                    remote_session_id,
                    &refreshed_caller,
                    requested,
                    Instant::now(),
                );
                if result.is_err() && started_agent {
                    self.stop_agent();
                }
                match result {
                    Ok(lease) => granted(remote_session_id, lease),
                    Err(error) => rejected(error),
                }
            }
            BrokerRequest::Heartbeat {
                protocol_version,
                remote_session_id,
                lease_id,
                ..
            } => {
                if protocol_version != crate::NATIVE_PROTOCOL_VERSION {
                    return rejected(BrokerError::IncompatibleProtocol);
                }
                if !caller.is_active_interactive_user() {
                    self.core.tombstone_lease_for_process(requested_process_id);
                    return rejected(BrokerError::CallerDenied);
                }
                if let Err(error) = self.ping_agent() {
                    self.agent_failed(Instant::now());
                    return rejected(error);
                }
                let refreshed_caller = match active_caller_identity(pipe, requested_process_id) {
                    Ok(caller) => caller,
                    Err(error) => {
                        self.core.tombstone_lease_for_process(requested_process_id);
                        return rejected(error);
                    }
                };
                match self.core.heartbeat(
                    protocol_version,
                    remote_session_id,
                    lease_id,
                    &refreshed_caller,
                    Instant::now(),
                ) {
                    Ok(expires_in) => BrokerResponse::Ack {
                        expires_in_ms: Some(duration_ms(expires_in)),
                    },
                    Err(error) => rejected(error),
                }
            }
            BrokerRequest::Release {
                protocol_version,
                remote_session_id,
                lease_id,
                ..
            } => match self
                .core
                .release(protocol_version, remote_session_id, lease_id, &caller)
            {
                Ok(()) => BrokerResponse::Ack {
                    expires_in_ms: None,
                },
                Err(error) => rejected(error),
            },
        }
    }

    fn ensure_agent(
        &mut self,
        remote_session_id: Uuid,
        caller: &CallerIdentity,
        requested: CapabilitySet,
        now: Instant,
    ) -> Result<bool, BrokerError> {
        if let Some(agent) = self.agent.as_ref() {
            if agent.remote_session_id != remote_session_id {
                if self.core.active_lease_remote_session_id().is_some() {
                    return Err(BrokerError::AgentUnavailable);
                }
                self.stop_agent();
            } else if agent.windows_session_id != caller.windows_session_id {
                self.stop_agent();
            } else if !agent.capabilities.satisfies(requested) {
                return Err(BrokerError::CapabilityUnavailable);
            } else if agent.is_running() {
                if self.ping_agent().is_ok() {
                    return Ok(false);
                }
                self.agent_failed(now);
            } else {
                self.agent_failed(now);
            }
        }

        self.core
            .begin_agent_start(caller.windows_session_id, now)?;
        match AgentProcess::launch(remote_session_id, caller) {
            Ok(agent) => {
                let capabilities = agent.capabilities;
                if !capabilities.satisfies(requested) {
                    let mut agent = agent;
                    agent.stop();
                    self.core.agent_stopped();
                    return Err(BrokerError::CapabilityUnavailable);
                }
                self.core
                    .agent_ready(agent.process_id, agent.windows_session_id, capabilities)?;
                self.agent = Some(agent);
                Ok(true)
            }
            Err(_) => {
                self.core.agent_failed(now);
                Err(BrokerError::AgentUnavailable)
            }
        }
    }

    fn ping_agent(&mut self) -> Result<(), BrokerError> {
        let Some(agent) = self.agent.as_mut() else {
            return Err(BrokerError::AgentUnavailable);
        };
        self.agent_sequence = self.agent_sequence.wrapping_add(1).max(1);
        agent
            .ping(self.agent_sequence)
            .map_err(|_| BrokerError::AgentUnavailable)
    }

    fn agent_failed(&mut self, now: Instant) {
        if let Some(mut agent) = self.agent.take() {
            agent.stop();
        }
        self.core.agent_failed(now);
    }

    fn stop_agent(&mut self) {
        if let Some(mut agent) = self.agent.take() {
            agent.stop();
        }
        self.core.agent_stopped();
    }
}

fn granted(remote_session_id: Uuid, lease: GrantedLease) -> BrokerResponse {
    BrokerResponse::Granted {
        protocol_version: crate::NATIVE_PROTOCOL_VERSION,
        remote_session_id,
        lease_id: lease.id,
        expires_in_ms: duration_ms(lease.expires_in),
        capabilities: lease.capabilities,
    }
}

fn rejected(error: BrokerError) -> BrokerResponse {
    let retry_after_ms = match error {
        BrokerError::RestartBackoff => Some(1_000),
        _ => None,
    };
    BrokerResponse::Rejected {
        code: error.into(),
        retry_after_ms,
    }
}

fn duration_ms(duration: Duration) -> u64 {
    duration.as_millis().try_into().unwrap_or(u64::MAX)
}

fn call_service(request: &BrokerRequest) -> Result<BrokerResponse> {
    let (connect_timeout, response_timeout) = request_timeouts(request);
    let deadline = Instant::now() + connect_timeout;
    let mut file = loop {
        match OpenOptions::new()
            .read(true)
            .write(true)
            .open(BROKER_PIPE_NAME)
        {
            Ok(file) => break file,
            Err(error) if Instant::now() < deadline => {
                let _ = error;
                thread::sleep(CLIENT_RETRY_INTERVAL);
            }
            Err(error) => return Err(error).context("connecting to the remote capability broker"),
        }
    };
    validate_service_server(&file)?;
    write_message(&mut file, request)?;
    read_message(&mut file, response_timeout)
}

fn request_timeouts(request: &BrokerRequest) -> (Duration, Duration) {
    match request {
        BrokerRequest::Acquire { .. } => (
            BROKER_ACQUIRE_CONNECT_TIMEOUT,
            BROKER_ACQUIRE_RESPONSE_TIMEOUT,
        ),
        BrokerRequest::Heartbeat { .. } => (
            BROKER_HEARTBEAT_CONNECT_TIMEOUT,
            BROKER_HEARTBEAT_RESPONSE_TIMEOUT,
        ),
        BrokerRequest::Release { .. } => (
            BROKER_RELEASE_CONNECT_TIMEOUT,
            BROKER_RELEASE_RESPONSE_TIMEOUT,
        ),
    }
}

fn validate_service_server(file: &File) -> Result<()> {
    let mut server_process_id = 0u32;
    unsafe {
        GetNamedPipeServerProcessId(file_handle(file), &mut server_process_id)
            .context("querying named-pipe server process")?;
    }
    let expected = crate::service::process_id()
        .ok_or_else(|| anyhow!("the installed remote service has no running process"))?;
    if server_process_id != expected {
        bail!("named-pipe server is not the installed remote service");
    }
    Ok(())
}

struct AgentProcess {
    process: OwnedHandle,
    process_id: u32,
    remote_session_id: Uuid,
    windows_session_id: u32,
    capabilities: CapabilitySet,
    channel: File,
}

impl AgentProcess {
    fn launch(remote_session_id: Uuid, caller: &CallerIdentity) -> Result<Self> {
        let nonce = Uuid::new_v4();
        let pipe_name = format!("{AGENT_PIPE_PREFIX}-{}-{nonce}", caller.windows_session_id);
        let security = PipeSecurity::new()?;
        let listener = ListeningPipe::new(&pipe_name, &security, true)?;
        let service_process_id = unsafe { GetCurrentProcessId() };
        let process = launch_in_session(
            caller.windows_session_id,
            &pipe_name,
            remote_session_id,
            nonce,
            service_process_id,
        )?;
        let process_id = process.process_id;
        let never_shutdown = AtomicBool::new(false);
        let mut channel =
            match listener.accept(&never_shutdown, Some(process_id), AGENT_HANDSHAKE_TIMEOUT)? {
                Some(channel) => channel,
                None => {
                    let mut process = process;
                    process.terminate();
                    bail!("session agent did not connect before the handshake timeout");
                }
            };
        let process_identity = connected_process_identity(&channel)?;
        if !same_user_session(&process_identity, caller) {
            let mut process = process;
            process.terminate();
            bail!("session agent identity does not match the capability caller");
        }
        let hello: AgentHello = read_message(&mut channel, AGENT_HANDSHAKE_TIMEOUT)?;
        let pipe_identity = caller_identity(&channel, process_id)?;
        if !same_bound_identity(&process_identity, &pipe_identity)
            || !same_user_session(&pipe_identity, caller)
        {
            let mut process = process;
            process.terminate();
            bail!("session agent pipe token does not match its process identity");
        }
        if hello.protocol_version != crate::NATIVE_PROTOCOL_VERSION
            || hello.remote_session_id != remote_session_id
            || hello.nonce != nonce
            || hello.process_id != process_id
            || hello.windows_session_id != caller.windows_session_id
        {
            let mut process = process;
            process.terminate();
            bail!("session agent handshake does not match the broker expectation");
        }
        Ok(Self {
            process: process.into_handle(),
            process_id,
            remote_session_id,
            windows_session_id: caller.windows_session_id,
            capabilities: hello.capabilities,
            channel,
        })
    }

    fn is_running(&self) -> bool {
        unsafe { WaitForSingleObject(self.process.0, 0) == WAIT_TIMEOUT }
    }

    fn ping(&mut self, sequence: u64) -> Result<()> {
        if !self.is_running() {
            bail!("session agent exited");
        }
        write_message(&mut self.channel, &AgentCommand::Ping { sequence })?;
        match read_message::<AgentResponse>(&mut self.channel, AGENT_RPC_TIMEOUT)? {
            AgentResponse::Pong {
                sequence: response_sequence,
            } if response_sequence == sequence => Ok(()),
            _ => bail!("session agent returned an invalid heartbeat"),
        }
    }

    fn stop(&mut self) {
        if self.is_running() {
            let _ = write_message(&mut self.channel, &AgentCommand::Stop);
            let _ = read_message::<AgentResponse>(&mut self.channel, AGENT_RPC_TIMEOUT);
            if unsafe { WaitForSingleObject(self.process.0, AGENT_RPC_TIMEOUT.as_millis() as u32) }
                == WAIT_TIMEOUT
            {
                let _ = unsafe { TerminateProcess(self.process.0, 1) };
                let _ = unsafe { WaitForSingleObject(self.process.0, 1_000) };
            }
        }
    }
}

impl Drop for AgentProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

struct SpawnedAgent {
    handle: Option<OwnedHandle>,
    process_id: u32,
}

impl SpawnedAgent {
    fn terminate(&mut self) {
        let Some(handle) = self.handle.as_ref() else {
            return;
        };
        if unsafe { WaitForSingleObject(handle.0, 0) } == WAIT_TIMEOUT {
            let _ = unsafe { TerminateProcess(handle.0, 1) };
            let _ = unsafe { WaitForSingleObject(handle.0, 1_000) };
        }
    }

    fn into_handle(mut self) -> OwnedHandle {
        self.handle
            .take()
            .expect("spawned session agent always owns a process handle")
    }
}

impl Drop for SpawnedAgent {
    fn drop(&mut self) {
        self.terminate();
    }
}

fn launch_in_session(
    windows_session_id: u32,
    pipe_name: &str,
    remote_session_id: Uuid,
    nonce: Uuid,
    service_process_id: u32,
) -> Result<SpawnedAgent> {
    let mut token = HANDLE::default();
    unsafe {
        WTSQueryUserToken(windows_session_id, &mut token)
            .context("querying the active Windows session token")?;
    }
    let token = OwnedHandle(token);
    let executable = std::env::current_exe().context("resolving session-agent executable")?;
    let executable_wide = wide_path(&executable);
    let mut command_line = wide(&format!(
        "\"{}\" --session-agent --broker-pipe \"{pipe_name}\" --remote-session-id {remote_session_id} --nonce {nonce} --windows-session-id {windows_session_id} --service-pid {service_process_id}",
        executable.display()
    ));
    let mut desktop = wide(r"winsta0\default");
    let startup = STARTUPINFOW {
        cb: size_of::<STARTUPINFOW>() as u32,
        lpDesktop: PWSTR(desktop.as_mut_ptr()),
        ..Default::default()
    };
    let mut process = PROCESS_INFORMATION::default();
    unsafe {
        CreateProcessAsUserW(
            Some(token.0),
            PCWSTR(executable_wide.as_ptr()),
            Some(PWSTR(command_line.as_mut_ptr())),
            None,
            None,
            false,
            CREATE_NO_WINDOW,
            None,
            PCWSTR::null(),
            &startup,
            &mut process,
        )
        .context("launching the active-session remote agent")?;
    }
    let spawned = SpawnedAgent {
        handle: Some(OwnedHandle(process.hProcess)),
        process_id: process.dwProcessId,
    };
    unsafe {
        CloseHandle(process.hThread).context("closing session-agent thread handle")?;
    }
    Ok(spawned)
}

pub fn run_agent_channel(
    pipe_name: &str,
    remote_session_id: Uuid,
    nonce: Uuid,
    expected_windows_session_id: u32,
    expected_service_process_id: u32,
    capabilities: CapabilitySet,
) -> Result<()> {
    let process_id = unsafe { GetCurrentProcessId() };
    let mut actual_session_id = 0u32;
    unsafe {
        ProcessIdToSessionId(process_id, &mut actual_session_id)
            .context("querying session-agent Windows session")?;
    }
    if actual_session_id != expected_windows_session_id {
        bail!("session agent was launched into an unexpected Windows session");
    }

    let deadline = Instant::now() + AGENT_HANDSHAKE_TIMEOUT;
    let mut channel = loop {
        match OpenOptions::new().read(true).write(true).open(pipe_name) {
            Ok(channel) => break channel,
            Err(error) if Instant::now() < deadline => {
                let _ = error;
                thread::sleep(CLIENT_RETRY_INTERVAL);
            }
            Err(error) => return Err(error).context("connecting session agent to the service"),
        }
    };
    let mut server_process_id = 0u32;
    unsafe {
        GetNamedPipeServerProcessId(file_handle(&channel), &mut server_process_id)
            .context("querying session-agent pipe server")?;
    }
    if server_process_id != expected_service_process_id {
        bail!("session-agent pipe is not owned by the launching service");
    }
    write_message(
        &mut channel,
        &AgentHello {
            protocol_version: crate::NATIVE_PROTOCOL_VERSION,
            remote_session_id,
            nonce,
            process_id,
            windows_session_id: actual_session_id,
            capabilities,
        },
    )?;
    loop {
        match read_message::<AgentCommand>(&mut channel, LEASE_TTL + AGENT_RPC_TIMEOUT)? {
            AgentCommand::Ping { sequence } => {
                write_message(&mut channel, &AgentResponse::Pong { sequence })?;
            }
            AgentCommand::Stop => {
                write_message(&mut channel, &AgentResponse::Stopped)?;
                break;
            }
        }
    }
    Ok(())
}

struct ListeningPipe {
    file: File,
}

impl ListeningPipe {
    fn new(name: &str, security: &PipeSecurity, first_instance: bool) -> Result<Self> {
        let name = wide(name);
        let access = if first_instance {
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE
        } else {
            PIPE_ACCESS_DUPLEX
        };
        let mode =
            PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS;
        let handle = unsafe {
            CreateNamedPipeW(
                PCWSTR(name.as_ptr()),
                access,
                mode,
                1,
                MAX_BROKER_MESSAGE_BYTES as u32,
                MAX_BROKER_MESSAGE_BYTES as u32,
                BROKER_REQUEST_TIMEOUT.as_millis() as u32,
                Some(&security.attributes),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error()).context("creating local broker pipe");
        }
        Ok(Self {
            file: unsafe { File::from_raw_handle(handle.0) },
        })
    }

    fn accept(
        self,
        shutdown: &AtomicBool,
        expected_process_id: Option<u32>,
        timeout: Duration,
    ) -> Result<Option<File>> {
        let deadline = Instant::now() + timeout;
        loop {
            match unsafe { ConnectNamedPipe(file_handle(&self.file), None) } {
                Ok(()) => break,
                Err(_) => {
                    let code = std::io::Error::last_os_error().raw_os_error();
                    if code == Some(ERROR_PIPE_CONNECTED.0 as i32) {
                        break;
                    }
                    if code != Some(ERROR_PIPE_LISTENING.0 as i32)
                        && code != Some(ERROR_NO_DATA.0 as i32)
                    {
                        return Err(std::io::Error::last_os_error())
                            .context("accepting local broker pipe");
                    }
                }
            }
            if shutdown.load(Ordering::Acquire) || Instant::now() >= deadline {
                return Ok(None);
            }
            thread::sleep(PIPE_POLL_INTERVAL);
        }
        if let Some(expected_process_id) = expected_process_id {
            let mut actual_process_id = 0u32;
            unsafe {
                GetNamedPipeClientProcessId(file_handle(&self.file), &mut actual_process_id)
                    .context("querying local pipe client process")?;
            }
            if actual_process_id != expected_process_id {
                bail!("unexpected local pipe client process");
            }
        }
        Ok(Some(self.file))
    }
}

struct PipeSecurity {
    descriptor: PSECURITY_DESCRIPTOR,
    attributes: SECURITY_ATTRIBUTES,
}

impl PipeSecurity {
    fn new() -> Result<Self> {
        let sddl = wide(SERVICE_PIPE_SDDL);
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(sddl.as_ptr()),
                SDDL_REVISION_1,
                &mut descriptor,
                None,
            )
            .context("building broker pipe security descriptor")?;
        }
        Ok(Self {
            descriptor,
            attributes: SECURITY_ATTRIBUTES {
                nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor.0,
                bInheritHandle: BOOL(0),
            },
        })
    }
}

impl Drop for PipeSecurity {
    fn drop(&mut self) {
        unsafe {
            let _ = LocalFree(Some(HLOCAL(self.descriptor.0)));
        }
    }
}

fn connected_process_identity(pipe: &File) -> Result<CallerIdentity> {
    let mut process_id = 0u32;
    unsafe {
        GetNamedPipeClientProcessId(file_handle(pipe), &mut process_id)
            .context("querying broker caller process")?;
    }
    if process_id == 0 {
        bail!("broker caller process is unavailable");
    }
    process_identity(process_id)
}

fn process_identity(process_id: u32) -> Result<CallerIdentity> {
    validate_client_binary(process_id)?;
    let mut process_session_id = 0u32;
    unsafe {
        ProcessIdToSessionId(process_id, &mut process_session_id)
            .context("querying broker caller process session")?;
    }
    let process = unsafe {
        OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id)
            .context("opening broker caller process for token authentication")?
    };
    let process = OwnedHandle(process);
    let mut token = HANDLE::default();
    unsafe {
        OpenProcessToken(process.0, TOKEN_QUERY, &mut token)
            .context("opening broker caller process token")?;
    }
    caller_identity_from_token(process_id, process_session_id, OwnedHandle(token))
}

fn caller_identity(pipe: &File, declared_process_id: u32) -> Result<CallerIdentity> {
    let mut process_id = 0u32;
    unsafe {
        GetNamedPipeClientProcessId(file_handle(pipe), &mut process_id)
            .context("querying broker caller process")?;
    }
    if process_id == 0 || process_id != declared_process_id {
        bail!("broker caller process does not match its declaration");
    }
    validate_client_binary(process_id)?;
    let mut process_session_id = 0u32;
    unsafe {
        ProcessIdToSessionId(process_id, &mut process_session_id)
            .context("querying broker caller process session")?;
        ImpersonateNamedPipeClient(file_handle(pipe)).context("impersonating broker caller")?;
    }
    let _revert = RevertGuard;
    let mut token = HANDLE::default();
    unsafe {
        OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, false, &mut token)
            .context("opening broker caller token")?;
    }
    let token = OwnedHandle(token);
    caller_identity_from_token(process_id, process_session_id, token)
}

fn caller_identity_from_token(
    process_id: u32,
    process_session_id: u32,
    token: OwnedHandle,
) -> Result<CallerIdentity> {
    let token_session_id = token_session_id(token.0)?;
    if token_session_id != process_session_id {
        bail!("broker caller token and process sessions differ");
    }
    let sid = token_sid(token.0)?;
    Ok(CallerIdentity {
        process_id,
        windows_session_id: token_session_id,
        sid,
        active_windows_session_id: active_windows_session_id(token_session_id),
    })
}

fn active_caller_identity(
    pipe: &File,
    declared_process_id: u32,
) -> Result<CallerIdentity, BrokerError> {
    let caller =
        caller_identity(pipe, declared_process_id).map_err(|_| BrokerError::CallerDenied)?;
    if caller.is_active_interactive_user() {
        Ok(caller)
    } else {
        Err(BrokerError::CallerDenied)
    }
}

fn same_bound_identity(left: &CallerIdentity, right: &CallerIdentity) -> bool {
    left.process_id == right.process_id && same_user_session(left, right)
}

fn same_user_session(left: &CallerIdentity, right: &CallerIdentity) -> bool {
    left.windows_session_id == right.windows_session_id && left.sid == right.sid
}

fn active_windows_session_id(session_id: u32) -> u32 {
    let mut buffer = PWSTR::null();
    let mut bytes_returned = 0u32;
    if unsafe {
        WTSQuerySessionInformationW(
            None,
            session_id,
            WTSConnectState,
            &mut buffer,
            &mut bytes_returned,
        )
    }
    .is_err()
    {
        return u32::MAX;
    }
    let active = !buffer.is_null()
        && bytes_returned >= size_of::<WTS_CONNECTSTATE_CLASS>() as u32
        && unsafe { *(buffer.0.cast::<WTS_CONNECTSTATE_CLASS>()) } == WTSActive;
    unsafe {
        WTSFreeMemory(buffer.0.cast());
    }
    if active { session_id } else { u32::MAX }
}

fn validate_client_binary(process_id: u32) -> Result<()> {
    let process = unsafe {
        OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id)
            .context("opening broker caller process")?
    };
    let process = OwnedHandle(process);
    let mut path = vec![0u16; 32_768];
    let mut path_len = path.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            process.0,
            PROCESS_NAME_WIN32,
            PWSTR(path.as_mut_ptr()),
            &mut path_len,
        )
        .context("querying broker caller executable")?;
    }
    path.truncate(path_len as usize);
    let caller_path = PathBuf::from(String::from_utf16(&path)?);
    let service_path = std::env::current_exe().context("resolving broker executable")?;
    if normalized_path(&caller_path) != normalized_path(&service_path) {
        bail!("broker caller is not the installed remote-host executable");
    }
    Ok(())
}

fn process_is_running(process_id: u32) -> bool {
    let process = match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) }
    {
        Ok(process) => OwnedHandle(process),
        Err(_) => {
            return std::io::Error::last_os_error().raw_os_error()
                != Some(ERROR_INVALID_PARAMETER.0 as i32);
        }
    };
    let mut exit_code = 0u32;
    unsafe { GetExitCodeProcess(process.0, &mut exit_code) }.is_ok()
        && exit_code == STILL_ACTIVE.0 as u32
}

fn normalized_path(path: &Path) -> String {
    std::fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('/', r"\")
        .to_lowercase()
}

fn token_session_id(token: HANDLE) -> Result<u32> {
    let mut session_id = 0u32;
    let mut returned = 0u32;
    unsafe {
        GetTokenInformation(
            token,
            TokenSessionId,
            Some((&mut session_id as *mut u32).cast()),
            size_of::<u32>() as u32,
            &mut returned,
        )
        .context("querying caller token session")?;
    }
    Ok(session_id)
}

fn token_sid(token: HANDLE) -> Result<Vec<u8>> {
    let mut required = 0u32;
    let _ = unsafe { GetTokenInformation(token, TokenUser, None, 0, &mut required) };
    if required < size_of::<TOKEN_USER>() as u32 {
        bail!("caller token did not expose a user SID");
    }
    let mut buffer = vec![0u8; required as usize];
    unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            Some(buffer.as_mut_ptr().cast()),
            required,
            &mut required,
        )
        .context("querying caller user SID")?;
    }
    let token_user = unsafe { &*(buffer.as_ptr().cast::<TOKEN_USER>()) };
    if !unsafe { IsValidSid(token_user.User.Sid) }.as_bool() {
        bail!("caller user SID is invalid");
    }
    let sid_len = unsafe { GetLengthSid(token_user.User.Sid) } as usize;
    if sid_len == 0 || sid_len > required as usize {
        bail!("caller user SID has an invalid size");
    }
    Ok(unsafe { std::slice::from_raw_parts(token_user.User.Sid.0.cast::<u8>(), sid_len) }.to_vec())
}

struct RevertGuard;

impl Drop for RevertGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = RevertToSelf();
        }
    }
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

fn write_message<T: serde::Serialize>(file: &mut File, value: &T) -> Result<()> {
    let encoded =
        encode_bounded(value).map_err(|code| anyhow!("encoding broker message: {code:?}"))?;
    file.write_all(&encoded)?;
    file.flush()?;
    Ok(())
}

fn read_message<T: for<'de> serde::Deserialize<'de>>(
    file: &mut File,
    timeout: Duration,
) -> Result<T> {
    let deadline = Instant::now() + timeout;
    let mut bytes = Vec::with_capacity(512);
    loop {
        let mut available = 0u32;
        let peek =
            unsafe { PeekNamedPipe(file_handle(file), None, 0, None, Some(&mut available), None) };
        if peek.is_err() {
            return Err(std::io::Error::last_os_error()).context("reading local broker pipe");
        }
        if available > 0 {
            let remaining = MAX_BROKER_MESSAGE_BYTES.saturating_sub(bytes.len());
            if remaining == 0 || available as usize > remaining {
                bail!("local broker message exceeds its size limit");
            }
            let mut chunk = vec![0u8; available as usize];
            let count = file.read(&mut chunk)?;
            if count == 0 {
                bail!("local broker pipe closed before a complete message");
            }
            bytes.extend_from_slice(&chunk[..count]);
            if let Some(newline) = bytes.iter().position(|byte| *byte == b'\n') {
                if newline + 1 != bytes.len() {
                    bail!("local broker pipe contains trailing data");
                }
                return decode_bounded(&bytes[..newline])
                    .map_err(|code| anyhow!("decoding broker message: {code:?}"));
            }
        } else if Instant::now() >= deadline {
            bail!("local broker message timed out");
        } else {
            thread::sleep(PIPE_POLL_INTERVAL);
        }
    }
}

fn file_handle(file: &File) -> HANDLE {
    HANDLE(file.as_raw_handle())
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn wide_path(value: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lease_heartbeat_interval_is_well_inside_the_ttl() {
        let lease = BrokerLeaseClient {
            remote_session_id: Uuid::nil(),
            lease_id: Uuid::nil(),
            process_id: 1,
            expires_in: LEASE_TTL,
            rpc_lock: std::sync::Mutex::new(()),
            closed: AtomicBool::new(false),
        };
        assert!(lease.heartbeat_interval() < LEASE_TTL / 2);
        assert!(lease.heartbeat_interval() <= Duration::from_secs(2));
        assert!(
            lease.heartbeat_interval()
                + BROKER_HEARTBEAT_CONNECT_TIMEOUT
                + BROKER_HEARTBEAT_RESPONSE_TIMEOUT
                < Duration::from_secs(5)
        );
        lease.closed.store(true, Ordering::Release);
        assert!(matches!(lease.heartbeat(), Err(BrokerClientError::Closed)));
    }

    #[test]
    fn cold_agent_acquisition_outlives_the_agent_handshake_deadline() {
        let acquire = BrokerRequest::Acquire {
            protocol_version: crate::NATIVE_PROTOCOL_VERSION,
            remote_session_id: Uuid::nil(),
            process_id: 1,
            requested: CapabilitySet::REMOTE_DESKTOP,
        };
        let heartbeat = BrokerRequest::Heartbeat {
            protocol_version: crate::NATIVE_PROTOCOL_VERSION,
            remote_session_id: Uuid::nil(),
            process_id: 1,
            lease_id: Uuid::nil(),
        };
        let (acquire_connect, acquire_response) = request_timeouts(&acquire);
        let (heartbeat_connect, heartbeat_response) = request_timeouts(&heartbeat);
        assert_eq!(acquire_connect, BROKER_ACQUIRE_CONNECT_TIMEOUT);
        assert!(acquire_response > AGENT_HANDSHAKE_TIMEOUT);
        assert_eq!(heartbeat_connect, BROKER_HEARTBEAT_CONNECT_TIMEOUT);
        assert_eq!(heartbeat_response, BROKER_HEARTBEAT_RESPONSE_TIMEOUT);
    }

    #[test]
    fn agent_pipe_name_and_sddl_are_local_and_bounded() {
        let name = format!("{AGENT_PIPE_PREFIX}-7-{}", Uuid::nil());
        assert!(name.starts_with(r"\\.\pipe\"));
        assert!(name.len() < 256);
        assert!(SERVICE_PIPE_SDDL.contains("IU"));
        assert!(!SERVICE_PIPE_SDDL.contains("AN"));
    }

    #[test]
    fn named_pipe_round_trip_binds_the_real_windows_process_and_token() {
        let pipe_name = format!(r"\\.\pipe\EZTerminalRemoteHost-test-{}", Uuid::new_v4());
        let server_name = pipe_name.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
        let server = std::thread::spawn(move || -> Result<CallerIdentity> {
            let security = PipeSecurity::new()?;
            let listener = ListeningPipe::new(&server_name, &security, true)?;
            ready_tx.send(())?;
            let shutdown = AtomicBool::new(false);
            let mut connection = listener
                .accept(
                    &shutdown,
                    Some(unsafe { GetCurrentProcessId() }),
                    Duration::from_secs(2),
                )?
                .ok_or_else(|| anyhow!("test pipe accept timed out"))?;
            let preauthenticated = connected_process_identity(&connection)?;
            let request = read_message::<BrokerRequest>(&mut connection, Duration::from_secs(2))?;
            let identity = caller_identity(&connection, request.process_id())?;
            if !same_bound_identity(&preauthenticated, &identity) {
                bail!("pre-read process token and post-read pipe token differ");
            }
            write_message(
                &mut connection,
                &BrokerResponse::Ack {
                    expires_in_ms: None,
                },
            )?;
            Ok(identity)
        });

        ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let mut client = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&pipe_name)
            .unwrap();
        let process_id = unsafe { GetCurrentProcessId() };
        write_message(
            &mut client,
            &BrokerRequest::Release {
                protocol_version: crate::NATIVE_PROTOCOL_VERSION,
                remote_session_id: Uuid::new_v4(),
                process_id,
                lease_id: Uuid::new_v4(),
            },
        )
        .unwrap();
        assert_eq!(
            read_message::<BrokerResponse>(&mut client, Duration::from_secs(2)).unwrap(),
            BrokerResponse::Ack {
                expires_in_ms: None
            }
        );
        let identity = server.join().unwrap().unwrap();
        assert_eq!(identity.process_id, process_id);
        assert!(!identity.sid.is_empty());
    }
}
