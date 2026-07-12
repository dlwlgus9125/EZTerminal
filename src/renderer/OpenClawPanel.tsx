import { useCallback, useEffect, useRef, useState } from 'react';

import {
  OPENCLAW_CONFIG_UNSET,
  type OpenClawAgentSession,
  type OpenClawCoreConfig,
  type OpenClawLifecycleAction,
  type OpenClawLogLine,
  type OpenClawStatus,
  type OpenClawStatusState,
} from '../shared/openclaw';
import { formatPacketTime } from './status-shared';

/** How often the sessions list is re-polled while the gateway is running —
 * there is no push subscription for it (unlike status/logs), see the M1
 * IPC surface (`listOpenClawSessions` is a plain invoke). */
const SESSIONS_POLL_MS = 5000;
/** Oldest lines are dropped once the tail holds this many (mirrors the
 * packet preview's PACKET_ROW_CAP pattern in status-shared.ts). */
const LOG_LINE_MAX = 500;

const STATE_LABEL: Record<OpenClawStatusState, string> = {
  'not-installed': '설치 안 됨',
  stopped: '중지됨',
  starting: '시작 중…',
  running: '실행 중',
  unknown: '알 수 없음',
};

interface OpenClawPanelProps {
  readonly onClose: () => void;
}

/**
 * Desktop OpenClaw management drawer (openclaw-management M2) — right-edge
 * overlay reusing StatusPanel/SettingsPanel's `status-drawer`/`status-section`
 * chrome (same slot family, joins App.tsx's right-slot mutual exclusion).
 * Status/log data arrive via `setOpenClawDrawerOpen`-gated pushes (seed via
 * `getOpenClawStatus`, then stay current via `onOpenClawStatus`/`onOpenClawLog`
 * — same seed-then-subscribe shape as the stats overlay). Sessions have no
 * push channel, so they're polled on-demand while the gateway is running.
 * Guidance states (not-installed / stopped) replace the operational sections
 * with a calm CTA — never an error toast (AC6).
 */
export function OpenClawPanel({ onClose }: OpenClawPanelProps): JSX.Element {
  const [status, setStatus] = useState<OpenClawStatus | null>(null);
  const [sessions, setSessions] = useState<readonly OpenClawAgentSession[]>([]);
  const [logLines, setLogLines] = useState<OpenClawLogLine[]>([]);

  const [busyAction, setBusyAction] = useState<OpenClawLifecycleAction | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);

  const [config, setConfig] = useState<OpenClawCoreConfig | null>(null);
  const [modelDraft, setModelDraft] = useState('');
  const [portDraft, setPortDraft] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [restartBanner, setRestartBanner] = useState(false);

  const [autoScroll, setAutoScroll] = useState(true);
  const logViewRef = useRef<HTMLDivElement | null>(null);

  // ── Status seed + push (gated main-side by drawer-open, mirrors the stats
  // overlay's `setStatsPanelVisible`) ────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    const api = window.ezterminalDesktop;
    api?.setOpenClawDrawerOpen(true);
    void api?.getOpenClawStatus().then((s) => {
      if (alive) setStatus(s);
    });
    const unsubStatus = api?.onOpenClawStatus((s) => setStatus(s));
    const unsubLog = api?.onOpenClawLog((line) => {
      setLogLines((current) => {
        const next = [...current, line];
        return next.length > LOG_LINE_MAX ? next.slice(next.length - LOG_LINE_MAX) : next;
      });
    });
    return () => {
      alive = false;
      unsubStatus?.();
      unsubLog?.();
      api?.setOpenClawDrawerOpen(false);
    };
  }, []);

  // ── Sessions: on-demand poll while running (no push channel) ─────────────
  useEffect(() => {
    if (status?.state !== 'running') {
      setSessions([]);
      return;
    }
    let alive = true;
    const load = (): void => {
      void window.ezterminalDesktop?.listOpenClawSessions().then((list) => {
        if (alive) setSessions(list);
      });
    };
    load();
    const timer = setInterval(load, SESSIONS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [status?.state]);

  // ── Core config: fetched once, editable via local drafts ─────────────────
  const refreshConfig = useCallback(async (): Promise<void> => {
    const cfg = await window.ezterminalDesktop?.getOpenClawConfig();
    if (!cfg) return;
    setConfig(cfg);
    setModelDraft(cfg['agents.defaults.model'] === OPENCLAW_CONFIG_UNSET ? '' : cfg['agents.defaults.model']);
    setPortDraft(cfg['gateway.port'] === OPENCLAW_CONFIG_UNSET ? '' : cfg['gateway.port']);
  }, []);

  useEffect(() => {
    void refreshConfig();
  }, [refreshConfig]);

  // ── Lifecycle actions ─────────────────────────────────────────────────────
  const runLifecycle = useCallback(async (action: OpenClawLifecycleAction): Promise<void> => {
    setBusyAction(action);
    setLifecycleError(null);
    try {
      const result = await window.ezterminalDesktop?.runOpenClawLifecycle(action);
      if (result && !result.ok) setLifecycleError(result.stderr ?? `${action} failed`);
      const fresh = await window.ezterminalDesktop?.getOpenClawStatus(true);
      if (fresh) setStatus(fresh);
    } finally {
      setBusyAction(null);
    }
  }, []);

  // ── Core settings save ─────────────────────────────────────────────────────
  const saveConfig = useCallback(async (): Promise<void> => {
    const api = window.ezterminalDesktop;
    if (!api) return;
    setSavingConfig(true);
    setConfigError(null);
    try {
      const errors: string[] = [];
      let restartRequired = false;
      if (modelDraft.trim()) {
        const r = await api.setOpenClawConfig('agents.defaults.model', modelDraft.trim());
        if (!r.ok) errors.push(r.error ?? '기본 모델 저장 실패');
        restartRequired = restartRequired || r.restartRequired;
      }
      if (portDraft.trim()) {
        const r = await api.setOpenClawConfig('gateway.port', portDraft.trim());
        if (!r.ok) errors.push(r.error ?? '포트 저장 실패');
        restartRequired = restartRequired || r.restartRequired;
      }
      if (errors.length > 0) setConfigError(errors.join('; '));
      if (restartRequired) setRestartBanner(true);
      await refreshConfig();
    } finally {
      setSavingConfig(false);
    }
  }, [modelDraft, portDraft, refreshConfig]);

  const restartNow = useCallback((): void => {
    setRestartBanner(false);
    void runLifecycle('restart');
  }, [runLifecycle]);

  // ── Log tail: auto-scroll pinned to bottom, paused on scroll-up ──────────
  const handleLogScroll = useCallback((): void => {
    const el = logViewRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setAutoScroll(atBottom);
  }, []);

  useEffect(() => {
    if (!autoScroll) return;
    const el = logViewRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logLines, autoScroll]);

  const resumeAutoScroll = useCallback((): void => {
    setAutoScroll(true);
    const el = logViewRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const state = status?.state;
  const busy = busyAction !== null;
  const startDisabled = busy || state === undefined || state === 'running' || state === 'starting';
  const stopDisabled = busy || state === undefined || state === 'stopped' || state === 'not-installed';
  const restartDisabled = busy || state === undefined || state === 'not-installed';

  return (
    <div className="status-drawer openclaw-drawer" data-testid="openclaw-panel">
      <div className="openclaw-drawer-header">
        <h2 className="status-section-title">OpenClaw</h2>
        <button className="btn btn-split" onClick={onClose} title="Close" data-testid="openclaw-close">
          ✕
        </button>
      </div>

      <section className="status-section" data-testid="openclaw-state">
        <div className={`openclaw-state-row openclaw-state-${state ?? 'unknown'}`}>
          <span className="openclaw-state-dot" aria-hidden="true" />
          <span className="status-metric">{status ? STATE_LABEL[status.state] : '확인 중…'}</span>
        </div>
        {status?.version && <div className="openclaw-state-detail">버전 {status.version}</div>}
        {status?.pid !== undefined && <div className="openclaw-state-detail">PID {status.pid}</div>}
        {status && <div className="openclaw-state-detail">포트 {status.port}</div>}
        {status?.configPath && (
          <div className="openclaw-state-detail openclaw-state-path" title={status.configPath}>
            {status.configPath}
          </div>
        )}
      </section>

      {state === 'not-installed' ? (
        <section className="status-section" data-testid="openclaw-guidance">
          <h2 className="status-section-title">설치 필요</h2>
          <p className="openclaw-guidance-text">OpenClaw CLI가 설치되어 있지 않습니다.</p>
          <code className="openclaw-guidance-cmd">npm i -g openclaw</code>
          <a
            className="openclaw-guidance-link"
            href="https://docs.openclaw.ai"
            target="_blank"
            rel="noreferrer"
          >
            docs.openclaw.ai
          </a>
        </section>
      ) : (
        <>
          <section className="status-section">
            <h2 className="status-section-title">수명주기</h2>
            <div className="openclaw-lifecycle-buttons">
              <button
                type="button"
                className="btn btn-split"
                disabled={startDisabled}
                onClick={() => void runLifecycle('start')}
                data-testid="btn-openclaw-start"
              >
                시작
              </button>
              <button
                type="button"
                className="btn btn-split"
                disabled={stopDisabled}
                onClick={() => void runLifecycle('stop')}
                data-testid="btn-openclaw-stop"
              >
                중지
              </button>
              <button
                type="button"
                className="btn btn-split"
                disabled={restartDisabled}
                onClick={() => void runLifecycle('restart')}
                data-testid="btn-openclaw-restart"
              >
                재시작
              </button>
            </div>
            {lifecycleError && (
              <div className="openclaw-error-inline" data-testid="openclaw-lifecycle-error">
                {lifecycleError}
              </div>
            )}
            <button
              type="button"
              className="btn btn-split openclaw-chat-btn"
              disabled
              title="곧 제공"
              data-testid="btn-openclaw-open-chat"
            >
              채팅 열기
            </button>
          </section>

          {state === 'stopped' && (
            <section className="status-section" data-testid="openclaw-guidance">
              <div className="status-loading">
                게이트웨이가 중지되어 있습니다. 시작 버튼을 눌러 세션과 로그를 확인하세요.
              </div>
            </section>
          )}

          {(state === 'running' || state === 'starting') && (
            <section className="status-section">
              <h2 className="status-section-title">세션</h2>
              {sessions.length === 0 ? (
                <div className="status-loading">활성 세션 없음</div>
              ) : (
                <div className="openclaw-sessions" data-testid="openclaw-sessions">
                  {sessions.map((s) => (
                    <div key={s.sessionId} className="openclaw-session-row" data-testid="openclaw-session-row">
                      <div className="openclaw-session-key">{s.key}</div>
                      <div className="status-disk-label">
                        <span>{s.model ?? '—'}</span>
                        <span>{s.totalTokens !== undefined ? `${s.totalTokens} tok` : '—'}</span>
                      </div>
                      {s.updatedAt !== undefined && (
                        <div className="openclaw-session-updated">{formatPacketTime(s.updatedAt)}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          <section className="status-section">
            <h2 className="status-section-title">로그</h2>
            <div
              className="openclaw-log-view"
              data-testid="openclaw-log-view"
              ref={logViewRef}
              onScroll={handleLogScroll}
            >
              {logLines.map((line, i) => (
                <div
                  key={i}
                  className={`openclaw-log-line openclaw-log-level-${line.level.toLowerCase()}`}
                >
                  <span className="openclaw-log-time">{formatPacketTime(new Date(line.time).getTime())}</span>
                  <span className="openclaw-log-level">{line.level}</span>
                  <span className="openclaw-log-message">{line.message}</span>
                </div>
              ))}
            </div>
            {!autoScroll && (
              <button
                type="button"
                className="btn btn-split openclaw-log-resume"
                onClick={resumeAutoScroll}
                data-testid="openclaw-log-resume"
              >
                최신 로그로 이동
              </button>
            )}
          </section>

          <section className="status-section">
            <h2 className="status-section-title">핵심 설정</h2>
            <div className="openclaw-config-row">
              <span>기본 모델</span>
              <input
                className="settings-scrollback-input"
                value={modelDraft}
                onChange={(e) => setModelDraft(e.target.value)}
                data-testid="openclaw-config-model"
              />
            </div>
            <div className="openclaw-config-row">
              <span>게이트웨이 포트</span>
              <input
                type="number"
                className="settings-scrollback-input"
                value={portDraft}
                placeholder={config?.['gateway.port'] === OPENCLAW_CONFIG_UNSET ? '(미설정)' : undefined}
                onChange={(e) => setPortDraft(e.target.value)}
                data-testid="openclaw-config-port"
              />
            </div>
            <button
              type="button"
              className="btn btn-split"
              disabled={savingConfig}
              onClick={() => void saveConfig()}
              data-testid="openclaw-config-save"
            >
              저장
            </button>
            {configError && (
              <div className="openclaw-error-inline" data-testid="openclaw-config-error">
                {configError}
              </div>
            )}
            {restartBanner && (
              <div className="openclaw-restart-banner" data-testid="openclaw-restart-banner">
                <span>게이트웨이를 재시작해야 적용됩니다.</span>
                <button
                  type="button"
                  className="btn btn-split"
                  onClick={restartNow}
                  data-testid="openclaw-restart-now"
                >
                  재시작
                </button>
              </div>
            )}
            <label className="settings-radio-row openclaw-autostart-row" title="곧 제공">
              <input type="checkbox" disabled data-testid="openclaw-autostart-toggle" />
              <span>시작 시 자동 실행 (곧 제공)</span>
            </label>
          </section>
        </>
      )}
    </div>
  );
}
