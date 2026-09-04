import { CalendarClock, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ProviderModel } from '../shared/daemon-provider';
import {
  createDaemonCommand,
  type DaemonCommand,
  type DaemonSchedule,
  type DaemonSnapshot,
  type PermissionPreset,
} from '../shared/daemon-protocol';
import { rendererCapabilities, type CapabilityAccess } from './capability-access';
import { useAppTranslation } from './i18n';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Select,
  Status,
  Switch,
} from './ui';

interface ScheduleSettingsProps {
  readonly capabilities?: CapabilityAccess;
}

interface ScheduleDraft {
  readonly name: string;
  readonly workspaceId: string;
  readonly providerId: string;
  readonly model: string;
  readonly permissionPreset: PermissionPreset;
  readonly prompt: string;
  readonly cron: string;
  readonly timezone: string;
  readonly maxRuns: string;
  readonly enabled: boolean;
}

type ScheduleDraftErrorKey = keyof ScheduleDraft | 'form';
type ScheduleDraftErrors = Readonly<Partial<Record<ScheduleDraftErrorKey, string>>>;

interface ScheduleMessage {
  readonly variant: 'success' | 'warning' | 'danger';
  readonly text: string;
}

interface BlockedScheduleMutation {
  readonly blockedMessage: string;
}

const PERMISSION_PRESETS: readonly PermissionPreset[] = ['plan', 'standard', 'full-access'];

function opaqueId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `${prefix}-${uuid}` : `${prefix}-${Date.now().toString(36)}`;
}

function detectedTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function isExactFiveFieldCron(value: string): boolean {
  return value.trim().split(/\s+/u).filter(Boolean).length === 5;
}

export function isIanaTimeZone(value: string): boolean {
  const candidate = value.trim();
  if (!candidate || /\s/u.test(candidate)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: candidate }).format(0);
    return true;
  } catch {
    return false;
  }
}

function automationReady(snapshot: DaemonSnapshot): boolean {
  return snapshot.runtime.keepRunning && snapshot.runtime.startAtLogin;
}

function createDraft(snapshot: DaemonSnapshot): ScheduleDraft {
  const workspace = snapshot.workspaces.find((candidate) => !candidate.archivedAt);
  const provider = snapshot.providers.find((candidate) => candidate.enabled && candidate.health === 'ready')
    ?? snapshot.providers[0];
  return {
    name: '',
    workspaceId: workspace?.id ?? '',
    providerId: provider?.id ?? '',
    model: '',
    permissionPreset: 'standard',
    prompt: '',
    cron: '0 9 * * 1-5',
    timezone: detectedTimeZone(),
    maxRuns: '',
    enabled: automationReady(snapshot),
  };
}

function formatRunTime(value: string | undefined, locale: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === 'ko' ? 'ko-KR' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function ScheduleSettings({
  capabilities = rendererCapabilities,
}: ScheduleSettingsProps): JSX.Element {
  const { i18n, t } = useAppTranslation();
  const [snapshot, setSnapshot] = useState<DaemonSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const [draftErrors, setDraftErrors] = useState<ScheduleDraftErrors>({});
  const [models, setModels] = useState<readonly ProviderModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [message, setMessage] = useState<ScheduleMessage | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const snapshotRef = useRef<DaemonSnapshot | null>(null);
  const refreshGeneration = useRef(0);
  const modelGeneration = useRef(0);
  const mutationBusyRef = useRef(false);

  const applySnapshot = useCallback((next: DaemonSnapshot): void => {
    snapshotRef.current = next;
    setSnapshot(next);
    setLoadError(null);
  }, []);

  const refreshSnapshot = useCallback(async (showLoading = false): Promise<DaemonSnapshot | null> => {
    const generation = refreshGeneration.current + 1;
    refreshGeneration.current = generation;
    if (showLoading || !snapshotRef.current) setLoading(true);
    try {
      const next = await capabilities.daemon.getSnapshot();
      if (refreshGeneration.current !== generation) return snapshotRef.current;
      if (!next) {
        setLoadError(t('agentSettings.scheduleUnavailable'));
        return null;
      }
      applySnapshot(next);
      return next;
    } catch {
      if (refreshGeneration.current === generation) {
        setLoadError(t('agentSettings.scheduleUnavailable'));
      }
      return null;
    } finally {
      if (refreshGeneration.current === generation) setLoading(false);
    }
  }, [applySnapshot, capabilities, t]);

  useEffect(() => {
    let active = true;
    void refreshSnapshot(true);
    let dispose = (): void => undefined;
    try {
      dispose = capabilities.daemon.observeEvents((event) => {
        if (!active || mutationBusyRef.current) return;
        const scheduleChanged = event.kind === 'entity.upserted'
          && ['schedule', 'workspace', 'provider'].includes(event.payload.entityType);
        const workspaceArchived = event.kind === 'entity.archived'
          && event.payload.entityType === 'workspace';
        if (event.kind === 'runtime.changed' || scheduleChanged || workspaceArchived) void refreshSnapshot();
      }, () => {
        if (active) setLoadError(t('agentSettings.scheduleLiveUpdatesUnavailable'));
      });
    } catch {
      setLoadError(t('agentSettings.scheduleLiveUpdatesUnavailable'));
    }
    return () => {
      active = false;
      refreshGeneration.current += 1;
      dispose();
    };
  }, [capabilities, refreshSnapshot, t]);

  useEffect(() => {
    if (!draft?.providerId) {
      setModels([]);
      setModelsError(null);
      setModelsLoading(false);
      return;
    }
    const generation = modelGeneration.current + 1;
    modelGeneration.current = generation;
    setModelsLoading(true);
    setModelsError(null);
    void capabilities.structuredProviders.listModels(draft.providerId).then((result) => {
      if (modelGeneration.current !== generation) return;
      if (!result.ok) {
        setModels([]);
        setModelsError(t('agentSettings.scheduleModelsUnavailable'));
        return;
      }
      setModels(result.value);
    }).catch(() => {
      if (modelGeneration.current === generation) {
        setModels([]);
        setModelsError(t('agentSettings.scheduleModelsUnavailable'));
      }
    }).finally(() => {
      if (modelGeneration.current === generation) setModelsLoading(false);
    });
    return () => {
      if (modelGeneration.current === generation) modelGeneration.current += 1;
    };
  }, [capabilities, draft?.providerId, t]);

  useEffect(() => {
    if (!snapshot || !draft) return;
    const workspaces = snapshot.workspaces.filter((workspace) => !workspace.archivedAt);
    const workspaceId = workspaces.some((workspace) => workspace.id === draft.workspaceId)
      ? draft.workspaceId
      : workspaces[0]?.id ?? '';
    const providerId = snapshot.providers.some((provider) => provider.id === draft.providerId)
      ? draft.providerId
      : snapshot.providers[0]?.id ?? '';
    const enabled = automationReady(snapshot) ? draft.enabled : false;
    if (workspaceId !== draft.workspaceId || providerId !== draft.providerId || enabled !== draft.enabled) {
      setDraft({ ...draft, workspaceId, providerId, model: providerId === draft.providerId ? draft.model : '', enabled });
    }
  }, [draft, snapshot]);

  useEffect(() => {
    if (confirmDeleteId && snapshot && !snapshot.schedules.some((schedule) => schedule.id === confirmDeleteId)) {
      setConfirmDeleteId(null);
    }
  }, [confirmDeleteId, snapshot]);

  const workspaceRecords = useMemo(() => new Map(
    (snapshot?.workspaces ?? []).map((workspace) => [workspace.id, workspace]),
  ), [snapshot]);
  const providerRecords = useMemo(() => new Map(
    (snapshot?.providers ?? []).map((provider) => [provider.id, provider]),
  ), [snapshot]);
  const activeWorkspaces = useMemo(
    () => (snapshot?.workspaces ?? []).filter((workspace) => !workspace.archivedAt),
    [snapshot],
  );
  const readyForAutomation = snapshot ? automationReady(snapshot) : false;

  const patchDraft = <K extends keyof ScheduleDraft>(key: K, value: ScheduleDraft[K]): void => {
    setDraft((current) => current ? { ...current, [key]: value } : current);
    setDraftErrors((current) => {
      if (!current[key] && !current.form) return current;
      const next = { ...current };
      delete next[key];
      delete next.form;
      return next;
    });
    setMessage(null);
  };

  const validateDraft = (candidate: ScheduleDraft, authority: DaemonSnapshot): ScheduleDraftErrors => {
    const errors: Partial<Record<ScheduleDraftErrorKey, string>> = {};
    if (!candidate.name.trim()) errors.name = t('agentSettings.scheduleNameRequired');
    if (!authority.workspaces.some((workspace) => workspace.id === candidate.workspaceId && !workspace.archivedAt)) {
      errors.workspaceId = t('agentSettings.scheduleWorkspaceRequired');
    }
    const provider = authority.providers.find((item) => item.id === candidate.providerId);
    if (!provider) {
      errors.providerId = t('agentSettings.scheduleProviderRequired');
    } else if (candidate.enabled && (!provider.enabled || provider.health !== 'ready')) {
      errors.providerId = t('agentSettings.scheduleProviderNotReady');
    }
    if (!candidate.prompt.trim()) errors.prompt = t('agentSettings.schedulePromptRequired');
    if (!isExactFiveFieldCron(candidate.cron)) errors.cron = t('agentSettings.scheduleCronInvalid');
    if (!isIanaTimeZone(candidate.timezone)) errors.timezone = t('agentSettings.scheduleTimezoneInvalid');
    if (candidate.maxRuns.trim()) {
      const maxRuns = Number(candidate.maxRuns.trim());
      if (!/^\d+$/u.test(candidate.maxRuns.trim()) || !Number.isSafeInteger(maxRuns) || maxRuns < 1) {
        errors.maxRuns = t('agentSettings.scheduleMaxRunsInvalid');
      }
    }
    if (candidate.enabled && !automationReady(authority)) {
      errors.enabled = t('agentSettings.scheduleAutomationRequired');
    }
    return errors;
  };

  const runMutation = async (
    action: string,
    build: (authority: DaemonSnapshot) => DaemonCommand | BlockedScheduleMutation,
    successText: string,
  ): Promise<boolean> => {
    if (mutationBusyRef.current) return false;
    mutationBusyRef.current = true;
    setBusyAction(action);
    setMessage(null);
    try {
      const authority = await refreshSnapshot();
      if (!authority) {
        setMessage({ variant: 'danger', text: t('agentSettings.scheduleUnavailable') });
        return false;
      }
      const built = build(authority);
      if ('blockedMessage' in built) {
        setMessage({ variant: 'warning', text: built.blockedMessage });
        return false;
      }
      const receipt = await capabilities.daemon.sendCommand(built);
      if (!receipt.ok) {
        await refreshSnapshot();
        const text = receipt.error.code === 'revision-conflict'
          ? t('agentSettings.scheduleRevisionChanged')
          : receipt.error.code === 'automation-requires-daemon'
            ? t('agentSettings.scheduleAutomationRequired')
            : receipt.error.message;
        setMessage({
          variant: receipt.error.code === 'automation-requires-daemon' ? 'warning' : 'danger',
          text,
        });
        return false;
      }
      await refreshSnapshot();
      setMessage({ variant: 'success', text: successText });
      return true;
    } catch {
      setMessage({ variant: 'danger', text: t('agentSettings.scheduleCommandFailed') });
      return false;
    } finally {
      mutationBusyRef.current = false;
      setBusyAction(null);
    }
  };

  const submitDraft = async (): Promise<void> => {
    if (!draft || !snapshotRef.current || mutationBusyRef.current) return;
    const candidate = draft;
    const errors = validateDraft(candidate, snapshotRef.current);
    if (Object.keys(errors).length > 0) {
      setDraftErrors(errors);
      return;
    }
    const scheduleId = opaqueId('schedule');
    const saved = await runMutation('create', (authority) => {
      const freshErrors = validateDraft(candidate, authority);
      if (Object.keys(freshErrors).length > 0) {
        setDraftErrors(freshErrors);
        return {
          blockedMessage: Object.values(freshErrors)[0] ?? t('agentSettings.scheduleCommandFailed'),
        };
      }
      const commandId = opaqueId('schedule-settings');
      return createDaemonCommand({
        commandId,
        idempotencyKey: commandId,
        expectedRevision: authority.revision,
        issuedAt: new Date().toISOString(),
        principal: { kind: 'desktop', id: 'renderer-schedule-settings' },
        type: 'schedule.create',
        payload: {
          scheduleId,
          name: candidate.name.trim(),
          workspaceId: candidate.workspaceId,
          providerId: candidate.providerId,
          ...(candidate.model.trim() ? { model: candidate.model.trim() } : {}),
          permissionPreset: candidate.permissionPreset,
          prompt: candidate.prompt.trim(),
          cron: candidate.cron.trim().replace(/\s+/gu, ' '),
          timezone: candidate.timezone.trim(),
          ...(candidate.maxRuns.trim() ? { maxRuns: Number(candidate.maxRuns.trim()) } : {}),
          enabled: candidate.enabled,
        },
      });
    }, t('agentSettings.scheduleCreated', { name: candidate.name.trim() }));
    if (saved) {
      setCreating(false);
      setDraft(null);
      setDraftErrors({});
    }
  };

  const toggleSchedule = async (schedule: DaemonSchedule): Promise<void> => {
    const enabled = !schedule.enabled;
    await runMutation(`toggle:${schedule.id}`, (authority) => {
      if (enabled && !automationReady(authority)) {
        return { blockedMessage: t('agentSettings.scheduleAutomationRequired') };
      }
      const provider = authority.providers.find((candidate) => candidate.id === schedule.providerId);
      const workspace = authority.workspaces.find((candidate) => (
        candidate.id === schedule.workspaceId && !candidate.archivedAt
      ));
      if (enabled && (!workspace || !provider?.enabled || provider.health !== 'ready')) {
        return { blockedMessage: t('agentSettings.scheduleTargetUnavailable') };
      }
      const commandId = opaqueId('schedule-settings');
      return createDaemonCommand({
        commandId,
        idempotencyKey: commandId,
        expectedRevision: authority.revision,
        issuedAt: new Date().toISOString(),
        principal: { kind: 'desktop', id: 'renderer-schedule-settings' },
        type: 'schedule.update',
        payload: { scheduleId: schedule.id, enabled },
      });
    }, enabled
      ? t('agentSettings.scheduleEnabled', { name: schedule.name })
      : t('agentSettings.scheduleDisabled', { name: schedule.name }));
  };

  const runNow = async (schedule: DaemonSchedule): Promise<void> => {
    await runMutation(`run:${schedule.id}`, (authority) => {
      const provider = authority.providers.find((candidate) => candidate.id === schedule.providerId);
      const workspace = authority.workspaces.find((candidate) => (
        candidate.id === schedule.workspaceId && !candidate.archivedAt
      ));
      if (!workspace || !provider?.enabled || provider.health !== 'ready') {
        return { blockedMessage: t('agentSettings.scheduleTargetUnavailable') };
      }
      const commandId = opaqueId('schedule-settings');
      return createDaemonCommand({
        commandId,
        idempotencyKey: commandId,
        expectedRevision: authority.revision,
        issuedAt: new Date().toISOString(),
        principal: { kind: 'desktop', id: 'renderer-schedule-settings' },
        type: 'schedule.run-now',
        payload: { scheduleId: schedule.id },
      });
    }, t('agentSettings.scheduleRunRequested', { name: schedule.name }));
  };

  const deleteSchedule = async (schedule: DaemonSchedule): Promise<void> => {
    const deleted = await runMutation(`delete:${schedule.id}`, (authority) => {
      const commandId = opaqueId('schedule-settings');
      return createDaemonCommand({
        commandId,
        idempotencyKey: commandId,
        expectedRevision: authority.revision,
        issuedAt: new Date().toISOString(),
        principal: { kind: 'desktop', id: 'renderer-schedule-settings' },
        type: 'schedule.delete',
        payload: { scheduleId: schedule.id },
      });
    }, t('agentSettings.scheduleDeleted', { name: schedule.name }));
    if (deleted) setConfirmDeleteId(null);
  };

  const focusHostControls = (): void => {
    const target = document.getElementById('agent-host-settings');
    target?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    target?.focus({ preventScroll: true });
  };

  return (
    <section
      className="schedule-settings"
      aria-labelledby="schedule-settings-title"
      aria-busy={loading || busyAction !== null || undefined}
    >
      <div className="agent-settings-heading">
        <div>
          <h2 className="status-section-title" id="schedule-settings-title">
            {t('agentSettings.schedulesTitle')}
          </h2>
          <p>{t('agentSettings.schedulesDescription')}</p>
        </div>
        {snapshot && (
          <Button
            size="sm"
            leadingIcon={<Plus size={14} />}
            disabled={creating || busyAction !== null}
            onClick={() => {
              setCreating(true);
              setDraft(createDraft(snapshot));
              setDraftErrors({});
              setMessage(null);
            }}
            data-testid="schedule-create-open"
          >
            {t('agentSettings.scheduleAdd')}
          </Button>
        )}
      </div>

      {loading && !snapshot && <LoadingState label={t('agentSettings.scheduleLoading')} />}
      {!loading && loadError && !snapshot && (
        <ErrorState
          title={t('agentSettings.scheduleLoadFailed')}
          description={loadError}
          action={(
            <Button size="sm" leadingIcon={<RefreshCw size={14} />} onClick={() => void refreshSnapshot(true)}>
              {t('agentSettings.scheduleRetry')}
            </Button>
          )}
        />
      )}

      {snapshot && (
        <>
          {!readyForAutomation && (
            <div className="schedule-settings__automation-warning" data-testid="schedule-runtime-warning">
              <Status variant="warning">{t('agentSettings.scheduleAutomationRequired')}</Status>
              <p>{t('agentSettings.scheduleAutomationRequiredHint')}</p>
              <Button size="sm" variant="ghost" onClick={focusHostControls}>
                {t('agentSettings.scheduleReviewHostRuntime')}
              </Button>
            </div>
          )}

          {loadError && (
            <Status className="schedule-settings__status" variant="warning" live="polite">
              {loadError}
            </Status>
          )}
          {message && (
            <Status className="schedule-settings__status" variant={message.variant} live="polite">
              {message.text}
            </Status>
          )}

          {creating && draft && (
            <form
              className="schedule-create-form"
              aria-labelledby="schedule-create-title"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void submitDraft();
              }}
              data-testid="schedule-create-form"
            >
              <div className="schedule-create-form__heading">
                <h3 id="schedule-create-title">{t('agentSettings.scheduleCreateTitle')}</h3>
                <p>{t('agentSettings.scheduleCreateDescription')}</p>
              </div>
              <div className="schedule-create-form__grid">
                <Field label={t('agentSettings.scheduleName')} required error={draftErrors.name}>
                  <Input
                    value={draft.name}
                    maxLength={120}
                    autoComplete="off"
                    onChange={(event) => patchDraft('name', event.target.value)}
                    data-testid="schedule-name"
                  />
                </Field>
                <Field label={t('agentSettings.scheduleWorkspace')} required error={draftErrors.workspaceId}>
                  <Select
                    value={draft.workspaceId}
                    onChange={(event) => patchDraft('workspaceId', event.target.value)}
                    data-testid="schedule-workspace"
                  >
                    {!activeWorkspaces.length && <option value="">{t('agentSettings.scheduleNoWorkspaces')}</option>}
                    {activeWorkspaces.map((workspace) => (
                      <option value={workspace.id} key={workspace.id}>{workspace.name} — {workspace.rootPath}</option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('agentSettings.scheduleProvider')} required error={draftErrors.providerId}>
                  <Select
                    value={draft.providerId}
                    onChange={(event) => {
                      patchDraft('providerId', event.target.value);
                      patchDraft('model', '');
                    }}
                    data-testid="schedule-provider"
                  >
                    {!snapshot.providers.length && <option value="">{t('agentSettings.scheduleNoProviders')}</option>}
                    {snapshot.providers.map((provider) => (
                      <option value={provider.id} key={provider.id}>
                        {provider.displayName} — {provider.enabled && provider.health === 'ready'
                          ? t('agentSettings.providerReady')
                          : t('agentSettings.providerMissing')}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label={t('agentSettings.scheduleModel')}
                  description={modelsLoading
                    ? t('agentSettings.scheduleModelsLoading')
                    : modelsError ?? t('agentSettings.scheduleModelOptional')}
                >
                  <Input
                    value={draft.model}
                    list="schedule-model-options"
                    maxLength={256}
                    autoComplete="off"
                    placeholder={t('agentSettings.scheduleProviderDefault')}
                    onChange={(event) => patchDraft('model', event.target.value)}
                    data-testid="schedule-model"
                  />
                  <datalist id="schedule-model-options">
                    {models.map((model) => <option value={model.id} key={model.id}>{model.displayName}</option>)}
                  </datalist>
                </Field>
                <Field label={t('agentSettings.schedulePermission')} required>
                  <Select
                    value={draft.permissionPreset}
                    onChange={(event) => patchDraft('permissionPreset', event.target.value as PermissionPreset)}
                    data-testid="schedule-permission"
                  >
                    {PERMISSION_PRESETS.map((preset) => (
                      <option value={preset} key={preset}>{t(`agentSettings.schedulePermission_${preset}`)}</option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('agentSettings.scheduleCron')} required error={draftErrors.cron}>
                  <Input
                    value={draft.cron}
                    maxLength={160}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="0 9 * * 1-5"
                    onChange={(event) => patchDraft('cron', event.target.value)}
                    data-testid="schedule-cron"
                  />
                </Field>
                <Field label={t('agentSettings.scheduleTimezone')} required error={draftErrors.timezone}>
                  <Input
                    value={draft.timezone}
                    maxLength={128}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="Asia/Seoul"
                    onChange={(event) => patchDraft('timezone', event.target.value)}
                    data-testid="schedule-timezone"
                  />
                </Field>
                <Field
                  label={t('agentSettings.scheduleMaxRuns')}
                  description={t('agentSettings.scheduleMaxRunsOptional')}
                  error={draftErrors.maxRuns}
                >
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    value={draft.maxRuns}
                    onChange={(event) => patchDraft('maxRuns', event.target.value)}
                    data-testid="schedule-max-runs"
                  />
                </Field>
                <Field
                  className="schedule-create-form__prompt"
                  id="schedule-prompt"
                  label={t('agentSettings.schedulePrompt')}
                  required
                  error={draftErrors.prompt}
                >
                  <textarea
                    id="schedule-prompt"
                    className="ez-ui-input schedule-create-form__textarea"
                    rows={4}
                    required
                    maxLength={20_000}
                    value={draft.prompt}
                    aria-invalid={Boolean(draftErrors.prompt) || undefined}
                    aria-describedby={draftErrors.prompt ? 'schedule-prompt-error' : undefined}
                    onChange={(event) => patchDraft('prompt', event.target.value)}
                    data-testid="schedule-prompt"
                  />
                </Field>
              </div>
              <Switch
                checked={draft.enabled}
                disabled={!readyForAutomation || busyAction !== null}
                onChange={(event) => patchDraft('enabled', event.target.checked)}
                label={t('agentSettings.scheduleEnableOnCreate')}
                description={readyForAutomation
                  ? t('agentSettings.scheduleEnableOnCreateHint')
                  : t('agentSettings.scheduleSaveDisabledHint')}
                data-testid="schedule-enabled"
              />
              {draftErrors.enabled && <p className="schedule-create-form__error" role="alert">{draftErrors.enabled}</p>}
              {draftErrors.form && <p className="schedule-create-form__error" role="alert">{draftErrors.form}</p>}
              <div className="schedule-create-form__actions">
                <Button
                  size="sm"
                  disabled={busyAction !== null}
                  onClick={() => {
                    setCreating(false);
                    setDraft(null);
                    setDraftErrors({});
                  }}
                >
                  {t('agentSettings.scheduleCancel')}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  loading={busyAction === 'create'}
                  loadingLabel={t('agentSettings.scheduleSaving')}
                  disabled={busyAction !== null || !activeWorkspaces.length || !snapshot.providers.length}
                  data-testid="schedule-create-submit"
                >
                  {draft.enabled ? t('agentSettings.scheduleCreateEnabled') : t('agentSettings.scheduleSaveDisabled')}
                </Button>
              </div>
            </form>
          )}

          {!snapshot.schedules.length && !creating ? (
            <EmptyState
              icon={CalendarClock}
              title={t('agentSettings.scheduleEmptyTitle')}
              description={t('agentSettings.scheduleEmptyDescription')}
            />
          ) : (
            <div className="schedule-list" role="list" aria-label={t('agentSettings.schedulesTitle')}>
              {snapshot.schedules.map((schedule) => {
                const provider = providerRecords.get(schedule.providerId);
                const workspace = workspaceRecords.get(schedule.workspaceId);
                const targetAvailable = Boolean(
                  workspace && !workspace.archivedAt && provider?.enabled && provider.health === 'ready',
                );
                const nextRun = formatRunTime(schedule.nextRunAt, i18n.language);
                const toggling = busyAction === `toggle:${schedule.id}`;
                const running = busyAction === `run:${schedule.id}`;
                const deleting = busyAction === `delete:${schedule.id}`;
                const confirmingDelete = confirmDeleteId === schedule.id;
                return (
                  <article className="schedule-row" role="listitem" key={schedule.id} data-testid={`schedule-${schedule.id}`}>
                    <header className="schedule-row__header">
                      <div className="schedule-row__identity">
                        <strong>{schedule.name}</strong>
                        <span>{provider?.displayName ?? schedule.providerId} · {workspace?.name ?? schedule.workspaceId}</span>
                      </div>
                      <Badge size="sm" variant={schedule.enabled ? 'success' : 'neutral'}>
                        {schedule.enabled ? t('agentSettings.scheduleEnabledState') : t('agentSettings.scheduleDisabledState')}
                      </Badge>
                    </header>
                    <dl className="schedule-row__metadata">
                      <div>
                        <dt>{t('agentSettings.scheduleNextRun')}</dt>
                        <dd>{nextRun ?? (schedule.enabled
                          ? t('agentSettings.scheduleNextRunPending')
                          : t('agentSettings.scheduleNotScheduled'))}</dd>
                      </div>
                      <div>
                        <dt>{t('agentSettings.scheduleRunCount')}</dt>
                        <dd>{schedule.maxRuns
                          ? t('agentSettings.scheduleRunCountBounded', { count: schedule.runCount, max: schedule.maxRuns })
                          : t('agentSettings.scheduleRunCountValue', { count: schedule.runCount })}</dd>
                      </div>
                      <div className="is-wide">
                        <dt>{t('agentSettings.scheduleTiming')}</dt>
                        <dd><code>{schedule.cron}</code><span>{schedule.timezone}</span></dd>
                      </div>
                    </dl>
                    {!targetAvailable && (
                      <Status variant="warning">{t('agentSettings.scheduleTargetUnavailable')}</Status>
                    )}
                    {confirmingDelete ? (
                      <div
                        className="schedule-row__delete-confirmation"
                        role="group"
                        aria-label={t('agentSettings.scheduleDeleteQuestion', { name: schedule.name })}
                        data-testid={`schedule-delete-confirm-${schedule.id}`}
                      >
                        <span>{t('agentSettings.scheduleDeleteQuestion', { name: schedule.name })}</span>
                        <div>
                          <Button size="sm" disabled={busyAction !== null} onClick={() => setConfirmDeleteId(null)}>
                            {t('agentSettings.scheduleCancel')}
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            loading={deleting}
                            loadingLabel={t('agentSettings.scheduleDeleting')}
                            disabled={busyAction !== null}
                            onClick={() => void deleteSchedule(schedule)}
                            data-testid={`schedule-delete-commit-${schedule.id}`}
                          >
                            {t('agentSettings.scheduleDeleteConfirm')}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="schedule-row__actions">
                        <Button
                          size="sm"
                          disabled={busyAction !== null || (!schedule.enabled && (!readyForAutomation || !targetAvailable))}
                          loading={toggling}
                          loadingLabel={t('agentSettings.scheduleSaving')}
                          onClick={() => void toggleSchedule(schedule)}
                          data-testid={`schedule-toggle-${schedule.id}`}
                        >
                          {schedule.enabled ? t('agentSettings.scheduleDisable') : t('agentSettings.scheduleEnable')}
                        </Button>
                        <Button
                          size="sm"
                          leadingIcon={<Play size={13} />}
                          disabled={busyAction !== null || !targetAvailable}
                          loading={running}
                          loadingLabel={t('agentSettings.scheduleStarting')}
                          onClick={() => void runNow(schedule)}
                          data-testid={`schedule-run-${schedule.id}`}
                        >
                          {t('agentSettings.scheduleRunNow')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          leadingIcon={<Trash2 size={13} />}
                          disabled={busyAction !== null}
                          onClick={() => setConfirmDeleteId(schedule.id)}
                          data-testid={`schedule-delete-${schedule.id}`}
                        >
                          {t('agentSettings.scheduleDelete')}
                        </Button>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}
