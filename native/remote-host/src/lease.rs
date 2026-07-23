use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const RESUME_GRACE: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerIdentity {
    pub client_id: Uuid,
    pub client_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LeaseDecision {
    Granted { session_id: Uuid },
    Resumed { session_id: Uuid },
    Busy { controller_name: String },
}

#[derive(Debug, Clone)]
struct Lease {
    session_id: Uuid,
    controller: ControllerIdentity,
    disconnected_at: Option<Instant>,
}

#[derive(Debug, Default)]
pub struct LeaseManager {
    active: Option<Lease>,
}

impl LeaseManager {
    pub fn acquire(&mut self, controller: ControllerIdentity, now: Instant) -> LeaseDecision {
        self.expire(now);
        match self.active.as_mut() {
            None => {
                let session_id = Uuid::new_v4();
                self.active = Some(Lease {
                    session_id,
                    controller,
                    disconnected_at: None,
                });
                LeaseDecision::Granted { session_id }
            }
            Some(lease) if lease.controller.client_id == controller.client_id => {
                lease.controller.client_name = controller.client_name;
                lease.disconnected_at = None;
                LeaseDecision::Resumed {
                    session_id: lease.session_id,
                }
            }
            Some(lease) => LeaseDecision::Busy {
                controller_name: lease.controller.client_name.clone(),
            },
        }
    }

    pub fn mark_disconnected(&mut self, session_id: Uuid, now: Instant) -> bool {
        let Some(lease) = self.active.as_mut() else {
            return false;
        };
        if lease.session_id != session_id {
            return false;
        }
        lease.disconnected_at = Some(now);
        true
    }

    pub fn release(&mut self, session_id: Uuid) -> bool {
        if self
            .active
            .as_ref()
            .is_some_and(|lease| lease.session_id == session_id)
        {
            self.active = None;
            true
        } else {
            false
        }
    }

    pub fn expire(&mut self, now: Instant) -> Option<Uuid> {
        let expired = self.active.as_ref().is_some_and(|lease| {
            lease
                .disconnected_at
                .is_some_and(|at| now.saturating_duration_since(at) >= RESUME_GRACE)
        });
        if expired {
            self.active.take().map(|lease| lease.session_id)
        } else {
            None
        }
    }

    pub fn active_controller(&self) -> Option<&ControllerIdentity> {
        self.active.as_ref().map(|lease| &lease.controller)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn controller(id: u128, name: &str) -> ControllerIdentity {
        ControllerIdentity {
            client_id: Uuid::from_u128(id),
            client_name: name.into(),
        }
    }

    #[test]
    fn only_one_controller_is_granted() {
        let now = Instant::now();
        let mut manager = LeaseManager::default();
        let first = manager.acquire(controller(1, "Phone A"), now);
        assert!(matches!(first, LeaseDecision::Granted { .. }));
        assert_eq!(
            manager.acquire(controller(2, "Phone B"), now),
            LeaseDecision::Busy {
                controller_name: "Phone A".into()
            }
        );
    }

    #[test]
    fn same_client_resumes_within_grace_and_other_client_wins_after_expiry() {
        let now = Instant::now();
        let mut manager = LeaseManager::default();
        let session_id = match manager.acquire(controller(1, "Phone A"), now) {
            LeaseDecision::Granted { session_id } => session_id,
            other => panic!("unexpected decision: {other:?}"),
        };
        assert!(manager.mark_disconnected(session_id, now));
        assert_eq!(
            manager.acquire(
                controller(1, "Renamed Phone"),
                now + Duration::from_secs(14)
            ),
            LeaseDecision::Resumed { session_id }
        );
        assert!(manager.mark_disconnected(session_id, now + Duration::from_secs(14)));
        assert!(matches!(
            manager.acquire(controller(2, "Phone B"), now + Duration::from_secs(30)),
            LeaseDecision::Granted { .. }
        ));
    }

    #[test]
    fn explicit_release_has_no_grace() {
        let now = Instant::now();
        let mut manager = LeaseManager::default();
        let session_id = match manager.acquire(controller(1, "Phone A"), now) {
            LeaseDecision::Granted { session_id } => session_id,
            other => panic!("unexpected decision: {other:?}"),
        };
        assert!(manager.release(session_id));
        assert!(matches!(
            manager.acquire(controller(2, "Phone B"), now),
            LeaseDecision::Granted { .. }
        ));
    }
}
