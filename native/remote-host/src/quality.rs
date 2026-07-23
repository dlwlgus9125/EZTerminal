use serde::{Deserialize, Serialize};

use crate::protocol::QualityTier;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSample {
    pub round_trip_time_ms: u32,
    pub packet_loss_percent: f32,
    pub send_backlog_ms: u32,
}

#[derive(Debug, Clone)]
pub struct QualityController {
    tier: QualityTier,
    stable_samples: u8,
}

impl Default for QualityController {
    fn default() -> Self {
        Self {
            tier: QualityTier::High,
            stable_samples: 0,
        }
    }
}

impl QualityController {
    pub fn tier(&self) -> QualityTier {
        self.tier
    }

    pub fn observe(&mut self, sample: NetworkSample) -> QualityTier {
        let severe = sample.packet_loss_percent >= 8.0
            || sample.send_backlog_ms >= 350
            || sample.round_trip_time_ms >= 350;
        let degraded = sample.packet_loss_percent >= 3.0
            || sample.send_backlog_ms >= 150
            || sample.round_trip_time_ms >= 220;

        if severe || degraded {
            self.stable_samples = 0;
            self.tier = if severe {
                downgrade(self.tier, 2)
            } else {
                downgrade(self.tier, 1)
            };
            return self.tier;
        }

        self.stable_samples = self.stable_samples.saturating_add(1);
        if self.stable_samples >= 5 {
            self.tier = upgrade(self.tier);
            self.stable_samples = 0;
        }
        self.tier
    }
}

fn downgrade(tier: QualityTier, steps: usize) -> QualityTier {
    let index = tier_index(tier).saturating_add(steps).min(3);
    tier_at(index)
}

fn upgrade(tier: QualityTier) -> QualityTier {
    tier_at(tier_index(tier).saturating_sub(1))
}

fn tier_index(tier: QualityTier) -> usize {
    match tier {
        QualityTier::High => 0,
        QualityTier::Medium => 1,
        QualityTier::Low => 2,
        QualityTier::Survival => 3,
    }
}

fn tier_at(index: usize) -> QualityTier {
    match index {
        0 => QualityTier::High,
        1 => QualityTier::Medium,
        2 => QualityTier::Low,
        _ => QualityTier::Survival,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn degrades_fast_and_upgrades_only_after_ten_stable_seconds() {
        let mut controller = QualityController::default();
        assert_eq!(
            controller.observe(NetworkSample {
                round_trip_time_ms: 80,
                packet_loss_percent: 9.0,
                send_backlog_ms: 0,
            }),
            QualityTier::Low
        );
        let stable = NetworkSample {
            round_trip_time_ms: 80,
            packet_loss_percent: 0.2,
            send_backlog_ms: 10,
        };
        for _ in 0..4 {
            assert_eq!(controller.observe(stable), QualityTier::Low);
        }
        assert_eq!(controller.observe(stable), QualityTier::Medium);
    }
}
