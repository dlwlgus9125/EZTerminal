import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { TFunction } from 'i18next';

import type {
  AgentCapabilityCatalog,
  AgentCapabilityItem,
  AgentCapabilityResult,
  AgentExtensionAction,
  AgentExtensionReceipt,
  AgentHostCommand,
  AgentHostExtensionsClient,
  AgentMarketplace,
  AgentPluginBrowsePage,
  AgentPluginEntry,
} from '../shared/agent-capabilities';
import type { AgentCliBlocker, AgentCliClient, AgentCliStatus, AgentCliUpdateResult } from '../shared/agent-cli';
import type { DaemonSnapshot } from '../shared/daemon-protocol';
import { useAppTranslation } from './i18n';
import {
  Badge,
  Button,
  Dialog,
  ErrorState,
  Field,
  Glyph,
  Input,
  Led,
  LoadingState,
  Select,
  Status,
  Switch,
  Tab,
  TabList,
  TabPanel,
  Tabs,
} from './ui';
import './agent-management-settings.css';

export type AgentManagementProviderId = 'claude' | 'codex';

export interface AgentManagementProviderState {
  /** Turned on under "Chat in app"; managing extensions needs it. */
  readonly enabled: boolean;
  /** Installed program version the PC reported, shown where there is no update control. */
  readonly version?: string;
}

/** An app project a Claude plugin can be installed into. */
export interface AgentManagementProject {
  readonly workspaceId: string;
  readonly name: string;
  readonly path: string;
}

export interface AgentManagementSettingsProps {
  readonly variant: 'desktop' | 'mobile';
  /** App projects offered as install targets for Claude plugins. */
  readonly projects?: readonly AgentManagementProject[];
  /** `null` when the connected PC app is too old to offer this screen. */
  readonly extensions: AgentHostExtensionsClient | null;
  /** Program status and update; the desktop app only. */
  readonly cli?: AgentCliClient;
  readonly providers: Readonly<Record<AgentManagementProviderId, AgentManagementProviderState>>;
  readonly initialProvider?: AgentManagementProviderId;
}

const PROVIDERS: readonly AgentManagementProviderId[] = ['claude', 'codex'];

/** What the screen needs from the PC's daemon snapshot: which AIs are usable and the app projects. */
export function agentManagementInputs(snapshot: Pick<DaemonSnapshot, 'providers' | 'projects' | 'workspaces'> | null): {
  readonly providers: Readonly<Record<AgentManagementProviderId, AgentManagementProviderState>>;
  readonly projects: readonly AgentManagementProject[];
} {
  const provider = (id: AgentManagementProviderId): AgentManagementProviderState => {
    const record = snapshot?.providers.find((entry) => entry.id === id);
    const version = record?.executableVersion && record.executableVersion !== 'unknown' ? record.executableVersion : undefined;
    return { enabled: record?.enabled === true && record.health === 'ready', ...(version ? { version } : {}) };
  };
  const projects: AgentManagementProject[] = [];
  for (const project of snapshot?.projects ?? []) {
    if (project.archivedAt || !project.rootPath) continue;
    const workspace = snapshot?.workspaces.find((entry) => entry.projectId === project.id && !entry.archivedAt && entry.kind === 'local')
      ?? snapshot?.workspaces.find((entry) => entry.projectId === project.id && !entry.archivedAt);
    if (workspace) projects.push({ workspaceId: workspace.id, name: project.name, path: workspace.rootPath });
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));
  return { providers: { claude: provider('claude'), codex: provider('codex') }, projects };
}
const PROVIDER_LABELS: Readonly<Record<AgentManagementProviderId, string>> = { claude: 'Claude Code', codex: 'Codex' };
const SEARCH_THRESHOLD = 10;
const BROWSE_PAGE = 30;
// Exact requests survive closing the section, so an unconfirmed change can be checked
// again with the same command id. MCP arguments stay in memory, never in storage.
const pendingByClient = new WeakMap<AgentHostExtensionsClient, Map<AgentManagementProviderId, AgentHostCommand>>();
const newCommandId = (): string => `extension-${Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, '0')).join('')}`;

export function AgentManagementSettings({
  variant,
  extensions,
  cli,
  providers,
  projects = [],
  initialProvider = 'claude',
}: AgentManagementSettingsProps): JSX.Element {
  const { t } = useAppTranslation();
  const [providerId, setProviderId] = useState<AgentManagementProviderId>(initialProvider);
  return (
    <section className="agent-management" data-variant={variant} aria-labelledby="agent-management-title" data-testid="agent-management">
      <div className="agent-settings-heading">
        <div>
          <h2 className="status-section-title" id="agent-management-title">{t('agentSettings.management.title')}</h2>
          <p>{t('agentSettings.management.description')}</p>
        </div>
      </div>
      <Tabs value={providerId} onValueChange={(value) => setProviderId(value as AgentManagementProviderId)}>
        <TabList label={t('agentSettings.management.providerTabs')}>
          {PROVIDERS.map((id) => <Tab key={id} value={id} data-testid={`agent-management-tab-${id}`}>{PROVIDER_LABELS[id]}</Tab>)}
        </TabList>
        {PROVIDERS.map((id) => (
          <TabPanel key={id} value={id}>
            {id === providerId && (
              <ProviderPanel
                providerId={id}
                variant={variant}
                extensions={extensions}
                cli={variant === 'desktop' ? cli : undefined}
                state={providers[id]}
                projects={projects}
              />
            )}
          </TabPanel>
        ))}
      </Tabs>
    </section>
  );
}

interface ProviderPanelProps {
  readonly providerId: AgentManagementProviderId;
  readonly variant: 'desktop' | 'mobile';
  readonly extensions: AgentHostExtensionsClient | null;
  readonly cli: AgentCliClient | undefined;
  readonly state: AgentManagementProviderState;
  readonly projects: readonly AgentManagementProject[];
}

function ProviderPanel({ providerId, variant, extensions, cli, state, projects }: ProviderPanelProps): JSX.Element {
  const { t } = useAppTranslation();
  const name = PROVIDER_LABELS[providerId];
  return (
    <div className="agent-management__panel" data-testid={`agent-management-${providerId}`}>
      <ProgramGroup providerId={providerId} cli={cli} version={state.version} />
      {extensions === null
        ? <p className="agent-management__notice" role="status">{t('agentSettings.management.unsupportedHost')}</p>
        : !state.enabled
          ? (
            <p className="agent-management__notice" role="status" data-testid="agent-management-not-enabled">
              {t('agentSettings.management.notEnabled', { provider: name })}{' '}
              {variant === 'desktop' ? t('agentSettings.management.notEnabledDesktop') : t('agentSettings.management.notEnabledMobile')}
            </p>
          )
          : <ExtensionGroups providerId={providerId} client={extensions} variant={variant} projects={projects} />}
    </div>
  );
}

// == PROGRAM ==

function blockerText(t: TFunction, blocker: AgentCliBlocker): string {
  switch (blocker.kind) {
    case 'running': return t('agentSettings.management.blockedRunning');
    case 'not-npm': return t('agentSettings.management.blockedNotNpm');
    case 'prefix-mismatch': return t('agentSettings.management.blockedPrefix');
    case 'policy': return t('agentSettings.management.blockedPolicy');
    case 'incompatible': return t('agentSettings.management.blockedIncompatible', { version: blocker.version });
  }
}

function ProgramGroup({ providerId, cli, version }: {
  readonly providerId: AgentManagementProviderId;
  readonly cli: AgentCliClient | undefined;
  readonly version: string | undefined;
}): JSX.Element {
  const { t } = useAppTranslation();
  const name = PROVIDER_LABELS[providerId];
  const [status, setStatus] = useState<AgentCliStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [result, setResult] = useState<AgentCliUpdateResult | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);

  const load = useCallback(async (refreshLatest: boolean): Promise<void> => {
    if (!cli) return;
    const current = ++generation.current;
    setChecking(true);
    setCheckFailed(false);
    try {
      const next = await cli.status(providerId, { refreshLatest });
      if (current !== generation.current) return;
      if (next) setStatus(next); else setCheckFailed(true);
    } catch {
      if (current === generation.current) setCheckFailed(true);
    } finally {
      if (current === generation.current) setChecking(false);
    }
  }, [cli, providerId]);

  useEffect(() => {
    setStatus(null);
    setResult(null);
    void load(false);
    return () => { generation.current += 1; };
  }, [load]);

  const update = async (): Promise<void> => {
    if (!cli || updating) return;
    setConfirming(false);
    setUpdating(true);
    setResult(null);
    try {
      setResult(await cli.update(providerId) ?? { ok: false, code: 'unavailable' });
    } catch {
      setResult({ ok: false, code: 'unavailable' });
    } finally {
      setUpdating(false);
      await load(false);
    }
  };

  if (!cli) {
    return (
      <section className="agent-management__group" aria-labelledby={`agent-program-${providerId}`}>
        <h3 id={`agent-program-${providerId}`}>{t('agentSettings.management.programTitle')}</h3>
        <div className="agent-management__row">
          <div className="agent-management__copy">
            <strong>{name}</strong>
            <span>{version ? <code>{version}</code> : t('agentSettings.management.versionUnknown')}</span>
          </div>
        </div>
        <p className="settings-hint">{t('agentSettings.management.programOnPc')}</p>
      </section>
    );
  }

  const running = status?.blockers.find((blocker): blocker is Extract<AgentCliBlocker, { kind: 'running' }> => blocker.kind === 'running');
  const otherBlockers = status?.blockers.filter((blocker) => blocker.kind !== 'running') ?? [];
  const busy = updating || status?.updating === true;
  const canUpdate = Boolean(status?.updateAvailable && status.blockers.length === 0 && !busy && !checking);
  const showManual = Boolean(status && (status.installedVersion === null || otherBlockers.some((blocker) => blocker.kind === 'not-npm' || blocker.kind === 'prefix-mismatch')));

  let statusNode: JSX.Element;
  if (busy) statusNode = <Status variant="loading">{t('agentSettings.management.updating')}</Status>;
  else if (!status) statusNode = checkFailed
    ? <Status variant="warning">{t('agentSettings.management.versionCheckFailed')}</Status>
    : <Status variant="loading">{t('agentSettings.management.versionChecking')}</Status>;
  else if (status.installedVersion === null) statusNode = <Status variant="neutral">{t('agentSettings.management.notInstalled')}</Status>;
  else if (status.latestVersion === null) statusNode = <Status variant="warning">{t('agentSettings.management.latestUnknown')}</Status>;
  else if (status.updateAvailable) statusNode = <Status variant="info">{t('agentSettings.management.updateAvailable', { version: status.latestVersion })}</Status>;
  else statusNode = <Status variant="success">{t('agentSettings.management.upToDate')}</Status>;

  return (
    <section className="agent-management__group" aria-labelledby={`agent-program-${providerId}`} data-testid={`agent-program-${providerId}`}>
      <h3 id={`agent-program-${providerId}`}>{t('agentSettings.management.programTitle')}</h3>
      <div className="agent-management__row" aria-busy={checking || busy || undefined}>
        <div className="agent-management__copy">
          <strong>{name}</strong>
          <span>
            {status?.installedVersion
              ? <>{t('agentSettings.management.installedVersion')} <code>{status.installedVersion}</code></>
              : null}
            {status?.latestVersion && status.installedVersion !== status.latestVersion
              ? <> · {t('agentSettings.management.latestVersion')} <code>{status.latestVersion}</code></>
              : null}
          </span>
        </div>
        {statusNode}
        <div className="agent-management__actions">
          <Button size="sm" variant="ghost" leadingIcon={<Glyph name="refresh" size={14} />} disabled={busy}
            loading={checking} loadingLabel={t('agentSettings.management.versionChecking')}
            onClick={() => void load(true)} data-testid={`agent-program-check-${providerId}`}>
            {t('agentSettings.management.checkAgain')}
          </Button>
          {status?.updateAvailable && (
            <Button size="sm" variant="primary" leadingIcon={<Glyph name="download" size={14} />} disabled={!canUpdate}
              loading={busy} loadingLabel={t('agentSettings.management.updating')}
              onClick={() => setConfirming(true)} data-testid={`agent-program-update-${providerId}`}>
              {t('agentSettings.management.update')}
            </Button>
          )}
        </div>
      </div>

      {running && (
        <div className="agent-management__notice" data-tone="warning" role="status" data-testid={`agent-program-running-${providerId}`}>
          <strong>{t('agentSettings.management.blockedRunning')}</strong>
          <ul>
            {running.locations.map((location, index) => (
              <li key={`${location.kind}:${location.label ?? index}`}>
                {location.kind === 'conversation'
                  ? t('agentSettings.management.runningConversation', { label: location.label ?? name })
                  : location.kind === 'terminal'
                    ? t('agentSettings.management.runningTerminal', { label: location.label ?? '' })
                    : t('agentSettings.management.runningOutside')}
              </li>
            ))}
          </ul>
          <p>{t('agentSettings.management.runningHint')}</p>
        </div>
      )}
      {otherBlockers.map((blocker) => (
        <p className="agent-management__notice" data-tone="warning" role="status" key={blocker.kind}>{blockerText(t, blocker)}</p>
      ))}
      {showManual && status && (
        <p className="settings-hint">
          {status.installedVersion === null ? t('agentSettings.management.installHint') : t('agentSettings.management.manualHint')}{' '}
          <code className="agent-management__command">{status.manualCommand}</code>
        </p>
      )}
      {result && <UpdateResult result={result} providerName={name} />}

      <Dialog
        open={confirming}
        onOpenChange={(open) => { if (!open) setConfirming(false); }}
        title={t('agentSettings.management.updateConfirmTitle', { provider: name, version: status?.latestVersion ?? '' })}
        description={t('agentSettings.management.updateConfirmDescription')}
        size="sm"
        initialFocusRef={cancelRef}
        closeLabel={t('common.cancel')}
        testId="agent-program-update-dialog"
        footer={(
          <>
            <Button ref={cancelRef} variant="secondary" onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={() => void update()} data-testid="agent-program-update-confirm">{t('agentSettings.management.update')}</Button>
          </>
        )}
      >
        <p className="settings-hint">{t('agentSettings.management.updateConfirmIdle')}</p>
      </Dialog>
    </section>
  );
}

function UpdateResult({ result, providerName }: { readonly result: AgentCliUpdateResult; readonly providerName: string }): JSX.Element {
  const { t } = useAppTranslation();
  if (result.ok) {
    const text = result.provider === 'needs-review'
      ? t('agentSettings.management.updatedNeedsReview', { version: result.version })
      : t('agentSettings.management.updated', { provider: providerName, version: result.version });
    return <p className="agent-management__notice" data-tone={result.provider === 'needs-review' ? 'warning' : 'success'} role="status">{text}</p>;
  }
  return (
    <div className="agent-management__notice" data-tone="danger" role="alert">
      <strong>{result.code === 'blocked' ? t('agentSettings.management.blockedRunning') : t('agentSettings.management.updateFailed')}</strong>
      {result.detail && <p><code className="agent-management__command">{result.detail}</code></p>}
      {result.manualCommand && <p>{t('agentSettings.management.manualHint')} <code className="agent-management__command">{result.manualCommand}</code></p>}
    </div>
  );
}

// == EXTENSIONS ==

function failureText(t: TFunction, failure: Extract<AgentCapabilityResult<unknown>, { ok: false }>): string {
  switch (failure.code) {
    case 'stale': return t('agentSettings.management.failureStale');
    case 'forbidden': return t('agentSettings.management.failureForbidden');
    case 'invalid-input': return t('agentSettings.management.failureInvalid');
    case 'unsupported': return t('agentSettings.management.unsupportedHost');
    case 'uncertain': return t('agentSettings.management.uncertain');
    case 'unavailable': return t('agentSettings.management.failureUnavailable');
  }
}

type ManageRequest = Pick<AgentHostCommand, 'action' | 'target'> & Partial<Pick<AgentHostCommand, 'mcp' | 'scope' | 'workspaceId'>>;
type InstallScope = Pick<AgentHostCommand, 'scope' | 'workspaceId'>;

/** A project install is changed in its own project; everything else PC-wide. */
function itemScope(item: AgentCapabilityItem): InstallScope {
  return (item.scope === 'project' || item.scope === 'local') && item.workspaceId
    ? { scope: item.scope, workspaceId: item.workspaceId }
    : { scope: 'user' };
}

type Confirmation =
  | { readonly kind: 'remove'; readonly action: 'plugin-remove' | 'marketplace-remove' | 'mcp-remove'; readonly target: string; readonly name: string; readonly scope?: InstallScope };

function ExtensionGroups({ providerId, client, variant, projects }: {
  readonly providerId: AgentManagementProviderId;
  readonly client: AgentHostExtensionsClient;
  readonly variant: 'desktop' | 'mobile';
  readonly projects: readonly AgentManagementProject[];
}): JSX.Element {
  const { t } = useAppTranslation();
  const [catalog, setCatalog] = useState<AgentCapabilityCatalog>();
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string>();
  const [message, setMessage] = useState<{ readonly tone: 'success' | 'warning' | 'danger'; readonly text: string }>();
  const [busyTarget, setBusyTarget] = useState<string>();
  const [pending, setPending] = useState<AgentHostCommand | undefined>(() => pendingByClient.get(client)?.get(providerId));
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [browsing, setBrowsing] = useState(false);
  const generation = useRef(0);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const remember = useCallback((command: AgentHostCommand | undefined): void => {
    let entries = pendingByClient.get(client);
    if (!entries) { entries = new Map(); pendingByClient.set(client, entries); }
    if (command) entries.set(providerId, command); else entries.delete(providerId);
    setPending(command);
  }, [client, providerId]);

  const refresh = useCallback(async (): Promise<void> => {
    const current = ++generation.current;
    setLoading(true);
    setListError(undefined);
    try {
      const result = await client.list({ providerId });
      if (current !== generation.current) return;
      if (result.ok) setCatalog(result.value); else setListError(failureText(t, result));
    } catch {
      if (current === generation.current) setListError(t('agentSettings.management.failureUnavailable'));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [client, providerId, t]);

  useEffect(() => {
    setCatalog(undefined);
    setMessage(undefined);
    void refresh();
    return () => { generation.current += 1; };
  }, [refresh]);

  useEffect(() => client.onChanged?.((changed) => { if (changed === providerId) void refresh(); }), [client, providerId, refresh]);

  const recoveredPending = catalog?.extensionReceipts?.find((receipt) => receipt.state === 'uncertain' && receipt.commandId !== pending?.commandId);
  const locked = Boolean(busyTarget || pending || recoveredPending);

  const send = async (command: AgentHostCommand, busyKey: string): Promise<boolean> => {
    setBusyTarget(busyKey);
    setMessage(undefined);
    remember(command);
    try {
      const result = await client.manage(command);
      if ((result.ok && result.value.state === 'applied') || (!result.ok && result.code !== 'uncertain')) remember(undefined);
      if (!result.ok) setMessage({ tone: 'danger', text: failureText(t, result) });
      else setMessage(result.value.state === 'applied'
        ? { tone: 'success', text: t('agentSettings.management.applied') }
        : { tone: 'warning', text: t('agentSettings.management.uncertain') });
      await refresh();
      return result.ok && result.value.state === 'applied';
    } catch {
      setMessage({ tone: 'danger', text: t('agentSettings.management.connectionLost') });
      return false;
    } finally {
      setBusyTarget(undefined);
    }
  };

  const manage = async (request: ManageRequest): Promise<boolean> => {
    if (!catalog || locked) return false;
    return send({
      providerId,
      commandId: newCommandId(),
      expectedRevision: catalog.revision,
      scope: 'user',
      ...request,
    }, `${request.action}:${request.target}`);
  };

  const recover = async (receipt: Pick<AgentExtensionReceipt, 'commandId' | 'action'>, recovery: 'inspect' | 'acknowledge'): Promise<void> => {
    if (!catalog || busyTarget) return;
    setBusyTarget('recovery');
    try {
      const result = await client.manage({ providerId, commandId: receipt.commandId, action: receipt.action, target: 'receipt', scope: 'user', expectedRevision: catalog.revision, recovery });
      if (!result.ok) setMessage({ tone: 'danger', text: failureText(t, result) });
      else {
        if (recovery === 'acknowledge' && pending?.commandId === receipt.commandId) remember(undefined);
        setMessage(result.value.state === 'applied'
          ? { tone: 'success', text: t('agentSettings.management.recoveredApplied') }
          : { tone: 'warning', text: t('agentSettings.management.uncertain') });
      }
      await refresh();
    } catch {
      setMessage({ tone: 'danger', text: t('agentSettings.management.connectionLost') });
    } finally {
      setBusyTarget(undefined);
    }
  };

  if (!catalog) {
    if (listError) {
      return (
        <ErrorState
          title={t('agentSettings.management.listFailed')}
          description={listError}
          action={<Button size="sm" onClick={() => void refresh()}>{t('common.retry')}</Button>}
        />
      );
    }
    return <LoadingState label={t('agentSettings.management.listLoading')} />;
  }

  const items = catalog.items;
  const plugins = items.filter((item) => item.kind === 'plugin');
  const mcp = items.filter((item) => item.kind === 'mcp');
  const skills = items.filter((item) => item.kind === 'skill');
  const can = (action: AgentExtensionAction): boolean => catalog.actions.includes(action);
  const unconfirmed = pending ?? recoveredPending;

  return (
    <div className="agent-management__extensions" aria-busy={loading || undefined}>
      <div className="agent-management__toolbar">
        <span className="settings-hint">{t('agentSettings.management.scopeHint')}</span>
        <Button size="sm" variant="ghost" leadingIcon={<Glyph name="refresh" size={14} />} loading={loading}
          loadingLabel={t('agentSettings.management.listLoading')} onClick={() => void refresh()}
          data-testid={`agent-management-refresh-${providerId}`}>
          {t('agentSettings.management.refresh')}
        </Button>
      </div>
      {listError && <p className="agent-management__notice" data-tone="danger" role="alert">{listError}</p>}
      {unconfirmed && (
        <div className="agent-management__notice" data-tone="warning" role="status" data-testid="agent-management-unconfirmed">
          <strong>{t('agentSettings.management.unconfirmedTitle')}</strong>
          <p>{t(`agentSettings.management.action.${unconfirmed.action}`)}{'target' in unconfirmed && unconfirmed.target !== 'receipt' ? ` · ${unconfirmed.target}` : ''}</p>
          <div className="agent-management__actions">
            {pending && <Button size="sm" disabled={Boolean(busyTarget)} onClick={() => void send(pending, 'recovery')}>{t('agentSettings.management.checkSameRequest')}</Button>}
            {!pending && recoveredPending && <Button size="sm" disabled={Boolean(busyTarget)} onClick={() => void recover(recoveredPending, 'inspect')}>{t('agentSettings.management.checkSavedResult')}</Button>}
            <Button size="sm" variant="ghost" disabled={Boolean(busyTarget)} onClick={() => void recover(unconfirmed, 'acknowledge')}>{t('agentSettings.management.acknowledge')}</Button>
          </div>
        </div>
      )}
      {message && <p className="agent-management__notice" data-tone={message.tone} role={message.tone === 'danger' ? 'alert' : 'status'}>{message.text}</p>}

      <PluginGroup
        providerId={providerId}
        plugins={plugins}
        projects={projects}
        canBrowse={can('plugin-install')}
        busyTarget={busyTarget}
        locked={locked}
        onBrowse={() => setBrowsing(true)}
        onToggle={(item) => void manage({ action: item.enabled ? 'plugin-disable' : 'plugin-enable', target: item.id, ...itemScope(item) })}
        onUpdate={(item) => void manage({ action: 'plugin-update', target: item.id, ...itemScope(item) })}
        onRemove={(item) => setConfirmation({ kind: 'remove', action: 'plugin-remove', target: item.id, name: item.name, scope: itemScope(item) })}
      />
      <MarketplaceGroup
        marketplaces={catalog.marketplaces ?? []}
        canAdd={can('marketplace-add')}
        busyTarget={busyTarget}
        locked={locked}
        onAdd={(source) => manage({ action: 'marketplace-add', target: source })}
        onUpdate={(marketplace) => void manage({ action: 'marketplace-update', target: marketplace.name })}
        onRemove={(marketplace) => setConfirmation({ kind: 'remove', action: 'marketplace-remove', target: marketplace.name, name: marketplace.name })}
      />
      <McpGroup
        servers={mcp}
        canAdd={can('mcp-add')}
        busyTarget={busyTarget}
        locked={locked}
        onAdd={(name, server) => manage({ action: 'mcp-add', target: name, mcp: server })}
        onRemove={(item) => setConfirmation({ kind: 'remove', action: 'mcp-remove', target: item.id, name: item.name })}
      />
      <SkillGroup
        providerId={providerId}
        skills={skills}
        busyTarget={busyTarget}
        locked={locked}
        onToggle={(item) => void manage({ action: item.enabled ? 'skill-disable' : 'skill-enable', target: item.id })}
      />

      <Dialog
        open={confirmation !== undefined}
        onOpenChange={(open) => { if (!open) setConfirmation(undefined); }}
        role="alertdialog"
        tone="danger"
        size="sm"
        icon={<Glyph name="warn" size={20} />}
        title={confirmation ? t(`agentSettings.management.confirm.${confirmation.action}.title`, { name: confirmation.name }) : ''}
        description={confirmation ? t(`agentSettings.management.confirm.${confirmation.action}.description`) : undefined}
        initialFocusRef={cancelRef}
        closeLabel={t('common.cancel')}
        testId="agent-management-remove-dialog"
        footer={(
          <>
            <Button ref={cancelRef} variant="secondary" onClick={() => setConfirmation(undefined)}>{t('common.cancel')}</Button>
            <Button variant="danger" data-testid="agent-management-remove-confirm" onClick={() => {
              if (!confirmation) return;
              const { action, target, scope } = confirmation;
              setConfirmation(undefined);
              void manage({ action, target, ...scope });
            }}>
              {confirmation ? t(`agentSettings.management.action.${confirmation.action}`) : ''}
            </Button>
          </>
        )}
      >
        {null}
      </Dialog>

      {browsing && (
        <PluginBrowser
          providerId={providerId}
          client={client}
          variant={variant}
          projects={projects}
          locked={locked}
          onClose={() => setBrowsing(false)}
          onInstall={(entry, scope) => manage({ action: 'plugin-install', target: entry.id, ...scope })}
        />
      )}
    </div>
  );
}

function GroupHeading({ id, title, count, children }: {
  readonly id: string;
  readonly title: string;
  readonly count: number;
  readonly children?: ReactNode;
}): JSX.Element {
  return (
    <div className="agent-management__group-heading">
      <h3 id={id}>{title} <Badge size="sm">{count}</Badge></h3>
      {children}
    </div>
  );
}

function ItemCopy({ name, meta, description }: { readonly name: string; readonly meta?: ReactNode; readonly description?: string }): JSX.Element {
  return (
    <div className="agent-management__copy">
      <strong>{name}</strong>
      {meta && <span>{meta}</span>}
      {description && <span className="agent-management__description">{description}</span>}
    </div>
  );
}

function useFilter<T extends { readonly name: string; readonly description?: string }>(items: readonly T[]): {
  readonly query: string;
  readonly setQuery: (query: string) => void;
  readonly visible: readonly T[];
  readonly searchable: boolean;
} {
  const [query, setQuery] = useState('');
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return items;
    return items.filter((item) => `${item.name} ${item.description ?? ''}`.toLocaleLowerCase().includes(needle));
  }, [items, query]);
  return { query, setQuery, visible, searchable: items.length > SEARCH_THRESHOLD };
}

function projectName(path: string | undefined, workspaceId: string | undefined, projects: readonly AgentManagementProject[]): string {
  const project = projects.find((entry) => entry.workspaceId === workspaceId);
  if (project) return project.name;
  return path?.split(/[\\/]/u).filter(Boolean).pop() ?? '';
}

function scopeLabel(t: TFunction, item: AgentCapabilityItem, projects: readonly AgentManagementProject[]): string {
  if (item.scope !== 'project' && item.scope !== 'local') return t('agentSettings.management.itemScope.user');
  const project = projectName(item.projectPath, item.workspaceId, projects);
  const label = item.scope === 'project'
    ? t('agentSettings.management.itemScope.project', { project })
    : t('agentSettings.management.itemScope.local', { project });
  return item.workspaceId ? label : `${label} (${t('agentSettings.management.itemUnmanaged')})`;
}

function PluginGroup({ providerId, plugins, projects, canBrowse, busyTarget, locked, onBrowse, onToggle, onUpdate, onRemove }: {
  readonly providerId: AgentManagementProviderId;
  readonly plugins: readonly AgentCapabilityItem[];
  readonly projects: readonly AgentManagementProject[];
  readonly canBrowse: boolean;
  readonly busyTarget: string | undefined;
  readonly locked: boolean;
  readonly onBrowse: () => void;
  readonly onToggle: (item: AgentCapabilityItem) => void;
  readonly onUpdate: (item: AgentCapabilityItem) => void;
  readonly onRemove: (item: AgentCapabilityItem) => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const id = `agent-plugins-${providerId}`;
  return (
    <section className="agent-management__group" aria-labelledby={id} data-testid={`agent-plugins-${providerId}`}>
      <GroupHeading id={id} title={t('agentSettings.management.pluginsTitle')} count={plugins.length}>
        {canBrowse && (
          <Button size="sm" leadingIcon={<Glyph name="search" size={14} />} disabled={locked} onClick={onBrowse} data-testid={`agent-plugins-browse-${providerId}`}>
            {t('agentSettings.management.browse')}
          </Button>
        )}
      </GroupHeading>
      {plugins.length === 0 && <p className="settings-hint">{t('agentSettings.management.pluginsEmpty')}</p>}
      <ul className="agent-management__list">
        {plugins.map((item) => {
          const toggle = item.actions.includes(item.enabled ? 'plugin-disable' : 'plugin-enable');
          return (
            <li className="agent-management__row" key={item.id} data-testid={`agent-plugin-${item.id}`} aria-busy={busyTarget?.endsWith(`:${item.id}`) || undefined}>
              <ItemCopy
                name={item.name}
                meta={[scopeLabel(t, item, projects), item.source, item.version ? `v${item.version}` : undefined].filter(Boolean).join(' · ')}
                description={item.description}
              />
              <div className="agent-management__actions">
                {toggle && (
                  <Switch
                    label={t('agentSettings.management.use')}
                    aria-label={t('agentSettings.management.useItem', { name: item.name })}
                    checked={item.enabled}
                    disabled={locked}
                    onChange={() => onToggle(item)}
                  />
                )}
                {item.actions.includes('plugin-update') && (
                  <Button size="sm" variant="ghost" disabled={locked} onClick={() => onUpdate(item)}>{t('agentSettings.management.action.plugin-update')}</Button>
                )}
                {item.actions.includes('plugin-remove') && (
                  <Button size="sm" variant="ghost" leadingIcon={<Glyph name="trash" size={14} />} disabled={locked} onClick={() => onRemove(item)}
                    aria-label={t('agentSettings.management.removeItem', { name: item.name })}>
                    {t('agentSettings.management.remove')}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function MarketplaceGroup({ marketplaces, canAdd, busyTarget, locked, onAdd, onUpdate, onRemove }: {
  readonly marketplaces: readonly AgentMarketplace[];
  readonly canAdd: boolean;
  readonly busyTarget: string | undefined;
  readonly locked: boolean;
  readonly onAdd: (source: string) => Promise<boolean>;
  readonly onUpdate: (marketplace: AgentMarketplace) => void;
  readonly onRemove: (marketplace: AgentMarketplace) => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const [source, setSource] = useState('');
  return (
    <section className="agent-management__group" aria-labelledby="agent-marketplaces" data-testid="agent-marketplaces">
      <GroupHeading id="agent-marketplaces" title={t('agentSettings.management.marketplacesTitle')} count={marketplaces.length} />
      {marketplaces.length === 0 && <p className="settings-hint">{t('agentSettings.management.marketplacesEmpty')}</p>}
      <ul className="agent-management__list">
        {marketplaces.map((marketplace) => (
          <li className="agent-management__row" key={marketplace.name} data-testid={`agent-marketplace-${marketplace.name}`} aria-busy={busyTarget?.endsWith(`:${marketplace.name}`) || undefined}>
            <ItemCopy name={marketplace.name} meta={marketplace.source ? <code>{marketplace.source}</code> : undefined} />
            <div className="agent-management__actions">
              {marketplace.actions.includes('marketplace-update') && (
                <Button size="sm" variant="ghost" leadingIcon={<Glyph name="refresh" size={14} />} disabled={locked} onClick={() => onUpdate(marketplace)}>
                  {t('agentSettings.management.action.marketplace-update')}
                </Button>
              )}
              {marketplace.actions.includes('marketplace-remove') && (
                <Button size="sm" variant="ghost" leadingIcon={<Glyph name="trash" size={14} />} disabled={locked} onClick={() => onRemove(marketplace)}
                  aria-label={t('agentSettings.management.removeItem', { name: marketplace.name })}>
                  {t('agentSettings.management.remove')}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {canAdd && (
        <details className="agent-management__disclosure" data-testid="agent-marketplace-add-disclosure">
          <summary>{t('agentSettings.management.action.marketplace-add')}</summary>
          <form className="agent-management__form" onSubmit={(event) => {
            event.preventDefault();
            const value = source.trim();
            if (!value) return;
            void onAdd(value).then((applied) => { if (applied) setSource(''); });
          }}>
            <Field label={t('agentSettings.management.marketplaceSource')} description={t('agentSettings.management.marketplaceSourceHint')}>
              <Input value={source} onChange={(event) => setSource(event.target.value)} placeholder="owner/repo" maxLength={2_048} data-testid="agent-marketplace-source" />
            </Field>
            <Button type="submit" size="sm" leadingIcon={<Glyph name="plus" size={14} />} disabled={locked || !source.trim()} data-testid="agent-marketplace-add">
              {t('agentSettings.management.action.marketplace-add')}
            </Button>
          </form>
        </details>
      )}
    </section>
  );
}

const MCP_STATUS = {
  connected: ['ok', 'agentSettings.management.mcpStatus.connected'],
  ready: ['ok', 'agentSettings.management.mcpStatus.connected'],
  configured: ['ok', 'agentSettings.management.mcpStatus.configured'],
  pending: ['idle', 'agentSettings.management.mcpStatus.pending'],
  'needs-auth': ['amber', 'agentSettings.management.mcpStatus.needsAuth'],
  notLoggedIn: ['amber', 'agentSettings.management.mcpStatus.needsAuth'],
  failed: ['red', 'agentSettings.management.mcpStatus.failed'],
  disabled: ['idle', 'agentSettings.management.mcpStatus.disabled'],
} as const satisfies Readonly<Record<string, readonly ['ok' | 'amber' | 'red' | 'idle', string]>>;
const MCP_SCOPE = {
  user: 'agentSettings.management.mcpScope.user',
  project: 'agentSettings.management.mcpScope.project',
  local: 'agentSettings.management.mcpScope.local',
  dynamic: 'agentSettings.management.mcpScope.dynamic',
  claudeai: 'agentSettings.management.mcpScope.claudeai',
} as const;
const mcpStatus = (status: string | undefined): (typeof MCP_STATUS)[keyof typeof MCP_STATUS] | undefined =>
  status !== undefined && Object.hasOwn(MCP_STATUS, status) ? MCP_STATUS[status as keyof typeof MCP_STATUS] : undefined;

function McpGroup({ servers, canAdd, busyTarget, locked, onAdd, onRemove }: {
  readonly servers: readonly AgentCapabilityItem[];
  readonly canAdd: boolean;
  readonly busyTarget: string | undefined;
  readonly locked: boolean;
  readonly onAdd: (name: string, server: NonNullable<AgentHostCommand['mcp']>) => Promise<boolean>;
  readonly onRemove: (item: AgentCapabilityItem) => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'http' | 'stdio'>('http');
  const [address, setAddress] = useState('');
  const [args, setArgs] = useState('');
  const [formError, setFormError] = useState<string>();
  const statusText = (status: string | undefined): string => {
    const known = mcpStatus(status);
    return known ? t(known[1]) : status ?? t('agentSettings.management.mcpStatus.unknown');
  };
  const scopeText = (scope: string | undefined): string | undefined => {
    if (!scope) return undefined;
    return Object.hasOwn(MCP_SCOPE, scope) ? t(MCP_SCOPE[scope as keyof typeof MCP_SCOPE]) : scope;
  };
  return (
    <section className="agent-management__group" aria-labelledby="agent-mcp" data-testid="agent-mcp">
      <GroupHeading id="agent-mcp" title={t('agentSettings.management.mcpTitle')} count={servers.length} />
      {servers.length === 0 && <p className="settings-hint">{t('agentSettings.management.mcpEmpty')}</p>}
      <ul className="agent-management__list">
        {servers.map((item) => (
          <li className="agent-management__row" key={item.id} data-testid={`agent-mcp-${item.id}`} aria-busy={busyTarget?.endsWith(`:${item.id}`) || undefined}>
            <ItemCopy
              name={item.name}
              meta={<><Led tone={mcpStatus(item.status)?.[0] ?? 'idle'} /> {statusText(item.status)}{scopeText(item.scope) ? ` · ${scopeText(item.scope)}` : ''}</>}
            />
            {item.actions.includes('mcp-remove') && (
              <div className="agent-management__actions">
                <Button size="sm" variant="ghost" leadingIcon={<Glyph name="trash" size={14} />} disabled={locked} onClick={() => onRemove(item)}
                  aria-label={t('agentSettings.management.removeItem', { name: item.name })}>
                  {t('agentSettings.management.remove')}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {canAdd && (
        <details className="agent-management__disclosure">
          <summary>{t('agentSettings.management.mcpAdd')}</summary>
          <form className="agent-management__form" onSubmit={(event) => {
            event.preventDefault();
            setFormError(undefined);
            let server: NonNullable<AgentHostCommand['mcp']>;
            try {
              server = transport === 'http'
                ? { type: 'http', url: new URL(address.trim()).href }
                : { type: 'stdio', command: address.trim(), args: args.split('\n').map((line) => line.trim()).filter(Boolean) };
              if (!name.trim() || (server.type === 'stdio' && !server.command)) throw new Error('missing');
            } catch {
              setFormError(t('agentSettings.management.mcpInvalid'));
              return;
            }
            void onAdd(name.trim(), server).then((applied) => {
              if (!applied) return;
              setName(''); setAddress(''); setArgs('');
            });
          }}>
            <Field label={t('agentSettings.management.mcpName')}>
              <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={128} data-testid="agent-mcp-name" />
            </Field>
            <Field label={t('agentSettings.management.mcpTransport')}>
              <Select value={transport} onChange={(event) => setTransport(event.target.value as 'http' | 'stdio')}>
                <option value="http">HTTP</option>
                <option value="stdio">{t('agentSettings.management.mcpStdio')}</option>
              </Select>
            </Field>
            <Field label={transport === 'http' ? t('agentSettings.management.mcpUrl') : t('agentSettings.management.mcpCommand')}>
              <Input value={address} onChange={(event) => setAddress(event.target.value)} maxLength={2_048} data-testid="agent-mcp-address" />
            </Field>
            {transport === 'stdio' && (
              <Field label={t('agentSettings.management.mcpArgs')} description={t('agentSettings.management.mcpArgsHint')}>
                <textarea className="agent-management__textarea" value={args} rows={3} onChange={(event) => setArgs(event.target.value)} />
              </Field>
            )}
            {formError && <p className="agent-management__notice" data-tone="danger" role="alert">{formError}</p>}
            <p className="settings-hint">{t('agentSettings.management.mcpAuthHint')}</p>
            <Button type="submit" size="sm" leadingIcon={<Glyph name="plus" size={14} />} disabled={locked} data-testid="agent-mcp-add">
              {t('agentSettings.management.action.mcp-add')}
            </Button>
          </form>
        </details>
      )}
    </section>
  );
}

function SkillGroup({ providerId, skills, busyTarget, locked, onToggle }: {
  readonly providerId: AgentManagementProviderId;
  readonly skills: readonly AgentCapabilityItem[];
  readonly busyTarget: string | undefined;
  readonly locked: boolean;
  readonly onToggle: (item: AgentCapabilityItem) => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const filter = useFilter(skills);
  const id = `agent-skills-${providerId}`;
  return (
    <section className="agent-management__group" aria-labelledby={id} data-testid={`agent-skills-${providerId}`}>
      <GroupHeading id={id} title={t('agentSettings.management.skillsTitle')} count={skills.length} />
      {providerId === 'claude' && <p className="settings-hint">{t('agentSettings.management.claudeSkillsHint')}</p>}
      {skills.length === 0 && <p className="settings-hint">{t('agentSettings.management.skillsEmpty')}</p>}
      {skills.length > 0 && (
        <details className="agent-management__disclosure">
          <summary>{t('agentSettings.management.skillsShow', { count: skills.length })}</summary>
          {filter.searchable && (
            <Field label={t('agentSettings.management.skillsSearch')} labelHidden>
              <Input type="search" value={filter.query} onChange={(event) => filter.setQuery(event.target.value)} placeholder={t('agentSettings.management.skillsSearch')} />
            </Field>
          )}
          <ul className="agent-management__list">
            {filter.visible.map((item) => {
              const toggle = item.actions.includes(item.enabled ? 'skill-disable' : 'skill-enable');
              return (
                <li className="agent-management__row" key={item.id} aria-busy={busyTarget?.endsWith(`:${item.id}`) || undefined}>
                  <ItemCopy name={item.invocation ?? item.name} description={item.description} />
                  {toggle && (
                    <div className="agent-management__actions">
                      <Switch
                        label={t('agentSettings.management.use')}
                        aria-label={t('agentSettings.management.useItem', { name: item.name })}
                        checked={item.enabled}
                        disabled={locked}
                        onChange={() => onToggle(item)}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </section>
  );
}

// == BROWSE ==

const INSTALL_SCOPES = ['user', 'project', 'local'] as const;

/** Install confirmation: a plugin runs code on the PC, and Claude lets it live in one project. */
function InstallConfirm({ providerId, entry, projects, onCancel, onConfirm }: {
  readonly providerId: AgentManagementProviderId;
  readonly entry: AgentPluginEntry;
  readonly projects: readonly AgentManagementProject[];
  readonly onCancel: () => void;
  readonly onConfirm: (scope: InstallScope) => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const [scope, setScope] = useState<(typeof INSTALL_SCOPES)[number]>('user');
  const [workspaceId, setWorkspaceId] = useState(projects[0]?.workspaceId ?? '');
  const inProject = scope !== 'user';
  const ready = !inProject || projects.some((project) => project.workspaceId === workspaceId);
  const title = t('agentSettings.management.installConfirm', { name: entry.id });
  return (
    <div className="agent-plugin-browser__confirm" role="group" aria-label={title} data-testid="agent-plugin-install-panel">
      <span><strong>{title}</strong>{' '}{t('agentSettings.management.installWarning')}</span>
      {providerId === 'claude'
        ? (
          <fieldset className="agent-plugin-browser__scope">
            <legend>{t('agentSettings.management.installScope')}</legend>
            {INSTALL_SCOPES.map((value) => (
              <label className="settings-radio-row" key={value}>
                <input
                  type="radio"
                  name={`agent-plugin-scope-${entry.id}`}
                  value={value}
                  checked={scope === value}
                  disabled={value !== 'user' && projects.length === 0}
                  onChange={() => setScope(value)}
                  data-testid={`agent-plugin-scope-${value}`}
                />
                <span>
                  {t(`agentSettings.management.scopeOption.${value}`)}
                  <small>{t(`agentSettings.management.scopeOptionHint.${value}`)}</small>
                </span>
              </label>
            ))}
            {projects.length === 0 && <p className="settings-hint">{t('agentSettings.management.installNoProjects')}</p>}
            {inProject && projects.length > 0 && (
              <Field label={t('agentSettings.management.installProject')}>
                <Select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} data-testid="agent-plugin-project">
                  {projects.map((project) => <option key={project.workspaceId} value={project.workspaceId} title={project.path}>{project.name}</option>)}
                </Select>
              </Field>
            )}
          </fieldset>
        )
        : <span className="settings-hint">{t('agentSettings.management.codexScopeNote')}</span>}
      <div className="agent-management__actions">
        <Button size="sm" variant="secondary" onClick={onCancel}>{t('common.cancel')}</Button>
        <Button size="sm" variant="primary" disabled={!ready} data-testid="agent-plugin-install-confirm"
          onClick={() => onConfirm(inProject ? { scope, workspaceId } : { scope: 'user' })}>
          {t('agentSettings.management.install')}
        </Button>
      </div>
    </div>
  );
}

function PluginBrowser({ providerId, client, variant, projects, locked, onClose, onInstall }: {
  readonly providerId: AgentManagementProviderId;
  readonly client: AgentHostExtensionsClient;
  readonly variant: 'desktop' | 'mobile';
  readonly projects: readonly AgentManagementProject[];
  readonly locked: boolean;
  readonly onClose: () => void;
  readonly onInstall: (entry: AgentPluginEntry, scope: InstallScope) => Promise<boolean>;
}): JSX.Element {
  const { t, i18n } = useAppTranslation();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [marketplace, setMarketplace] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<AgentPluginBrowsePage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const [installing, setInstalling] = useState<string>();
  const [installed, setInstalled] = useState<ReadonlySet<string>>(new Set());
  const generation = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => { setDebouncedQuery(query.trim()); setOffset(0); }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(async (refresh = false): Promise<void> => {
    const current = ++generation.current;
    setLoading(true);
    setError(undefined);
    try {
      const result = await client.browse({
        providerId,
        offset,
        limit: BROWSE_PAGE,
        ...(debouncedQuery ? { query: debouncedQuery } : {}),
        ...(marketplace ? { marketplace } : {}),
        ...(refresh ? { refresh: true } : {}),
      });
      if (current !== generation.current) return;
      if (result.ok) setPage(result.value); else setError(failureText(t, result));
    } catch {
      if (current === generation.current) setError(t('agentSettings.management.failureUnavailable'));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [client, providerId, offset, debouncedQuery, marketplace, t]);

  useEffect(() => { void load(); }, [load]);

  const install = async (entry: AgentPluginEntry, scope: InstallScope): Promise<void> => {
    setConfirming(undefined);
    setInstalling(entry.id);
    try {
      if (await onInstall(entry, scope) && scope.scope === 'user') setInstalled((current) => new Set(current).add(entry.id));
    } finally {
      setInstalling(undefined);
    }
  };

  const numberFormat = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const total = page?.total ?? 0;
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + BROWSE_PAGE, total);

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={t('agentSettings.management.browseTitle', { provider: PROVIDER_LABELS[providerId] })}
      description={t('agentSettings.management.browseDescription')}
      size="lg"
      variant={variant === 'mobile' ? 'sheet' : 'dialog'}
      // On a phone a focused search field raises the keyboard over the list; focus it on tap there.
      {...(variant === 'mobile' ? {} : { initialFocusRef: searchRef })}
      closeLabel={t('common.close')}
      className="agent-plugin-browser"
      testId="agent-plugin-browser"
      footer={(
        <div className="agent-plugin-browser__pager">
          <span>{total > 0 ? t('agentSettings.management.browseRange', { first: numberFormat.format(first), last: numberFormat.format(last), total: numberFormat.format(total) }) : ''}</span>
          <Button size="sm" variant="ghost" disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - BROWSE_PAGE))}>{t('agentSettings.management.browsePrevious')}</Button>
          <Button size="sm" variant="ghost" disabled={loading || last >= total} onClick={() => setOffset(offset + BROWSE_PAGE)}>{t('agentSettings.management.browseNext')}</Button>
        </div>
      )}
    >
      <div className="agent-plugin-browser__filters">
        <Field label={t('agentSettings.management.browseSearch')} labelHidden>
          <Input ref={searchRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder={t('agentSettings.management.browseSearch')} maxLength={200} data-testid="agent-plugin-search" />
        </Field>
        <Field label={t('agentSettings.management.browseMarketplace')} labelHidden>
          <Select value={marketplace} onChange={(event) => { setMarketplace(event.target.value); setOffset(0); }} data-testid="agent-plugin-marketplace">
            <option value="">{t('agentSettings.management.browseAllMarketplaces')}</option>
            {page?.marketplaces.map((name) => <option key={name} value={name}>{name}</option>)}
          </Select>
        </Field>
        <Button size="sm" variant="ghost" leadingIcon={<Glyph name="refresh" size={14} />} disabled={loading} onClick={() => void load(true)}>
          {t('agentSettings.management.refresh')}
        </Button>
      </div>
      {error && <ErrorState title={t('agentSettings.management.browseFailed')} description={error}
        action={<Button size="sm" onClick={() => void load()}>{t('common.retry')}</Button>} />}
      {!error && !page && <LoadingState label={t('agentSettings.management.browseLoading')} />}
      {!error && page && page.entries.length === 0 && (
        <p className="settings-hint" role="status">{debouncedQuery ? t('agentSettings.management.browseNoMatch') : t('agentSettings.management.browseEmpty')}</p>
      )}
      {!error && page && page.entries.length > 0 && (
        <ul className="agent-management__list agent-plugin-browser__list" aria-busy={loading || undefined}>
          {page.entries.map((entry) => {
            const isInstalled = entry.installed || installed.has(entry.id);
            return (
              <li className="agent-management__row" key={entry.id} data-testid={`agent-plugin-entry-${entry.id}`}>
                <ItemCopy
                  name={entry.name}
                  meta={[
                    entry.marketplace,
                    entry.version ? `v${entry.version}` : undefined,
                    entry.installCount !== undefined ? t('agentSettings.management.installCount', { installs: numberFormat.format(entry.installCount) }) : undefined,
                  ].filter(Boolean).join(' · ')}
                  description={entry.description}
                />
                <div className={confirming === entry.id && !isInstalled ? 'agent-management__actions agent-management__actions--confirming' : 'agent-management__actions'}>
                  {isInstalled
                    ? <Badge size="sm" variant="success">{t('agentSettings.management.installed')}</Badge>
                    : confirming === entry.id
                      ? (
                        <InstallConfirm
                          providerId={providerId}
                          entry={entry}
                          projects={projects}
                          onCancel={() => setConfirming(undefined)}
                          onConfirm={(scope) => void install(entry, scope)}
                        />
                      )
                      : (
                        <Button size="sm" leadingIcon={<Glyph name="download" size={14} />} disabled={locked || installing !== undefined}
                          loading={installing === entry.id} loadingLabel={t('agentSettings.management.installing')}
                          onClick={() => setConfirming(entry.id)} data-testid={`agent-plugin-install-${entry.id}`}>
                          {t('agentSettings.management.install')}
                        </Button>
                      )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
