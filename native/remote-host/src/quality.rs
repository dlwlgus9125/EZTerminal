use serde::{Deserialize, Serialize};

use crate::protocol::QualityTier;

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSample {
    pub round_trip_time_ms: u32,
    pub packet_loss_percent: f32,
    pub send_backlog_ms: u32,
    pub pipeline_utilization_percent: f32,
    pub client_dropped_frame_percent: f32,
    pub client_decoded_frames_per_second: f32,
    pub client_target_frames_per_second: f32,
    pub client_freeze_duration_ms: u32,
    pub client_video_stats_seen: bool,
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
        let decode_ratio =
            if sample.client_video_stats_seen && sample.client_target_frames_per_second > 0.0 {
                sample.client_decoded_frames_per_second / sample.client_target_frames_per_second
            } else {
                1.0
            };
        let severe = sample.packet_loss_percent >= 8.0
            || sample.send_backlog_ms >= 350
            || sample.round_trip_time_ms >= 350
            || sample.pipeline_utilization_percent >= 120.0
            || sample.client_dropped_frame_percent >= 12.0
            || (sample.client_video_stats_seen
                && (decode_ratio < 0.6 || sample.client_freeze_duration_ms >= 500));
        let degraded = sample.packet_loss_percent >= 3.0
            || sample.send_backlog_ms >= 150
            || sample.round_trip_time_ms >= 220
            || sample.pipeline_utilization_percent >= 90.0
            || sample.client_dropped_frame_percent >= 5.0
            || (sample.client_video_stats_seen
                && (decode_ratio < 0.8 || sample.client_freeze_duration_ms >= 250));

        if severe || degraded {
            self.stable_samples = 0;
            self.tier = if severe {
                downgrade(self.tier, 2)
            } else {
                downgrade(self.tier, 1)
            };
            return self.tier;
        }

        let stable = sample.pipeline_utilization_percent < 70.0
            && sample.client_dropped_frame_percent < 2.0
            && (!sample.client_video_stats_seen
                || (decode_ratio >= 0.95 && sample.client_freeze_duration_ms < 250));
        if !stable {
            self.stable_samples = 0;
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
                pipeline_utilization_percent: 20.0,
                client_dropped_frame_percent: 0.0,
                ..Default::default()
            }),
            QualityTier::Low
        );
        let stable = NetworkSample {
            round_trip_time_ms: 80,
            packet_loss_percent: 0.2,
            send_backlog_ms: 10,
            pipeline_utilization_percent: 20.0,
            client_dropped_frame_percent: 0.0,
            ..Default::default()
        };
        for _ in 0..4 {
            assert_eq!(controller.observe(stable), QualityTier::Low);
        }
        assert_eq!(controller.observe(stable), QualityTier::Medium);
    }

    #[test]
    fn pipeline_pressure_degrades_and_blocks_premature_upgrade() {
        let mut controller = QualityController::default();
        let overloaded = NetworkSample {
            round_trip_time_ms: 20,
            packet_loss_percent: 0.0,
            send_backlog_ms: 0,
            pipeline_utilization_percent: 125.0,
            client_dropped_frame_percent: 0.0,
            ..Default::default()
        };
        assert_eq!(controller.observe(overloaded), QualityTier::Low);
        let busy = NetworkSample {
            pipeline_utilization_percent: 75.0,
            ..overloaded
        };
        for _ in 0..8 {
            assert_eq!(controller.observe(busy), QualityTier::Low);
        }
    }

    #[test]
    fn client_decode_pressure_drives_the_same_bounded_quality_ladder() {
        let mut controller = QualityController::default();
        let frozen = NetworkSample {
            round_trip_time_ms: 20,
            packet_loss_percent: 0.0,
            pipeline_utilization_percent: 20.0,
            client_decoded_frames_per_second: 10.0,
            client_target_frames_per_second: 30.0,
            client_freeze_duration_ms: 600,
            client_video_stats_seen: true,
            ..Default::default()
        };
        assert_eq!(controller.observe(frozen), QualityTier::Low);

        let recovered = NetworkSample {
            client_decoded_frames_per_second: 30.0,
            client_freeze_duration_ms: 0,
            ..frozen
        };
        for _ in 0..4 {
            assert_eq!(controller.observe(recovered), QualityTier::Low);
        }
        assert_eq!(controller.observe(recovered), QualityTier::Medium);
    }
}
