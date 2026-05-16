/**
 * StatusPanel — T8 implementation.
 * Renders CPU/memory/disk metrics pushed from main via IPC.
 * Uses useVisibilityLifecycle to start/stop metrics:start/stop.
 */

import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { MetricsData } from "../../../../shared/metrics-types";
import { useVisibilityLifecycle } from "../../../hooks/useVisibilityLifecycle";
import styles from "./StatusPanel.module.css";

interface StatusPanelProps {
  isVisible: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function StatusPanel({ isVisible }: StatusPanelProps): ReactElement {
  const [metrics, setMetrics] = useState<MetricsData | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  useVisibilityLifecycle({
    isVisible,
    onStart() {
      window.electronAPI.metrics.start();
      unsubRef.current = window.electronAPI.metrics.onUpdate((data) => {
        setMetrics(data);
      });
    },
    onStop() {
      window.electronAPI.metrics.stop();
      unsubRef.current?.();
      unsubRef.current = null;
    },
  });

  // Cleanup on unmount (useVisibilityLifecycle already calls onStop, but guard for safety)
  useEffect(() => {
    return () => {
      unsubRef.current?.();
      unsubRef.current = null;
    };
  }, []);

  return (
    <div className={styles.panel} data-testid="status-panel">
      <h2 className={styles.title}>System Status</h2>

      <section className={styles.section} data-testid="cpu-section">
        <h3 className={styles.sectionTitle}>CPU</h3>
        <div className={styles.row}>
          <span className={styles.label}>Usage</span>
          <span className={styles.value} data-metric="cpu-usage">
            {metrics !== null ? `${metrics.cpu.usage.toFixed(1)}%` : "--"}
          </span>
        </div>
      </section>

      <section className={styles.section} data-testid="memory-section">
        <h3 className={styles.sectionTitle}>Memory</h3>
        <div className={styles.row}>
          <span className={styles.label}>Used</span>
          <span className={styles.value} data-metric="mem-used">
            {metrics !== null ? formatBytes(metrics.memory.used) : "--"}
          </span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>Total</span>
          <span className={styles.value} data-metric="mem-total">
            {metrics !== null ? formatBytes(metrics.memory.total) : "--"}
          </span>
        </div>
      </section>

      <section className={styles.section} data-testid="disk-section">
        <h3 className={styles.sectionTitle}>Disk</h3>
        <div className={styles.row}>
          <span className={styles.label}>Read</span>
          <span className={styles.value} data-metric="disk-read">
            {metrics !== null ? `${formatBytes(metrics.disk.readBytesPerSec)}/s` : "--"}
          </span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>Write</span>
          <span className={styles.value} data-metric="disk-write">
            {metrics !== null ? `${formatBytes(metrics.disk.writeBytesPerSec)}/s` : "--"}
          </span>
        </div>
      </section>
    </div>
  );
}
