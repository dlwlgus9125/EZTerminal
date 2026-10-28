import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ChatAgentPhaseMap, ChatAgentProfile, ChatAgentProfileAccess } from '../shared/chat-agent-profiles';
import type { SettingsChangesAccess } from '../shared/settings-changes';
import { createDaemonCommand, type DaemonSnapshot } from '../shared/daemon-protocol';
import { AgentPhaseSettings } from './AgentPhaseSettings';
import { AgentProfilesSettings, type AgentProfileProviderOption } from './AgentProfilesSettings';
import { rendererCapabilities, type CapabilityAccess } from './capability-access';
import { useAppTranslation } from './i18n';
import { structuredAgentEffortOptions, structuredAgentProviderOptions } from './structured-agent-create';
import { Status, Switch } from './ui';

/** Names for the built-in AIs when the host lists none yet (a profile can outlive its provider's enablement). */
const KNOWN_PROVIDER_LABELS: Readonly<Record<string, string>> = { codex: 'Codex', claude: 'Claude' };

function opaqueId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `${prefix}-${uuid}` : `${prefix}-${Date.now().toString(36)}`;
}

/**
 * Settings → Agents → 에이전트 협업, always visible: whether agents may start other
 * agents (the host's orchestration toggle) and the saved agent profiles.
 */
export function ChatAgentCollaborationSettings({
  capabilities = rendererCapabilities,
  profilesAccess = window.ezterminal?.chatAgentProfiles,
  settingsAccess = window.ezterminal?.settingsChanges,
}: {
  readonly capabilities?: CapabilityAccess;
  readonly profilesAccess?: ChatAgentProfileAccess;
  /** 자문 switch and settings:changed (a conversation's AI changed agents or 단계 연결). */
  readonly settingsAccess?: SettingsChangesAccess;
}): JSX.Element {
  const { t, i18n } = useAppTranslation();
  const [snapshot, setSnapshot] = useState<DaemonSnapshot | null>(null);
  const [profiles, setProfiles] = useState<readonly ChatAgentProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const refreshSnapshot = useCallback(async (): Promise<DaemonSnapshot | null> => {
    try {
      const next = await capabilities.daemon.getSnapshot();
      if (!next) {
        setError(t('agentSettings.daemonUnavailable'));
        return null;
      }
      setSnapshot(next);
      return next;
    } catch {
      setError(t('agentSettings.daemonUnavailable'));
      return null;
    }
  }, [capabilities, t]);

  const [phases, setPhases] = useState<ChatAgentPhaseMap | null>(null);
  const [advisor, setAdvisor] = useState<boolean | null>(null);
  useEffect(() => {
    void refreshSnapshot();
    void profilesAccess?.list().then(setProfiles).catch(() => undefined);
    void profilesAccess?.phases?.().then(setPhases).catch(() => undefined);
    void settingsAccess?.advisor().then(setAdvisor).catch(() => undefined);
  }, [refreshSnapshot, profilesAccess, settingsAccess]);
  // Changed from a conversation (or a proposal a person applied): show what is stored now.
  useEffect(() => settingsAccess?.onChanged((event) => {
    if (event.domains.includes('agent')) void profilesAccess?.list().then(setProfiles).catch(() => undefined);
    if (event.domains.includes('phase') || event.domains.includes('agent')) void profilesAccess?.phases?.().then(setPhases).catch(() => undefined);
    if (event.domains.includes('host')) {
      void refreshSnapshot();
      void settingsAccess.advisor().then(setAdvisor).catch(() => undefined);
    }
  }), [refreshSnapshot, profilesAccess, settingsAccess]);

  const updateOrchestration = async (enabled: boolean): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const authority = await capabilities.daemon.getSnapshot();
      if (!authority) throw new Error('unavailable');
      setSnapshot(authority);
      const commandId = opaqueId('agent-collaboration');
      const receipt = await capabilities.daemon.sendCommand(createDaemonCommand({
        commandId,
        idempotencyKey: commandId,
        expectedRevision: authority.revision,
        issuedAt: new Date().toISOString(),
        principal: { kind: 'desktop', id: 'renderer-agent-collaboration' },
        type: 'runtime.set-settings',
        payload: { orchestrationToolsEnabled: enabled },
      }));
      if (!receipt.ok) {
        await refreshSnapshot();
        setError(receipt.error.code === 'revision-conflict'
          ? t('agentSettings.runtimeRevisionChanged')
          : receipt.error.message);
        return;
      }
      await refreshSnapshot();
    } catch {
      setError(t('agentSettings.runtimeSaveFailed'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const providers = useMemo((): readonly AgentProfileProviderOption[] => structuredAgentProviderOptions(snapshot).map((provider) => ({
    id: provider.id,
    label: provider.label,
    models: provider.models.map((model) => model.id),
    efforts: structuredAgentEffortOptions(provider.id),
  })), [snapshot]);

  const unavailable = { ok: false as const, error: t('agentSettings.daemonUnavailable') };
  const ko = i18n.language.startsWith('ko');
  return (
    <section className="status-section" data-testid="agent-collaboration-settings">
      <AgentProfilesSettings
        orchestrationEnabled={snapshot?.runtime.orchestrationToolsEnabled ?? false}
        orchestrationBusy={busy || !snapshot}
        onOrchestrationChange={(enabled) => void updateOrchestration(enabled)}
        profiles={profiles}
        providers={providers}
        onSaveProfile={async (profile) => {
          const result = await profilesAccess?.save(profile).catch(() => unavailable) ?? unavailable;
          if (result.ok) setProfiles(result.profiles);
          return result.ok ? { ok: true } : result;
        }}
        onDeleteProfile={async (id) => {
          const result = await profilesAccess?.remove(id).catch(() => unavailable) ?? unavailable;
          if (result.ok) setProfiles(result.profiles);
          return result.ok ? { ok: true } : result;
        }}
      />
      {phases && profilesAccess?.savePhases && <AgentPhaseSettings ko={i18n.language.startsWith('ko')} profiles={profiles} phases={phases}
        providers={[...new Set([...providers.map((provider) => provider.id), ...profiles.map((profile) => profile.providerId)])]
          .map((id) => ({ id, label: providers.find((provider) => provider.id === id)?.label ?? KNOWN_PROVIDER_LABELS[id] ?? id }))}
        onChange={(next) => { setPhases(next); void profilesAccess.savePhases?.(next).then((result) => { if (result.ok) setPhases(result.phases); }).catch(() => undefined); }} />}
      {advisor !== null && settingsAccess && <Switch
        checked={advisor}
        onChange={(event) => { const enabled = event.target.checked; setAdvisor(enabled); void settingsAccess.setAdvisor(enabled).then(setAdvisor).catch(() => setAdvisor(!enabled)); }}
        label={ko ? '자문: 대화의 AI가 검토 에이전트에게 물어볼 수 있음' : 'Advisor: conversation AIs can ask the review agent'}
        description={ko
          ? '켜면 직접 보는 대화의 AI가 단계 연결의 검토 에이전트에게 읽기 전용으로 질문할 수 있습니다(차례당 2번, 대화당 6번). 검토 에이전트를 연결해야 쓸 수 있고, 에이전트 만들기와는 따로 켭니다.'
          : 'Lets the AI of a conversation you see ask the review agent from phase links a question, read-only (2 per turn, 6 per conversation). Needs a linked review agent; separate from agents creating agents.'}
        data-testid="agent-collaboration-advisor"
      />}
      {busy && <Status variant="loading" live="polite">{t('agentSettings.runtimeSaving')}</Status>}
      {error && <Status className="agent-settings-error" variant="danger" live="assertive">{error}</Status>}
    </section>
  );
}
