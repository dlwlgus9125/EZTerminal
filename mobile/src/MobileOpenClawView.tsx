import { useCallback, useEffect, useRef, useState } from 'react';

import {
  OPENCLAW_CONFIG_UNSET,
  type OpenClawCoreConfig,
  type OpenClawLifecycleAction,
  type OpenClawLogLine,
  type OpenClawStatus,
} from '../../src/shared/openclaw';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';

type OpenClawTab = 'status' | 'logs' | 'settings' | 'chat';

/** Local rendering cap for the accumulated log tail — mirrors the wire's own
 * per-flush pending cap (remote-bridge.ts's `OPENCLAW_LOG_PENDING_CAP`), just
 * applied client-side to the whole session's accumulated lines. */
const LOG_LINE_CAP = 500;

/** Human labels for the state dot + guidance card (Korean, matching
 * MobileStatsView.tsx's full-screen-overlay language convention). */
const STATE_LABEL: Record<OpenClawStatus['state'], string> = {
  'not-installed': '미설치',
  stopped: '중지됨',
  starting: '시작하는 중…',
  running: '실행 중',
  unknown: '알 수 없음',
};

// MobileOpenClawView — full-screen OpenClaw management overlay (openclaw-
// management M4). Modeled on MobileStatsView.tsx's structure (standalone
// tabbed view reusing the desktop's `status-*` CSS classes, imported
// wholesale by main.tsx). Tabs: 상태(Status) | 로그(Logs) | 설정(Settings) |
// 채팅(Chat). Status/Logs subscribe only while THIS view (and, for logs, that
// specific tab) is visible — same acquire-on-mount/release-on-unmount
// discipline as MobileStatsView's stats subscription. Guidance states
// (not-installed/stopped) are informational cards with a CTA, never an error
// toast (mirrors the desktop drawer's "안내 상태" requirement) — the Chat tab
// is a placeholder only; M5 wires it to `transport.getOpenClawChatTicket()`.
export function MobileOpenClawView({
  transport,
  onClose,
}: {
  transport: WsEzTerminalTransport;
  onClose: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<OpenClawTab>('status');
  const [status, setStatus] = useState<OpenClawStatus | null>(null);
  const [busyAction, setBusyAction] = useState<OpenClawLifecycleAction | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = transport.onOpenClawStatus((s) => setStatus(s));
    transport.setOpenClawStatusSubscribed(true);
    return () => {
      unsubscribe();
      transport.setOpenClawStatusSubscribed(false);
    };
  }, [transport]);

  const runLifecycle = useCallback(
    (action: OpenClawLifecycleAction) => {
      setBusyAction(action);
      setLifecycleError(null);
      void transport.runOpenClawLifecycle(action).then((result) => {
        setBusyAction(null);
        if (!result.ok) setLifecycleError(result.stderr || '작업을 완료하지 못했습니다.');
      });
    },
    [transport],
  );

  const busy = busyAction !== null;
  const state = status?.state;
  const canStart = !busy && state !== 'running' && state !== 'not-installed' && state !== 'starting';
  const canStop = !busy && state === 'running';
  const canRestart = !busy && state === 'running';

  // ── Logs tab (M4): subscribes only while this tab is active. ─────────────
  const [logs, setLogs] = useState<OpenClawLogLine[]>([]);
  const logsActive = tab === 'logs';
  const logsEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!logsActive) return;
    setLogs([]);
    const unsubscribe = transport.onOpenClawLogLines((lines) => {
      setLogs((current) => {
        const next = current.concat(lines);
        return next.length > LOG_LINE_CAP ? next.slice(next.length - LOG_LINE_CAP) : next;
      });
    });
    transport.setOpenClawLogsSubscribed(true);
    return () => {
      unsubscribe();
      transport.setOpenClawLogsSubscribed(false);
    };
  }, [logsActive, transport]);

  useEffect(() => {
    if (!logsActive) return;
    logsEndRef.current?.scrollIntoView({ block: 'end' });
  }, [logsActive, logs]);

  // ── Settings tab (M4): core config (model/port) via CLI-backed get/set —
  // fetched once when the tab opens (mirrors the desktop drawer's settings
  // form load, not live-followed). ──────────────────────────────────────────
  const [config, setConfig] = useState<OpenClawCoreConfig | null>(null);
  const [modelDraft, setModelDraft] = useState('');
  const [portDraft, setPortDraft] = useState('');
  const [restartBanner, setRestartBanner] = useState(false);
  const [configSaving, setConfigSaving] = useState<'model' | 'port' | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  useEffect(() => {
    if (tab !== 'settings') return;
    void transport.getOpenClawConfig().then((c) => {
      setConfig(c);
      setModelDraft(c['agents.defaults.model'] === OPENCLAW_CONFIG_UNSET ? '' : c['agents.defaults.model']);
      setPortDraft(c['gateway.port'] === OPENCLAW_CONFIG_UNSET ? '' : c['gateway.port']);
    });
  }, [tab, transport]);

  const saveConfig = useCallback(
    (key: 'agents.defaults.model' | 'gateway.port', value: string, which: 'model' | 'port') => {
      setConfigSaving(which);
      setConfigError(null);
      void transport.setOpenClawConfig(key, value).then((result) => {
        setConfigSaving(null);
        if (result.ok) {
          setRestartBanner(true);
        } else {
          setConfigError(result.error || '설정을 저장하지 못했습니다.');
        }
      });
    },
    [transport],
  );

  return (
    <div className="mobile-openclaw-view" data-testid="mobile-openclaw-view">
      <header className="mobile-openclaw-head">
        <button
          type="button"
          className="btn"
          onClick={onClose}
          aria-label="Close OpenClaw"
          data-testid="mobile-openclaw-close"
        >
          ✕
        </button>
        <div className="mobile-openclaw-tabs" role="tablist">
          <button
            type="button"
            className={tab === 'status' ? 'mobile-openclaw-tab mobile-openclaw-tab--active' : 'mobile-openclaw-tab'}
            onClick={() => setTab('status')}
            data-testid="openclaw-tab-status"
          >
            상태
          </button>
          <button
            type="button"
            className={tab === 'logs' ? 'mobile-openclaw-tab mobile-openclaw-tab--active' : 'mobile-openclaw-tab'}
            onClick={() => setTab('logs')}
            data-testid="openclaw-tab-logs"
          >
            로그
          </button>
          <button
            type="button"
            className={tab === 'settings' ? 'mobile-openclaw-tab mobile-openclaw-tab--active' : 'mobile-openclaw-tab'}
            onClick={() => setTab('settings')}
            data-testid="openclaw-tab-settings"
          >
            설정
          </button>
          <button
            type="button"
            className={tab === 'chat' ? 'mobile-openclaw-tab mobile-openclaw-tab--active' : 'mobile-openclaw-tab'}
            onClick={() => setTab('chat')}
            data-testid="openclaw-tab-chat"
          >
            채팅
          </button>
        </div>
      </header>

      <div className="mobile-openclaw-body">
        {tab === 'status' && (
          <section className="status-section" data-testid="openclaw-status-section">
            <h2 className="status-section-title">OpenClaw</h2>
            {status ? (
              <>
                <div className="openclaw-status-row">
                  <span
                    className={`openclaw-status-dot openclaw-status-dot--${status.state}`}
                    data-testid="openclaw-status-dot"
                  />
                  <span data-testid="openclaw-status-label">{STATE_LABEL[status.state]}</span>
                </div>
                {status.version && (
                  <div className="status-metric" data-testid="openclaw-status-version">
                    버전 {status.version}
                  </div>
                )}
                <div className="status-metric" data-testid="openclaw-status-port">
                  포트 {status.port}
                </div>

                {status.state === 'not-installed' && (
                  <div className="openclaw-guidance" data-testid="openclaw-guidance">
                    OpenClaw CLI를 찾을 수 없습니다. 설치 후 다시 시도하세요.
                  </div>
                )}
                {status.state === 'stopped' && (
                  <div className="openclaw-guidance" data-testid="openclaw-guidance">
                    OpenClaw 게이트웨이가 중지되어 있습니다. 시작하려면 아래 버튼을 누르세요.
                  </div>
                )}
                {status.state === 'unknown' && (
                  <div className="openclaw-guidance" data-testid="openclaw-guidance">
                    상태를 확인할 수 없습니다.
                  </div>
                )}

                <div className="openclaw-lifecycle-buttons">
                  <button
                    type="button"
                    className="btn"
                    disabled={!canStart}
                    onClick={() => runLifecycle('start')}
                    data-testid="openclaw-btn-start"
                  >
                    {busyAction === 'start' ? '시작하는 중…' : '시작'}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={!canStop}
                    onClick={() => runLifecycle('stop')}
                    data-testid="openclaw-btn-stop"
                  >
                    {busyAction === 'stop' ? '중지하는 중…' : '중지'}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={!canRestart}
                    onClick={() => runLifecycle('restart')}
                    data-testid="openclaw-btn-restart"
                  >
                    {busyAction === 'restart' ? '재시작하는 중…' : '재시작'}
                  </button>
                </div>
                {lifecycleError && (
                  <div className="openclaw-guidance openclaw-guidance--error" data-testid="openclaw-lifecycle-error">
                    {lifecycleError}
                  </div>
                )}
              </>
            ) : (
              <div className="status-loading">확인 중…</div>
            )}
          </section>
        )}

        {tab === 'logs' && (
          <section className="status-section openclaw-logs-section" data-testid="openclaw-logs-section">
            <h2 className="status-section-title">로그</h2>
            <div className="openclaw-log-list" data-testid="openclaw-log-list">
              {logs.length === 0 ? (
                <div className="status-loading">로그를 기다리는 중…</div>
              ) : (
                logs.map((line, i) => (
                  <div
                    key={i}
                    className={`openclaw-log-line openclaw-log-line--${line.level.toLowerCase()}`}
                    data-testid="openclaw-log-line"
                  >
                    <span className="openclaw-log-time">{line.time}</span>
                    <span className="openclaw-log-level">{line.level}</span>
                    <span className="openclaw-log-message">{line.message}</span>
                  </div>
                ))
              )}
              <div ref={logsEndRef} />
            </div>
          </section>
        )}

        {tab === 'settings' && (
          <section className="status-section" data-testid="openclaw-settings-section">
            <h2 className="status-section-title">설정</h2>
            {restartBanner && (
              <div className="openclaw-guidance" data-testid="openclaw-restart-banner">
                적용하려면 게이트웨이를 재시작하세요.
              </div>
            )}
            {configError && (
              <div className="openclaw-guidance openclaw-guidance--error" data-testid="openclaw-config-error">
                {configError}
              </div>
            )}
            {config ? (
              <>
                <label className="openclaw-config-row">
                  <span>기본 모델</span>
                  <input
                    type="text"
                    value={modelDraft}
                    placeholder="(설정되지 않음)"
                    onChange={(e) => setModelDraft(e.target.value)}
                    data-testid="openclaw-config-model"
                  />
                  <button
                    type="button"
                    className="btn"
                    disabled={configSaving !== null}
                    onClick={() => saveConfig('agents.defaults.model', modelDraft, 'model')}
                    data-testid="openclaw-config-save-model"
                  >
                    {configSaving === 'model' ? '저장하는 중…' : '저장'}
                  </button>
                </label>
                <label className="openclaw-config-row">
                  <span>게이트웨이 포트</span>
                  <input
                    type="text"
                    value={portDraft}
                    placeholder="(설정되지 않음)"
                    onChange={(e) => setPortDraft(e.target.value)}
                    data-testid="openclaw-config-port"
                  />
                  <button
                    type="button"
                    className="btn"
                    disabled={configSaving !== null}
                    onClick={() => saveConfig('gateway.port', portDraft, 'port')}
                    data-testid="openclaw-config-save-port"
                  >
                    {configSaving === 'port' ? '저장하는 중…' : '저장'}
                  </button>
                </label>
              </>
            ) : (
              <div className="status-loading">불러오는 중…</div>
            )}
          </section>
        )}

        {tab === 'chat' && (
          <section className="status-section" data-testid="openclaw-chat-section">
            <h2 className="status-section-title">채팅</h2>
            <div className="openclaw-guidance" data-testid="openclaw-chat-placeholder">
              채팅은 M5에서 제공됩니다.
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
