import { useCallback, useEffect, useState } from 'react';

import {
  AGENT_SETTINGS_SCHEMA_VERSION,
  type AgentIntegrationProvider,
  type AgentIntegrationStatus,
  type AgentSettings,
  type GenericAgentProfile,
} from '../shared/agent';

const DEFAULT_SETTINGS: AgentSettings = {
  schemaVersion: AGENT_SETTINGS_SCHEMA_VERSION,
  notifications: { waiting: true, blocked: true, error: true },
  genericProfiles: [],
};

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
  const [integrations, setIntegrations] = useState<readonly AgentIntegrationStatus[]>([]);
  const [settings, setSettings] = useState<AgentSettings>(DEFAULT_SETTINGS);
  const [busyProvider, setBusyProvider] = useState<AgentIntegrationProvider | null>(null);
  const [message, setMessage] = useState<string | null>(null);

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
    void refresh().catch(() => setMessage('Agent integration settings are unavailable.'));
  }, [refresh]);

  const mutateIntegration = async (provider: AgentIntegrationProvider, enabled: boolean): Promise<void> => {
    const desktop = window.ezterminalDesktop;
    if (!desktop || busyProvider) return;
    setBusyProvider(provider);
    setMessage(null);
    const result = await desktop.setAgentIntegrationEnabled(provider, enabled);
    setBusyProvider(null);
    if (result.ok) {
      setMessage(`${providerLabel(provider)} hooks ${enabled ? 'installed' : 'removed'}.`);
      await refresh();
      return;
    }
    setMessage(result.message);
    setIntegrations((current) => current.map((item) => item.provider === provider ? result.status : item));
  };

  const persist = async (next: AgentSettings): Promise<void> => {
    setSettings(next);
    try {
      const saved = await window.ezterminalDesktop?.setAgentSettings(next);
      if (!saved) {
        setMessage('Check generic profile names and executable basenames for blanks or duplicates.');
        return;
      }
      setSettings(saved);
      setMessage('Agent settings saved.');
    } catch {
      setMessage('Could not save agent settings.');
    }
  };

  const patchProfile = (id: string, patch: Partial<GenericAgentProfile>): void => {
    setSettings((current) => ({
      ...current,
      genericProfiles: current.genericProfiles.map((profile) => profile.id === id ? { ...profile, ...patch } : profile),
    }));
  };

  return (
    <>
      <div className="agent-integration-list">
        {integrations.map((integration) => (
          <div className="agent-integration-row" key={integration.provider}>
            <div className="agent-integration-copy">
              <strong>{providerLabel(integration.provider)}</strong>
              <span title={integration.configPath}>{integration.enabled ? 'Exact lifecycle hooks enabled' : 'Process lifecycle only'}</span>
              {integration.drift && <span className="settings-agent-warning">Installed hook was modified; removal requires review.</span>}
              {integration.needsTrust && <span className="settings-agent-warning">Review and trust Codex hooks with `/hooks`.</span>}
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
              {busyProvider === integration.provider ? 'Working…' : integration.enabled ? 'Remove' : 'Install'}
            </button>
          </div>
        ))}
      </div>

      <h3 className="settings-agent-subtitle">Desktop notifications</h3>
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
          Notify when an agent is {event}
        </label>
      ))}

      <div className="settings-agent-generic-head">
        <h3 className="settings-agent-subtitle">Generic CLI profiles</h3>
        <button
          type="button"
          className="btn btn-split"
          onClick={() => setSettings((current) => ({
            ...current,
            genericProfiles: [...current.genericProfiles, newProfile()],
          }))}
        >
          Add
        </button>
      </div>
      {settings.genericProfiles.map((profile) => (
        <div className="settings-agent-profile" key={profile.id}>
          <input
            value={profile.name}
            aria-label="Generic agent name"
            maxLength={80}
            onChange={(event) => patchProfile(profile.id, { name: event.target.value })}
          />
          <input
            value={profile.executable}
            aria-label="Generic agent executable"
            placeholder="executable basename"
            maxLength={128}
            onChange={(event) => patchProfile(profile.id, { executable: event.target.value })}
          />
          <label className="settings-radio-row">
            <input
              type="checkbox"
              checked={profile.enabled}
              onChange={(event) => patchProfile(profile.id, { enabled: event.target.checked })}
            />
            Enabled
          </label>
          <button
            type="button"
            className="btn btn-split"
            onClick={() => setSettings((current) => ({
              ...current,
              genericProfiles: current.genericProfiles.filter((candidate) => candidate.id !== profile.id),
            }))}
          >
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-split" onClick={() => void persist(settings)}>
        Save agent profiles
      </button>
      {message && <div className="settings-agent-message" role="status">{message}</div>}
    </>
  );
}
