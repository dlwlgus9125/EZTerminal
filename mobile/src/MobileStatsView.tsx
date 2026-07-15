import { X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import {
  HISTORY_MAX,
  PACKET_ROW_CAP,
  Sparkline,
  formatBytes,
  formatPacketTime,
  formatRate,
  mergeSnapshot,
} from '../../src/renderer/status-shared';
import type { PacketRow, SystemStatsSnapshot } from '../../src/shared/ipc';
import type { RemotePacketFrame, RemotePacketStatus } from '../../src/shared/remote-protocol';
import { useAppTranslation } from '../../src/renderer/i18n';
import { Tab, TabList, TabPanel, Tabs } from '../../src/renderer/ui/Tabs';
import { e2eLog } from './e2e-telemetry';

type StatsTab = 'summary' | 'conns' | 'capture';

/** Same key + one-time gate as the desktop's `StatusPanel.tsx` — a user who
 * has already acknowledged the metadata-only notice on either surface won't
 * see it again on that same surface (separate localStorage per app/device). */
const PACKET_ACK_KEY = 'ezterminal.packetAckSeen';

// MobileStatsView — full-screen stats overlay (mobile remote-control plan,
// M2: first phone-visible stats wiring; M3: real 캡처 tab). NOT a straight
// port of the desktop's `StatusPanel.tsx` (that's a 300px drawer docked
// beside dockview) — this is a standalone tabbed view (요약|연결|캡처), but it
// reuses the shared `status-*` CSS classes from renderer/mobile-shared.css
// (loaded by mobile/src/main.tsx) so the CPU/MEM/NET/DISK/PROC
// markup renders exactly like the desktop panel. The 캡처 tab mirrors the
// desktop's packet sub-view (StatusPanel.tsx), adapted to be VIEW-ONLY: the
// desktop owns start/stop, so a `'idle'` status here means "no capture is
// running to view", not an error.
export function MobileStatsView({ onClose }: { onClose: () => void }): JSX.Element {
  const { t } = useAppTranslation();
  const [tab, setTab] = useState<StatsTab>('summary');
  const [history, setHistory] = useState<SystemStatsSnapshot[]>([]);

  useEffect(() => {
    let alive = true;
    window.ezterminal.setStatsPanelVisible(true);
    void window.ezterminal.getStatsHistory().then((seed) => {
      if (!alive) return;
      setHistory((current) => (current.length === 0 ? seed.slice(-HISTORY_MAX) : current));
    });
    const unsubscribe = window.ezterminal.onStatsUpdate((snapshot) => {
      if (!alive) return;
      setHistory((current) => mergeSnapshot(current, snapshot));
      // E2E-only marker for the logcat-driven Android parity harness.
      e2eLog(
        'stats:',
        'cpu=' + Math.round(snapshot.cpu.loadPct),
        'cores=' + snapshot.cpu.cores.length,
        'conns=' + (snapshot.conns ? snapshot.conns.length : 'null'),
      );
    });
    return () => {
      alive = false;
      unsubscribe();
      window.ezterminal.setStatsPanelVisible(false);
    };
  }, []);

  // 캡처 tab (M3): off until the tab is both selected AND acknowledged —
  // mirrors the desktop's packetCapturing gate (StatusPanel.tsx), just keyed
  // on tab selection instead of an open/close toggle.
  const [packetAckPending, setPacketAckPending] = useState(
    () => localStorage.getItem(PACKET_ACK_KEY) !== '1',
  );
  const [packetRows, setPacketRows] = useState<PacketRow[]>([]);
  const [packetStatus, setPacketStatus] = useState<RemotePacketStatus | null>(null);
  const packetActive = tab === 'capture' && !packetAckPending;

  const handlePacketAckConfirm = useCallback(() => {
    localStorage.setItem(PACKET_ACK_KEY, '1');
    setPacketAckPending(false);
  }, []);

  // Subscribes only while the capture tab is active AND acknowledged. Frames
  // arrive over a dedicated port (never main/bridge-relayed beyond the
  // hand-off — same `_ezPacketPort` window-message mechanics as
  // `ws-ezterminal.ts`'s `_ezPort` handoff for cmd ports). rAF-coalesced:
  // multiple batches within one frame merge into a single setState, never one
  // setState per batch (copied from the desktop's verified effect shape).
  useEffect(() => {
    if (!packetActive) return;
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
      // e2e marker: mobile/e2e greps logcat for this (no DOM access without Appium).
      e2eLog('packets:', 'rows=' + drained.length);
    };

    const onPortMessage = (event: MessageEvent<RemotePacketFrame>): void => {
      const frame = event.data;
      if (frame.type === 'packets') {
        pending.push(...frame.rows);
        if (rafId === null) rafId = requestAnimationFrame(flush);
      } else {
        setPacketStatus(frame.status);
        e2eLog('packets:', frame.status);
      }
    };

    // Same-window-origin guard as the cmd-port receiver (MobileSessionView.tsx's
    // `_ezPort` handler / the desktop's StatusPanel.tsx) — never trust a port
    // transfer from a foreign frame (SEC-LOW-5).
    const onWindowMessage = (event: MessageEvent): void => {
      if (event.source !== window && event.origin !== window.location.origin) return;
      if (!event.data || (event.data as { _ezPacketPort?: boolean })._ezPacketPort !== true) return;
      const p = event.ports[0];
      if (!p) return;
      port = p;
      port.addEventListener('message', onPortMessage as EventListener);
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
  }, [packetActive]);

  const latest = history[history.length - 1] ?? null;
  const cpuValues = history.map((s) => s.cpu.loadPct);
  const memValues = history.map((s) => (s.mem.usedBytes / s.mem.totalBytes) * 100);

  // Only the snapshots where NET has already reported (panel-open + past
  // warmup) feed the rate sparklines — matches the desktop panel's gating.
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
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as StatsTab)}
      className="mobile-stats-view"
      data-testid="mobile-stats-view"
    >
      <header className="mobile-stats-head">
        <button type="button" className="btn" onClick={onClose} aria-label={t('mobile.stats.close')} data-testid="mobile-stats-close">
          <X aria-hidden="true" size={18} />
        </button>
        <TabList className="mobile-stats-tabs" label={t('mobile.moreActions.stats')}>
          <Tab
            value="summary"
            className={tab === 'summary' ? 'mobile-stats-tab mobile-stats-tab--active' : 'mobile-stats-tab'}
            data-testid="stats-tab-summary"
          >
            {t('mobile.stats.summary')}
          </Tab>
          <Tab
            value="conns"
            className={tab === 'conns' ? 'mobile-stats-tab mobile-stats-tab--active' : 'mobile-stats-tab'}
            data-testid="stats-tab-conns"
          >
            {t('mobile.stats.connections')}
          </Tab>
          <Tab
            value="capture"
            className={tab === 'capture' ? 'mobile-stats-tab mobile-stats-tab--active' : 'mobile-stats-tab'}
            data-testid="stats-tab-capture"
          >
            {t('mobile.stats.capture')}
          </Tab>
        </TabList>
      </header>

      <div className="mobile-stats-body">
        <TabPanel value="summary" className="mobile-stats-tab-panel">
          {tab === 'summary' && (
            <div className="mobile-stats-grid">
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
                <div className="status-loading">{t('mobile.stats.measuring')}</div>
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
                          <span>{t('mobile.stats.used')}</span>
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
                        <span>{t('mobile.stats.available')}</span>
                        <span>{formatBytes(latest.memDetail.availableBytes)}</span>
                      </div>
                      <div className="status-disk-label">
                        <span>{t('mobile.stats.cached')}</span>
                        <span>{formatBytes(latest.memDetail.cachedBytes)}</span>
                      </div>
                      <div className="status-disk-row">
                        <div className="status-disk-label">
                          <span>{t('mobile.stats.pageFile')}</span>
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
                <div className="status-loading">{t('mobile.stats.measuring')}</div>
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
                <div className="status-loading">{t('mobile.stats.measuring')}</div>
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
                          <div className="status-disk-bar-fill" style={{ width: `${Math.min(100, pct)}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="status-loading">{t('mobile.stats.measuring')}</div>
              )}
            </section>

            <section className="status-section" data-testid="status-section-proc">
              <h2 className="status-section-title">PROC</h2>
              {latest?.procs ? (
                <table className="status-proc-table">
                  <thead>
                    <tr>
                      <th>{t('mobile.stats.name')}</th>
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
                <div className="status-loading">{t('mobile.stats.measuring')}</div>
              )}
            </section>
            </div>
          )}
        </TabPanel>

        <TabPanel value="conns" className="mobile-stats-tab-panel">
          {tab === 'conns' && (
            <section className="status-section" data-testid="status-section-conns">
            <h2 className="status-section-title">{t('mobile.stats.connections')}</h2>
            {latest?.conns ? (
              <table className="status-proc-table">
                <thead>
                  <tr>
                    <th>{t('mobile.stats.process')}</th>
                    <th>{t('mobile.stats.protocol')}</th>
                    <th>{t('mobile.stats.localPeer')}</th>
                    <th>{t('mobile.stats.state')}</th>
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
              <div className="status-loading">{t('mobile.stats.measuring')}</div>
            )}
            </section>
          )}
        </TabPanel>

        <TabPanel value="capture" className="mobile-stats-tab-panel">
          {tab === 'capture' && (
            <section className="status-section" data-testid="status-section-capture">
            <h2 className="status-section-title">
              {t('mobile.stats.packetCapture')}
              {packetStatus === 'capturing' && <span data-testid="packets-live"> ● LIVE</span>}
            </h2>
            {packetAckPending ? (
              <div className="status-packet-ack">
                <p>
                  {t('mobile.stats.packetPrivacy')}
                </p>
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
                {packetStatus === 'idle' && (
                  <div className="status-loading" data-testid="stats-capture-idle">
                    {t('mobile.stats.captureIdle')}
                  </div>
                )}
                {packetStatus === 'npcap-missing' && (
                  <div className="status-packet-status">
                    {t('mobile.stats.npcapRequired')}{' '}
                    <a href="https://npcap.com" target="_blank" rel="noreferrer">
                      npcap.com
                    </a>
                  </div>
                )}
                {packetStatus === 'access-denied' && (
                  <div className="status-packet-status">{t('mobile.stats.accessDenied')}</div>
                )}
                {packetStatus === 'error' && (
                  <div className="status-packet-status">{t('mobile.stats.captureError')}</div>
                )}
                {(packetStatus === null || packetStatus === 'capturing') && packetRows.length === 0 && (
                  <div className="status-loading">
                    {packetStatus === 'capturing' ? t('mobile.stats.capturing') : t('mobile.stats.connecting')}
                  </div>
                )}
                {packetRows.length > 0 && (
                  <table className="status-proc-table">
                    <thead>
                      <tr>
                        <th>{t('mobile.stats.time')}</th>
                        <th>src→dst</th>
                        <th>{t('mobile.stats.protocol')}</th>
                        <th>{t('mobile.stats.length')}</th>
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
            </section>
          )}
        </TabPanel>
      </div>
    </Tabs>
  );
}
