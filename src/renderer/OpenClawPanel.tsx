import { X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  OPENCLAW_CONFIG_UNSET,
  type OpenClawAgentSession,
  type OpenClawAutostartAction,
  type OpenClawCoreConfig,
  type OpenClawLifecycleAction,
  type OpenClawLogLine,
  type OpenClawStatus,
  type OpenClawStatusState,
} from '../shared/openclaw';
import { useAppTranslation } from './i18n';

/** How often the sessions list is re-polled while the gateway is running —
 * there is no push subscription for it (unlike status/logs), see the M1
 * IPC surface (`listOpenClawSessions` is a plain invoke). */
const SESSIONS_POLL_MS = 5000;
/** Oldest lines are dropped once the tail holds this many (mirrors the
 * packet preview's PACKET_ROW_CAP pattern in status-shared.ts). */
const LOG_LINE_MAX = 500;

const STATE_LABEL_KEY = {
  'not-installed': 'openClaw.state.notInstalled',
  stopped: 'openClaw.state.stopped',
  starting: 'openClaw.state.starting',
  running: 'openClaw.state.running',
  unknown: 'openClaw.state.unknown',
} as const satisfies Record<OpenClawStatusState, string>;

interface OpenClawPanelProps {
  readonly onClose: () => void;
  /** Opens (or focuses, if already open) the singleton chat dockview panel —
   * see App.tsx's `openOpenClawChat` (openclaw-management M3). */
  readonly onOpenChat: () => void;
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
export function OpenClawPanel({ onClose, onOpenChat }: OpenClawPanelProps): JSX.Element {
  const { t, i18n } = useAppTranslation();
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
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const timeFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }),
    [locale],
  );

  // ── Autostart toggle (task #9: `gateway install`/`gateway uninstall`) ────
  // No fast way to know the CURRENT registration state (that's only in the
  // 9-18s `gateway status --json` CLI call, M0 ⑥) — the UI stays
  // state-agnostic (neutral copy + both actions) rather than lying with a
  // stale/guessed toggle. Two-step click stands in for a confirm dialog
  // without a blocking window.confirm (per the M3/#9 assignment's explicit
  // "no window.confirm dialogs" constraint).
  const [pendingAutostart, setPendingAutostart] = useState<OpenClawAutostartAction | null>(null);
  const [autostartBusy, setAutostartBusy] = useState<OpenClawAutostartAction | null>(null);
  const [autostartResult, setAutostartResult] = useState<string | null>(null);

  const runAutostart = useCallback(async (action: OpenClawAutostartAction): Promise<void> => {
    setPendingAutostart(null);
    setAutostartBusy(action);
    setAutostartResult(null);
    try {
      const result = await window.ezterminalDesktop?.runOpenClawAutostart(action);
      if (result) {
        setAutostartResult(
          result.ok
            ? action === 'install'
              ? t('openClaw.autostartInstalled')
              : t('openClaw.autostartRemoved')
            : (result.stderr ?? t('openClaw.actionFailed', { action })),
        );
      }
    } finally {
      setAutostartBusy(null);
    }
  }, [t]);

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
      if (result && !result.ok) {
        setLifecycleError(result.stderr ?? t('openClaw.actionFailed', { action }));
      }
      const fresh = await window.ezterminalDesktop?.getOpenClawStatus(true);
      if (fresh) setStatus(fresh);
    } finally {
      setBusyAction(null);
    }
  }, [t]);

  // ── Core settings save ─────────────────────────────────────────────────────
  const saveConfig = useCallback(async (): Promise<void> => {
    const api = window.ezterminalDesktop;
    if (!api) return;
    const model = modelDraft.trim();
    const port = portDraft.trim();
    // Config save contract (openclaw-stabilization M6): an empty/whitespace
    // field is never sent (no change) — if EVERY field is empty there is
    // nothing to save, so say so instead of silently no-op'ing.
    if (!model && !port) {
      setConfigError(t('openClaw.enterValue'));
      return;
    }
    setSavingConfig(true);
    setConfigError(null);
    try {
      const errors: string[] = [];
      let restartRequired = false;
      if (model) {
        const r = await api.setOpenClawConfig('agents.defaults.model', model);
        if (!r.ok) errors.push(r.error ?? t('openClaw.modelSaveFailed'));
        restartRequired = restartRequired || r.restartRequired;
      }
      if (port) {
        const r = await api.setOpenClawConfig('gateway.port', port);
        if (!r.ok) errors.push(r.error ?? t('openClaw.portSaveFailed'));
        restartRequired = restartRequired || r.restartRequired;
      }
      if (errors.length > 0) setConfigError(errors.join('; '));
      if (restartRequired) setRestartBanner(true);
      await refreshConfig();
    } finally {
      setSavingConfig(false);
    }
  }, [modelDraft, portDraft, refreshConfig, t]);

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
    <div
      className="status-drawer openclaw-drawer"
      data-testid="openclaw-panel"
      role="region"
      aria-label={t('rail.openClaw')}
    >
      <div className="openclaw-drawer-header">
        <h2 className="status-section-title">{t('rail.openClaw')}</h2>
        <button
          className="btn btn-split"
          onClick={onClose}
          title={t('common.close')}
          aria-label={t('common.close')}
          data-testid="openclaw-close"
        >
          <X aria-hidden="true" size={16} />
        </button>
      </div>

      <section
        className="status-section"
        data-testid="openclaw-state"
        data-state={state ?? 'unknown'}
      >
        <div
          className={`openclaw-state-row openclaw-state-${state ?? 'unknown'}`}
          data-state={state ?? 'unknown'}
        >
          <span className="openclaw-state-dot" aria-hidden="true" />
          <span className="status-metric">
            {status ? t(STATE_LABEL_KEY[status.state]) : t('openClaw.checking')}
          </span>
        </div>
        {status?.version && (
          <div className="openclaw-state-detail">
            {t('openClaw.version', { version: status.version })}
          </div>
        )}
        {status && (
          <div className="openclaw-state-detail">{t('openClaw.port', { port: status.port })}</div>
        )}
      </section>

      {state === 'not-installed' ? (
        <section className="status-section" data-testid="openclaw-guidance">
          <h2 className="status-section-title">{t('openClaw.installRequired')}</h2>
          <p className="openclaw-guidance-text">{t('openClaw.notInstalled')}</p>
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
            <h2 className="status-section-title">{t('openClaw.lifecycle')}</h2>
            <div className="openclaw-lifecycle-buttons">
              <button
                type="button"
                className="btn btn-split"
                disabled={startDisabled}
                onClick={() => void runLifecycle('start')}
                data-testid="btn-openclaw-start"
              >
                {t('openClaw.start')}
              </button>
              <button
                type="button"
                className="btn btn-split"
                disabled={stopDisabled}
                onClick={() => void runLifecycle('stop')}
                data-testid="btn-openclaw-stop"
              >
                {t('openClaw.stop')}
              </button>
              <button
                type="button"
                className="btn btn-split"
                disabled={restartDisabled}
                onClick={() => void runLifecycle('restart')}
                data-testid="btn-openclaw-restart"
              >
                {t('openClaw.restart')}
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
              onClick={onOpenChat}
              title={t('openClaw.openChat')}
              data-testid="btn-openclaw-open-chat"
            >
              {t('openClaw.openChat')}
            </button>
            <button
              type="button"
              className="btn btn-split openclaw-chat-btn"
              onClick={() => void window.ezterminalDesktop?.openOpenClawChatExternal()}
              title={t('openClaw.openBrowser')}
              data-testid="btn-openclaw-open-chat-external"
            >
              {t('openClaw.openBrowser')}
            </button>
          </section>

          {state === 'stopped' && (
            <section className="status-section" data-testid="openclaw-guidance">
              <div className="status-loading">
                {t('openClaw.stoppedGuide')}
              </div>
            </section>
          )}

          {state === 'unknown' && (
            <section className="status-section" data-testid="openclaw-guidance">
              <div className="status-loading">{t('openClaw.unknownGuide')}</div>
            </section>
          )}

          {(state === 'running' || state === 'starting') && (
            <section className="status-section">
              <h2 className="status-section-title">{t('openClaw.sessions')}</h2>
              {sessions.length === 0 ? (
                <div className="status-loading">{t('openClaw.noActiveSessions')}</div>
              ) : (
                <div className="openclaw-sessions" data-testid="openclaw-sessions">
                  {sessions.map((s) => (
                    <div key={s.sessionId} className="openclaw-session-row" data-testid="openclaw-session-row">
                      <div className="openclaw-session-key">{s.key}</div>
                      <div className="status-disk-label">
                        <span>{s.model ?? '—'}</span>
                        <span>
                          {s.totalTokens !== undefined
                            ? t('openClaw.tokenCount', {
                              value: numberFormatter.format(s.totalTokens),
                            })
                            : '—'}
                        </span>
                      </div>
                      {s.updatedAt !== undefined && (
                        <div className="openclaw-session-updated">
                          {timeFormatter.format(new Date(s.updatedAt))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          <section className="status-section">
            <h2 className="status-section-title">{t('openClaw.logs')}</h2>
            <div
              className="openclaw-log-view"
              data-testid="openclaw-log-view"
              role="log"
              aria-label={t('openClaw.logs')}
              ref={logViewRef}
              onScroll={handleLogScroll}
            >
              {logLines.map((line, i) => (
                <div
                  key={i}
                  className={`openclaw-log-line openclaw-log-level-${line.level.toLowerCase()}`}
                >
                  <span className="openclaw-log-time">
                    {timeFormatter.format(new Date(line.time))}
                  </span>
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
                {t('openClaw.resumeLogs')}
              </button>
            )}
          </section>

          <section className="status-section">
            <h2 className="status-section-title">{t('openClaw.coreSettings')}</h2>
            <div className="openclaw-config-row">
              <span>{t('openClaw.defaultModel')}</span>
              <input
                className="settings-scrollback-input"
                value={modelDraft}
                aria-label={t('openClaw.defaultModel')}
                onChange={(e) => setModelDraft(e.target.value)}
                data-testid="openclaw-config-model"
              />
            </div>
            <div className="openclaw-config-row">
              <span>{t('openClaw.gatewayPort')}</span>
              <input
                type="number"
                className="settings-scrollback-input"
                value={portDraft}
                placeholder={config?.['gateway.port'] === OPENCLAW_CONFIG_UNSET ? t('openClaw.unset') : undefined}
                aria-label={t('openClaw.gatewayPort')}
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
              {t('openClaw.save')}
            </button>
            {configError && (
              <div className="openclaw-error-inline" data-testid="openclaw-config-error">
                {configError}
              </div>
            )}
            {restartBanner && (
              <div className="openclaw-restart-banner" data-testid="openclaw-restart-banner">
                <span>{t('openClaw.restartRequired')}</span>
                <button
                  type="button"
                  className="btn btn-split"
                  onClick={restartNow}
                  data-testid="openclaw-restart-now"
                >
                  {t('openClaw.restart')}
                </button>
              </div>
            )}
            <div className="openclaw-autostart-row" data-testid="openclaw-autostart-row">
              <span>{t('openClaw.autostart')}</span>
              <div className="openclaw-autostart-actions">
                <button
                  type="button"
                  className="btn btn-split"
                  disabled={autostartBusy !== null}
                  onClick={() => setPendingAutostart((current) => (current === 'install' ? null : 'install'))}
                  data-testid="btn-openclaw-autostart-install"
                >
                  {pendingAutostart === 'install'
                    ? t('openClaw.confirmQuestion')
                    : t('openClaw.register')}
                </button>
                {pendingAutostart === 'install' && (
                  <button
                    type="button"
                    className="btn btn-split"
                    onClick={() => void runAutostart('install')}
                    data-testid="btn-openclaw-autostart-install-confirm"
                  >
                    {t('openClaw.confirmRegister')}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-split"
                  disabled={autostartBusy !== null}
                  onClick={() => setPendingAutostart((current) => (current === 'uninstall' ? null : 'uninstall'))}
                  data-testid="btn-openclaw-autostart-uninstall"
                >
                  {pendingAutostart === 'uninstall'
                    ? t('openClaw.confirmQuestion')
                    : t('openClaw.unregister')}
                </button>
                {pendingAutostart === 'uninstall' && (
                  <button
                    type="button"
                    className="btn btn-split"
                    onClick={() => void runAutostart('uninstall')}
                    data-testid="btn-openclaw-autostart-uninstall-confirm"
                  >
                    {t('openClaw.confirmUnregister')}
                  </button>
                )}
              </div>
              {autostartBusy && <div className="status-loading">{t('openClaw.processing')}</div>}
              {autostartResult && (
                <div className="openclaw-error-inline" data-testid="openclaw-autostart-result">
                  {autostartResult}
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
