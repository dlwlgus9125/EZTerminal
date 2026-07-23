import { useCallback, useEffect, useMemo, useState } from 'react';

import type { PacketCaptureFrame, PacketCaptureStatus, PacketRow, SystemStatsSnapshot } from '../shared/ipc';
import { rendererCapabilities, type CapabilityAccess } from './capability-access';
import {
  HISTORY_MAX,
  PACKET_ROW_CAP,
  Sparkline,
  formatBytes,
  formatRate,
  mergeSnapshot,
} from './status-shared';
import { useAppTranslation } from './i18n';

/** One-time local acknowledgement that packet metadata will be shown — never the packet data itself. */
const PACKET_ACK_KEY = 'ezterminal.packetAckSeen';

/** 300px overlay drawer: CPU/MEM (always-on sparklines) + NET/DISK/PROC (populated
 * only while the panel is visible — main gates their collection accordingly, so
 * those fields read null here until the panel-open-only collectors report in). */
export function StatusPanel({
  capabilities = rendererCapabilities,
}: { readonly capabilities?: CapabilityAccess }): JSX.Element {
  const { t, i18n } = useAppTranslation();
  const [history, setHistory] = useState<SystemStatsSnapshot[]>([]);
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const timeFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }),
    [locale],
  );

  useEffect(() => {
    return capabilities.systemStatus.observe({
      onSeed: (seed) => {
        setHistory((current) => (current.length === 0 ? seed.slice(-HISTORY_MAX) : current));
      },
      onSnapshot: (snapshot) => {
        setHistory((current) => mergeSnapshot(current, snapshot));
      },
    });
  }, [capabilities]);

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
    const closePort = (candidate: MessagePort | null | undefined): void => {
      if (!candidate) return;
      try {
        candidate.removeEventListener('message', onPortMessage);
      } catch {
        // A malformed or already-detached endpoint still gets a close attempt.
      }
      try {
        candidate.close();
      } catch {
        // Closing an already-closed transferred port is idempotent.
      }
    };

    const onWindowMessage = (event: MessageEvent): void => {
      if (!event.data || event.data._ezPacketPort !== true) return;
      const received = Array.from(event.ports ?? []);
      if (
        event.source !== window
        || event.origin !== window.location.origin
        || received.length !== 1
      ) {
        for (const candidate of received) closePort(candidate);
        return;
      }
      const nextPort = received[0]!;
      closePort(port);
      port = nextPort;
      port.addEventListener('message', onPortMessage);
      port.start();
    };

    window.addEventListener('message', onWindowMessage);
    const stopCapture = capabilities.systemStatus.capturePackets(() => {
      if (alive) setPacketStatus('error');
    });

    return () => {
      alive = false;
      window.removeEventListener('message', onWindowMessage);
      if (rafId !== null) cancelAnimationFrame(rafId);
      closePort(port);
      port = null;
      stopCapture();
    };
  }, [capabilities, packetCapturing]);

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
    <div
      className="status-drawer"
      data-testid="status-panel"
      role="region"
      aria-label={t('monitor.label')}
    >
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
          <div className="status-loading">{t('monitor.measuring')}</div>
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
                    <span>{t('monitor.used')}</span>
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
                  <span>{t('monitor.available')}</span>
                  <span>{formatBytes(latest.memDetail.availableBytes)}</span>
                </div>
                <div className="status-disk-label">
                  <span>{t('monitor.cached')}</span>
                  <span>{formatBytes(latest.memDetail.cachedBytes)}</span>
                </div>
                <div className="status-disk-row">
                  <div className="status-disk-label">
                    <span>{t('monitor.pageFile')}</span>
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
          <div className="status-loading">{t('monitor.measuring')}</div>
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
          <div className="status-loading">{t('monitor.measuring')}</div>
        )}
        <button
          type="button"
          className="btn status-packet-toggle"
          data-testid="status-packet-toggle"
          aria-pressed={packetOpen}
          onClick={handlePacketToggle}
        >
          {packetOpen ? t('monitor.hidePackets') : t('monitor.showPackets')}
        </button>
        {packetOpen && (
          <div className="status-packet-view" data-testid="status-packet-view">
            {packetAckPending ? (
              <div className="status-packet-ack">
                <p>{t('monitor.packetPrivacy')}</p>
                <button
                  type="button"
                  className="btn"
                  data-testid="status-packet-ack-confirm"
                  onClick={handlePacketAckConfirm}
                >
                  {t('common.confirm')}
                </button>
              </div>
            ) : (
              <>
                {packetStatus === 'npcap-missing' && (
                  <div className="status-packet-status">
                    {t('monitor.npcapRequired')}{' '}
                    <a href="https://npcap.com" target="_blank" rel="noreferrer">
                      npcap.com
                    </a>
                  </div>
                )}
                {packetStatus === 'access-denied' && (
                  <div className="status-packet-status">{t('monitor.adminRequired')}</div>
                )}
                {packetStatus === 'error' && (
                  <div className="status-packet-status">{t('monitor.packetCaptureError')}</div>
                )}
                {(packetStatus === null || packetStatus === 'capturing') &&
                  packetRows.length === 0 && (
                    <div className="status-loading">
                      {packetStatus === 'capturing'
                        ? t('monitor.capturing')
                        : t('monitor.connecting')}
                    </div>
                  )}
                {packetRows.length > 0 && (
                  <table className="status-proc-table" aria-label={t('monitor.packetTable')}>
                    <thead>
                      <tr>
                        <th>{t('monitor.time')}</th>
                        <th>{t('monitor.route')}</th>
                        <th>{t('monitor.protocol')}</th>
                        <th>{t('monitor.length')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {packetRows.map((r, i) => (
                        <tr key={`${r.at}-${i}`}>
                          <td>{timeFormatter.format(new Date(r.at))}</td>
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
        <h2 className="status-section-title">{t('monitor.connections')}</h2>
        {latest?.conns ? (
          <table className="status-proc-table" aria-label={t('monitor.connectionTable')}>
            <thead>
              <tr>
                <th>{t('monitor.process')}</th>
                <th>{t('monitor.protocol')}</th>
                <th>{t('monitor.localPeer')}</th>
                <th>{t('monitor.state')}</th>
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
          <div className="status-loading">{t('monitor.measuring')}</div>
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
          <div className="status-loading">{t('monitor.measuring')}</div>
        )}
      </section>

      <section className="status-section" data-testid="status-section-proc">
        <h2 className="status-section-title">PROC</h2>
        {latest?.procs ? (
          <table className="status-proc-table" aria-label={t('monitor.processTable')}>
            <thead>
              <tr>
                <th>{t('monitor.name')}</th>
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
          <div className="status-loading">{t('monitor.measuring')}</div>
        )}
      </section>
    </div>
  );
}
