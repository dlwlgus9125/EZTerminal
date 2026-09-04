import { useMemo, useState } from 'react';

import { useAppTranslation } from '../../src/renderer/i18n';
import {
  MAX_AGENT_VALIDATIONS,
  type AgentCoordinationSnapshot,
  type AgentValidationCommand,
} from '../../src/shared/agent-coordination';
import {
  DEFAULT_COLLABORATION_LIMITS,
  DEFAULT_COLLABORATION_MERGE_POLICY,
  type AgentOrchestrationSnapshot,
  type CollaborationPermissionMode,
} from '../../src/shared/agent-orchestration';
import type { AgentProjectSummary } from '../../src/shared/agent-history';
import { MobileActionSheet } from './MobileActionSheet';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';

function lines(value: string): readonly string[] {
  return value.split(/\r?\n/gu).map((entry) => entry.trim()).filter(Boolean);
}

export function MobileCollaborationPolicySheet({
  project,
  coordinationSnapshot,
  snapshot,
  transport,
  onClose,
}: {
  readonly project: AgentProjectSummary;
  readonly coordinationSnapshot: AgentCoordinationSnapshot;
  readonly snapshot: AgentOrchestrationSnapshot;
  readonly transport: WsEzTerminalTransport;
  readonly onClose: () => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const current = snapshot.policies.find((policy) => policy.projectId === project.projectId);
  const coordinatedProject = coordinationSnapshot.projects.find(
    (candidate) => candidate.projectId === project.projectId,
  );
  const workerProfiles = useMemo(
    () => snapshot.profiles.filter((profile) => profile.capabilities.includes('worker')),
    [snapshot.profiles],
  );
  const [enabled, setEnabled] = useState(current?.enabled ?? false);
  const [permissionMode, setPermissionMode] = useState<CollaborationPermissionMode>(
    current?.permissionMode ?? 'ask',
  );
  const [profileIds, setProfileIds] = useState<readonly string[]>(
    current?.allowedWorkerProfileIds
      ?? workerProfiles.filter((profile) => profile.available).map((profile) => profile.profileId),
  );
  const [goal, setGoal] = useState(coordinatedProject?.goal ?? project.name);
  const [targetBranch, setTargetBranch] = useState(
    coordinatedProject?.defaultTargetBranch ?? current?.mergePolicy.targetBranches[0] ?? 'main',
  );
  const [validationCommands, setValidationCommands] = useState<readonly AgentValidationCommand[]>(
    coordinatedProject?.validationCommands ?? [],
  );
  const [coordinationRevision, setCoordinationRevision] = useState(
    coordinatedProject?.configRevision ?? 0,
  );
  const [policyRevision] = useState(current?.revision ?? 0);
  const [maxConcurrent, setMaxConcurrent] = useState(
    current?.limits.maxConcurrent ?? DEFAULT_COLLABORATION_LIMITS.maxConcurrent,
  );
  const [maxCreated, setMaxCreated] = useState(
    current?.limits.maxCreated ?? DEFAULT_COLLABORATION_LIMITS.maxCreated,
  );
  const [maxMinutes, setMaxMinutes] = useState(
    (current?.limits.maxDurationMs ?? DEFAULT_COLLABORATION_LIMITS.maxDurationMs) / 60_000,
  );
  const [maxFiles, setMaxFiles] = useState(
    current?.mergePolicy.maxChangedFiles ?? DEFAULT_COLLABORATION_MERGE_POLICY.maxChangedFiles,
  );
  const [maxLines, setMaxLines] = useState(
    current?.mergePolicy.maxChangedLines ?? DEFAULT_COLLABORATION_MERGE_POLICY.maxChangedLines,
  );
  const [allowPaths, setAllowPaths] = useState(current?.mergePolicy.allowPaths.join('\n') ?? '');
  const [denyPaths, setDenyPaths] = useState(
    current?.mergePolicy.denyPaths.join('\n') ?? DEFAULT_COLLABORATION_MERGE_POLICY.denyPaths.join('\n'),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [migrationConfirmation, setMigrationConfirmation] = useState(false);

  const confirmMigration = async (): Promise<void> => {
    if (busy || !snapshot.migration.required) return;
    setBusy(true);
    setMessage(null);
    const result = await transport.confirmLegacyTeamMigration().catch(() => ({
      ok: false as const,
      error: 'unavailable' as const,
      message: t('collaboration.migrationFailed'),
    }));
    setBusy(false);
    if (!result.ok) {
      setMessage(t('collaboration.migrationFailed'));
      return;
    }
    setMigrationConfirmation(false);
    setMessage(t('collaboration.migrationComplete'));
  };

  const save = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const normalizedValidations = validationCommands.map((validation) => ({
      ...validation,
      name: validation.name.trim(),
      command: validation.command.trim(),
      timeoutMs: Number.isFinite(validation.timeoutMs)
        ? Math.max(1_000, Math.min(30 * 60_000, Math.round(validation.timeoutMs)))
        : 300_000,
    }));
    const coordinationResult = await transport.saveAgentCoordinationProject({
      projectId: project.projectId,
      goal: goal.trim(),
      defaultTargetBranch: targetBranch.trim(),
      validationCommands: normalizedValidations,
      expectedRevision: coordinationRevision,
    }).catch(() => ({
      ok: false as const,
      error: 'unavailable' as const,
      message: t('collaboration.policySaveFailed'),
    }));
    if (!coordinationResult.ok) {
      setBusy(false);
      setMessage(coordinationResult.message);
      return;
    }
    setCoordinationRevision(coordinationResult.value.configRevision);

    const result = await transport.saveCollaborationPolicy({
      projectId: project.projectId,
      enabled,
      permissionMode,
      allowedWorkerProfileIds: profileIds,
      limits: {
        maxConcurrent: Math.max(1, Math.min(4, Math.round(maxConcurrent))),
        maxCreated: Math.max(1, Math.min(12, Math.round(maxCreated))),
        maxDurationMs: Math.max(1, Math.min(120, Math.round(maxMinutes))) * 60_000,
      },
      mergePolicy: {
        targetBranches: [targetBranch.trim()],
        allowPaths: lines(allowPaths),
        denyPaths: lines(denyPaths),
        requiredValidationIds: normalizedValidations.map((validation) => validation.id),
        maxChangedFiles: Math.max(1, Math.round(maxFiles)),
        maxChangedLines: Math.max(1, Math.round(maxLines)),
      },
      expectedRevision: policyRevision,
    }).catch(() => ({
      ok: false as const,
      error: 'unavailable' as const,
      message: t('collaboration.policySaveFailed'),
    }));
    setBusy(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    onClose();
  };

  return (
    <MobileActionSheet
      title={t('collaboration.projectPolicy')}
      description={project.name}
      onClose={onClose}
      variant="fullscreen"
      showCloseButton={false}
      testId="mobile-collaboration-policy"
      contentClassName="mobile-collaboration-policy"
    >
      <p className="mobile-collaboration-policy__hint">{t('collaboration.projectPolicyHint')}</p>
      <fieldset className="mobile-collaboration-policy__group" disabled={busy}>
        <legend>{t('agentHub.collaboration.projectTitle', { name: project.name })}</legend>
        <div className="mobile-collaboration-policy__fields">
          <label className="mobile-collaboration-policy__wide">
            <span>{t('agentHub.collaboration.goal')}</span>
            <textarea
              rows={3}
              maxLength={2000}
              value={goal}
              onChange={(event) => setGoal(event.currentTarget.value)}
              data-testid="mobile-collaboration-goal"
            />
          </label>
          <label className="mobile-collaboration-policy__wide">
            <span>{t('agentHub.collaboration.targetBranch')}</span>
            <input
              maxLength={200}
              value={targetBranch}
              onChange={(event) => setTargetBranch(event.currentTarget.value)}
              data-testid="mobile-collaboration-target"
            />
          </label>
        </div>
      </fieldset>

      <section className="mobile-collaboration-policy__validations" aria-labelledby="mobile-collaboration-validations-title">
        <div className="mobile-collaboration-policy__validation-head">
          <h3 id="mobile-collaboration-validations-title">{t('agentHub.collaboration.validations')}</h3>
          <button
            type="button"
            className="mob-btn-ghost"
            disabled={busy || validationCommands.length >= MAX_AGENT_VALIDATIONS}
            onClick={() => setValidationCommands((values) => [...values, {
              id: globalThis.crypto?.randomUUID?.() ?? `validation-${Date.now()}-${values.length}`,
              name: '',
              command: '',
              timeoutMs: 300_000,
            }])}
            data-testid="mobile-collaboration-add-validation"
          >
            {t('agentHub.collaboration.addValidation')}
          </button>
        </div>
        {validationCommands.map((validation, index) => (
          <fieldset className="mobile-collaboration-policy__validation" key={validation.id} disabled={busy}>
            <legend>{t('agentHub.collaboration.validationNumber', { value: index + 1 })}</legend>
            <label>
              <span>{t('agentHub.collaboration.validationName')}</span>
              <input
                maxLength={120}
                value={validation.name}
                onChange={(event) => setValidationCommands((values) => values.map((value) => (
                  value.id === validation.id ? { ...value, name: event.currentTarget.value } : value
                )))}
              />
            </label>
            <label>
              <span>{t('agentHub.collaboration.validationCommand')}</span>
              <textarea
                rows={2}
                maxLength={8192}
                value={validation.command}
                onChange={(event) => setValidationCommands((values) => values.map((value) => (
                  value.id === validation.id ? { ...value, command: event.currentTarget.value } : value
                )))}
              />
            </label>
            <label>
              <span>{t('agentHub.collaboration.validationTimeout')}</span>
              <input
                type="number"
                min={1}
                max={1800}
                value={Math.round(validation.timeoutMs / 1000)}
                onChange={(event) => setValidationCommands((values) => values.map((value) => (
                  value.id === validation.id
                    ? { ...value, timeoutMs: Number(event.currentTarget.value) * 1000 }
                    : value
                )))}
              />
            </label>
            <button
              type="button"
              className="mob-btn-danger"
              disabled={busy}
              onClick={() => setValidationCommands((values) => values.filter((value) => value.id !== validation.id))}
            >
              {t('common.remove')}
            </button>
          </fieldset>
        ))}
      </section>
      {snapshot.migration.required && (
        <section className="mobile-collaboration-policy__warning" role="status">
          <strong>{t('collaboration.migrationTitle')}</strong>
          <p>{t('collaboration.migrationSummary', {
            catalog: snapshot.migration.catalogItemCount,
            runs: snapshot.migration.runCount,
          })}</p>
          {migrationConfirmation ? (
            <>
              <p>{t('collaboration.migrationIrreversible')}</p>
              <div className="mobile-collaboration-policy__inline-actions">
                <button type="button" className="mob-btn-ghost" disabled={busy} onClick={() => setMigrationConfirmation(false)}>
                  {t('common.cancel')}
                </button>
                <button type="button" className="mob-btn-danger" disabled={busy} onClick={() => void confirmMigration()}>
                  {t('collaboration.deleteLegacy')}
                </button>
              </div>
            </>
          ) : (
            <button type="button" className="mob-btn-ghost" disabled={busy} onClick={() => setMigrationConfirmation(true)}>
              {t('collaboration.reviewMigration')}
            </button>
          )}
        </section>
      )}

      <label className="mobile-collaboration-policy__toggle">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy || snapshot.migration.required}
          onChange={(event) => setEnabled(event.currentTarget.checked)}
        />
        <span>
          <strong>{t('collaboration.enableForProject')}</strong>
          <small>{t('collaboration.enableForProjectHint')}</small>
        </span>
      </label>

      <fieldset className="mobile-collaboration-policy__group" disabled={!enabled || busy}>
        <legend>{t('collaboration.permissionMode')}</legend>
        {(['ask', 'safe-auto', 'custom'] as const).map((mode) => (
          <label className="mobile-collaboration-policy__choice" key={mode}>
            <input
              type="radio"
              name={`collaboration-permission-${project.projectId}`}
              value={mode}
              checked={permissionMode === mode}
              onChange={() => setPermissionMode(mode)}
            />
            <span>
              <strong>{t(`collaboration.permission.${mode}`)}</strong>
              <small>{t(`collaboration.permissionHint.${mode}`)}</small>
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className="mobile-collaboration-policy__group" disabled={!enabled || busy}>
        <legend>{t('collaboration.allowedProfiles')}</legend>
        <p>{t('collaboration.allowedProfilesHint')}</p>
        {workerProfiles.map((profile) => (
          <label className="mobile-collaboration-policy__choice" key={profile.profileId}>
            <input
              type="checkbox"
              checked={profileIds.includes(profile.profileId)}
              disabled={!profile.available && !profileIds.includes(profile.profileId)}
              onChange={(event) => setProfileIds((values) => event.currentTarget.checked
                ? [...values, profile.profileId]
                : values.filter((profileId) => profileId !== profile.profileId))}
            />
            <span>
              <strong>{profile.name}</strong>
              <small>
                {profile.permissionMode} · {profile.capabilities
                  .filter((capability) => capability === 'read' || capability === 'write' || capability === 'verify')
                  .join(' / ')}
              </small>
            </span>
          </label>
        ))}
        {workerProfiles.length === 0 && <p>{t('collaboration.noProfiles')}</p>}
        {workerProfiles.some((profile) => !profile.available) && (
          <p className="mobile-collaboration-policy__integration-hint">
            {t('collaboration.mobileIntegrationRequired')}
          </p>
        )}
      </fieldset>

      {permissionMode === 'safe-auto' && (
        <p className="mobile-collaboration-policy__warning">{t('collaboration.safeAutoWarning')}</p>
      )}

      <details className="mobile-collaboration-policy__advanced" open={permissionMode === 'custom'}>
        <summary>{t('collaboration.policyLimits')}</summary>
        <div className="mobile-collaboration-policy__fields">
          <label>
            <span>{t('collaboration.maxConcurrent')}</span>
            <input type="number" min={1} max={4} value={maxConcurrent} disabled={!enabled || busy} onChange={(event) => setMaxConcurrent(Number(event.currentTarget.value))} />
          </label>
          <label>
            <span>{t('collaboration.maxCreated')}</span>
            <input type="number" min={1} max={12} value={maxCreated} disabled={!enabled || busy} onChange={(event) => setMaxCreated(Number(event.currentTarget.value))} />
          </label>
          <label>
            <span>{t('collaboration.maxMinutes')}</span>
            <input type="number" min={1} max={120} value={maxMinutes} disabled={!enabled || busy} onChange={(event) => setMaxMinutes(Number(event.currentTarget.value))} />
          </label>
          <label>
            <span>{t('collaboration.maxFiles')}</span>
            <input type="number" min={1} value={maxFiles} disabled={!enabled || busy} onChange={(event) => setMaxFiles(Number(event.currentTarget.value))} />
          </label>
          <label>
            <span>{t('collaboration.maxLines')}</span>
            <input type="number" min={1} value={maxLines} disabled={!enabled || busy} onChange={(event) => setMaxLines(Number(event.currentTarget.value))} />
          </label>
          <label className="mobile-collaboration-policy__wide">
            <span>{t('collaboration.allowPaths')}</span>
            <textarea rows={3} value={allowPaths} disabled={!enabled || busy} onChange={(event) => setAllowPaths(event.currentTarget.value)} />
          </label>
          <label className="mobile-collaboration-policy__wide">
            <span>{t('collaboration.denyPaths')}</span>
            <textarea rows={4} value={denyPaths} disabled={!enabled || busy} onChange={(event) => setDenyPaths(event.currentTarget.value)} />
          </label>
        </div>
      </details>

      {message && <p className="mobile-collaboration-policy__error" role="alert">{message}</p>}
      <div className="mobile-collaboration-policy__actions">
        <button type="button" className="mob-btn-ghost" disabled={busy} onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="mob-btn-warning"
          disabled={busy
            || snapshot.migration.required
            || !goal.trim()
            || !targetBranch.trim()
            || validationCommands.some((validation) => !validation.name.trim() || !validation.command.trim())
            || (enabled && profileIds.length === 0)}
          onClick={() => void save()}
          data-testid="mobile-collaboration-save"
        >
          {t('common.save')}
        </button>
      </div>
    </MobileActionSheet>
  );
}
