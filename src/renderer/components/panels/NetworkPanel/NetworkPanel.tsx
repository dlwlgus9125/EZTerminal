/**
 * NetworkPanel — T9 implementation.
 * Displays network traffic (rx/tx), connection table, and optional capture area.
 * Uses useVisibilityLifecycle to start/stop network:start/stop IPC.
 * Shows "Npcap required" fallback in capture area when Npcap is unavailable.
 */

import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { ConnectionInfo, TrafficData } from "../../../../shared/network-types";
import { useVisibilityLifecycle } from "../../../hooks/useVisibilityLifecycle";
import styles from "./NetworkPanel.module.css";

interface NetworkPanelProps {
  isVisible: boolean;
  /** Whether Npcap is available (injected from main via preload or prop) */
  npcapAvailable?: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB/s`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB/s`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB/s`;
  }
  return `${bytes.toFixed(0)} B/s`;
}

export function NetworkPanel({
  isVisible,
  npcapAvailable = false,
}: NetworkPanelProps): ReactElement {
  const [traffic, setTraffic] = useState<TrafficData | null>(null);
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const unsubRef = useRef<(() => void) | null>(null);

  useVisibilityLifecycle({
    isVisible,
    onStart() {
      window.electronAPI.network.startCapture();
      unsubRef.current = window.electronAPI.network.onTraffic((data) => {
        setTraffic(data);
      });
    },
    onStop() {
      window.electronAPI.network.stopCapture();
      unsubRef.current?.();
      unsubRef.current = null;
    },
  });

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      unsubRef.current?.();
      unsubRef.current = null;
    };
  }, []);

  return (
    <div className={styles.panel} data-testid="network-panel">
      <h2 className={styles.title}>Network</h2>

      {/* Traffic section */}
      <section className={styles.section} data-testid="traffic-section">
        <h3 className={styles.sectionTitle}>Traffic</h3>
        <div className={styles.row}>
          <span className={styles.label}>RX</span>
          <span className={styles.value} data-metric="rx">
            {traffic !== null ? formatBytes(traffic.rxBytesPerSec) : "--"}
          </span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>TX</span>
          <span className={styles.value} data-metric="tx">
            {traffic !== null ? formatBytes(traffic.txBytesPerSec) : "--"}
          </span>
        </div>
        {traffic !== null && (
          <div className={styles.row}>
            <span className={styles.label}>Interface</span>
            <span className={styles.value} data-metric="interface">
              {traffic.interface || "unknown"}
            </span>
          </div>
        )}
      </section>

      {/* Connection table */}
      <section className={styles.section} data-testid="connections-section">
        <h3 className={styles.sectionTitle}>Connections</h3>
        {connections.length === 0 ? (
          <div className={styles.empty} data-testid="connections-empty">
            No active connections
          </div>
        ) : (
          <div className={styles.tableWrapper}>
            <table className={styles.table} data-testid="connections-table">
              <thead>
                <tr>
                  <th>Protocol</th>
                  <th>Local</th>
                  <th>Remote</th>
                  <th>State</th>
                  <th>PID</th>
                </tr>
              </thead>
              <tbody>
                {connections.map((conn, idx) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: stable list from SI
                  <tr key={idx}>
                    <td>{conn.protocol}</td>
                    <td>{`${conn.localAddress}:${conn.localPort}`}</td>
                    <td>{`${conn.remoteAddress}:${conn.remotePort}`}</td>
                    <td>{conn.state}</td>
                    <td>{conn.pid}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Capture area */}
      <section className={styles.section} data-testid="capture-section">
        <h3 className={styles.sectionTitle}>Packet Capture</h3>
        {npcapAvailable ? (
          <div className={styles.captureActive} data-testid="capture-active">
            Capturing packets...
          </div>
        ) : (
          <div className={styles.npcapFallback} data-testid="npcap-fallback">
            <span>Npcap required for packet capture.</span>
            <a
              href="https://npcap.com/#download"
              target="_blank"
              rel="noreferrer"
              className={styles.npcapLink}
              data-testid="npcap-install-link"
            >
              Install Npcap
            </a>
          </div>
        )}
      </section>
    </div>
  );
}
