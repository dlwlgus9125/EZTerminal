import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  DEFAULT_CLAUDE_PROVIDER_ENABLEMENT,
  type ClaudeAuthenticationPath,
  type ClaudeProviderEnablement,
  type ProviderInspection,
  type ProviderProbeResult,
} from '../shared/daemon-provider';
import {
  createDaemonCommand,
  type DaemonProvider,
  type DaemonSnapshot,
} from '../shared/daemon-protocol';
import type { DaemonLifecycleSettings } from '../shared/ipc';
import { rendererCapabilities, type CapabilityAccess } from './capability-access';
import { useAppTranslation } from './i18n';
import { Badge, Button, Status, Switch } from './ui';

type BuiltInProviderId = 'codex' | 'claude';

interface InspectionState {
  readonly checking: boolean;
  readonly inspection: ProviderInspection | null;
  readonly error: string | null;
}

type InspectionMap = Readonly<Record<BuiltInProviderId, InspectionState>>;
type ProviderMessageMap = Readonly<Record<BuiltInProviderId, string | null>>;

const PROVIDER_IDS: readonly BuiltInProviderId[] = ['codex', 'claude'];

const EMPTY_INSPECTIONS: InspectionMap = {
  codex: { checking: true, inspection: null, error: null },
  claude: { checking: true, inspection: null, error: null },
};

function opaqueId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `${prefix}-${uuid}` : `${prefix}-${Date.now().toString(36)}`;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function daemonProviderMatchesProbe(
  provider: DaemonProvider | undefined,
  probe: ProviderProbeResult,
): boolean {
  return Boolean(provider
    && provider.displayName === probe.displayName
    && provider.protocol === probe.protocol
    && provider.executablePath === probe.executablePath
    && provider.executableVersion === probe.executableVersion
    && arraysEqual(provider.argv, probe.argv)
    && arraysEqual(provider.environmentVariableNames, probe.environmentVariableNames)
    && arraysEqual(provider.capabilities, probe.capabilities));
}

function claudeEnablementEqual(
  left: ClaudeProviderEnablement | null,
  right: ClaudeProviderEnablement,
): boolean {
  return Boolean(left
    && left.enabled === right.enabled
    && left.termsAccepted === right.termsAccepted
    && left.commercialUseApproved === right.commercialUseApproved
    && left.authenticationPath === right.authenticationPath
    && left.anthropicThirdPartyApproval === right.anthropicThirdPartyApproval);
}

function claudeGateComplete(enablement: ClaudeProviderEnablement): boolean {
  return enablement.termsAccepted
    && enablement.commercialUseApproved
    && (enablement.authenticationPath !== 'existing-claude-ai-login'
      || enablement.anthropicThirdPartyApproval);
}

function isClaudeConsentRequired(probe: ProviderProbeResult): boolean {
  return probe.providerId === 'claude'
    && probe.unavailableReason?.startsWith('CLAUDE_PROVIDER_DISABLED:') === true;
}

function enablementWith(
  current: ClaudeProviderEnablement,
  patch: Partial<ClaudeProviderEnablement>,
): ClaudeProviderEnablement {
  const next = { ...current, ...patch };
  return next.authenticationPath === 'existing-claude-ai-login'
    ? next
    : { ...next, anthropicThirdPartyApproval: false };
}

interface ProviderStatusProps {
  readonly providerId: BuiltInProviderId;
  readonly state: InspectionState;
  readonly provider: DaemonProvider | undefined;
  readonly busy: 'enable' | 'disable' | 'prepare' | null;
  readonly actionError: string | null;
}

function ProviderStatus({
  providerId,
  state,
  provider,
  busy,
  actionError,
}: ProviderStatusProps): JSX.Element {
  const { t } = useAppTranslation();
  if (busy === 'disable') return <Status variant="loading" live="polite">{t('agentSettings.providerDisabling')}</Status>;
  if (busy === 'enable') return <Status variant="loading" live="polite">{t('agentSettings.providerEnabling')}</Status>;
  if (busy === 'prepare') return <Status variant="loading" live="polite">{t('agentSettings.providerPreparing')}</Status>;
  if (actionError) return <Status variant="danger" live="assertive">{actionError}</Status>;
  if (state.checking && !state.inspection) {
    return <Status variant="loading" live="polite">{t('agentSettings.providerChecking')}</Status>;
  }
  if (state.error || !state.inspection) {
    return <Status variant="danger" live="assertive">{t('agentSettings.providerCheckFailed')}</Status>;
  }
  const { probe } = state.inspection;
  if (!probe.available && !isClaudeConsentRequired(probe)) {
    return <Status variant="danger">{t('agentSettings.providerMissing')}</Status>;
  }
  if (provider?.enabled) {
    if (provider.health !== 'ready') {
      return <Status variant="danger">{provider.healthDetail ?? t('agentSettings.providerError')}</Status>;
    }
    if (!daemonProviderMatchesProbe(provider, probe)) {
      return <Status variant="warning">{t('agentSettings.providerStale')}</Status>;
    }
    return <Status variant="success">{t('agentSettings.providerReady')}</Status>;
  }
  if (providerId === 'claude' && isClaudeConsentRequired(probe)) {
    return <Status variant="warning">{t('agentSettings.claudeConsentPending')}</Status>;
  }
  return <Status variant="warning">{t('agentSettings.providerReviewPending')}</Status>;
}

interface StructuredProviderSettingsProps {
  readonly capabilities?: CapabilityAccess;
}

export function StructuredProviderSettings({
  capabilities = rendererCapabilities,
}: StructuredProviderSettingsProps): JSX.Element {
  const { t } = useAppTranslation();
  const [snapshot, setSnapshot] = useState<DaemonSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [inspections, setInspections] = useState<InspectionMap>(EMPTY_INSPECTIONS);
  const [reviewedDigests, setReviewedDigests] = useState<Readonly<Record<BuiltInProviderId, string | null>>>({
    codex: null,
    claude: null,
  });
  const [providerMessages, setProviderMessages] = useState<ProviderMessageMap>({ codex: null, claude: null });
  const [busyProviders, setBusyProviders] = useState<Readonly<Record<
    BuiltInProviderId,
    'enable' | 'disable' | 'prepare' | null
  >>>({ codex: null, claude: null });
  const [claudeStored, setClaudeStored] = useState<ClaudeProviderEnablement | null>(null);
  const [claudeDraft, setClaudeDraft] = useState<ClaudeProviderEnablement>(DEFAULT_CLAUDE_PROVIDER_ENABLEMENT);
  const [claudeLoadError, setClaudeLoadError] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState<DaemonLifecycleSettings | null>(null);
  const [hostError, setHostError] = useState<string | null>(null);
  const [hostBusy, setHostBusy] = useState<'orchestration' | 'lifecycle' | null>(null);
  const providerBusyRef = useRef(new Set<BuiltInProviderId>());
  const hostBusyRef = useRef(false);
  const inspectionGeneration = useRef<Record<BuiltInProviderId, number>>({ codex: 0, claude: 0 });

  const refreshSnapshot = useCallback(async (): Promise<DaemonSnapshot | null> => {
    try {
      const next = await capabilities.daemon.getSnapshot();
      if (!next) {
        setSnapshotError(t('agentSettings.daemonUnavailable'));
        return null;
      }
      setSnapshot(next);
      setSnapshotError(null);
      return next;
    } catch {
      setSnapshotError(t('agentSettings.daemonUnavailable'));
      return null;
    }
  }, [capabilities, t]);

  const inspectProvider = useCallback(async (
    providerId: BuiltInProviderId,
    invalidateReview = false,
  ): Promise<ProviderInspection | null> => {
    const generation = inspectionGeneration.current[providerId] + 1;
    inspectionGeneration.current[providerId] = generation;
    setInspections((current) => ({
      ...current,
      [providerId]: { ...current[providerId], checking: true, error: null },
    }));
    try {
      const result = await capabilities.structuredProviders.inspect(providerId);
      if (inspectionGeneration.current[providerId] !== generation) return null;
      if (!result.ok) {
        setInspections((current) => ({
          ...current,
          [providerId]: { ...current[providerId], checking: false, error: result.message },
        }));
        return null;
      }
      setInspections((current) => ({
        ...current,
        [providerId]: { checking: false, inspection: result.value, error: null },
      }));
      setReviewedDigests((current) => ({
        ...current,
        [providerId]: !invalidateReview && current[providerId] === result.value.reviewDigest
          ? current[providerId]
          : null,
      }));
      return result.value;
    } catch {
      if (inspectionGeneration.current[providerId] !== generation) return null;
      setInspections((current) => ({
        ...current,
        [providerId]: { ...current[providerId], checking: false, error: t('agentSettings.providerCheckFailed') },
      }));
      return null;
    }
  }, [capabilities, t]);

  useEffect(() => {
    let alive = true;
    void Promise.all([
      refreshSnapshot(),
      Promise.resolve().then(() => capabilities.daemon.getLifecycleSettings()).then((value) => {
        if (!alive) return;
        if (value) setLifecycle(value);
        else setHostError(t('agentSettings.lifecycleUnavailable'));
      }).catch(() => {
        if (alive) setHostError(t('agentSettings.lifecycleUnavailable'));
      }),
      Promise.resolve().then(() => capabilities.structuredProviders.getClaudeEnablement()).then((result) => {
        if (!alive) return;
        if (!result.ok) {
          setClaudeLoadError(result.message);
          return;
        }
        setClaudeStored(result.value);
        setClaudeDraft(result.value);
        setClaudeLoadError(null);
      }).catch(() => {
        if (alive) setClaudeLoadError(t('agentSettings.providerActionFailed'));
      }),
      ...PROVIDER_IDS.map((providerId) => inspectProvider(providerId)),
    ]);
    return () => { alive = false; };
  }, [capabilities, inspectProvider, refreshSnapshot, t]);

  useEffect(() => {
    if (!lifecycle && snapshot) {
      setLifecycle({
        keepRunning: snapshot.runtime.keepRunning,
        startAtLogin: snapshot.runtime.startAtLogin,
      });
    }
  }, [lifecycle, snapshot]);

  const setClaudeDraftValue = (patch: Partial<ClaudeProviderEnablement>): void => {
    setClaudeDraft((current) => enablementWith(current, patch));
    setReviewedDigests((current) => ({ ...current, claude: null }));
    setProviderMessages((current) => ({ ...current, claude: null }));
  };

  const updateLifecycle = async (patch: Partial<DaemonLifecycleSettings>): Promise<void> => {
    if (hostBusyRef.current) return;
    hostBusyRef.current = true;
    setHostBusy('lifecycle');
    setHostError(null);
    try {
      const next = await capabilities.daemon.setLifecycleSettings(patch);
      if (!next) throw new Error('unavailable');
      setLifecycle(next);
      await refreshSnapshot();
    } catch {
      setHostError(t('agentSettings.lifecycleSaveFailed'));
    } finally {
      hostBusyRef.current = false;
      setHostBusy(null);
    }
  };

  const updateOrchestration = async (enabled: boolean): Promise<void> => {
    if (hostBusyRef.current) return;
    hostBusyRef.current = true;
    setHostBusy('orchestration');
    setHostError(null);
    try {
      const authority = await capabilities.daemon.getSnapshot();
      if (!authority) throw new Error('unavailable');
      setSnapshot(authority);
      const commandId = opaqueId('provider-settings');
      const receipt = await capabilities.daemon.sendCommand(createDaemonCommand({
        commandId,
        idempotencyKey: commandId,
        expectedRevision: authority.revision,
        issuedAt: new Date().toISOString(),
        principal: { kind: 'desktop', id: 'renderer-provider-settings' },
        type: 'runtime.set-settings',
        payload: { orchestrationToolsEnabled: enabled },
      }));
      if (!receipt.ok) {
        await refreshSnapshot();
        setHostError(receipt.error.code === 'revision-conflict'
          ? t('agentSettings.runtimeRevisionChanged')
          : receipt.error.message);
        return;
      }
      await refreshSnapshot();
    } catch {
      setHostError(t('agentSettings.runtimeSaveFailed'));
    } finally {
      hostBusyRef.current = false;
      setHostBusy(null);
    }
  };

  const prepareClaude = async (): Promise<void> => {
    const desired = { ...claudeDraft, enabled: true };
    const result = await capabilities.structuredProviders.setClaudeEnablement(desired);
    if (!result.ok) {
      setProviderMessages((current) => ({ ...current, claude: result.message }));
      return;
    }
    setClaudeStored(result.value);
    setClaudeDraft(result.value);
    const inspection = await inspectProvider('claude', true);
    setProviderMessages((current) => ({
      ...current,
      claude: inspection ? null : t('agentSettings.providerCheckFailed'),
    }));
  };

  const enableProvider = async (providerId: BuiltInProviderId): Promise<void> => {
    if (providerBusyRef.current.has(providerId)) return;
    const state = inspections[providerId];
    const inspection = state.inspection;
    if (!inspection || reviewedDigests[providerId] !== inspection.reviewDigest) return;
    if (providerId === 'claude' && !claudeGateComplete(claudeDraft)) return;
    providerBusyRef.current.add(providerId);
    setProviderMessages((current) => ({ ...current, [providerId]: null }));
    const desiredClaude = { ...claudeDraft, enabled: true };
    const requiresClaudePreparation = providerId === 'claude'
      && !claudeEnablementEqual(claudeStored, desiredClaude);
    setBusyProviders((current) => ({
      ...current,
      [providerId]: requiresClaudePreparation ? 'prepare' : 'enable',
    }));
    try {
      if (requiresClaudePreparation) {
        await prepareClaude();
        return;
      }
      if (!inspection.probe.available) return;
      const authority = await capabilities.daemon.getSnapshot();
      if (!authority) throw new Error('unavailable');
      setSnapshot(authority);
      const currentProvider = authority.providers.find((provider) => provider.id === providerId);
      const commandId = opaqueId('provider-settings');
      const { probe, reviewDigest } = inspection;
      const receipt = await capabilities.daemon.sendCommand(createDaemonCommand({
        commandId,
        idempotencyKey: commandId,
        expectedRevision: authority.revision,
        issuedAt: new Date().toISOString(),
        principal: { kind: 'desktop', id: 'renderer-provider-settings' },
        type: currentProvider ? 'provider.update' : 'provider.enable',
        payload: {
          providerId: probe.providerId,
          displayName: probe.displayName,
          protocol: probe.protocol,
          executablePath: probe.executablePath,
          executableVersion: probe.executableVersion,
          argv: probe.argv,
          environmentVariableNames: probe.environmentVariableNames,
          capabilities: probe.capabilities,
          reviewDigest,
        },
      }));
      if (!receipt.ok) {
        if (receipt.error.code === 'revision-conflict') await refreshSnapshot();
        if (/changed after review|review/iu.test(receipt.error.message)) {
          await inspectProvider(providerId, true);
          setProviderMessages((current) => ({
            ...current,
            [providerId]: t('agentSettings.providerStale'),
          }));
        } else {
          setProviderMessages((current) => ({ ...current, [providerId]: receipt.error.message }));
        }
        return;
      }
      setReviewedDigests((current) => ({ ...current, [providerId]: null }));
      await refreshSnapshot();
    } catch {
      setProviderMessages((current) => ({
        ...current,
        [providerId]: t('agentSettings.providerActionFailed'),
      }));
    } finally {
      providerBusyRef.current.delete(providerId);
      setBusyProviders((current) => ({ ...current, [providerId]: null }));
    }
  };

  const disableProvider = async (providerId: BuiltInProviderId): Promise<void> => {
    if (providerBusyRef.current.has(providerId)) return;
    providerBusyRef.current.add(providerId);
    setBusyProviders((current) => ({ ...current, [providerId]: 'disable' }));
    setProviderMessages((current) => ({ ...current, [providerId]: null }));
    try {
      const authority = await capabilities.daemon.getSnapshot();
      if (!authority) throw new Error('unavailable');
      const current = authority.providers.find((provider) => provider.id === providerId);
      if (current?.enabled) {
        const commandId = opaqueId('provider-settings');
        const receipt = await capabilities.daemon.sendCommand(createDaemonCommand({
          commandId,
          idempotencyKey: commandId,
          expectedRevision: authority.revision,
          issuedAt: new Date().toISOString(),
          principal: { kind: 'desktop', id: 'renderer-provider-settings' },
          type: 'provider.disable',
          payload: { providerId },
        }));
        if (!receipt.ok) {
          if (receipt.error.code === 'revision-conflict') await refreshSnapshot();
          setProviderMessages((messages) => ({ ...messages, [providerId]: receipt.error.message }));
          return;
        }
      }
      if (providerId === 'claude' && claudeStored?.enabled) {
        const disabled = { ...claudeStored, enabled: false };
        const result = await capabilities.structuredProviders.setClaudeEnablement(disabled);
        if (!result.ok) {
          setProviderMessages((messages) => ({ ...messages, claude: result.message }));
          await refreshSnapshot();
          return;
        }
        setClaudeStored(result.value);
        setClaudeDraft(result.value);
        await inspectProvider('claude', true);
      }
      setReviewedDigests((current) => ({ ...current, [providerId]: null }));
      await refreshSnapshot();
    } catch {
      setProviderMessages((current) => ({
        ...current,
        [providerId]: t('agentSettings.providerActionFailed'),
      }));
    } finally {
      providerBusyRef.current.delete(providerId);
      setBusyProviders((current) => ({ ...current, [providerId]: null }));
    }
  };

  const providerRecords = useMemo(() => new Map(
    (snapshot?.providers ?? []).map((provider) => [provider.id, provider]),
  ), [snapshot]);

  return (
    <div className="structured-provider-settings">
      <section className="agent-host-settings" aria-labelledby="agent-host-settings-title">
        <div className="agent-settings-heading">
          <div>
            <h2 className="status-section-title" id="agent-host-settings-title">
              {t('agentSettings.hostRuntimeTitle')}
            </h2>
            <p>{t('agentSettings.hostRuntimeDescription')}</p>
          </div>
          {hostBusy && <Status variant="loading" live="polite">{t('agentSettings.runtimeSaving')}</Status>}
        </div>
        {lifecycle && snapshot ? (
          <div className="agent-host-settings__controls">
            <Switch
              checked={snapshot.runtime.orchestrationToolsEnabled}
              disabled={hostBusy !== null}
              onChange={(event) => void updateOrchestration(event.target.checked)}
              label={t('agentSettings.orchestrationTools')}
              description={t('agentSettings.orchestrationToolsHint')}
              data-testid="agent-orchestration-tools"
            />
            <Switch
              checked={lifecycle.keepRunning}
              disabled={hostBusy !== null}
              onChange={(event) => void updateLifecycle({ keepRunning: event.target.checked })}
              label={t('agentSettings.keepRunning')}
              description={t('agentSettings.keepRunningHint')}
              data-testid="agent-keep-running"
            />
            <Switch
              checked={lifecycle.startAtLogin}
              disabled={hostBusy !== null || !lifecycle.keepRunning}
              onChange={(event) => void updateLifecycle({ startAtLogin: event.target.checked })}
              label={t('agentSettings.startAtLogin')}
              description={lifecycle.keepRunning
                ? t('agentSettings.startAtLoginHint')
                : t('agentSettings.startAtLoginRequiresKeepRunning')}
              data-testid="agent-start-at-login"
            />
          </div>
        ) : (
          <Status variant="loading" live="polite">{t('agentSettings.runtimeLoading')}</Status>
        )}
        {(hostError || snapshotError) && (
          <Status className="agent-settings-error" variant="danger" live="assertive">
            {hostError ?? snapshotError}
          </Status>
        )}
      </section>

      <section className="structured-provider-section" aria-labelledby="structured-provider-title">
        <div className="agent-settings-heading">
          <div>
            <h2 className="status-section-title" id="structured-provider-title">
              {t('agentSettings.structuredProvidersTitle')}
            </h2>
            <p>{t('agentSettings.structuredProvidersDescription')}</p>
          </div>
        </div>
        <div className="structured-provider-list">
          {PROVIDER_IDS.map((providerId) => {
            const state = inspections[providerId];
            const inspection = state.inspection;
            const probe = inspection?.probe;
            const provider = providerRecords.get(providerId);
            const active = provider?.enabled === true;
            const stale = Boolean(active && probe && !daemonProviderMatchesProbe(provider, probe));
            const claudeNeedsPreparation = providerId === 'claude'
              && !claudeEnablementEqual(claudeStored, { ...claudeDraft, enabled: true });
            const reviewable = Boolean(probe
              && (probe.available || isClaudeConsentRequired(probe))
              && (!active || stale));
            const reviewed = Boolean(inspection && reviewedDigests[providerId] === inspection.reviewDigest);
            const canEnable = reviewable
              && reviewed
              && !state.checking
              && !state.error
              && (providerId !== 'claude' || (claudeStored !== null && claudeGateComplete(claudeDraft)))
              && (probe?.available === true || claudeNeedsPreparation);
            const canDisable = active || (providerId === 'claude' && claudeStored?.enabled === true);
            const providerLabel = providerId === 'codex' ? 'Codex' : 'Claude Agent';
            const actionLabel = providerId === 'claude' && claudeNeedsPreparation
              ? t('agentSettings.claudeApplyAndRecheck')
              : active
                ? t('agentSettings.providerUpdate')
                : t('agentSettings.providerEnable');

            return (
              <article
                className="structured-provider-card"
                key={providerId}
                data-testid={`structured-provider-${providerId}`}
                aria-busy={state.checking || busyProviders[providerId] !== null || undefined}
              >
                <header className="structured-provider-card__header">
                  <div className="structured-provider-card__identity">
                    <strong>{providerLabel}</strong>
                    <span>{providerId === 'codex'
                      ? t('agentSettings.codexProviderDescription')
                      : t('agentSettings.claudeProviderDescription')}</span>
                  </div>
                  <ProviderStatus
                    providerId={providerId}
                    state={state}
                    provider={provider}
                    busy={busyProviders[providerId]}
                    actionError={providerMessages[providerId]}
                  />
                </header>

                {state.error && <p className="structured-provider-card__error" role="alert">{state.error}</p>}
                {probe?.unavailableReason && !isClaudeConsentRequired(probe) && (
                  <p className="structured-provider-card__error" role="alert">{probe.unavailableReason}</p>
                )}

                {inspection && (
                  <details className="structured-provider-review" open={!active || stale ? true : undefined}>
                    <summary>{t('agentSettings.providerReviewDetails')}</summary>
                    <div className="structured-provider-review__body">
                      <h3>{t('agentSettings.providerIdentityHeading')}</h3>
                      <dl className="structured-provider-metadata">
                        <div><dt>{t('agentSettings.providerProtocol')}</dt><dd><code>{probe?.protocol}</code></dd></div>
                        <div><dt>{t('agentSettings.providerVersion')}</dt><dd><code>{probe?.executableVersion}</code></dd></div>
                        <div className="is-wide"><dt>{t('agentSettings.providerExecutable')}</dt><dd><code>{probe?.executablePath}</code></dd></div>
                        <div className="is-wide"><dt>{t('agentSettings.providerArguments')}</dt><dd><code>{probe?.argv.join(' ') || t('agentSettings.providerNone')}</code></dd></div>
                        <div className="is-wide"><dt>{t('agentSettings.providerEnvironment')}</dt><dd><code>{probe?.environmentVariableNames.join(', ') || t('agentSettings.providerNone')}</code></dd></div>
                      </dl>
                      <div className="structured-provider-capabilities" aria-label={t('agentSettings.providerCapabilities')}>
                        {probe?.capabilities.map((capability) => (
                          <Badge key={capability} size="sm">{capability}</Badge>
                        ))}
                      </div>

                      {(probe?.reviewNotices?.length ?? 0) > 0 && (
                        <div className="structured-provider-notices" aria-labelledby={`${providerId}-provider-notices`}>
                          <h3 id={`${providerId}-provider-notices`}>{t('agentSettings.providerNotices')}</h3>
                          {probe?.reviewNotices?.map((notice) => (
                            <div className="structured-provider-notice" data-level={notice.level} key={notice.id}>
                              <strong>{notice.title}</strong>
                              <p>{notice.message}</p>
                              {notice.url && (
                                <a
                                  href={notice.url}
                                  onClick={(event) => {
                                    event.preventDefault();
                                    void capabilities.files.openExternalHttpUrl(notice.url!);
                                  }}
                                >
                                  {t('agentSettings.providerOfficialDocumentation')}
                                </a>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {providerId === 'claude' && (
                        <div className="claude-provider-consent">
                          <fieldset disabled={busyProviders.claude !== null || claudeStored === null}>
                            <legend>{t('agentSettings.claudeAuthentication')}</legend>
                            {([
                              ['api-key-environment', 'agentSettings.claudeAuthApiKey'],
                              ['existing-cli-environment', 'agentSettings.claudeAuthCli'],
                              ['existing-claude-ai-login', 'agentSettings.claudeAuthLogin'],
                            ] as const satisfies readonly (readonly [ClaudeAuthenticationPath, string])[]).map(([value, label]) => (
                              <label className="settings-radio-row" key={value}>
                                <input
                                  type="radio"
                                  name="claude-provider-authentication"
                                  value={value}
                                  checked={claudeDraft.authenticationPath === value}
                                  onChange={() => setClaudeDraftValue({ authenticationPath: value })}
                                  data-testid={`claude-auth-${value}`}
                                />
                                <span>{t(label)}</span>
                              </label>
                            ))}
                          </fieldset>
                          <p className="settings-hint">{t('agentSettings.claudeNoSecrets')}</p>
                          <fieldset disabled={busyProviders.claude !== null || claudeStored === null}>
                            <legend>{t('agentSettings.claudeRequirements')}</legend>
                            <label className="settings-radio-row">
                              <input
                                type="checkbox"
                                checked={claudeDraft.termsAccepted}
                                onChange={(event) => setClaudeDraftValue({ termsAccepted: event.target.checked })}
                                data-testid="claude-terms-accepted"
                              />
                              <span>{t('agentSettings.claudeTermsAccepted')}</span>
                            </label>
                            <label className="settings-radio-row">
                              <input
                                type="checkbox"
                                checked={claudeDraft.commercialUseApproved}
                                onChange={(event) => setClaudeDraftValue({ commercialUseApproved: event.target.checked })}
                                data-testid="claude-commercial-approved"
                              />
                              <span>{t('agentSettings.claudeCommercialApproved')}</span>
                            </label>
                            {claudeDraft.authenticationPath === 'existing-claude-ai-login' && (
                              <label className="settings-radio-row settings-radio-row--warning">
                                <input
                                  type="checkbox"
                                  checked={claudeDraft.anthropicThirdPartyApproval}
                                  onChange={(event) => setClaudeDraftValue({
                                    anthropicThirdPartyApproval: event.target.checked,
                                  })}
                                  data-testid="claude-third-party-approved"
                                />
                                <span>{t('agentSettings.claudeThirdPartyApproved')}</span>
                              </label>
                            )}
                            {claudeDraft.authenticationPath === 'existing-claude-ai-login' && (
                              <p className="settings-hint">{t('agentSettings.claudeThirdPartyHint')}</p>
                            )}
                          </fieldset>
                          {claudeLoadError && <p className="structured-provider-card__error" role="alert">{claudeLoadError}</p>}
                        </div>
                      )}

                      {reviewable && (
                        <label className="structured-provider-review__confirmation">
                          <input
                            type="checkbox"
                            checked={reviewed}
                            disabled={state.checking || busyProviders[providerId] !== null}
                            onChange={(event) => setReviewedDigests((current) => ({
                              ...current,
                              [providerId]: event.target.checked ? inspection.reviewDigest : null,
                            }))}
                            data-testid={`provider-review-${providerId}`}
                          />
                          <span>{t('agentSettings.providerReviewConfirmation')}</span>
                        </label>
                      )}
                    </div>
                  </details>
                )}

                <div className="structured-provider-card__actions">
                  <Button
                    size="sm"
                    leadingIcon={<RefreshCw size={14} />}
                    disabled={busyProviders[providerId] !== null}
                    loading={state.checking}
                    loadingLabel={t('agentSettings.providerChecking')}
                    onClick={() => void inspectProvider(providerId, true)}
                    data-testid={`provider-check-${providerId}`}
                  >
                    {t('agentSettings.providerCheckAgain')}
                  </Button>
                  {reviewable && (
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={!canEnable || busyProviders[providerId] !== null}
                      loading={busyProviders[providerId] === 'enable' || busyProviders[providerId] === 'prepare'}
                      loadingLabel={t('agentSettings.providerEnabling')}
                      onClick={() => void enableProvider(providerId)}
                      data-testid={`provider-enable-${providerId}`}
                    >
                      {actionLabel}
                    </Button>
                  )}
                  {canDisable && (
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busyProviders[providerId] !== null}
                      loading={busyProviders[providerId] === 'disable'}
                      loadingLabel={t('agentSettings.providerDisabling')}
                      onClick={() => void disableProvider(providerId)}
                      data-testid={`provider-disable-${providerId}`}
                    >
                      {t('agentSettings.providerDisable')}
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
