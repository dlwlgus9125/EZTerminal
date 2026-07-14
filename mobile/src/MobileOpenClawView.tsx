import { Browser } from '@capacitor/browser';
import { X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  OPENCLAW_CONFIG_UNSET,
  type OpenClawCoreConfig,
  type OpenClawLifecycleAction,
  type OpenClawLogLine,
  type OpenClawStatus,
} from '../../src/shared/openclaw';
import type {
  OpenClawChatFailureReason,
  WsEzTerminalTransport,
} from './transport/ws-ezterminal';
import { usePageVisible } from './use-page-visible';
import { useAppTranslation } from '../../src/renderer/i18n';
import { Tab, TabList, TabPanel, Tabs } from '../../src/renderer/ui/Tabs';

type OpenClawTab = 'status' | 'logs' | 'settings' | 'chat';

/** Chat tab (M5) states — `unavailable` covers both a `{null,0,null}` ticket
 * reply (proxy/bridge down) and any other minting failure; `ready` carries
 * the fully assembled Control UI URL. */
type ChatErrorReason = OpenClawChatFailureReason | 'invalid-host' | 'frame-timeout' | 'frame-error';
type ChatState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'frame-loading'; readonly url: string; readonly generation: number }
  | { readonly kind: 'ready'; readonly url: string; readonly generation: number }
  | { readonly kind: 'unavailable'; readonly reason: ChatErrorReason };

export const OPENCLAW_CHAT_FRAME_TIMEOUT_MS = 20_000;

/** Assembles the Control UI URL from a resolved chat ticket — see
 * openclaw-proxy.ts's module doc: the `#token=` fragment is consumed
 * client-side by the Control UI's own SPA and never reaches the proxy
 * server. Exported for direct unit testing (same precedent as
 * openclaw-proxy.ts's own small pure helpers). */
export function buildChatUrl(host: string, proxyPort: number, ticket: string, token: string): string {
  const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${formattedHost}:${proxyPort}/?t=${encodeURIComponent(ticket)}#token=${encodeURIComponent(token)}`;
}

/** Local rendering cap for the accumulated log tail — mirrors the wire's own
 * per-flush pending cap (remote-bridge.ts's `OPENCLAW_LOG_PENDING_CAP`), just
 * applied client-side to the whole session's accumulated lines. */
const LOG_LINE_CAP = 500;

const STATE_LABEL_KEY = {
  'not-installed': 'mobile.openClaw.stateNotInstalled',
  stopped: 'mobile.openClaw.stateStopped',
  starting: 'mobile.openClaw.stateStarting',
  running: 'mobile.openClaw.stateRunning',
  unknown: 'mobile.openClaw.stateUnknown',
} as const;

// MobileOpenClawView — full-screen OpenClaw management overlay (openclaw-
// management M4/M5). Modeled on MobileStatsView.tsx's structure (standalone
// tabbed view reusing the desktop's `status-*` CSS classes, imported
// wholesale by main.tsx). Tabs: 상태(Status) | 로그(Logs) | 설정(Settings) |
// 채팅(Chat). Status/Logs subscribe only while THIS view (and, for logs, that
// specific tab) is visible — same acquire-on-mount/release-on-unmount
// discipline as MobileStatsView's stats subscription. Guidance states
// (not-installed/stopped/gateway-not-running) are informational cards with a
// CTA, never an error toast (mirrors the desktop drawer's "안내 상태"
// requirement) — the Chat tab (M5) embeds the OpenClaw Control UI in an
// `<iframe>` via a fresh, single-use ticket (`transport.getOpenClawChatTicket()`
// + `openclaw-proxy.ts`'s ticket+cookie flow) minted on every tab activation
// and every explicit reload; it never reuses one.
export function MobileOpenClawView({
  transport,
  onClose,
  openclawAvailable,
}: {
  transport: WsEzTerminalTransport;
  onClose: () => void;
  /** Desktop's effective OpenClaw availability push (openclaw-stabilization
   * review fix) — a dep-only signal, not read directly: see the status/logs
   * effects below for why this view needs it too, not just MobileWorkspace's
   * own entry-dot subscription. */
  openclawAvailable: boolean;
}): JSX.Element {
  const { t } = useAppTranslation();
  const stateLabel = useCallback(
    (value: OpenClawStatus['state']): string => t(STATE_LABEL_KEY[value]),
    [t],
  );
  const [tab, setTab] = useState<OpenClawTab>('status');
  const [status, setStatus] = useState<OpenClawStatus | null>(null);
  const [busyAction, setBusyAction] = useState<OpenClawLifecycleAction | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);

  // Background pause (openclaw-stabilization M6) — released while the app is
  // backgrounded, re-acquired on foreground; see use-page-visible.ts's doc.
  const pageVisible = usePageVisible();

  // `openclawAvailable` is a dep even though this effect doesn't read it:
  // this view can stay mounted (open) across a desktop hidden->visible flip
  // while mode='on', and the bridge silently drops a status-subscribe sent
  // while hidden (remote-bridge.ts's `openclawVisible()` gate never attaches
  // it) — without this dep the subscription would never re-send once desktop
  // becomes visible again (same gap MobileWorkspace's own status effect has).
  useEffect(() => {
    if (!pageVisible) return;
    const unsubscribe = transport.onOpenClawStatus((s) => setStatus(s));
    transport.setOpenClawStatusSubscribed(true);
    return () => {
      unsubscribe();
      transport.setOpenClawStatusSubscribed(false);
    };
  }, [pageVisible, openclawAvailable, transport]);

  const runLifecycle = useCallback(
    (action: OpenClawLifecycleAction) => {
      setBusyAction(action);
      setLifecycleError(null);
      void transport.runOpenClawLifecycle(action).then((result) => {
        setBusyAction(null);
        if (result.ok) {
          // A successful restart applies whatever config change was pending
          // (openclaw-stabilization M6's one-tap "지금 재시작") — clear the
          // banner regardless of which button triggered the restart.
          if (action === 'restart') setRestartBanner(false);
        } else {
          setLifecycleError(result.stderr || t('mobile.openClaw.actionFailed'));
        }
      });
    },
    [t, transport],
  );

  const busy = busyAction !== null;
  const state = status?.state;
  const canStart = !busy && state !== 'running' && state !== 'not-installed' && state !== 'starting';
  const canStop = !busy && state === 'running';
  const canRestart = !busy && state === 'running';

  // ── Logs tab (M4): subscribes only while this tab is active. ─────────────
  const [logs, setLogs] = useState<OpenClawLogLine[]>([]);
  const logsActive = tab === 'logs';
  // Background pause (M6): combine tab-gating with page visibility — the tab
  // being active isn't enough on its own once the app is backgrounded.
  const logsSubscribed = logsActive && pageVisible;
  const logsEndRef = useRef<HTMLDivElement | null>(null);

  // `openclawAvailable` dep — same self-healing reasoning as the status
  // effect above: a desktop hidden->visible flip while this tab stays active
  // must re-send `openclaw-logs-subscribe`, or the bridge's silent hidden-
  // drop (remote-bridge.ts's `openclawVisible()` gate) leaves the log tail
  // dead until the tab is re-opened.
  useEffect(() => {
    if (!logsSubscribed) return;
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
  }, [logsSubscribed, openclawAvailable, transport]);

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
      const trimmed = value.trim();
      // Config save contract (openclaw-stabilization M6, matches the desktop
      // drawer): an empty/whitespace field is never sent (no change) — say
      // so inline instead of silently no-op'ing.
      if (!trimmed) {
        setConfigError(t('mobile.openClaw.enterValue'));
        return;
      }
      setConfigSaving(which);
      setConfigError(null);
      void transport.setOpenClawConfig(key, trimmed).then((result) => {
        setConfigSaving(null);
        if (result.ok) {
          setRestartBanner(true);
        } else {
          setConfigError(result.error || t('mobile.openClaw.saveFailed'));
        }
      });
    },
    [t, transport],
  );

  // ── Chat tab (M5): the gateway must be RUNNING before a ticket is worth
  // minting (status comes from the same subscription the Status tab already
  // holds), so a guidance+Start CTA (reusing `runLifecycle`/`canStart` above)
  // covers every non-running state instead of a ticket round trip that would
  // just come back unavailable. `chatReloadNonce` is bumped by both the
  // unavailable card's retry button and the loaded frame's reload button —
  // either always mints a BRAND NEW ticket (never reuses one; tickets are
  // single-use/60s TTL, see openclaw-proxy.ts's module doc), same as
  // activating the tab fresh does.
  const chatActive = tab === 'chat';
  const gatewayRunning = status?.state === 'running';
  const [chatState, setChatState] = useState<ChatState>({ kind: 'loading' });
  const [chatReloadNonce, setChatReloadNonce] = useState(0);
  const chatGenerationRef = useRef(0);
  const browserGenerationRef = useRef(0);
  const [browserBusy, setBrowserBusy] = useState(false);
  const [browserError, setBrowserError] = useState<ChatErrorReason | 'browser-open-failed' | null>(null);

  useEffect(() => {
    const generation = chatGenerationRef.current + 1;
    chatGenerationRef.current = generation;
    if (!chatActive || !gatewayRunning || !pageVisible) {
      setChatState({ kind: 'loading' });
      return;
    }
    let cancelled = false;
    setChatState({ kind: 'loading' });
    setBrowserError(null);
    void transport.getOpenClawChatTicket()
      .then((reply) => {
        if (cancelled || generation !== chatGenerationRef.current) return;
        if (!reply.ok) {
          setChatState({ kind: 'unavailable', reason: reply.reason });
          return;
        }
        const host = transport.connectedHost;
        if (!host) {
          setChatState({ kind: 'unavailable', reason: 'invalid-host' });
          return;
        }
        setChatState({
          kind: 'frame-loading',
          generation,
          url: buildChatUrl(host, reply.proxyPort, reply.ticket, reply.token),
        });
      })
      .catch(() => {
        if (!cancelled && generation === chatGenerationRef.current) {
          setChatState({ kind: 'unavailable', reason: 'gateway-unreachable' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [chatActive, gatewayRunning, chatReloadNonce, pageVisible, transport]);

  useEffect(() => {
    if (chatState.kind !== 'frame-loading') return;
    const { generation, url } = chatState;
    const timer = setTimeout(() => {
      if (generation !== chatGenerationRef.current) return;
      setChatState((current) => current.kind === 'frame-loading' && current.url === url
        ? { kind: 'unavailable', reason: 'frame-timeout' }
        : current);
    }, OPENCLAW_CHAT_FRAME_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [chatState]);

  const reloadChat = useCallback(() => {
    setBrowserError(null);
    setChatReloadNonce((n) => n + 1);
  }, []);

  // "브라우저로 열기" opens in a SEPARATE top-level browsing context (external
  // browser, its own cookie jar) — it must mint its OWN fresh ticket rather
  // than reusing the iframe's `chatState.url`. A ticket is single-use: by
  // the time the user reaches for this fallback, the iframe has already
  // redeemed (and thus burned) whichever ticket produced that URL, so
  // reusing it here would always come back "ticket invalid or expired".
  const openInBrowser = useCallback(() => {
    const generation = browserGenerationRef.current + 1;
    browserGenerationRef.current = generation;
    setBrowserBusy(true);
    setBrowserError(null);
    void transport.getOpenClawChatTicket()
      .then(async (reply) => {
        if (generation !== browserGenerationRef.current) return;
        if (!reply.ok) {
          setBrowserError(reply.reason);
          return;
        }
        const host = transport.connectedHost;
        if (!host) {
          setBrowserError('invalid-host');
          return;
        }
        await Browser.open({ url: buildChatUrl(host, reply.proxyPort, reply.ticket, reply.token) });
      })
      .catch(() => {
        if (generation === browserGenerationRef.current) setBrowserError('browser-open-failed');
      })
      .finally(() => {
        if (generation === browserGenerationRef.current) setBrowserBusy(false);
      });
  }, [transport]);

  useEffect(() => () => {
    chatGenerationRef.current += 1;
    browserGenerationRef.current += 1;
  }, []);

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as OpenClawTab)}
      className="mobile-openclaw-view"
      data-testid="mobile-openclaw-view"
    >
      <header className="mobile-openclaw-head">
        <button
          type="button"
          className="btn"
          onClick={onClose}
          aria-label={t('mobile.openClaw.close')}
          data-testid="mobile-openclaw-close"
        >
          <X aria-hidden="true" size={18} />
        </button>
        <TabList className="mobile-openclaw-tabs" label="OpenClaw">
          <Tab
            value="status"
            className={tab === 'status' ? 'mobile-openclaw-tab mobile-openclaw-tab--active' : 'mobile-openclaw-tab'}
            data-testid="openclaw-tab-status"
          >
            {t('mobile.openClaw.status')}
          </Tab>
          <Tab
            value="logs"
            className={tab === 'logs' ? 'mobile-openclaw-tab mobile-openclaw-tab--active' : 'mobile-openclaw-tab'}
            data-testid="openclaw-tab-logs"
          >
            {t('mobile.openClaw.logs')}
          </Tab>
          <Tab
            value="settings"
            className={tab === 'settings' ? 'mobile-openclaw-tab mobile-openclaw-tab--active' : 'mobile-openclaw-tab'}
            data-testid="openclaw-tab-settings"
          >
            {t('mobile.openClaw.settings')}
          </Tab>
          <Tab
            value="chat"
            className={tab === 'chat' ? 'mobile-openclaw-tab mobile-openclaw-tab--active' : 'mobile-openclaw-tab'}
            data-testid="openclaw-tab-chat"
          >
            {t('mobile.openClaw.chat')}
          </Tab>
        </TabList>
      </header>

      <div className="mobile-openclaw-body">
        <TabPanel value="status" className="mobile-openclaw-tab-panel">
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
                  <span data-testid="openclaw-status-label">{stateLabel(status.state)}</span>
                </div>
                {status.version && (
                  <div className="status-metric" data-testid="openclaw-status-version">
                    {t('mobile.openClaw.version', { version: status.version })}
                  </div>
                )}
                <div className="status-metric" data-testid="openclaw-status-port">
                  {t('mobile.openClaw.port', { port: status.port })}
                </div>

                {status.state === 'not-installed' && (
                  <div className="openclaw-guidance" data-testid="openclaw-guidance">
                    {t('mobile.openClaw.notInstalledGuide')}
                  </div>
                )}
                {status.state === 'stopped' && (
                  <div className="openclaw-guidance" data-testid="openclaw-guidance">
                    {t('mobile.openClaw.stoppedGuide')}
                  </div>
                )}
                {status.state === 'unknown' && (
                  <div className="openclaw-guidance" data-testid="openclaw-guidance">
                    {t('mobile.openClaw.unknownGuide')}
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
                    {busyAction === 'start' ? t('mobile.openClaw.starting') : t('mobile.openClaw.start')}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={!canStop}
                    onClick={() => runLifecycle('stop')}
                    data-testid="openclaw-btn-stop"
                  >
                    {busyAction === 'stop' ? t('mobile.openClaw.stopping') : t('mobile.openClaw.stop')}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={!canRestart}
                    onClick={() => runLifecycle('restart')}
                    data-testid="openclaw-btn-restart"
                  >
                    {busyAction === 'restart' ? t('mobile.openClaw.restarting') : t('mobile.openClaw.restart')}
                  </button>
                </div>
                {lifecycleError && (
                  <div className="openclaw-guidance openclaw-guidance--error" data-testid="openclaw-lifecycle-error">
                    {lifecycleError}
                  </div>
                )}
              </>
            ) : (
              <div className="status-loading">{t('mobile.openClaw.checking')}</div>
            )}
            </section>
          )}
        </TabPanel>

        <TabPanel value="logs" className="mobile-openclaw-tab-panel">
          {tab === 'logs' && (
            <section className="status-section openclaw-logs-section" data-testid="openclaw-logs-section">
            <h2 className="status-section-title">{t('mobile.openClaw.logs')}</h2>
            <div className="openclaw-log-list" data-testid="openclaw-log-list">
              {logs.length === 0 ? (
                <div className="status-loading">{t('mobile.openClaw.waitingLogs')}</div>
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
        </TabPanel>

        <TabPanel value="settings" className="mobile-openclaw-tab-panel">
          {tab === 'settings' && (
            <section className="status-section" data-testid="openclaw-settings-section">
            <h2 className="status-section-title">{t('mobile.openClaw.settings')}</h2>
            {restartBanner && (
              <div className="openclaw-guidance" data-testid="openclaw-restart-banner">
                {t('mobile.openClaw.restartGuide')}
                <div className="openclaw-lifecycle-buttons">
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => runLifecycle('restart')}
                    data-testid="openclaw-restart-now"
                  >
                    {busyAction === 'restart' ? t('mobile.openClaw.restarting') : t('mobile.openClaw.restartNow')}
                  </button>
                </div>
                {lifecycleError && (
                  <div className="openclaw-guidance openclaw-guidance--error" data-testid="openclaw-restart-error">
                    {lifecycleError}
                  </div>
                )}
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
                  <span>{t('mobile.openClaw.defaultModel')}</span>
                  <input
                    type="text"
                    value={modelDraft}
                    placeholder={t('mobile.openClaw.unset')}
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
                    {configSaving === 'model' ? t('mobile.openClaw.saving') : t('mobile.openClaw.save')}
                  </button>
                </label>
                <label className="openclaw-config-row">
                  <span>{t('mobile.openClaw.gatewayPort')}</span>
                  <input
                    type="text"
                    value={portDraft}
                    placeholder={t('mobile.openClaw.unset')}
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
                    {configSaving === 'port' ? t('mobile.openClaw.saving') : t('mobile.openClaw.save')}
                  </button>
                </label>
              </>
            ) : (
              <div className="status-loading">{t('common.loading')}</div>
            )}
            </section>
          )}
        </TabPanel>

        <TabPanel value="chat" className="mobile-openclaw-tab-panel">
          {tab === 'chat' && (
            <section className="status-section openclaw-chat-section" data-testid="openclaw-chat-section">
            {!status ? (
              <div className="status-loading">{t('mobile.openClaw.checking')}</div>
            ) : !gatewayRunning ? (
              <div className="openclaw-guidance" data-testid="openclaw-chat-guidance">
                {t('mobile.openClaw.chatRequiresGateway', { state: stateLabel(status.state) })}
                <div className="openclaw-lifecycle-buttons">
                  <button
                    type="button"
                    className="btn"
                    disabled={!canStart}
                    onClick={() => runLifecycle('start')}
                    data-testid="openclaw-chat-start"
                  >
                    {busyAction === 'start' ? t('mobile.openClaw.starting') : t('mobile.openClaw.start')}
                  </button>
                </div>
              </div>
            ) : chatState.kind === 'loading' ? (
              <div className="status-loading" data-testid="openclaw-chat-loading">{t('mobile.openClaw.loadingChat')}</div>
            ) : chatState.kind === 'unavailable' ? (
              <div
                className="openclaw-guidance openclaw-guidance--error"
                data-error-reason={chatState.reason}
                data-testid="openclaw-chat-unavailable"
              >
                {t('mobile.openClaw.chatUnavailable')}
                <code className="openclaw-chat-error-code">{chatState.reason}</code>
                <div className="openclaw-lifecycle-buttons">
                  <button type="button" className="btn" onClick={reloadChat} data-testid="openclaw-chat-retry">
                    {t('common.retry')}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={browserBusy}
                    onClick={openInBrowser}
                    data-testid="openclaw-chat-open-browser"
                  >
                    {browserBusy ? t('mobile.openClaw.loadingChat') : t('mobile.openClaw.openBrowser')}
                  </button>
                </div>
                {browserError && <code className="openclaw-chat-error-code">{browserError}</code>}
              </div>
            ) : (
              <div className="openclaw-chat-frame-wrap">
                <div className="openclaw-chat-frame-stage">
                  {chatState.kind === 'frame-loading' && (
                    <div
                      className="status-loading openclaw-chat-frame-loading"
                      role="status"
                      data-testid="openclaw-chat-frame-loading"
                    >
                      {t('mobile.openClaw.loadingChat')}
                    </div>
                  )}
                  <iframe
                    key={chatState.url}
                    className={chatState.kind === 'frame-loading'
                      ? 'openclaw-chat-frame openclaw-chat-frame--loading'
                      : 'openclaw-chat-frame'}
                    src={chatState.url}
                    title="OpenClaw Control"
                    onLoad={() => setChatState((current) => (
                      current.kind === 'frame-loading' && current.url === chatState.url
                        ? { kind: 'ready', url: current.url, generation: current.generation }
                        : current
                    ))}
                    onError={() => setChatState((current) => (
                      current.kind === 'frame-loading' && current.url === chatState.url
                        ? { kind: 'unavailable', reason: 'frame-error' }
                        : current
                    ))}
                    data-testid="openclaw-chat-frame"
                  />
                </div>
                <div className="openclaw-chat-toolbar">
                  <button type="button" className="btn" onClick={reloadChat} data-testid="openclaw-chat-reload">
                    {t('mobile.openClaw.reload')}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={browserBusy}
                    onClick={openInBrowser}
                    data-testid="openclaw-chat-open-browser"
                  >
                    {browserBusy ? t('mobile.openClaw.loadingChat') : t('mobile.openClaw.openBrowser')}
                  </button>
                </div>
                {browserError && (
                  <div
                    className="openclaw-guidance openclaw-guidance--error"
                    data-error-reason={browserError}
                    data-testid="openclaw-browser-error"
                  >
                    {t('mobile.openClaw.chatUnavailable')}
                    <code className="openclaw-chat-error-code">{browserError}</code>
                  </div>
                )}
              </div>
            )}
            </section>
          )}
        </TabPanel>
      </div>
    </Tabs>
  );
}
