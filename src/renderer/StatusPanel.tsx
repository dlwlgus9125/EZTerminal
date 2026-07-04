import { useCallback, useEffect, useState } from 'react';

import type { PacketCaptureFrame, PacketCaptureStatus, PacketRow, SystemStatsSnapshot } from '../shared/ipc';

// 60-second in-renderer history buffer for the CPU/MEM sparklines — seeded once
// from `getStatsHistory` on mount, then extended by the 1Hz `onStatsUpdate` push
// (status-overlay-panel rev6 T3). No chart library: sparklines are hand-rolled
// inline SVG polylines.
const HISTORY_MAX = 60;

// Packet preview sub-view (status-panel-v2 Phase 2B) — off by default, header-only.
/** Oldest rows are dropped once the preview holds this many. */
const PACKET_ROW_CAP = 200;
/** One-time local acknowledgement that packet metadata will be shown — never the packet data itself. */
const PACKET_ACK_KEY = 'ezterminal.packetAckSeen';

function formatPacketTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Append `snapshot` only if its `at` is newer than the last known sample, then
 * trim to the last `HISTORY_MAX` entries — guards against duplicate/out-of-order
 * pushes without needing a full re-sort. */
function mergeSnapshot(
  history: SystemStatsSnapshot[],
  snapshot: SystemStatsSnapshot,
): SystemStatsSnapshot[] {
  const last = history[history.length - 1];
  if (last && snapshot.at <= last.at) return history;
  const next = [...history, snapshot];
  return next.length > HISTORY_MAX ? next.slice(next.length - HISTORY_MAX) : next;
}

function formatBytes(bytes: number): string {
  const gb = bytes / 1073741824;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1048576).toFixed(0)} MB`;
}

function formatRate(bytesPerSec: number): string {
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
function Sparkline({ values, max }: SparklineProps): JSX.Element {
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

/** 300px overlay drawer: CPU/MEM (always-on sparklines) + NET/DISK/PROC (populated
 * only while the panel is visible — main gates their collection accordingly, so
 * those fields read null here until the panel-open-only collectors report in). */
export function StatusPanel(): JSX.Element {
  const [history, setHistory] = useState<SystemStatsSnapshot[]>([]);

  useEffect(() => {
    let alive = true;
    void window.ezterminal.getStatsHistory().then((seed) => {
      if (!alive) return;
      setHistory((current) => (current.length === 0 ? seed.slice(-HISTORY_MAX) : current));
    });
    const unsubscribe = window.ezterminal.onStatsUpdate((snapshot) => {
      setHistory((current) => mergeSnapshot(current, snapshot));
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  // Packet preview sub-view: off by default, explicit opt-in each session.
  const [packetOpen, setPacketOpen] = useState(false);
  const [packetAckPending, setPacketAckPending] = useState(false);
  const [packetRows, setPacketRows] = useState<PacketRow[]>([]);
  const [packetStatus, setPacketStatus] = useState<PacketCaptureStatus | null>(null);
  const packetCapturing = packetOpen && !packetAckPending;

  const handlePacketToggle = useCallback(() => {
    setPacketOpen((current) => {
      const next = !current;
      setPacketAckPending(next && localStorage.getItem(PACKET_ACK_KEY) !== '1');
      return next;
    });
  }, []);

  const handlePacketAckConfirm = useCallback(() => {
    localStorage.setItem(PACKET_ACK_KEY, '1');
    setPacketAckPending(false);
  }, []);

  // Subscribes only while the sub-view is open AND acknowledged. Batches arrive
  // over a dedicated MessagePort (never main-relayed — same cmd-port-style
  // window-message handoff preload already does, see preload.ts `packet-port`).
  // rAF-coalesced: multiple batches within one frame merge into a single
  // setState, never one setState per batch.
  useEffect(() => {
    if (!packetCapturing) return;
    setPacketStatus(null);
    setPacketRows([]);

    let alive = true;
    let port: MessagePort | null = null;
    let pending: PacketRow[] = [];
    let rafId: number | null = null;

    const flush = (): void => {
      rafId = null;
      if (!alive || pending.length === 0) return;
      const drained = pending;
      pending = [];
      setPacketRows((current) => {
        const next = current.concat(drained);
        return next.length > PACKET_ROW_CAP ? next.slice(next.length - PACKET_ROW_CAP) : next;
      });
    };

    const onPortMessage = (event: MessageEvent<PacketCaptureFrame>): void => {
      const frame = event.data;
      if (frame.type === 'packets') {
        pending.push(...frame.rows);
        if (rafId === null) rafId = requestAnimationFrame(flush);
      } else {
        setPacketStatus(frame.status);
      }
    };

    // Same-window-origin guard as the cmd-port receiver (TerminalPane.tsx) — never
    // trust a port transfer from a foreign frame (SEC-LOW-5).
    const onWindowMessage = (event: MessageEvent): void => {
      if (event.source !== window && event.origin !== window.location.origin) return;
      if (!event.data || event.data._ezPacketPort !== true) return;
      const p = event.ports[0];
      if (!p) return;
      port = p;
      port.addEventListener('message', onPortMessage);
      port.start();
    };

    window.addEventListener('message', onWindowMessage);
    window.ezterminal.subscribePackets();

    return () => {
      alive = false;
      window.removeEventListener('message', onWindowMessage);
      if (rafId !== null) cancelAnimationFrame(rafId);
      port?.close();
      window.ezterminal.unsubscribePackets();
    };
  }, [packetCapturing]);

  const latest = history[history.length - 1] ?? null;
  const cpuValues = history.map((s) => s.cpu.loadPct);
  const memValues = history.map((s) => (s.mem.usedBytes / s.mem.totalBytes) * 100);

  // Only the snapshots where NET has already reported (panel-open + past warmup)
  // feed the rate sparklines — matches the panel-open-only null gating elsewhere.
  const netRxValues: number[] = [];
  const netTxValues: number[] = [];
  for (const s of history) {
    if (s.net) {
      netRxValues.push(s.net.rxSec);
      netTxValues.push(s.net.txSec);
    }
  }
  const netMax = Math.max(1, ...netRxValues, ...netTxValues);

  return (
    <div className="status-drawer" data-testid="status-panel">
      <section className="status-section" data-testid="status-section-cpu">
        <h2 className="status-section-title">CPU</h2>
        {latest ? (
          <>
            <div className="status-metric">{latest.cpu.loadPct.toFixed(0)}%</div>
            <Sparkline values={cpuValues} max={100} />
            {latest.cpu.cores.length > 0 && (
              <div
                className={
                  latest.cpu.cores.length > 16
                    ? 'status-core-grid status-core-grid--compact'
                    : 'status-core-grid'
                }
                data-testid="status-cpu-cores"
              >
                {latest.cpu.cores.map((load, i) => {
                  const compact = latest.cpu.cores.length > 16;
                  return (
                    <div key={i} className="status-core-row">
                      {!compact && (
                        <div className="status-core-label">
                          <span>C{i}</span>
                          <span>{load.toFixed(0)}%</span>
                        </div>
                      )}
                      <div className="status-disk-bar">
                        <div
                          className="status-disk-bar-fill"
                          style={{ width: `${Math.min(100, Math.max(0, load))}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          <div className="status-loading">측정 중…</div>
        )}
      </section>

      <section className="status-section" data-testid="status-section-mem">
        <h2 className="status-section-title">MEM</h2>
        {latest ? (
          <>
            <div className="status-metric">
              {formatBytes(latest.mem.usedBytes)} / {formatBytes(latest.mem.totalBytes)}
            </div>
            <Sparkline values={memValues} max={100} />
            {latest.memDetail && (
              <div className="status-mem-detail" data-testid="status-mem-detail">
                <div className="status-disk-row">
                  <div className="status-disk-label">
                    <span>Used</span>
                    <span>{formatBytes(latest.mem.usedBytes)}</span>
                  </div>
                  <div className="status-disk-bar">
                    <div
                      className="status-disk-bar-fill"
                      style={{
                        width: `${Math.min(100, (latest.mem.usedBytes / latest.mem.totalBytes) * 100)}%`,
                      }}
                    />
                  </div>
                </div>
                <div className="status-disk-label">
                  <span>Available</span>
                  <span>{formatBytes(latest.memDetail.availableBytes)}</span>
                </div>
                <div className="status-disk-label">
                  <span>Cached</span>
                  <span>{formatBytes(latest.memDetail.cachedBytes)}</span>
                </div>
                <div className="status-disk-row">
                  <div className="status-disk-label">
                    <span>PageFile</span>
                    <span>
                      {formatBytes(latest.memDetail.swapUsedBytes)} /{' '}
                      {formatBytes(latest.memDetail.swapTotalBytes)}
                    </span>
                  </div>
                  <div className="status-disk-bar">
                    <div
                      className="status-disk-bar-fill"
                      style={{
                        width: `${
                          latest.memDetail.swapTotalBytes > 0
                            ? Math.min(
                                100,
                                (latest.memDetail.swapUsedBytes / latest.memDetail.swapTotalBytes) * 100,
                              )
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="status-loading">측정 중…</div>
        )}
      </section>

      <section className="status-section" data-testid="status-section-net">
        <h2 className="status-section-title">NET</h2>
        {latest?.net ? (
          <>
            <div className="status-metric">
              {latest.net.iface} &nbsp;↓{formatRate(latest.net.rxSec)} ↑{formatRate(latest.net.txSec)}
            </div>
            <div className="status-net-sparks" data-testid="status-net-sparks">
              <Sparkline values={netRxValues} max={netMax} />
              <Sparkline values={netTxValues} max={netMax} />
            </div>
          </>
        ) : (
          <div className="status-loading">측정 중…</div>
        )}
        <button
          type="button"
          className="btn status-packet-toggle"
          data-testid="status-packet-toggle"
          aria-pressed={packetOpen}
          onClick={handlePacketToggle}
        >
          패킷 {packetOpen ? '끄기' : '보기'}
        </button>
        {packetOpen && (
          <div className="status-packet-view" data-testid="status-packet-view">
            {packetAckPending ? (
              <div className="status-packet-ack">
                <p>
                  패킷 프리뷰는 로컬 네트워크 트래픽의 메타데이터(시각·주소·포트·프로토콜·크기)만
                  표시합니다. 내용(페이로드)은 표시되거나 저장되지 않습니다.
                </p>
                <button
                  type="button"
                  className="btn"
                  data-testid="status-packet-ack-confirm"
                  onClick={handlePacketAckConfirm}
                >
                  확인
                </button>
              </div>
            ) : (
              <>
                {packetStatus === 'npcap-missing' && (
                  <div className="status-packet-status">
                    Npcap 필요 —{' '}
                    <a href="https://npcap.com" target="_blank" rel="noreferrer">
                      npcap.com
                    </a>
                  </div>
                )}
                {packetStatus === 'access-denied' && (
                  <div className="status-packet-status">관리자 권한으로 실행해야 캡처할 수 있습니다.</div>
                )}
                {packetStatus === 'error' && (
                  <div className="status-packet-status">패킷 캡처 오류가 발생했습니다.</div>
                )}
                {(packetStatus === null || packetStatus === 'capturing') &&
                  packetRows.length === 0 && (
                    <div className="status-loading">
                      {packetStatus === 'capturing' ? '캡처 중…' : '연결 중…'}
                    </div>
                  )}
                {packetRows.length > 0 && (
                  <table className="status-proc-table">
                    <thead>
                      <tr>
                        <th>시각</th>
                        <th>src→dst</th>
                        <th>프로토콜</th>
                        <th>길이</th>
                      </tr>
                    </thead>
                    <tbody>
                      {packetRows.map((r, i) => (
                        <tr key={`${r.at}-${i}`}>
                          <td>{formatPacketTime(r.at)}</td>
                          <td>
                            {r.src} → {r.dst}
                          </td>
                          <td>{r.proto}</td>
                          <td>{r.len}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            )}
          </div>
        )}
      </section>

      <section className="status-section" data-testid="status-section-conns">
        <h2 className="status-section-title">연결</h2>
        {latest?.conns ? (
          <table className="status-proc-table">
            <thead>
              <tr>
                <th>프로세스</th>
                <th>프로토콜</th>
                <th>로컬→피어</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {latest.conns.map((c, i) => (
                <tr key={`${c.local}-${c.peer}-${i}`}>
                  <td>{c.process}</td>
                  <td>{c.proto}</td>
                  <td>
                    {c.local} → {c.peer}
                  </td>
                  <td>{c.state}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="status-loading">측정 중…</div>
        )}
      </section>

      <section className="status-section" data-testid="status-section-disk">
        <h2 className="status-section-title">DISK</h2>
        {latest?.disks ? (
          <div className="status-disk-list">
            {latest.disks.map((d) => {
              const pct = d.sizeBytes > 0 ? (d.usedBytes / d.sizeBytes) * 100 : 0;
              return (
                <div key={d.mount} className="status-disk-row">
                  <div className="status-disk-label">
                    <span>{d.mount}</span>
                    <span>{pct.toFixed(0)}%</span>
                  </div>
                  <div className="status-disk-bar">
                    <div
                      className="status-disk-bar-fill"
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="status-loading">측정 중…</div>
        )}
      </section>

      <section className="status-section" data-testid="status-section-proc">
        <h2 className="status-section-title">PROC</h2>
        {latest?.procs ? (
          <table className="status-proc-table">
            <thead>
              <tr>
                <th>이름</th>
                <th>CPU%</th>
                <th>MEM</th>
              </tr>
            </thead>
            <tbody>
              {latest.procs.map((p) => (
                <tr key={p.pid}>
                  <td>{p.name}</td>
                  <td>{p.cpuPct.toFixed(1)}</td>
                  <td>{formatBytes(p.memBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="status-loading">측정 중…</div>
        )}
      </section>
    </div>
  );
}
