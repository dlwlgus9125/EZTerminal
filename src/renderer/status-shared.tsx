/**
 * Stats-overlay helpers shared between the desktop `StatusPanel.tsx` (a 300px
 * drawer docked beside dockview) and the mobile `MobileStatsView.tsx`
 * (mobile remote-control plan, M2) — extracted verbatim out of
 * `StatusPanel.tsx` so both can render the identical CPU/MEM/NET history
 * math and sparkline widget without duplicating it.
 */
import type { SystemStatsSnapshot } from '../shared/ipc';

// 60-second in-renderer history buffer for the CPU/MEM sparklines — seeded once
// from `getStatsHistory` on mount, then extended by the 1Hz `onStatsUpdate` push
// (status-overlay-panel rev6 T3). No chart library: sparklines are hand-rolled
// inline SVG polylines.
export const HISTORY_MAX = 60;

// Packet preview sub-view (status-panel-v2 Phase 2B) — off by default, header-only.
/** Oldest rows are dropped once the preview holds this many. */
export const PACKET_ROW_CAP = 200;

export function formatPacketTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Append `snapshot` only if its `at` is newer than the last known sample, then
 * trim to the last `HISTORY_MAX` entries — guards against duplicate/out-of-order
 * pushes without needing a full re-sort. */
export function mergeSnapshot(
  history: SystemStatsSnapshot[],
  snapshot: SystemStatsSnapshot,
): SystemStatsSnapshot[] {
  const last = history[history.length - 1];
  if (last && snapshot.at <= last.at) return history;
  const next = [...history, snapshot];
  return next.length > HISTORY_MAX ? next.slice(next.length - HISTORY_MAX) : next;
}

export function formatBytes(bytes: number): string {
  const gb = bytes / 1073741824;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1048576).toFixed(0)} MB`;
}

export function formatRate(bytesPerSec: number): string {
  const mb = bytesPerSec / 1048576;
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
  return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
}

interface SparklineProps {
  readonly values: readonly number[];
  /** Fixed scale ceiling (e.g. 100 for a percentage series). */
  readonly max: number;
}

/** A minimal inline SVG polyline sparkline — deliberately no chart library. */
export function Sparkline({ values, max }: SparklineProps): JSX.Element {
  const width = 100;
  const height = 24;
  const points = values
    .map((v, i) => {
      const x = values.length > 1 ? (i / (values.length - 1)) * width : width;
      const y = height - (Math.min(v, max) / max) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function polylinePoints(
  values: readonly number[],
  max: number,
  width: number,
  height: number,
): string {
  return values
    .map((value, index) => {
      const x = values.length > 1 ? (index / (values.length - 1)) * width : width;
      const y = height - (Math.min(value, max) / max) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

interface ScopeProps {
  readonly cpu: readonly number[];
  readonly mem: readonly number[];
}

/**
 * CPU and memory on one oscilloscope trace rather than two stacked sparklines.
 * They share a time axis, so overlaying them is what makes "memory climbed while
 * the CPU was idle" legible at a glance. CPU takes the heavier, glowing stroke
 * because it is the series that moves; memory rides underneath as a reference.
 */
export function Scope({ cpu, mem }: ScopeProps): JSX.Element {
  const width = 320;
  const height = 96;
  return (
    <div className="status-scope">
      <svg
        className="status-scope-trace"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <polyline
          className="status-scope-mem"
          points={polylinePoints(mem, 100, width, height)}
          fill="none"
          strokeWidth="1.5"
        />
        <polyline
          className="status-scope-cpu"
          points={polylinePoints(cpu, 100, width, height)}
          fill="none"
          strokeWidth="2"
        />
      </svg>
      <i className="status-scope-sweep" aria-hidden="true" />
    </div>
  );
}
