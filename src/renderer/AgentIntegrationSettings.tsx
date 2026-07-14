import { useCallback, useEffect, useState } from 'react';

import {
  AGENT_SETTINGS_SCHEMA_VERSION,
  type AgentIntegrationProvider,
  type AgentIntegrationStatus,
  type AgentSettings,
  type GenericAgentProfile,
} from '../shared/agent';
import { useAppTranslation } from './i18n';

const DEFAULT_SETTINGS: AgentSettings = {
  schemaVersion: AGENT_SETTINGS_SCHEMA_VERSION,
  notifications: { waiting: true, blocked: true, error: true },
  genericProfiles: [],
};

type AgentSettingsMessage =
  | { readonly kind: 'unavailable' | 'invalid-profiles' | 'saved' | 'save-failed' }
  | { readonly kind: 'hooks-installed' | 'hooks-removed'; readonly provider: string }
  | { readonly kind: 'external'; readonly message: string }
  | null;

const NOTIFICATION_LABEL_KEYS = {
  waiting: 'agentSettings.notifyWaiting',
  blocked: 'agentSettings.notifyBlocked',
  error: 'agentSettings.notifyError',
} as const;

function providerLabel(provider: AgentIntegrationProvider): string {
  return provider === 'codex' ? 'Codex' : 'Claude';
}

function newProfile(): GenericAgentProfile {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `generic-${Date.now()}`,
    name: 'Agent CLI',
    executable: '',
    enabled: true,
  };
}

export function AgentIntegrationSettings(): JSX.Element {
  const { t } = useAppTranslation();
  const [integrations, setIntegrations] = useState<readonly AgentIntegrationStatus[]>([]);
  const [settings, setSettings] = useState<AgentSettings>(DEFAULT_SETTINGS);
  const [busyProvider, setBusyProvider] = useState<AgentIntegrationProvider | null>(null);
  const [message, setMessage] = useState<AgentSettingsMessage>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const desktop = window.ezterminalDesktop;
    if (!desktop) return;
    const [nextIntegrations, nextSettings] = await Promise.all([
      desktop.listAgentIntegrations(),
      desktop.getAgentSettings(),
    ]);
    setIntegrations(nextIntegrations);
    setSettings(nextSettings);
  }, []);

  useEffect(() => {
    void refresh().catch(() => setMessage({ kind: 'unavailable' }));
  }, [refresh]);

  const mutateIntegration = async (provider: AgentIntegrationProvider, enabled: boolean): Promise<void> => {
    const desktop = window.ezterminalDesktop;
    if (!desktop || busyProvider) return;
    setBusyProvider(provider);
    setMessage(null);
    const result = await desktop.setAgentIntegrationEnabled(provider, enabled);
    setBusyProvider(null);
    if (result.ok) {
      setMessage({
        kind: enabled ? 'hooks-installed' : 'hooks-removed',
        provider: providerLabel(provider),
      });
      await refresh();
      return;
    }
    setMessage({ kind: 'external', message: result.message });
    setIntegrations((current) => current.map((item) => item.provider === provider ? result.status : item));
  };

  const persist = async (next: AgentSettings): Promise<void> => {
    setSettings(next);
    try {
      const saved = await window.ezterminalDesktop?.setAgentSettings(next);
      if (!saved) {
        setMessage({ kind: 'invalid-profiles' });
        return;
      }
      setSettings(saved);
      setMessage({ kind: 'saved' });
    } catch {
      setMessage({ kind: 'save-failed' });
    }
  };

  const patchProfile = (id: string, patch: Partial<GenericAgentProfile>): void => {
    setSettings((current) => ({
      ...current,
      genericProfiles: current.genericProfiles.map((profile) => profile.id === id ? { ...profile, ...patch } : profile),
    }));
  };

  const messageText = message?.kind === 'external'
    ? message.message
    : message?.kind === 'hooks-installed'
      ? t('agentSettings.hooksInstalled', { provider: message.provider })
      : message?.kind === 'hooks-removed'
        ? t('agentSettings.hooksRemoved', { provider: message.provider })
        : message?.kind === 'unavailable'
          ? t('agentSettings.unavailable')
          : message?.kind === 'invalid-profiles'
            ? t('agentSettings.invalidProfiles')
            : message?.kind === 'saved'
              ? t('agentSettings.saved')
              : message?.kind === 'save-failed'
                ? t('agentSettings.saveFailed')
                : null;

  return (
    <>
      <div className="agent-integration-list">
        {integrations.map((integration) => (
          <div className="agent-integration-row" key={integration.provider}>
            <div className="agent-integration-copy">
              <strong>{providerLabel(integration.provider)}</strong>
              <span title={integration.configPath}>
                {integration.enabled ? t('agentSettings.exactLifecycle') : t('agentSettings.processLifecycle')}
              </span>
              {integration.drift && <span className="settings-agent-warning">{t('agentSettings.hookModified')}</span>}
              {integration.needsTrust && <span className="settings-agent-warning">{t('agentSettings.trustCodexHooks')}</span>}
              {integration.blockers.map((blocker) => <span className="settings-agent-warning" key={blocker}>{blocker}</span>)}
            </div>
            <button
              type="button"
              className="btn btn-split"
              disabled={
                busyProvider !== null ||
                (!integration.enabled && integration.blockers.length > 0) ||
                (integration.drift && integration.enabled)
              }
              onClick={() => void mutateIntegration(integration.provider, !integration.enabled)}
              data-testid={`agent-integration-${integration.provider}`}
            >
              {busyProvider === integration.provider
                ? t('agentSettings.working')
                : integration.enabled
                  ? t('agentSettings.remove')
                  : t('agentSettings.install')}
            </button>
          </div>
        ))}
      </div>

      <h3 className="settings-agent-subtitle">{t('agentSettings.desktopNotifications')}</h3>
      {(['waiting', 'blocked', 'error'] as const).map((event) => (
        <label className="settings-radio-row" key={event}>
          <input
            type="checkbox"
            checked={settings.notifications[event]}
            onChange={(change) => void persist({
              ...settings,
              notifications: { ...settings.notifications, [event]: change.target.checked },
            })}
          />
          {t(NOTIFICATION_LABEL_KEYS[event])}
        </label>
      ))}

      <div className="settings-agent-generic-head">
        <h3 className="settings-agent-subtitle">{t('agentSettings.genericProfiles')}</h3>
        <button
          type="button"
          className="btn btn-split"
          onClick={() => setSettings((current) => ({
            ...current,
            genericProfiles: [...current.genericProfiles, newProfile()],
          }))}
        >
          {t('agentSettings.add')}
        </button>
      </div>
      {settings.genericProfiles.map((profile) => (
        <div className="settings-agent-profile" key={profile.id}>
          <input
            value={profile.name}
            aria-label={t('agentSettings.genericName')}
            maxLength={80}
            onChange={(event) => patchProfile(profile.id, { name: event.target.value })}
          />
          <input
            value={profile.executable}
            aria-label={t('agentSettings.genericExecutable')}
            placeholder={t('agentSettings.executablePlaceholder')}
            maxLength={128}
            onChange={(event) => patchProfile(profile.id, { executable: event.target.value })}
          />
          <label className="settings-radio-row">
            <input
              type="checkbox"
              checked={profile.enabled}
              onChange={(event) => patchProfile(profile.id, { enabled: event.target.checked })}
            />
            {t('agentSettings.enabled')}
          </label>
          <button
            type="button"
            className="btn btn-split"
            onClick={() => setSettings((current) => ({
              ...current,
              genericProfiles: current.genericProfiles.filter((candidate) => candidate.id !== profile.id),
            }))}
          >
            {t('agentSettings.remove')}
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-split" onClick={() => void persist(settings)}>
        {t('agentSettings.saveProfiles')}
      </button>
      {messageText && <div className="settings-agent-message" role="status">{messageText}</div>}
    </>
  );
}
