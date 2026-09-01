import {
  Bot,
  ChevronDown,
  ChevronUp,
  Code2,
  FileText,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  TestTube2,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  AGENT_PERSONA_ICONS,
  AGENT_PERSONA_PRESETS,
  AGENT_PERSONA_PRESET_DEFINITIONS,
  DEFAULT_AGENT_TEAM_INSTRUCTIONS,
  EMPTY_AGENT_TEAM_DESKTOP_SNAPSHOT,
  MAX_AGENT_TEAM_GOAL_CRITERIA,
  MAX_AGENT_TEAM_MEMBERS,
  defaultAgentPersonaLaunch,
  type AgentLauncherCapabilities,
  type AgentPersona,
  type AgentPersonaIcon,
  type AgentPersonaLaunch,
  type AgentPersonaPreset,
  type AgentTeam,
  type AgentTeamDesktopSnapshot,
} from '../shared/agent-team';
import { useAppTranslation } from './i18n';
import { Badge, Button, Dialog, Field, IconButton, Input, Select } from './ui';

type Provider = AgentPersonaLaunch['provider'];

const ICONS: Readonly<Record<AgentPersonaIcon, LucideIcon>> = {
  bot: Bot,
  code: Code2,
  search: Search,
  'shield-check': ShieldCheck,
  'test-tube': TestTube2,
  'file-text': FileText,
};

interface PersonaDraft {
  readonly source?: AgentPersona;
  readonly preset: AgentPersonaPreset;
  readonly name: string;
  readonly icon: AgentPersonaIcon;
  readonly role: string;
  readonly instructions: string;
  readonly provider: Provider;
  readonly model: string;
  readonly codexSandbox: 'read-only' | 'workspace-write';
  readonly claudeEffort: '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly claudePermission: 'plan' | 'manual' | 'acceptEdits';
}

interface TeamDraft {
  readonly source?: AgentTeam;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly personaIds: readonly string[];
  readonly plannerPersonaId: string;
  readonly defaultGoalEnabled: boolean;
  readonly defaultGoalOutcome: string;
  readonly defaultGoalCriteria: readonly string[];
}

interface StarterDraft {
  readonly plannerProvider: Provider | '';
  readonly implementerProvider: Provider | '';
}

type DeleteTarget =
  | { readonly kind: 'persona'; readonly value: AgentPersona }
  | { readonly kind: 'team'; readonly value: AgentTeam };

function capabilityFor(
  capabilities: readonly AgentLauncherCapabilities[],
  provider: Provider,
): AgentLauncherCapabilities | undefined {
  return capabilities.find((capability) => capability.provider === provider);
}

function launchPermission(
  launch: AgentPersonaLaunch,
): AgentLauncherCapabilities['permissionValues'][number] {
  return launch.provider === 'codex' ? launch.sandbox : launch.permissionMode;
}

function supportsPreset(
  capabilities: readonly AgentLauncherCapabilities[],
  provider: Provider,
  preset: AgentPersonaPreset,
): boolean {
  const capability = capabilityFor(capabilities, provider);
  const launch = defaultAgentPersonaLaunch(preset, provider);
  return Boolean(capability?.available && capability.permissionValues.includes(launchPermission(launch)));
}

function firstProvider(
  capabilities: readonly AgentLauncherCapabilities[],
  preset: AgentPersonaPreset,
): Provider {
  return (['codex', 'claude'] as const).find((provider) => supportsPreset(capabilities, provider, preset))
    ?? capabilities.find((capability) => capability.available)?.provider
    ?? 'codex';
}

function personaDraft(source?: AgentPersona, provider: Provider = 'codex'): PersonaDraft {
  const preset = source?.preset ?? (source ? 'custom' : 'implementer');
  const defaults = AGENT_PERSONA_PRESET_DEFINITIONS[preset];
  const launch = source?.launch;
  const codexDefault = defaultAgentPersonaLaunch(preset, 'codex');
  const claudeDefault = defaultAgentPersonaLaunch(preset, 'claude');
  return {
    ...(source ? { source } : {}),
    preset,
    name: source?.name ?? '',
    icon: source?.icon ?? defaults.icon,
    role: source?.role ?? defaults.role,
    instructions: source?.instructions ?? defaults.instructions,
    provider: launch?.provider ?? provider,
    model: launch?.model ?? '',
    codexSandbox: launch?.provider === 'codex'
      ? launch.sandbox
      : codexDefault.provider === 'codex' ? codexDefault.sandbox : 'read-only',
    claudeEffort: launch?.provider === 'claude' ? launch.effort ?? '' : '',
    claudePermission: launch?.provider === 'claude'
      ? launch.permissionMode
      : claudeDefault.provider === 'claude' ? claudeDefault.permissionMode : 'manual',
  };
}

function applyPreset(draft: PersonaDraft, preset: AgentPersonaPreset): PersonaDraft {
  const defaults = AGENT_PERSONA_PRESET_DEFINITIONS[preset];
  const codexLaunch = defaultAgentPersonaLaunch(preset, 'codex');
  const claudeLaunch = defaultAgentPersonaLaunch(preset, 'claude');
  return {
    ...draft,
    preset,
    icon: defaults.icon,
    role: defaults.role,
    instructions: defaults.instructions,
    model: '',
    claudeEffort: '',
    codexSandbox: codexLaunch.provider === 'codex' ? codexLaunch.sandbox : 'read-only',
    claudePermission: claudeLaunch.provider === 'claude' ? claudeLaunch.permissionMode : 'manual',
  };
}

function applyProvider(draft: PersonaDraft, provider: Provider): PersonaDraft {
  const launch = defaultAgentPersonaLaunch(draft.preset, provider);
  return {
    ...draft,
    provider,
    model: '',
    claudeEffort: '',
    ...(launch.provider === 'codex'
      ? { codexSandbox: launch.sandbox }
      : { claudePermission: launch.permissionMode }),
  };
}

function teamDraft(source: AgentTeam | undefined, availablePersonas: readonly AgentPersona[]): TeamDraft {
  const personaIds = source?.personaIds ?? availablePersonas.slice(0, 2).map((persona) => persona.personaId);
  return {
    ...(source ? { source } : {}),
    name: source?.name ?? '',
    description: source?.description ?? '',
    instructions: source?.instructions ?? DEFAULT_AGENT_TEAM_INSTRUCTIONS,
    personaIds,
    plannerPersonaId: source?.plannerPersonaId ?? personaIds[0] ?? '',
    defaultGoalEnabled: source?.defaultGoal !== undefined,
    defaultGoalOutcome: source?.defaultGoal?.outcome ?? '',
    defaultGoalCriteria: source?.defaultGoal?.acceptanceCriteria ?? [''],
  };
}

function launchFromDraft(draft: PersonaDraft): AgentPersonaLaunch {
  return draft.provider === 'codex'
    ? {
        provider: 'codex',
        ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
        sandbox: draft.codexSandbox,
      }
    : {
        provider: 'claude',
        ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
        ...(draft.claudeEffort ? { effort: draft.claudeEffort } : {}),
        permissionMode: draft.claudePermission,
      };
}

function move<T>(items: readonly T[], index: number, offset: -1 | 1): readonly T[] {
  const target = index + offset;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

function validCriteria(criteria: readonly string[]): boolean {
  const normalized = criteria.map((criterion) => criterion.trim());
  return normalized.length >= 1
    && normalized.length <= MAX_AGENT_TEAM_GOAL_CRITERIA
    && normalized.every((criterion) => criterion.length > 0 && criterion.length <= 500)
    && new Set(normalized.map((criterion) => criterion.toLocaleLowerCase('en-US'))).size === normalized.length;
}

export function AgentTeamSettings(): JSX.Element {
  const { t } = useAppTranslation();
  const [snapshot, setSnapshot] = useState<AgentTeamDesktopSnapshot>(EMPTY_AGENT_TEAM_DESKTOP_SNAPSHOT);
  const [personaEditor, setPersonaEditor] = useState<PersonaDraft | null>(null);
  const [teamEditor, setTeamEditor] = useState<TeamDraft | null>(null);
  const [starterEditor, setStarterEditor] = useState<StarterDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const applySnapshot = useCallback((next: AgentTeamDesktopSnapshot): void => {
    setSnapshot((current) => next.revision < current.revision ? current : next);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    const desktop = window.ezterminalDesktop;
    if (!desktop) return;
    applySnapshot(await desktop.getAgentTeamSnapshot());
  }, [applySnapshot]);

  useEffect(() => {
    const desktop = window.ezterminalDesktop;
    if (!desktop) return undefined;
    void load().catch(() => setMessage(t('agentTeams.unavailable')));
    return desktop.onAgentTeamSnapshot(applySnapshot);
  }, [applySnapshot, load, t]);

  const personas = useMemo(
    () => new Map(snapshot.catalog.personas.map((persona) => [persona.personaId, persona])),
    [snapshot.catalog.personas],
  );
  const emptyCatalog = snapshot.catalog.personas.length === 0 && snapshot.catalog.teams.length === 0;

  const openPersonaEditor = (source?: AgentPersona): void => {
    setMessage(null);
    setPersonaEditor(personaDraft(
      source,
      firstProvider(snapshot.catalog.capabilities, source?.preset ?? (source ? 'custom' : 'implementer')),
    ));
  };

  const openStarterEditor = (): void => {
    setMessage(null);
    const plannerProvider = firstProvider(snapshot.catalog.capabilities, 'planner');
    const implementerProvider = firstProvider(snapshot.catalog.capabilities, 'implementer');
    setStarterEditor({
      plannerProvider: supportsPreset(snapshot.catalog.capabilities, plannerProvider, 'planner')
        ? plannerProvider : '',
      implementerProvider: supportsPreset(snapshot.catalog.capabilities, implementerProvider, 'implementer')
        ? implementerProvider : '',
    });
  };

  const savePersona = async (): Promise<void> => {
    const desktop = window.ezterminalDesktop;
    if (!desktop || !personaEditor || busy) return;
    setBusy(true);
    setMessage(null);
    const result = await desktop.saveAgentPersona({
      ...(personaEditor.source
        ? {
            personaId: personaEditor.source.personaId,
            expectedRevision: personaEditor.source.revision,
          }
        : {}),
      name: personaEditor.name.trim(),
      preset: personaEditor.preset,
      icon: personaEditor.icon,
      role: personaEditor.role.trim(),
      instructions: personaEditor.instructions.trim(),
      launch: launchFromDraft(personaEditor),
    }).catch(() => ({ ok: false, error: 'unavailable', message: t('agentTeams.saveFailed') } as const));
    setBusy(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setPersonaEditor(null);
    setMessage(t('agentTeams.personaSaved'));
  };

  const saveTeam = async (): Promise<void> => {
    const desktop = window.ezterminalDesktop;
    if (!desktop || !teamEditor || busy) return;
    setBusy(true);
    setMessage(null);
    const result = await desktop.saveAgentTeam({
      ...(teamEditor.source
        ? { teamId: teamEditor.source.teamId, expectedRevision: teamEditor.source.revision }
        : {}),
      name: teamEditor.name.trim(),
      ...(teamEditor.description.trim() ? { description: teamEditor.description.trim() } : {}),
      instructions: teamEditor.instructions.trim(),
      ...(teamEditor.defaultGoalEnabled ? {
        defaultGoal: {
          outcome: teamEditor.defaultGoalOutcome.trim(),
          acceptanceCriteria: teamEditor.defaultGoalCriteria.map((criterion) => criterion.trim()),
        },
      } : {}),
      personaIds: teamEditor.personaIds,
      plannerPersonaId: teamEditor.plannerPersonaId,
    }).catch(() => ({ ok: false, error: 'unavailable', message: t('agentTeams.saveFailed') } as const));
    setBusy(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setTeamEditor(null);
    setMessage(t('agentTeams.teamSaved'));
  };

  const createStarter = async (): Promise<void> => {
    const desktop = window.ezterminalDesktop;
    if (!desktop || !starterEditor?.plannerProvider || !starterEditor.implementerProvider || busy) return;
    setBusy(true);
    setMessage(null);
    const result = await desktop.createAgentStarterTeam({
      plannerProvider: starterEditor.plannerProvider,
      implementerProvider: starterEditor.implementerProvider,
    }).catch(() => ({ ok: false, error: 'unavailable', message: t('agentTeams.starterFailed') } as const));
    setBusy(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setStarterEditor(null);
    setMessage(t('agentTeams.starterCreated'));
  };

  const confirmDelete = async (): Promise<void> => {
    const desktop = window.ezterminalDesktop;
    if (!desktop || !deleteTarget || busy) return;
    setBusy(true);
    const result = await (deleteTarget.kind === 'persona'
      ? desktop.deleteAgentPersona(deleteTarget.value.personaId, deleteTarget.value.revision)
      : desktop.deleteAgentTeam(deleteTarget.value.teamId, deleteTarget.value.revision))
      .catch(() => ({ ok: false, error: 'unavailable', message: t('agentTeams.deleteFailed') } as const));
    setBusy(false);
    if (!result.ok) {
      setMessage(result.message);
      setDeleteTarget(null);
      return;
    }
    setDeleteTarget(null);
    setMessage(t('agentTeams.deleted'));
  };

  const personaCapability = personaEditor
    ? capabilityFor(snapshot.catalog.capabilities, personaEditor.provider)
    : undefined;
  const personaLaunch = personaEditor ? launchFromDraft(personaEditor) : undefined;
  const personaValid = Boolean(
    personaEditor?.name.trim()
    && personaEditor.role.trim()
    && personaEditor.instructions.trim()
    && personaCapability?.available
    && personaLaunch
    && personaCapability.permissionValues.includes(launchPermission(personaLaunch))
    && (!personaEditor.model.trim() || personaCapability.supportsModel)
    && (personaLaunch.provider !== 'claude'
      || !personaLaunch.effort
      || personaCapability.effortValues.includes(personaLaunch.effort)),
  );
  const teamValid = Boolean(
    teamEditor?.name.trim()
    && teamEditor.instructions.trim()
    && teamEditor.personaIds.length >= 2
    && teamEditor.personaIds.length <= MAX_AGENT_TEAM_MEMBERS
    && teamEditor.personaIds.includes(teamEditor.plannerPersonaId)
    && (!teamEditor.defaultGoalEnabled
      || (teamEditor.defaultGoalOutcome.trim() && validCriteria(teamEditor.defaultGoalCriteria))),
  );
  const starterValid = Boolean(
    starterEditor?.plannerProvider
    && starterEditor.implementerProvider
    && supportsPreset(snapshot.catalog.capabilities, starterEditor.plannerProvider, 'planner')
    && supportsPreset(snapshot.catalog.capabilities, starterEditor.implementerProvider, 'implementer'),
  );

  return (
    <div className="agent-team-settings">
      <div className="agent-team-settings__intro">
        <p>{t('agentTeams.description')}</p>
        <p className="settings-hint">{t('agentTeams.realisticHint')}</p>
      </div>

      {emptyCatalog && (
        <section className="agent-team-starter" aria-labelledby="agent-team-starter-heading">
          <Sparkles aria-hidden="true" />
          <div>
            <h3 id="agent-team-starter-heading">{t('agentTeams.starterTitle')}</h3>
            <p>{t('agentTeams.starterDescription')}</p>
          </div>
          <Button size="sm" variant="primary" onClick={openStarterEditor}>
            {t('agentTeams.createStarter')}
          </Button>
        </section>
      )}

      <section className="agent-team-settings__section" aria-labelledby="agent-personas-heading">
        <div className="settings-agent-generic-head">
          <h3 id="agent-personas-heading" className="settings-agent-subtitle">{t('agentTeams.personas')}</h3>
          <Button size="sm" variant="secondary" leadingIcon={<Plus />} onClick={() => openPersonaEditor()}>
            {t('agentTeams.addPersona')}
          </Button>
        </div>
        {snapshot.catalog.personas.length === 0 ? (
          <p className="settings-hint">{t('agentTeams.noPersonas')}</p>
        ) : (
          <div className="agent-team-card-list">
            {snapshot.catalog.personas.map((persona) => {
              const Icon = ICONS[persona.icon];
              const capability = capabilityFor(snapshot.catalog.capabilities, persona.launch.provider);
              const preset = persona.preset ?? 'custom';
              const launchReady = Boolean(
                capability?.available
                && capability.permissionValues.includes(launchPermission(persona.launch))
                && (!persona.launch.model || capability.supportsModel)
                && (persona.launch.provider !== 'claude'
                  || !persona.launch.effort
                  || capability.effortValues.includes(persona.launch.effort)),
              );
              return (
                <article className="agent-team-card" key={persona.personaId}>
                  <Icon aria-hidden="true" />
                  <div className="agent-team-card__copy">
                    <strong>{persona.name}</strong>
                    <span>{persona.role}</span>
                    <div className="agent-team-card__meta">
                      <Badge>{t(`agentTeams.preset_${preset}`)}</Badge>
                      <Badge>{persona.launch.provider === 'codex' ? 'Codex' : 'Claude'}</Badge>
                      <Badge variant={launchReady ? 'success' : 'warning'}>
                        {launchReady ? t('agentTeams.ready') : t('agentTeams.integrationRequired')}
                      </Badge>
                    </div>
                  </div>
                  <div className="agent-team-card__actions">
                    <IconButton icon={Pencil} aria-label={t('agentTeams.editPersona', { name: persona.name })} onClick={() => openPersonaEditor(persona)} />
                    <IconButton icon={Trash2} aria-label={t('agentTeams.deletePersona', { name: persona.name })} onClick={() => setDeleteTarget({ kind: 'persona', value: persona })} />
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="agent-team-settings__section" aria-labelledby="agent-teams-heading">
        <div className="settings-agent-generic-head">
          <h3 id="agent-teams-heading" className="settings-agent-subtitle">{t('agentTeams.teams')}</h3>
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={<Plus />}
            disabled={snapshot.catalog.personas.length < 2}
            onClick={() => setTeamEditor(teamDraft(undefined, snapshot.catalog.personas))}
          >
            {t('agentTeams.addTeam')}
          </Button>
        </div>
        {snapshot.catalog.teams.length === 0 ? (
          <p className="settings-hint">{t('agentTeams.noTeams')}</p>
        ) : (
          <div className="agent-team-card-list">
            {snapshot.catalog.teams.map((team) => (
              <article className="agent-team-card agent-team-card--team" key={team.teamId}>
                <Bot aria-hidden="true" />
                <div className="agent-team-card__copy">
                  <strong>{team.name}</strong>
                  <span>{team.defaultGoal?.outcome ?? team.description ?? t('agentTeams.noDefaultGoal')}</span>
                  <span className="agent-team-card__members">
                    {team.personaIds.map((personaId) => personas.get(personaId)?.name ?? t('agentTeams.missingPersona')).join(' · ')}
                  </span>
                </div>
                <div className="agent-team-card__actions">
                  <IconButton icon={Pencil} aria-label={t('agentTeams.editTeam', { name: team.name })} onClick={() => setTeamEditor(teamDraft(team, snapshot.catalog.personas))} />
                  <IconButton icon={Trash2} aria-label={t('agentTeams.deleteTeam', { name: team.name })} onClick={() => setDeleteTarget({ kind: 'team', value: team })} />
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {message && <div className="settings-agent-message" role="status">{message}</div>}

      <Dialog
        open={personaEditor !== null}
        onOpenChange={(open) => { if (!open && !busy) setPersonaEditor(null); }}
        title={personaEditor?.source ? t('agentTeams.editPersonaTitle') : t('agentTeams.addPersonaTitle')}
        description={t('agentTeams.personaDescription')}
        size="lg"
        testId="agent-persona-editor"
        footer={(
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setPersonaEditor(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={busy} disabled={!personaValid} onClick={() => void savePersona()}>{t('common.save')}</Button>
          </>
        )}
      >
        {personaEditor && (
          <div className="agent-team-editor">
            <div className="agent-team-editor__two-column">
              <Field label={t('agentTeams.preset')} description={t('agentTeams.presetHint')} required>
                <Select value={personaEditor.preset} onChange={(event) => setPersonaEditor(applyPreset(personaEditor, event.currentTarget.value as AgentPersonaPreset))}>
                  {AGENT_PERSONA_PRESETS.map((preset) => (
                    <option value={preset} key={preset}>{t(`agentTeams.preset_${preset}`)}</option>
                  ))}
                </Select>
              </Field>
              <Field label={t('agentTeams.name')} required>
                <Input value={personaEditor.name} maxLength={48} onChange={(event) => setPersonaEditor({ ...personaEditor, name: event.currentTarget.value })} />
              </Field>
            </div>
            <div className="agent-team-editor__two-column">
              <Field label={t('agentTeams.launcher')} required>
                <Select value={personaEditor.provider} onChange={(event) => setPersonaEditor(applyProvider(personaEditor, event.currentTarget.value as Provider))}>
                  {(['codex', 'claude'] as const).map((provider) => {
                    const capability = capabilityFor(snapshot.catalog.capabilities, provider);
                    return <option key={provider} value={provider} disabled={!capability?.available}>{provider === 'codex' ? 'Codex' : 'Claude Code'}{capability?.available ? '' : ` · ${t('agentTeams.integrationRequired')}`}</option>;
                  })}
                </Select>
              </Field>
              {personaEditor.provider === 'codex' ? (
                <Field label={t('agentTeams.permission')} required>
                  <Select value={personaEditor.codexSandbox} onChange={(event) => setPersonaEditor({ ...personaEditor, codexSandbox: event.currentTarget.value as PersonaDraft['codexSandbox'] })}>
                    <option value="read-only" disabled={!personaCapability?.permissionValues.includes('read-only')}>{t('agentTeams.readOnly')}</option>
                    <option value="workspace-write" disabled={!personaCapability?.permissionValues.includes('workspace-write')}>{t('agentTeams.workspaceWrite')}</option>
                  </Select>
                </Field>
              ) : (
                <Field label={t('agentTeams.permission')} required>
                  <Select value={personaEditor.claudePermission} onChange={(event) => setPersonaEditor({ ...personaEditor, claudePermission: event.currentTarget.value as PersonaDraft['claudePermission'] })}>
                    <option value="plan" disabled={!personaCapability?.permissionValues.includes('plan')}>{t('agentTeams.planOnly')}</option>
                    <option value="manual" disabled={!personaCapability?.permissionValues.includes('manual')}>{t('agentTeams.askNormally')}</option>
                    <option value="acceptEdits" disabled={!personaCapability?.permissionValues.includes('acceptEdits')}>{t('agentTeams.acceptEdits')}</option>
                  </Select>
                </Field>
              )}
            </div>
            <details className="agent-team-editor__advanced">
              <summary>{t('agentTeams.advancedSettings')}</summary>
              <div className="agent-team-editor__advanced-body">
                <div className="agent-team-editor__two-column">
                  <Field label={t('agentTeams.icon')}>
                    <Select value={personaEditor.icon} onChange={(event) => setPersonaEditor({ ...personaEditor, icon: event.currentTarget.value as AgentPersonaIcon })}>
                      {AGENT_PERSONA_ICONS.map((icon) => <option value={icon} key={icon}>{t(`agentTeams.icon_${icon}`)}</option>)}
                    </Select>
                  </Field>
                  <Field label={t('agentTeams.model')} description={t('agentTeams.modelHint')}>
                    <Input disabled={!personaCapability?.supportsModel} value={personaEditor.model} maxLength={128} placeholder={t('agentTeams.providerDefault')} onChange={(event) => setPersonaEditor({ ...personaEditor, model: event.currentTarget.value })} />
                  </Field>
                </div>
                {personaEditor.provider === 'claude' && (
                  <Field label={t('agentTeams.effort')}>
                    <Select value={personaEditor.claudeEffort} onChange={(event) => setPersonaEditor({ ...personaEditor, claudeEffort: event.currentTarget.value as PersonaDraft['claudeEffort'] })}>
                      <option value="">{t('agentTeams.providerDefault')}</option>
                      {personaCapability?.effortValues.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
                    </Select>
                  </Field>
                )}
                <Field label={t('agentTeams.role')} required>
                  <Input value={personaEditor.role} maxLength={120} onChange={(event) => setPersonaEditor({ ...personaEditor, role: event.currentTarget.value })} />
                </Field>
                <Field label={t('agentTeams.instructions')} description={t('agentTeams.instructionsHint')} required>
                  <textarea className="ui-textarea" rows={6} maxLength={8000} value={personaEditor.instructions} onChange={(event) => setPersonaEditor({ ...personaEditor, instructions: event.currentTarget.value })} />
                </Field>
              </div>
            </details>
          </div>
        )}
      </Dialog>

      <Dialog
        open={teamEditor !== null}
        onOpenChange={(open) => { if (!open && !busy) setTeamEditor(null); }}
        title={teamEditor?.source ? t('agentTeams.editTeamTitle') : t('agentTeams.addTeamTitle')}
        description={t('agentTeams.teamDescription')}
        size="lg"
        testId="agent-team-editor"
        footer={(
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setTeamEditor(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={busy} disabled={!teamValid} onClick={() => void saveTeam()}>{t('common.save')}</Button>
          </>
        )}
      >
        {teamEditor && (
          <div className="agent-team-editor">
            <Field label={t('agentTeams.name')} required>
              <Input value={teamEditor.name} maxLength={80} onChange={(event) => setTeamEditor({ ...teamEditor, name: event.currentTarget.value })} />
            </Field>
            <fieldset className="agent-team-member-editor">
              <legend>{t('agentTeams.members')}</legend>
              {[
                ...teamEditor.personaIds.map((personaId) => personas.get(personaId)).filter((persona): persona is AgentPersona => Boolean(persona)),
                ...snapshot.catalog.personas.filter((persona) => !teamEditor.personaIds.includes(persona.personaId)),
              ].map((persona) => {
                const selectedIndex = teamEditor.personaIds.indexOf(persona.personaId);
                const selected = selectedIndex >= 0;
                return (
                  <div className="agent-team-member-row" key={persona.personaId}>
                    <label>
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={!selected && teamEditor.personaIds.length >= MAX_AGENT_TEAM_MEMBERS}
                        onChange={(event) => {
                          const personaIds = event.currentTarget.checked
                            ? [...teamEditor.personaIds, persona.personaId]
                            : teamEditor.personaIds.filter((personaId) => personaId !== persona.personaId);
                          setTeamEditor({
                            ...teamEditor,
                            personaIds,
                            plannerPersonaId: personaIds.includes(teamEditor.plannerPersonaId)
                              ? teamEditor.plannerPersonaId
                              : personaIds[0] ?? '',
                          });
                        }}
                      />
                      <span>{persona.name}</span>
                    </label>
                    {selected && (
                      <>
                        <label className="agent-team-planner-choice">
                          <input type="radio" name="team-planner" checked={teamEditor.plannerPersonaId === persona.personaId} onChange={() => setTeamEditor({ ...teamEditor, plannerPersonaId: persona.personaId })} />
                          {t('agentTeams.planner')}
                        </label>
                        <IconButton icon={ChevronUp} aria-label={t('agentTeams.moveUp', { name: persona.name })} disabled={selectedIndex === 0} onClick={() => setTeamEditor({ ...teamEditor, personaIds: move(teamEditor.personaIds, selectedIndex, -1) })} />
                        <IconButton icon={ChevronDown} aria-label={t('agentTeams.moveDown', { name: persona.name })} disabled={selectedIndex === teamEditor.personaIds.length - 1} onClick={() => setTeamEditor({ ...teamEditor, personaIds: move(teamEditor.personaIds, selectedIndex, 1) })} />
                      </>
                    )}
                  </div>
                );
              })}
            </fieldset>
            {teamEditor.personaIds.length < 2 && <p className="settings-agent-warning">{t('agentTeams.minimumMembers')}</p>}
            {teamEditor.personaIds.length >= MAX_AGENT_TEAM_MEMBERS && (
              <p className="settings-hint">{t('agentTeams.maximumMembers', { count: MAX_AGENT_TEAM_MEMBERS })}</p>
            )}
            <label className="agent-team-goal-toggle">
              <input
                type="checkbox"
                checked={teamEditor.defaultGoalEnabled}
                onChange={(event) => setTeamEditor({ ...teamEditor, defaultGoalEnabled: event.currentTarget.checked })}
              />
              <span>
                <strong>{t('agentTeams.defaultGoal')}</strong>
                <small>{t('agentTeams.defaultGoalHint')}</small>
              </span>
            </label>
            {teamEditor.defaultGoalEnabled && (
              <div className="agent-team-goal-editor">
                <Field label={t('agentTeams.desiredOutcome')} required>
                  <textarea className="ui-textarea" rows={3} maxLength={2000} value={teamEditor.defaultGoalOutcome} onChange={(event) => setTeamEditor({ ...teamEditor, defaultGoalOutcome: event.currentTarget.value })} />
                </Field>
                <fieldset className="agent-team-criteria-editor">
                  <legend>{t('agentTeams.completionCriteria')}</legend>
                  {teamEditor.defaultGoalCriteria.map((criterion, index) => (
                    <div className="agent-team-criterion-row" key={index}>
                      <Input
                        aria-label={t('agentTeams.completionCriterionNumber', { number: index + 1 })}
                        value={criterion}
                        maxLength={500}
                        onChange={(event) => setTeamEditor({
                          ...teamEditor,
                          defaultGoalCriteria: teamEditor.defaultGoalCriteria.map((candidate, candidateIndex) => (
                            candidateIndex === index ? event.currentTarget.value : candidate
                          )),
                        })}
                      />
                      <IconButton
                        icon={X}
                        aria-label={t('agentTeams.removeCriterion', { number: index + 1 })}
                        disabled={teamEditor.defaultGoalCriteria.length === 1}
                        onClick={() => setTeamEditor({
                          ...teamEditor,
                          defaultGoalCriteria: teamEditor.defaultGoalCriteria.filter((_, candidateIndex) => candidateIndex !== index),
                        })}
                      />
                    </div>
                  ))}
                  <Button
                    size="sm"
                    variant="ghost"
                    leadingIcon={<Plus />}
                    disabled={teamEditor.defaultGoalCriteria.length >= MAX_AGENT_TEAM_GOAL_CRITERIA}
                    onClick={() => setTeamEditor({
                      ...teamEditor,
                      defaultGoalCriteria: [...teamEditor.defaultGoalCriteria, ''],
                    })}
                  >
                    {t('agentTeams.addCriterion')}
                  </Button>
                </fieldset>
              </div>
            )}
            <details className="agent-team-editor__advanced">
              <summary>{t('agentTeams.advancedSettings')}</summary>
              <div className="agent-team-editor__advanced-body">
                <Field label={t('agentTeams.descriptionLabel')}>
                  <Input value={teamEditor.description} maxLength={500} onChange={(event) => setTeamEditor({ ...teamEditor, description: event.currentTarget.value })} />
                </Field>
                <Field label={t('agentTeams.teamInstructions')} description={t('agentTeams.teamInstructionsHint')} required>
                  <textarea className="ui-textarea" rows={5} maxLength={8000} value={teamEditor.instructions} onChange={(event) => setTeamEditor({ ...teamEditor, instructions: event.currentTarget.value })} />
                </Field>
              </div>
            </details>
          </div>
        )}
      </Dialog>

      <Dialog
        open={starterEditor !== null}
        onOpenChange={(open) => { if (!open && !busy) setStarterEditor(null); }}
        title={t('agentTeams.starterDialogTitle')}
        description={t('agentTeams.starterDialogDescription')}
        size="md"
        testId="agent-team-starter-editor"
        footer={(
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setStarterEditor(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={busy} disabled={!starterValid} onClick={() => void createStarter()}>{t('agentTeams.createStarter')}</Button>
          </>
        )}
      >
        {starterEditor && (
          <div className="agent-team-editor">
            <Field label={t('agentTeams.plannerProvider')} description={t('agentTeams.plannerProviderHint')} required>
              <Select value={starterEditor.plannerProvider} onChange={(event) => setStarterEditor({ ...starterEditor, plannerProvider: event.currentTarget.value as Provider })}>
                <option value="" disabled>{t('agentTeams.chooseProvider')}</option>
                {(['codex', 'claude'] as const).map((provider) => (
                  <option key={provider} value={provider} disabled={!supportsPreset(snapshot.catalog.capabilities, provider, 'planner')}>
                    {provider === 'codex' ? 'Codex' : 'Claude Code'}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('agentTeams.implementerProvider')} description={t('agentTeams.implementerProviderHint')} required>
              <Select value={starterEditor.implementerProvider} onChange={(event) => setStarterEditor({ ...starterEditor, implementerProvider: event.currentTarget.value as Provider })}>
                <option value="" disabled>{t('agentTeams.chooseProvider')}</option>
                {(['codex', 'claude'] as const).map((provider) => (
                  <option key={provider} value={provider} disabled={!supportsPreset(snapshot.catalog.capabilities, provider, 'implementer')}>
                    {provider === 'codex' ? 'Codex' : 'Claude Code'}
                  </option>
                ))}
              </Select>
            </Field>
            {!starterValid && <p className="settings-agent-warning">{t('agentTeams.starterProviderRequired')}</p>}
          </div>
        )}
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open && !busy) setDeleteTarget(null); }}
        title={t('agentTeams.deleteTitle')}
        description={t('agentTeams.deleteDescription', { name: deleteTarget?.value.name ?? '' })}
        role="alertdialog"
        tone="danger"
        footer={(
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setDeleteTarget(null)}>{t('common.cancel')}</Button>
            <Button variant="danger" loading={busy} onClick={() => void confirmDelete()}>{t('common.remove')}</Button>
          </>
        )}
      >
        <p className="settings-hint">{deleteTarget?.kind === 'persona' ? t('agentTeams.personaDeleteHint') : t('agentTeams.teamDeleteHint')}</p>
      </Dialog>
    </div>
  );
}
