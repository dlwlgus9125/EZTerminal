use std::collections::VecDeque;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::NATIVE_PROTOCOL_VERSION;

pub const BROKER_PIPE_NAME: &str = r"\\.\pipe\EZTerminalRemoteHost-broker-v1";
pub const MAX_BROKER_MESSAGE_BYTES: usize = 8 * 1024;
pub const BROKER_REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
pub const BROKER_ACQUIRE_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
pub const AGENT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
pub const AGENT_RPC_TIMEOUT: Duration = Duration::from_secs(2);
pub const BROKER_ACQUIRE_RESPONSE_TIMEOUT: Duration =
    AGENT_HANDSHAKE_TIMEOUT.saturating_add(AGENT_RPC_TIMEOUT);
pub const BROKER_HEARTBEAT_CONNECT_TIMEOUT: Duration = Duration::from_secs(1);
pub const BROKER_HEARTBEAT_RESPONSE_TIMEOUT: Duration = Duration::from_millis(2_500);
pub const BROKER_RELEASE_CONNECT_TIMEOUT: Duration = Duration::from_secs(1);
pub const BROKER_RELEASE_RESPONSE_TIMEOUT: Duration = Duration::from_secs(1);
pub const LEASE_TTL: Duration = Duration::from_secs(20);
pub const LEASE_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(1);
pub const MAX_AGENT_RESTARTS: usize = 3;
pub const AGENT_RESTART_WINDOW: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrokerLifecycle {
    Starting,
    Ready,
    Stopping,
    Stopped,
    Faulted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitySet {
    pub capture: bool,
    pub input: bool,
    pub secure_attention: bool,
}

impl CapabilitySet {
    pub const REMOTE_DESKTOP: Self = Self {
        capture: true,
        input: true,
        secure_attention: false,
    };

    pub fn satisfies(self, requested: Self) -> bool {
        (!requested.capture || self.capture)
            && (!requested.input || self.input)
            && (!requested.secure_attention || self.secure_attention)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallerIdentity {
    pub process_id: u32,
    pub windows_session_id: u32,
    pub sid: Vec<u8>,
    pub active_windows_session_id: u32,
}

impl CallerIdentity {
    pub fn is_active_interactive_user(&self) -> bool {
        self.windows_session_id != 0
            && self.windows_session_id != u32::MAX
            && self.windows_session_id == self.active_windows_session_id
            && !self.sid.is_empty()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentState {
    Absent,
    Starting {
        windows_session_id: u32,
        attempt: u8,
    },
    Ready {
        process_id: u32,
        windows_session_id: u32,
        capabilities: CapabilitySet,
    },
    Backoff {
        until: Instant,
        attempt: u8,
    },
    Exhausted,
}

#[derive(Debug, Clone)]
struct CapabilityLease {
    id: Uuid,
    remote_session_id: Uuid,
    caller: CallerIdentity,
    expires_at: Instant,
    renewable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GrantedLease {
    pub id: Uuid,
    pub expires_in: Duration,
    pub capabilities: CapabilitySet,
}

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum BrokerError {
    #[error("broker is not ready")]
    NotReady,
    #[error("native protocol version is incompatible")]
    IncompatibleProtocol,
    #[error("caller is not the active interactive Windows user")]
    CallerDenied,
    #[error("another remote desktop controller owns the capability lease")]
    LeaseBusy,
    #[error("the supervised session agent is unavailable")]
    AgentUnavailable,
    #[error("the requested capability is unavailable")]
    CapabilityUnavailable,
    #[error("capability lease identity mismatch")]
    LeaseMismatch,
    #[error("session agent restart budget is exhausted")]
    RestartExhausted,
    #[error("session agent restart is in backoff")]
    RestartBackoff,
}

#[derive(Debug)]
pub struct BrokerCore {
    lifecycle: BrokerLifecycle,
    agent: AgentState,
    lease: Option<CapabilityLease>,
    restart_failures: VecDeque<Instant>,
}

impl Default for BrokerCore {
    fn default() -> Self {
        Self {
            lifecycle: BrokerLifecycle::Starting,
            agent: AgentState::Absent,
            lease: None,
            restart_failures: VecDeque::new(),
        }
    }
}

impl BrokerCore {
    pub fn set_ready(&mut self) {
        if self.lifecycle == BrokerLifecycle::Starting {
            self.lifecycle = BrokerLifecycle::Ready;
        }
    }

    pub fn begin_stopping(&mut self) {
        self.lifecycle = BrokerLifecycle::Stopping;
        self.lease = None;
    }

    pub fn set_stopped(&mut self) {
        self.lifecycle = BrokerLifecycle::Stopped;
        self.agent = AgentState::Absent;
        self.lease = None;
    }

    pub fn set_faulted(&mut self) {
        self.lifecycle = BrokerLifecycle::Faulted;
        self.agent = AgentState::Absent;
        self.lease = None;
    }

    pub fn lifecycle(&self) -> BrokerLifecycle {
        self.lifecycle
    }

    pub fn agent_state(&self) -> AgentState {
        self.agent
    }

    pub fn begin_agent_start(
        &mut self,
        windows_session_id: u32,
        now: Instant,
    ) -> Result<(), BrokerError> {
        self.ensure_ready()?;
        self.prune_restart_failures(now);
        match self.agent {
            AgentState::Backoff { until, .. } if now < until => {
                return Err(BrokerError::RestartBackoff);
            }
            AgentState::Exhausted if self.restart_failures.len() >= MAX_AGENT_RESTARTS => {
                return Err(BrokerError::RestartExhausted);
            }
            _ => {}
        }
        if self.restart_failures.len() >= MAX_AGENT_RESTARTS {
            self.agent = AgentState::Exhausted;
            return Err(BrokerError::RestartExhausted);
        }
        self.agent = AgentState::Starting {
            windows_session_id,
            attempt: (self.restart_failures.len() + 1) as u8,
        };
        Ok(())
    }

    pub fn agent_ready(
        &mut self,
        process_id: u32,
        windows_session_id: u32,
        capabilities: CapabilitySet,
    ) -> Result<(), BrokerError> {
        match self.agent {
            AgentState::Starting {
                windows_session_id: expected,
                ..
            } if expected == windows_session_id => {
                self.agent = AgentState::Ready {
                    process_id,
                    windows_session_id,
                    capabilities,
                };
                Ok(())
            }
            _ => Err(BrokerError::AgentUnavailable),
        }
    }

    pub fn agent_failed(&mut self, now: Instant) {
        self.tombstone_lease();
        self.restart_failures.push_back(now);
        self.prune_restart_failures(now);
        let attempt = self.restart_failures.len();
        if attempt >= MAX_AGENT_RESTARTS {
            self.agent = AgentState::Exhausted;
            return;
        }
        let delay_seconds = 1u64 << attempt.saturating_sub(1).min(2);
        self.agent = AgentState::Backoff {
            until: now + Duration::from_secs(delay_seconds),
            attempt: attempt as u8,
        };
    }

    pub fn agent_stopped(&mut self) {
        self.agent = AgentState::Absent;
        self.tombstone_lease();
    }

    pub fn expire(&mut self, now: Instant) {
        if let Some(lease) = self.lease.as_mut()
            && now >= lease.expires_at
        {
            lease.renewable = false;
        }
        self.prune_restart_failures(now);
        if matches!(self.agent, AgentState::Exhausted) && self.restart_failures.is_empty() {
            self.agent = AgentState::Absent;
        }
    }

    pub fn acquire(
        &mut self,
        protocol_version: u16,
        remote_session_id: Uuid,
        caller: &CallerIdentity,
        requested: CapabilitySet,
        now: Instant,
    ) -> Result<GrantedLease, BrokerError> {
        self.preflight_acquire(protocol_version, remote_session_id, caller, now)?;
        let capabilities = match self.agent {
            AgentState::Ready {
                windows_session_id,
                capabilities,
                ..
            } if windows_session_id == caller.windows_session_id => capabilities,
            _ => return Err(BrokerError::AgentUnavailable),
        };
        if !capabilities.satisfies(requested) {
            return Err(BrokerError::CapabilityUnavailable);
        }

        if let Some(lease) = self.lease.as_mut() {
            if !lease.renewable {
                return Err(BrokerError::LeaseBusy);
            }
            if lease.remote_session_id != remote_session_id
                || lease.caller.process_id != caller.process_id
                || lease.caller.windows_session_id != caller.windows_session_id
                || lease.caller.sid != caller.sid
            {
                return Err(BrokerError::LeaseBusy);
            }
            lease.expires_at = now + LEASE_TTL;
            return Ok(GrantedLease {
                id: lease.id,
                expires_in: LEASE_TTL,
                capabilities,
            });
        }

        let id = Uuid::new_v4();
        self.lease = Some(CapabilityLease {
            id,
            remote_session_id,
            caller: caller.clone(),
            expires_at: now + LEASE_TTL,
            renewable: true,
        });
        Ok(GrantedLease {
            id,
            expires_in: LEASE_TTL,
            capabilities,
        })
    }

    pub fn preflight_acquire(
        &mut self,
        protocol_version: u16,
        remote_session_id: Uuid,
        caller: &CallerIdentity,
        now: Instant,
    ) -> Result<(), BrokerError> {
        self.ensure_ready()?;
        if protocol_version != NATIVE_PROTOCOL_VERSION {
            return Err(BrokerError::IncompatibleProtocol);
        }
        if !caller.is_active_interactive_user() {
            return Err(BrokerError::CallerDenied);
        }
        self.expire(now);
        if let Some(lease) = self.lease.as_ref()
            && (!lease.renewable
                || lease.remote_session_id != remote_session_id
                || lease.caller.process_id != caller.process_id
                || lease.caller.windows_session_id != caller.windows_session_id
                || lease.caller.sid != caller.sid)
        {
            return Err(BrokerError::LeaseBusy);
        }
        Ok(())
    }

    pub fn heartbeat(
        &mut self,
        protocol_version: u16,
        remote_session_id: Uuid,
        lease_id: Uuid,
        caller: &CallerIdentity,
        now: Instant,
    ) -> Result<Duration, BrokerError> {
        self.ensure_ready()?;
        if protocol_version != NATIVE_PROTOCOL_VERSION {
            return Err(BrokerError::IncompatibleProtocol);
        }
        if !caller.is_active_interactive_user() {
            return Err(BrokerError::CallerDenied);
        }
        self.expire(now);
        if !matches!(
            self.agent,
            AgentState::Ready {
                windows_session_id,
                ..
            } if windows_session_id == caller.windows_session_id
        ) {
            return Err(BrokerError::AgentUnavailable);
        }
        let Some(lease) = self.lease.as_mut() else {
            return Err(BrokerError::LeaseMismatch);
        };
        if !lease.renewable
            || lease.id != lease_id
            || lease.remote_session_id != remote_session_id
            || lease.caller.process_id != caller.process_id
            || lease.caller.windows_session_id != caller.windows_session_id
            || lease.caller.sid != caller.sid
        {
            return Err(BrokerError::LeaseMismatch);
        }
        lease.expires_at = now + LEASE_TTL;
        Ok(LEASE_TTL)
    }

    pub fn release(
        &mut self,
        protocol_version: u16,
        remote_session_id: Uuid,
        lease_id: Uuid,
        caller: &CallerIdentity,
    ) -> Result<(), BrokerError> {
        if protocol_version != NATIVE_PROTOCOL_VERSION {
            return Err(BrokerError::IncompatibleProtocol);
        }
        let Some(lease) = self.lease.as_ref() else {
            return Ok(());
        };
        if lease.id != lease_id
            || lease.remote_session_id != remote_session_id
            || lease.caller.process_id != caller.process_id
            || lease.caller.windows_session_id != caller.windows_session_id
            || lease.caller.sid != caller.sid
        {
            return Err(BrokerError::LeaseMismatch);
        }
        self.lease = None;
        Ok(())
    }

    pub fn active_lease_process_id(&self) -> Option<u32> {
        self.lease.as_ref().map(|lease| lease.caller.process_id)
    }

    pub fn active_lease_remote_session_id(&self) -> Option<Uuid> {
        self.lease.as_ref().map(|lease| lease.remote_session_id)
    }

    pub fn revoke_lease_for_process(&mut self, process_id: u32) -> bool {
        if self
            .lease
            .as_ref()
            .is_some_and(|lease| lease.caller.process_id == process_id)
        {
            self.lease = None;
            true
        } else {
            false
        }
    }

    pub fn tombstone_lease_for_process(&mut self, process_id: u32) -> bool {
        if let Some(lease) = self
            .lease
            .as_mut()
            .filter(|lease| lease.caller.process_id == process_id)
        {
            lease.renewable = false;
            true
        } else {
            false
        }
    }

    fn ensure_ready(&self) -> Result<(), BrokerError> {
        if self.lifecycle == BrokerLifecycle::Ready {
            Ok(())
        } else {
            Err(BrokerError::NotReady)
        }
    }

    fn tombstone_lease(&mut self) {
        if let Some(lease) = self.lease.as_mut() {
            lease.renewable = false;
        }
    }

    fn prune_restart_failures(&mut self, now: Instant) {
        while self
            .restart_failures
            .front()
            .is_some_and(|failure| now.saturating_duration_since(*failure) >= AGENT_RESTART_WINDOW)
        {
            self.restart_failures.pop_front();
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum BrokerRequest {
    Acquire {
        protocol_version: u16,
        remote_session_id: Uuid,
        process_id: u32,
        requested: CapabilitySet,
    },
    Heartbeat {
        protocol_version: u16,
        remote_session_id: Uuid,
        process_id: u32,
        lease_id: Uuid,
    },
    Release {
        protocol_version: u16,
        remote_session_id: Uuid,
        process_id: u32,
        lease_id: Uuid,
    },
}

impl BrokerRequest {
    pub fn process_id(&self) -> u32 {
        match self {
            Self::Acquire { process_id, .. }
            | Self::Heartbeat { process_id, .. }
            | Self::Release { process_id, .. } => *process_id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum BrokerResponse {
    Granted {
        protocol_version: u16,
        remote_session_id: Uuid,
        lease_id: Uuid,
        expires_in_ms: u64,
        capabilities: CapabilitySet,
    },
    Ack {
        expires_in_ms: Option<u64>,
    },
    Rejected {
        code: BrokerErrorCode,
        retry_after_ms: Option<u64>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BrokerErrorCode {
    InvalidMessage,
    IncompatibleProtocol,
    CallerDenied,
    LeaseBusy,
    AgentUnavailable,
    CapabilityUnavailable,
    RestartExhausted,
    RestartBackoff,
    Internal,
}

impl From<BrokerError> for BrokerErrorCode {
    fn from(error: BrokerError) -> Self {
        match error {
            BrokerError::IncompatibleProtocol => Self::IncompatibleProtocol,
            BrokerError::CallerDenied | BrokerError::LeaseMismatch => Self::CallerDenied,
            BrokerError::LeaseBusy => Self::LeaseBusy,
            BrokerError::AgentUnavailable | BrokerError::NotReady => Self::AgentUnavailable,
            BrokerError::CapabilityUnavailable => Self::CapabilityUnavailable,
            BrokerError::RestartExhausted => Self::RestartExhausted,
            BrokerError::RestartBackoff => Self::RestartBackoff,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHello {
    pub protocol_version: u16,
    pub remote_session_id: Uuid,
    pub nonce: Uuid,
    pub process_id: u32,
    pub windows_session_id: u32,
    pub capabilities: CapabilitySet,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AgentCommand {
    Ping { sequence: u64 },
    Stop,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AgentResponse {
    Pong { sequence: u64 },
    Stopped,
    Error { code: String },
}

pub fn decode_bounded<T: for<'de> Deserialize<'de>>(bytes: &[u8]) -> Result<T, BrokerErrorCode> {
    if bytes.is_empty() || bytes.len() > MAX_BROKER_MESSAGE_BYTES {
        return Err(BrokerErrorCode::InvalidMessage);
    }
    serde_json::from_slice(bytes).map_err(|_| BrokerErrorCode::InvalidMessage)
}

pub fn encode_bounded<T: Serialize>(value: &T) -> Result<Vec<u8>, BrokerErrorCode> {
    let mut encoded = serde_json::to_vec(value).map_err(|_| BrokerErrorCode::Internal)?;
    if encoded.len() >= MAX_BROKER_MESSAGE_BYTES {
        return Err(BrokerErrorCode::InvalidMessage);
    }
    encoded.push(b'\n');
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caller(process_id: u32) -> CallerIdentity {
        CallerIdentity {
            process_id,
            windows_session_id: 7,
            sid: vec![1, 2, 3],
            active_windows_session_id: 7,
        }
    }

    fn ready_core(now: Instant) -> BrokerCore {
        let mut core = BrokerCore::default();
        core.set_ready();
        core.begin_agent_start(7, now).unwrap();
        core.agent_ready(99, 7, CapabilitySet::REMOTE_DESKTOP)
            .unwrap();
        core
    }

    #[test]
    fn acquisition_requires_exact_protocol_active_identity_and_ready_agent() {
        let now = Instant::now();
        let mut core = ready_core(now);
        assert_eq!(
            core.acquire(
                NATIVE_PROTOCOL_VERSION + 1,
                Uuid::new_v4(),
                &caller(10),
                CapabilitySet::REMOTE_DESKTOP,
                now
            ),
            Err(BrokerError::IncompatibleProtocol)
        );
        let mut inactive = caller(10);
        inactive.active_windows_session_id = 8;
        assert_eq!(
            core.acquire(
                NATIVE_PROTOCOL_VERSION,
                Uuid::new_v4(),
                &inactive,
                CapabilitySet::REMOTE_DESKTOP,
                now
            ),
            Err(BrokerError::CallerDenied)
        );
    }

    #[test]
    fn lease_is_exclusive_but_idempotent_for_bound_session_and_caller() {
        let now = Instant::now();
        let mut core = ready_core(now);
        let session = Uuid::new_v4();
        let first = core
            .acquire(
                NATIVE_PROTOCOL_VERSION,
                session,
                &caller(10),
                CapabilitySet::REMOTE_DESKTOP,
                now,
            )
            .unwrap();
        let resumed = core
            .acquire(
                NATIVE_PROTOCOL_VERSION,
                session,
                &caller(10),
                CapabilitySet::REMOTE_DESKTOP,
                now + Duration::from_secs(1),
            )
            .unwrap();
        assert_eq!(resumed.id, first.id);
        assert_eq!(
            core.acquire(
                NATIVE_PROTOCOL_VERSION,
                Uuid::new_v4(),
                &caller(11),
                CapabilitySet::REMOTE_DESKTOP,
                now
            ),
            Err(BrokerError::LeaseBusy)
        );
    }

    #[test]
    fn heartbeat_is_identity_bound_and_expired_leases_fail_closed() {
        let now = Instant::now();
        let mut core = ready_core(now);
        let session = Uuid::new_v4();
        let owner = caller(10);
        let lease = core
            .acquire(
                NATIVE_PROTOCOL_VERSION,
                session,
                &owner,
                CapabilitySet::REMOTE_DESKTOP,
                now,
            )
            .unwrap();
        assert_eq!(
            core.heartbeat(
                NATIVE_PROTOCOL_VERSION,
                session,
                lease.id,
                &caller(11),
                now + Duration::from_secs(1)
            ),
            Err(BrokerError::LeaseMismatch)
        );
        assert_eq!(
            core.heartbeat(
                NATIVE_PROTOCOL_VERSION,
                session,
                lease.id,
                &owner,
                now + LEASE_TTL
            ),
            Err(BrokerError::LeaseMismatch)
        );
        assert_eq!(core.active_lease_process_id(), Some(owner.process_id));
        assert_eq!(
            core.acquire(
                NATIVE_PROTOCOL_VERSION,
                Uuid::new_v4(),
                &caller(11),
                CapabilitySet::REMOTE_DESKTOP,
                now + LEASE_TTL + Duration::from_secs(1),
            ),
            Err(BrokerError::LeaseBusy)
        );
        core.release(NATIVE_PROTOCOL_VERSION, session, lease.id, &owner)
            .unwrap();
        assert_eq!(core.active_lease_process_id(), None);
    }

    #[test]
    fn heartbeat_cannot_keep_a_fast_user_switched_session_alive() {
        let now = Instant::now();
        let mut core = ready_core(now);
        let session = Uuid::new_v4();
        let active_caller = caller(10);
        let lease = core
            .acquire(
                NATIVE_PROTOCOL_VERSION,
                session,
                &active_caller,
                CapabilitySet::REMOTE_DESKTOP,
                now,
            )
            .unwrap();
        let mut switched_caller = active_caller.clone();
        switched_caller.active_windows_session_id = 8;
        assert_eq!(
            core.heartbeat(
                NATIVE_PROTOCOL_VERSION,
                session,
                lease.id,
                &switched_caller,
                now + Duration::from_secs(10),
            ),
            Err(BrokerError::CallerDenied)
        );
        core.expire(now + LEASE_TTL);
        assert_eq!(
            core.active_lease_process_id(),
            Some(active_caller.process_id)
        );
        core.release(NATIVE_PROTOCOL_VERSION, session, lease.id, &active_caller)
            .unwrap();
        assert_eq!(core.active_lease_process_id(), None);
    }

    #[test]
    fn preflight_preserves_a_busy_session_and_allows_rebinding_after_release() {
        let now = Instant::now();
        let mut core = ready_core(now);
        let first_session = Uuid::new_v4();
        let second_session = Uuid::new_v4();
        let owner = caller(10);
        let lease = core
            .acquire(
                NATIVE_PROTOCOL_VERSION,
                first_session,
                &owner,
                CapabilitySet::REMOTE_DESKTOP,
                now,
            )
            .unwrap();
        assert_eq!(
            core.preflight_acquire(
                NATIVE_PROTOCOL_VERSION,
                second_session,
                &owner,
                now + Duration::from_secs(1),
            ),
            Err(BrokerError::LeaseBusy)
        );
        assert_eq!(core.active_lease_remote_session_id(), Some(first_session));
        core.release(NATIVE_PROTOCOL_VERSION, first_session, lease.id, &owner)
            .unwrap();
        assert!(
            core.preflight_acquire(
                NATIVE_PROTOCOL_VERSION,
                second_session,
                &owner,
                now + Duration::from_secs(2),
            )
            .is_ok()
        );
    }

    #[test]
    fn agent_loss_revokes_the_lease_and_restart_budget_is_bounded() {
        let now = Instant::now();
        let mut core = ready_core(now);
        let session = Uuid::new_v4();
        let lease = core
            .acquire(
                NATIVE_PROTOCOL_VERSION,
                session,
                &caller(10),
                CapabilitySet::REMOTE_DESKTOP,
                now,
            )
            .unwrap();
        core.agent_failed(now);
        assert_eq!(core.active_lease_process_id(), Some(10));
        assert_eq!(
            core.heartbeat(NATIVE_PROTOCOL_VERSION, session, lease.id, &caller(10), now),
            Err(BrokerError::AgentUnavailable)
        );
        assert_eq!(
            core.acquire(
                NATIVE_PROTOCOL_VERSION,
                Uuid::new_v4(),
                &caller(11),
                CapabilitySet::REMOTE_DESKTOP,
                now + Duration::from_secs(1),
            ),
            Err(BrokerError::LeaseBusy)
        );
        for offset in [2, 5] {
            let at = now + Duration::from_secs(offset);
            core.begin_agent_start(7, at).unwrap();
            core.agent_failed(at);
        }
        assert_eq!(core.agent_state(), AgentState::Exhausted);
        assert_eq!(
            core.begin_agent_start(7, now + Duration::from_secs(10)),
            Err(BrokerError::RestartExhausted)
        );
    }

    #[test]
    fn unavailable_capabilities_are_never_silently_downgraded() {
        let now = Instant::now();
        let mut core = BrokerCore::default();
        core.set_ready();
        core.begin_agent_start(7, now).unwrap();
        core.agent_ready(
            99,
            7,
            CapabilitySet {
                capture: true,
                input: false,
                secure_attention: false,
            },
        )
        .unwrap();
        assert_eq!(
            core.acquire(
                NATIVE_PROTOCOL_VERSION,
                Uuid::new_v4(),
                &caller(10),
                CapabilitySet::REMOTE_DESKTOP,
                now
            ),
            Err(BrokerError::CapabilityUnavailable)
        );
    }

    #[test]
    fn a_dead_bound_process_can_be_revoked_without_releasing_other_leases() {
        let now = Instant::now();
        let mut core = ready_core(now);
        core.acquire(
            NATIVE_PROTOCOL_VERSION,
            Uuid::new_v4(),
            &caller(10),
            CapabilitySet::REMOTE_DESKTOP,
            now,
        )
        .unwrap();
        core.expire(now + LEASE_TTL);
        assert_eq!(core.active_lease_process_id(), Some(10));
        assert!(!core.revoke_lease_for_process(11));
        assert!(core.revoke_lease_for_process(10));
        assert_eq!(core.active_lease_process_id(), None);
    }

    #[test]
    fn broker_wire_is_bounded() {
        let response = BrokerResponse::Rejected {
            code: BrokerErrorCode::CallerDenied,
            retry_after_ms: None,
        };
        let encoded = encode_bounded(&response).unwrap();
        assert!(encoded.len() <= MAX_BROKER_MESSAGE_BYTES);
        assert_eq!(
            decode_bounded::<BrokerResponse>(&encoded[..encoded.len() - 1]).unwrap(),
            response
        );
        assert_eq!(
            decode_bounded::<BrokerRequest>(&vec![b'x'; MAX_BROKER_MESSAGE_BYTES + 1]),
            Err(BrokerErrorCode::InvalidMessage)
        );
    }
}
