import { Bot, Check, ChevronLeft } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  AgentActivity,
  AgentApprovalRisk,
  AgentActivitySnapshot,
  AgentDecision,
  AgentDecisionResult,
  AgentFollowupResult,
  AgentProvider,
  AgentStatus,
} from '../../src/shared/agent';
import {
  EMPTY_AGENT_COORDINATION_SNAPSHOT,
  type AgentCoordinationSnapshot,
  type ManagedMergeRequest,
} from '../../src/shared/agent-coordination';
import type {
  AgentLaunchBootstrap,
  AgentResumeBootstrap,
} from '../../src/shared/agent-history';
import {
  EMPTY_AGENT_ORCHESTRATION_SNAPSHOT,
  orchestrationWorkerActivityIds,
  type AgentOrchestrationSnapshot,
} from '../../src/shared/agent-orchestration';
import {
  EMPTY_GIT_DIRECTORY_STATUS,
  type GitDiffOmission,
  type GitDiffResult,
  type GitDirectoryStatus,
} from '../../src/shared/git-status';
import { formatCwd } from '../../src/renderer/format-cwd';
import { useGitBranches } from '../../src/renderer/use-git-branch';
import { useAppTranslation } from '../../src/renderer/i18n';
import { AgentFollowupComposer } from '../../src/renderer/AgentFollowupComposer';
import { AgentRelativeAge } from '../../src/renderer/AgentTime';
import { StructuredAgentChildTrack } from '../../src/renderer/StructuredAgentSession';
import {
  createDaemonCommand,
  type DaemonCommand,
  type DaemonTranscriptItem,
  type ManagedAgentState,
  type PermissionPreset,
} from '../../src/shared/daemon-protocol';
import { MobileActionSheet } from './MobileActionSheet';
import { MobileDaemonNavigator } from './MobileDaemonNavigator';
import { MobileStructuredAgentSession } from './MobileStructuredAgentSession';
import { useMobileToast } from './MobileToast';
import type {
  DaemonRuntimeViewState,
  WsEzTerminalTransport,
} from './transport/ws-ezterminal';

/** Used when the host predates the Git arms; every card then shows its cwd. */
const readNothing = (): Promise<GitDirectoryStatus> => Promise.resolve(EMPTY_GIT_DIRECTORY_STATUS);

const ATTENTION = new Set<AgentStatus>(['blocked', 'error', 'done']);
const RUNNING = new Set<AgentStatus>(['starting', 'working']);
const DAEMON_CANCELLABLE_STATES = new Set<ManagedAgentState>([
  'starting',
  'queued',
  'working',
  'blocked',
  'delivery-uncertain',
]);
const DAEMON_ARCHIVABLE_STATES = new Set<ManagedAgentState>([
  'idle',
  'done',
  'interrupted',
  'error',
]);

const INITIAL_DAEMON_RUNTIME_STATE: DaemonRuntimeViewState = {
  status: 'loading',
  snapshot: null,
};

const RISK_RANK = {
  danger: 0,
  write: 1,
  read: 2,
} as const satisfies Record<AgentApprovalRisk, number>;

const PROVIDER_LABEL: Record<AgentProvider, string> = {
  codex: 'Codex',
  claude: 'Claude',
  generic: 'CLI',
};

let mobileAgentCommandSequence = 0;

function mobileAgentCommandId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return `mobile-${random}`;
  mobileAgentCommandSequence += 1;
  return `mobile-${Date.now().toString(36)}-${mobileAgentCommandSequence.toString(36)}`;
}

const STATUS_LABEL_KEY = {
  starting: 'agentHub.status.starting',
  working: 'agentHub.status.working',
  blocked: 'agentHub.status.blocked',
  done: 'agentHub.status.done',
  idle: 'agentHub.status.idle',
  unknown: 'agentHub.status.unknown',
  error: 'agentHub.status.error',
} as const satisfies Record<AgentStatus, string>;

type AgentFilter = 'all' | 'attention' | 'running' | 'done';

function bucketOf(status: AgentStatus): AgentFilter {
  if (ATTENTION.has(status)) return 'attention';
  if (RUNNING.has(status)) return 'running';
  return 'done';
}

function sortRecent(a: AgentActivity, b: AgentActivity): number {
  return b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
}

function sortAttention(a: AgentActivity, b: AgentActivity): number {
  const aApproval = a.approval;
  const bApproval = b.approval;
  if (aApproval && !bApproval) return -1;
  if (!aApproval && bApproval) return 1;
  if (aApproval && bApproval) {
    const approvalOrder = RISK_RANK[aApproval.risk] - RISK_RANK[bApproval.risk]
      || aApproval.expiresAt - bApproval.expiresAt;
    if (approvalOrder !== 0) return approvalOrder;
  }
  const rank = (status: AgentStatus): number => status === 'blocked' ? 0 : status === 'error' ? 1 : 2;
  return rank(a.status) - rank(b.status) || sortRecent(a, b);
}

type MobileDiffView =
  | { readonly state: 'loading' }
  | {
      readonly state: 'ready';
      readonly text: string;
      readonly truncated: boolean;
      readonly omissions: readonly GitDiffOmission[];
    };

/**
 * The mobile Agents tab (handoff §4). A filtered card list rather than the
 * desktop's three fixed groups — the desktop AgentHub is deliberately left
 * alone, since this is a presentation split, not a data one: both read the
 * same `AgentActivitySnapshot` and use the same follow-up call.
 *
 * Approve and deny answer the permission hook the desktop is holding open for
 * that agent; "view diff" shows its uncommitted work. When no hook is parked —
 * an older desktop, an ungated provider, or a window that has already closed —
 * the card falls back to the two affordances that always exist: focus the
 * blocked session, and follow up once a live done/idle terminal is ready.
 */
export function MobileAgentView({
  snapshot,
  coordinationSnapshot = EMPTY_AGENT_COORDINATION_SNAPSHOT,
  orchestrationSnapshot = EMPTY_AGENT_ORCHESTRATION_SNAPSHOT,
  disconnected = false,
  currentTime,
  onBack,
  onFocusSession,
  onSendFollowup,
  onDecideApproval,
  onLoadDiff,
  onReadGitStatus,
  transport,
  daemonRuntimeState = INITIAL_DAEMON_RUNTIME_STATE,
  structuredTranscripts = {},
}: {
  readonly snapshot: AgentActivitySnapshot;
  readonly coordinationSnapshot?: AgentCoordinationSnapshot;
  readonly orchestrationSnapshot?: AgentOrchestrationSnapshot;
  readonly disconnected?: boolean;
  readonly currentTime?: number;
  readonly onBack: () => void;
  readonly onFocusSession: (sessionId: string) => void;
  readonly onSendFollowup: (activityId: string, text: string) => Promise<AgentFollowupResult>;
  readonly onDecideApproval?: (
    activityId: string,
    approvalId: string,
    decision: AgentDecision,
  ) => Promise<AgentDecisionResult>;
  readonly onLoadDiff?: (directory: string) => Promise<GitDiffResult>;
  readonly onReadGitStatus?: (directory: string) => Promise<GitDirectoryStatus>;
  readonly onResumeHistory?: (bootstrap: AgentResumeBootstrap) => Promise<void>;
  readonly onLaunchAgent?: (bootstrap: AgentLaunchBootstrap) => Promise<void>;
  readonly transport?: WsEzTerminalTransport;
  readonly daemonRuntimeState?: DaemonRuntimeViewState;
  /** Transcript pages are supplied by the transport adapter once fetched. */
  readonly structuredTranscripts?: Readonly<Record<string, readonly DaemonTranscriptItem[]>>;
}): JSX.Element {
  const { t, i18n } = useAppTranslation();
  const showToast = useMobileToast();
  const [filter, setFilter] = useState<AgentFilter>('all');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [decidingMergeId, setDecidingMergeId] = useState<string | null>(null);
  const [overrideRequest, setOverrideRequest] = useState<ManagedMergeRequest | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [diff, setDiff] = useState<MobileDiffView | null>(null);
  const [selectedDaemonSessionId, setSelectedDaemonSessionId] = useState<string | null>(null);
  const diffRequestGeneration = useRef(0);
  const daemonRevisionRef = useRef(daemonRuntimeState.snapshot?.revision ?? 0);
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const workerActivityIds = useMemo(
    () => orchestrationWorkerActivityIds(orchestrationSnapshot),
    [orchestrationSnapshot],
  );
  const userFacingItems = useMemo(
    () => snapshot.items.filter((item) => !workerActivityIds.has(item.id)),
    [snapshot.items, workerActivityIds],
  );
  const branches = useGitBranches(
    userFacingItems.map((item) => item.cwd),
    onReadGitStatus ?? readNothing,
    !disconnected,
  );
  const relativeTime = useMemo(
    () => new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'narrow' }),
    [locale],
  );

  useEffect(() => {
    if (daemonRuntimeState.snapshot) {
      daemonRevisionRef.current = Math.max(
        daemonRevisionRef.current,
        daemonRuntimeState.snapshot.revision,
      );
    }
  }, [daemonRuntimeState.snapshot]);

  useEffect(() => {
    if (selectedDaemonSessionId && daemonRuntimeState.snapshot && !daemonRuntimeState.snapshot.sessions.some((session) => (
      session.id === selectedDaemonSessionId
      && session.kind === 'agent'
      && session.source === 'structured'
    ))) {
      setSelectedDaemonSessionId(null);
    }
  }, [daemonRuntimeState.snapshot, selectedDaemonSessionId]);

  const managedMerges = useMemo(() => coordinationSnapshot.mergeRequests.filter((request) => (
    ['preparing', 'validating', 'approval-required', 'override-required', 'merging'].includes(request.state)
  )), [coordinationSnapshot.mergeRequests]);

  const decideMerge = async (
    request: ManagedMergeRequest,
    decision: 'approve' | 'deny',
    overrideReasonValue?: string,
  ): Promise<void> => {
    if (!transport || decidingMergeId !== null
      || (request.state !== 'approval-required' && request.state !== 'override-required')) return;
    setDecidingMergeId(request.requestId);
    const result = await transport.decideManagedMerge({
      requestId: request.requestId,
      revision: request.revision,
      decision,
      actor: 'mobile',
      ...(overrideReasonValue ? { overrideReason: overrideReasonValue } : {}),
    }).catch(() => ({
      ok: false as const,
      error: 'unavailable' as const,
      message: 'transport unavailable',
    }));
    setDecidingMergeId(null);
    if (result.ok) {
      setOverrideRequest(null);
      setOverrideReason('');
      showToast(decision === 'approve'
        ? t('agentHub.managedMerge.approved')
        : t('agentHub.managedMerge.denied'));
      return;
    }
    showToast(t('agentHub.managedMerge.decisionFailed'));
  };

  const decide = async (item: AgentActivity, decision: AgentDecision): Promise<void> => {
    if (!onDecideApproval || decidingId !== null || !item.approval) return;
    setDecidingId(item.id);
    const result = await onDecideApproval(
      item.id,
      item.approval.approvalId,
      decision,
    ).catch((): AgentDecisionResult => ({
      ok: false,
      error: 'outcome-unknown',
    }));
    setDecidingId(null);
    if (result.ok) {
      showToast(
        decision === 'allow'
          ? t('mobile.agentView.approved', { provider: PROVIDER_LABEL[item.provider] })
          : t('mobile.agentView.denied', { provider: PROVIDER_LABEL[item.provider] }),
      );
      return;
    }
    setErrors((previous) => ({
      ...previous,
      [item.id]: result.error === 'expired' || result.error === 'stale'
        ? t('agentHub.approvalExpired')
        : result.error === 'outcome-unknown'
          ? t('agentHub.approvalOutcomeUnknown')
          : t('agentHub.approvalFailed'),
    }));
  };

  const openDiff = async (directory: string): Promise<void> => {
    if (!onLoadDiff) return;
    const generation = ++diffRequestGeneration.current;
    setDiff({ state: 'loading' });
    const result = await onLoadDiff(directory).catch((): GitDiffResult => ({ ok: false, error: 'git-failed' }));
    if (generation !== diffRequestGeneration.current) return;
    if (!result.ok) {
      setDiff(null);
      showToast(result.error === 'not-a-repository' ? t('agentHub.diffUnavailable') : t('agentHub.approvalFailed'));
      return;
    }
    setDiff({
      state: 'ready',
      text: result.text,
      truncated: result.truncated,
      omissions: result.omissions,
    });
  };

  useEffect(() => () => {
    diffRequestGeneration.current += 1;
  }, []);

  const counts = useMemo(() => {
    const tally = { all: userFacingItems.length, attention: 0, running: 0, done: 0 };
    for (const item of userFacingItems) tally[bucketOf(item.status)] += 1;
    return tally;
  }, [userFacingItems]);

  const visible = useMemo(() => {
    return userFacingItems
      .filter((item) => filter === 'all' || bucketOf(item.status) === filter)
      .slice()
      .sort((a, b) => {
        const bucketDelta = ['attention', 'running', 'done'].indexOf(bucketOf(a.status))
          - ['attention', 'running', 'done'].indexOf(bucketOf(b.status));
        if (bucketDelta !== 0) return bucketDelta;
        return bucketOf(a.status) === 'attention' ? sortAttention(a, b) : sortRecent(a, b);
      });
  }, [filter, userFacingItems]);

  const send = useCallback(async (activityId: string, text: string): Promise<string | null> => {
    if (!text || sendingId !== null) return t('agentHub.errorDeliveryFailed');
    setSendingId(activityId);
    const result = await onSendFollowup(activityId, text).catch((): AgentFollowupResult => ({
      ok: false,
      error: 'delivery-failed',
    }));
    setSendingId(null);
    if (result.ok) {
      const item = snapshot.items.find((candidate) => candidate.id === activityId);
      showToast(t('mobile.agentView.followupSent', {
        provider: item ? PROVIDER_LABEL[item.provider] : '',
      }));
      return null;
    }
    return result.error === 'not-waiting' || result.error === 'not-ready'
      ? t('agentHub.errorNotWaiting')
      : result.error === 'invalid-text'
        ? t('agentHub.errorInvalidText')
        : result.error === 'session-ended'
          ? t('agentHub.errorSessionEnded')
          : t('agentHub.errorDeliveryFailed');
  }, [onSendFollowup, sendingId, showToast, snapshot.items, t]);

  const filters: readonly { readonly id: AgentFilter; readonly label: string; readonly count: number }[] = [
    { id: 'all', label: t('mobile.agentView.filterAll'), count: counts.all },
    { id: 'attention', label: t('mobile.agentView.filterAttention'), count: counts.attention },
    { id: 'running', label: t('mobile.agentView.filterRunning'), count: counts.running },
    { id: 'done', label: t('mobile.agentView.filterDone'), count: counts.done },
  ];

  const selectSession = (sessionId: string): void => {
    const daemonSession = daemonRuntimeState.snapshot?.sessions.find((session) => session.id === sessionId);
    if (daemonSession?.kind === 'agent' && daemonSession.source === 'structured') {
      setSelectedDaemonSessionId(sessionId);
    }
    onFocusSession(sessionId);
  };

  const dispatchDaemonCommand = async (command: DaemonCommand) => {
    if (!transport || disconnected) return { ok: false as const, message: 'Not connected to EZTerminal.' };
    const receipt = await transport.sendDaemonCommand(command).catch(() => null);
    if (!receipt) return { ok: false as const, message: 'The command could not be delivered.' };
    if (!receipt.ok) return { ok: false as const, message: receipt.error.message };
    daemonRevisionRef.current = Math.max(daemonRevisionRef.current, receipt.revision);
    return { ok: true as const };
  };

  const selectedDaemonSession = daemonRuntimeState.snapshot?.sessions.find((session) => (
    session.id === selectedDaemonSessionId && session.kind === 'agent' && session.source === 'structured'
  ));
  const selectedDaemonAgent = daemonRuntimeState.snapshot?.agents.find((agent) => (
    agent.sessionId === selectedDaemonSessionId
  ));
  const selectedDaemonWorkspace = daemonRuntimeState.snapshot?.workspaces.find((workspace) => (
    workspace.id === selectedDaemonSession?.workspaceId
  ));
  const selectedDaemonProvider = daemonRuntimeState.snapshot?.providers.find((provider) => (
    provider.id === selectedDaemonAgent?.providerId
  ));
  const selectedDaemonRelation = daemonRuntimeState.snapshot?.agentRelations.find((relation) => (
    relation.childSessionId === selectedDaemonSessionId && relation.detachedAt === undefined
  ));
  const selectedDaemonChildren = useMemo(() => {
    const daemonSnapshot = daemonRuntimeState.snapshot;
    if (!daemonSnapshot || !selectedDaemonSessionId) return [];
    return daemonSnapshot.agentRelations.flatMap((relation) => {
      if (
        relation.parentSessionId !== selectedDaemonSessionId
        || relation.detachedAt !== undefined
      ) return [];
      const session = daemonSnapshot.sessions.find((entry) => (
        entry.id === relation.childSessionId
        && entry.kind === 'agent'
        && entry.source === 'structured'
      ));
      const agent = daemonSnapshot.agents.find((entry) => entry.sessionId === relation.childSessionId);
      if (!session || !agent) return [];
      const provider = daemonSnapshot.providers.find((entry) => entry.id === agent.providerId);
      return [{
        sessionId: session.id,
        title: session.title,
        providerLabel: provider?.displayName ?? agent.providerId,
        state: agent.state,
        owner: relation.owner,
      }];
    });
  }, [daemonRuntimeState.snapshot, selectedDaemonSessionId]);

  if (selectedDaemonSession && selectedDaemonAgent && selectedDaemonWorkspace) {
    const buildCommandBase = () => {
      const commandId = mobileAgentCommandId();
      return {
        commandId,
        idempotencyKey: commandId,
        expectedRevision: daemonRevisionRef.current,
        issuedAt: new Date().toISOString(),
        principal: { kind: 'android' as const, id: 'mobile-agent-ui' },
      };
    };
    const availableModels = selectedDaemonProvider?.capabilities.flatMap((capability) => {
      const match = /^(?:model:|model=)(.+)$/u.exec(capability);
      return match?.[1] ? [{ id: match[1], label: match[1] }] : [];
    }) ?? [];
    if (selectedDaemonAgent.model && !availableModels.some((model) => model.id === selectedDaemonAgent.model)) {
      availableModels.unshift({ id: selectedDaemonAgent.model, label: selectedDaemonAgent.model });
    }
    const providerOwned = selectedDaemonRelation?.owner === 'provider-native';
    const canCancel = !providerOwned
      && selectedDaemonAgent.providerSessionId !== undefined
      && DAEMON_CANCELLABLE_STATES.has(selectedDaemonAgent.state);
    const canArchive = !providerOwned
      && selectedDaemonAgent.currentTurnId === undefined
      && selectedDaemonSession.archivedAt === undefined
      && DAEMON_ARCHIVABLE_STATES.has(selectedDaemonAgent.state);
    const canDetach = selectedDaemonRelation?.owner === 'managed'
      && selectedDaemonSession.archivedAt === undefined;
    return (
      <MobileStructuredAgentSession
        sessionId={selectedDaemonSession.id}
        title={selectedDaemonSession.title}
        providerId={selectedDaemonAgent.providerId}
        providerLabel={selectedDaemonProvider?.displayName ?? selectedDaemonAgent.providerId}
        workspace={{
          id: selectedDaemonWorkspace.id,
          label: selectedDaemonWorkspace.name,
          kind: selectedDaemonWorkspace.kind,
          path: selectedDaemonWorkspace.rootPath,
        }}
        model={selectedDaemonAgent.model}
        modelOptions={availableModels}
        permissionPreset={selectedDaemonAgent.permissionPreset}
        state={selectedDaemonAgent.state}
        queuedCount={selectedDaemonAgent.queuedTurnCount}
        items={structuredTranscripts[selectedDaemonSession.id] ?? []}
        approvals={(daemonRuntimeState.snapshot?.approvals ?? []).filter((approval) => (
          approval.sessionId === selectedDaemonSession.id
        ))}
        transcriptError={daemonRuntimeState.error === 'event-gap'
          ? 'Some transcript updates were missed. Reloading the authoritative state…'
          : null}
        disabled={disconnected || !transport}
        {...(selectedDaemonRelation ? { owner: selectedDaemonRelation.owner } : {})}
        {...(selectedDaemonChildren.length > 0 ? {
          childTrack: (
            <StructuredAgentChildTrack
              items={selectedDaemonChildren}
              onSelectSession={selectSession}
            />
          ),
        } : {})}
        onBack={() => setSelectedDaemonSessionId(null)}
        onRetryTranscript={() => { void transport?.getDaemonSnapshot(); }}
        onSend={(prompt) => dispatchDaemonCommand(createDaemonCommand({
          ...buildCommandBase(),
          type: 'agent.submit',
          payload: { sessionId: selectedDaemonSession.id, prompt },
        }))}
        onInterruptAndSend={(prompt) => dispatchDaemonCommand(createDaemonCommand({
          ...buildCommandBase(),
          type: 'agent.interrupt-and-submit',
          payload: { sessionId: selectedDaemonSession.id, prompt },
        }))}
        onChangeSettings={(settings: {
          readonly model?: string;
          readonly permissionPreset: PermissionPreset;
        }) => dispatchDaemonCommand(createDaemonCommand({
          ...buildCommandBase(),
          type: 'agent.set-settings',
          payload: {
            sessionId: selectedDaemonSession.id,
            ...(settings.model ? { model: settings.model } : {}),
            permissionPreset: settings.permissionPreset,
          },
        }))}
        {...(!providerOwned ? {
          onResolveApproval: (approvalId: string, decision: 'allow' | 'deny') => dispatchDaemonCommand(createDaemonCommand({
            ...buildCommandBase(),
            type: 'permission.resolve',
            payload: { approvalId, decision },
          })),
        } : {})}
        onOpenRelatedSession={selectSession}
        {...(canCancel ? {
          onCancel: () => dispatchDaemonCommand(createDaemonCommand({
            ...buildCommandBase(),
            type: 'agent.cancel',
            payload: { sessionId: selectedDaemonSession.id },
          })),
        } : {})}
        {...(canArchive ? {
          onArchive: () => dispatchDaemonCommand(createDaemonCommand({
            ...buildCommandBase(),
            type: 'agent.archive',
            payload: { sessionId: selectedDaemonSession.id },
          })),
        } : {})}
        {...(canDetach ? {
          onDetach: () => dispatchDaemonCommand(createDaemonCommand({
            ...buildCommandBase(),
            type: 'agent.detach',
            payload: { sessionId: selectedDaemonSession.id },
          })),
        } : {})}
      />
    );
  }

  return (
    <main className="mob-page" data-testid="mobile-agent-view" aria-label={t('agentHub.activity')}>
      <header className="mob-page__head">
        <button type="button" className="mob-icon-btn" onClick={onBack} aria-label={t('common.back')} data-testid="mobile-agent-close">
          <ChevronLeft aria-hidden="true" />
        </button>
        <div>
          <h1 className="mob-page__title">{t('mobile.agents')}</h1>
          {counts.attention > 0 && (
            <p className="mob-page__subtitle" data-testid="agent-attention-summary">
              {t('mobile.agentView.waitingCount', { value: counts.attention })}
            </p>
          )}
        </div>
      </header>

      {disconnected && <div className="mob-empty" role="status">{t('agentHub.reconnecting')}</div>}

      <div className="mob-agent-filters" role="group" aria-label={t('mobile.agentView.filterLabel')}>
        {filters.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={entry.id === 'attention' ? 'mob-chip mob-chip--warning' : 'mob-chip'}
            aria-pressed={filter === entry.id}
            onClick={() => setFilter(entry.id)}
            data-testid={`agent-filter-${entry.id}`}
          >
            {entry.label} {entry.count}
          </button>
        ))}
      </div>

      <div className="mob-page__body" data-testid="mobile-agent-scroll-region">
        <div className="mob-column">
          {managedMerges.map((request) => (
            <article
              key={request.requestId}
              className="mob-agent-card mob-agent-card--attention"
              data-testid="managed-merge-card"
              data-status={request.state}
            >
              <div className="mob-agent-card__head">
                <span className="mob-agent-card__chip" aria-hidden="true"><Bot /></span>
                <span className="mob-agent-card__name">{t('agentHub.managedMerge.title')}</span>
                <span className="mob-badge mob-badge--warning">
                  {t(`agentHub.managedMerge.state.${request.state}`)}
                </span>
              </div>
              <p className="mob-agent-card__branch">
                {request.sourceBranch} → {request.targetBranch}
              </p>
              {request.validations.length > 0 && (
                <ul className="mob-agent-diff-omissions" data-testid="managed-merge-validations">
                  {request.validations.map((validation) => (
                    <li key={validation.id}>
                      {validation.name}: {t(`agentHub.managedMerge.validation.${validation.status}`)}
                    </li>
                  ))}
                </ul>
              )}
              {request.state === 'approval-required' && (
                <div className="mob-agent-card__actions">
                  <button
                    type="button"
                    className="mob-btn-warning"
                    disabled={disconnected || decidingMergeId !== null}
                    onClick={() => void decideMerge(request, 'approve')}
                    data-testid="managed-merge-approve"
                  >
                    {t('agentHub.approve')}
                  </button>
                  <button
                    type="button"
                    className="mob-btn-ghost"
                    disabled={disconnected || decidingMergeId !== null}
                    onClick={() => void decideMerge(request, 'deny')}
                    data-testid="managed-merge-deny"
                  >
                    {t('agentHub.deny')}
                  </button>
                </div>
              )}
              {request.state === 'override-required' && (
                <div className="mob-agent-card__actions">
                  <button
                    type="button"
                    className="mob-btn-ghost"
                    disabled={disconnected || decidingMergeId !== null}
                    onClick={() => void decideMerge(request, 'deny')}
                    data-testid="managed-merge-deny"
                  >
                    {t('agentHub.deny')}
                  </button>
                  <button
                    type="button"
                    className="mob-btn-danger"
                    disabled={disconnected || decidingMergeId !== null}
                    onClick={() => {
                      setOverrideRequest(request);
                      setOverrideReason('');
                    }}
                    data-testid="managed-merge-override"
                  >
                    {t('agentHub.managedMerge.override')}
                  </button>
                </div>
              )}
            </article>
          ))}
          {[
            ...visible.filter((item) => bucketOf(item.status) === 'attention'),
            ...(transport ? [null] : []),
            ...visible.filter((item) => bucketOf(item.status) !== 'attention'),
          ].map((item) => {
            if (item === null) {
              return (
                <MobileDaemonNavigator
                  key="daemon-projects"
                  state={daemonRuntimeState}
                  onRetry={() => {
                    void transport!.getDaemonSnapshot();
                  }}
                  onSelectSession={selectSession}
                />
              );
            }
            const bucket = bucketOf(item.status);
            const age = (
              <AgentRelativeAge
                updatedAt={item.updatedAt}
                formatter={relativeTime}
                currentTime={currentTime}
              />
            );
            // A decision is only offered while the desktop is still holding the
            // provider's hook open. Past that the answer belongs in the terminal.
            const live = item.approval?.pending === true;

            if (bucket === 'done') {
              if (item.live && (item.status === 'idle' || item.status === 'unknown')) {
                return (
                  <article key={item.id} className="mob-agent-card mob-agent-card--done" data-testid="agent-card" data-status={item.status}>
                    <div className="mob-agent-card__head">
                      <Check aria-hidden="true" className="mob-row__chevron" />
                      <span className="mob-agent-card__name">{PROVIDER_LABEL[item.provider]}</span>
                      <span className="mob-agent-card__time">{age}</span>
                    </div>
                    <p className="mob-agent-card__branch" title={item.cwd}>
                      {formatCwd(item.cwd, 30)} · {t(STATUS_LABEL_KEY[item.status])}
                    </p>
                    <div className="mob-agent-card__actions">
                      <button
                        type="button"
                        className="mob-btn-ghost"
                        onClick={() => selectSession(item.sessionId)}
                        data-testid="agent-focus"
                      >
                        {t('agentHub.focus')}
                      </button>
                    </div>
                    {item.status === 'idle' && item.interactiveReady && (
                      <AgentFollowupComposer
                        activityId={item.id}
                        providerLabel={PROVIDER_LABEL[item.provider]}
                        variant="mobile"
                        disconnected={disconnected}
                        sending={sendingId === item.id}
                        anotherSending={sendingId !== null && sendingId !== item.id}
                        onSend={send}
                      />
                    )}
                  </article>
                );
              }
              return (
                <article key={item.id} className="mob-agent-card mob-agent-card--done" data-testid="agent-card" data-status={item.status}>
                  <Check aria-hidden="true" className="mob-row__chevron" />
                  <span className="mob-agent-card__done-copy">
                    <span className="mob-row__title mob-row__title--body">
                      {PROVIDER_LABEL[item.provider]} · {formatCwd(item.cwd, 28)}
                    </span>
                    <span className="mob-row__meta">{t(STATUS_LABEL_KEY[item.status])} · {age}</span>
                  </span>
                </article>
              );
            }

            if (bucket === 'running') {
              return (
                <article key={item.id} className="mob-agent-card mob-agent-card--running" data-testid="agent-card" data-status={item.status}>
                  <div className="mob-agent-card__head">
                    <span className="mob-agent-card__chip" aria-hidden="true">
                      <span className="mob-agent-card__spinner" />
                    </span>
                    <span className="mob-agent-card__name">{PROVIDER_LABEL[item.provider]}</span>
                    <span className="mob-agent-card__time">{age}</span>
                  </div>
                  <p className="mob-agent-card__branch" title={item.cwd}>
                    {formatCwd(item.cwd, 30)} · {t(STATUS_LABEL_KEY[item.status])}
                  </p>
                  <div className="mob-agent-card__progress" aria-hidden="true"><span /></div>
                </article>
              );
            }

            return (
              <article key={item.id} className="mob-agent-card mob-agent-card--attention" data-testid="agent-card" data-status={item.status}>
                <div className="mob-agent-card__head">
                  <span className="mob-agent-card__chip" aria-hidden="true"><Bot /></span>
                  <span className="mob-agent-card__name">{PROVIDER_LABEL[item.provider]}</span>
                  <span className="mob-badge mob-badge--warning">{t(STATUS_LABEL_KEY[item.status])}</span>
                </div>
                <p className="mob-agent-card__branch" title={item.cwd}>
                  {branches.get(item.cwd) ?? formatCwd(item.cwd, 30)}
                </p>
                <p className="mob-agent-card__body">
                  {item.status === 'done'
                    ? t('mobile.agentView.waitingBody')
                    : item.status === 'blocked'
                      ? t('mobile.agentView.blockedBody')
                      : t('mobile.agentView.errorBody')}
                </p>
                {live && (
                  <code className="mob-agent-card__command" data-risk={item.approval?.risk}>
                    {item.approval?.command ?? item.approval?.toolName}
                  </code>
                )}
                <div className="mob-agent-card__actions">
                  {live ? (
                    <>
                      <button
                        type="button"
                        className="mob-btn-warning"
                        disabled={disconnected || decidingId !== null}
                        onClick={() => void decide(item, 'allow')}
                        data-testid="agent-approve"
                      >
                        {t('mobile.agentView.approveAndContinue')}
                      </button>
                      <button
                        type="button"
                        className="mob-btn-ghost"
                        disabled={disconnected || decidingId !== null}
                        onClick={() => void decide(item, 'deny')}
                        data-testid="agent-deny"
                      >
                        {t('agentHub.deny')}
                      </button>
                      {onLoadDiff && (
                        <button
                          type="button"
                          className="mob-btn-ghost"
                          disabled={disconnected || diff?.state === 'loading'}
                          onClick={() => void openDiff(item.cwd)}
                          data-testid="agent-view-diff"
                        >
                          {t('agentHub.viewDiff')}
                        </button>
                      )}
                    </>
                  ) : (
                    <button
                      type="button"
                      className="mob-btn-warning"
                      onClick={() => selectSession(item.sessionId)}
                      data-testid="agent-focus"
                    >
                      {t('agentHub.review')} →
                    </button>
                  )}
                  <span className="mob-agent-card__time">{age}</span>
                </div>
                {(item.status === 'done' || item.status === 'idle') && item.live && item.interactiveReady && (
                  <AgentFollowupComposer
                    activityId={item.id}
                    providerLabel={PROVIDER_LABEL[item.provider]}
                    variant="mobile"
                    disconnected={disconnected}
                    sending={sendingId === item.id}
                    anotherSending={sendingId !== null && sendingId !== item.id}
                    onSend={send}
                  />
                )}
                {errors[item.id] && (
                  <p className="mob-agent-error" id={`mobile-agent-error-${item.id}`} role="alert">
                    {errors[item.id]}
                  </p>
                )}
              </article>
            );
          })}
          {visible.length === 0 && managedMerges.length === 0 && !transport && (
            <p className="mob-empty" data-testid="agent-empty">
              {userFacingItems.length === 0 ? t('agentHub.empty') : t('mobile.agentView.noMatches')}
            </p>
          )}
        </div>
      </div>
      {diff !== null && (
        <MobileActionSheet
          title={t('agentHub.diffTitle')}
          onClose={() => {
            diffRequestGeneration.current += 1;
            setDiff(null);
          }}
          variant="fullscreen"
          testId="mobile-agent-diff"
        >
          {diff.state === 'loading' ? (
            <p className="mob-empty" role="status">{t('common.loading')}</p>
          ) : (
            <>
              {diff.text.trim().length > 0 && <pre className="mob-agent-diff">{diff.text}</pre>}
              {diff.text.trim().length === 0 && !diff.truncated && diff.omissions.length === 0 && (
                <p className="mob-empty">{t('agentHub.diffEmpty')}</p>
              )}
              {diff.truncated && (
                <p
                  className="mob-agent-diff-note"
                  role="status"
                  data-testid="mobile-agent-diff-truncated"
                >
                  {t('agentHub.diffTruncated')}
                </p>
              )}
              {diff.omissions.length > 0 && (
                <ul
                  className="mob-agent-diff-omissions"
                  data-testid="mobile-agent-diff-omissions"
                >
                  {diff.omissions.map((omission) => (
                    <li key={`${omission.path}\0${omission.reason}`}>
                      <code>{omission.path}</code>
                      {' — '}
                      {t(`agentHub.diffOmissionReason.${omission.reason}`)}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </MobileActionSheet>
      )}
      {overrideRequest !== null && (
        <MobileActionSheet
          title={t('agentHub.managedMerge.overrideTitle')}
          description={t('agentHub.managedMerge.overrideDescription')}
          onClose={() => {
            if (decidingMergeId === null) {
              setOverrideRequest(null);
              setOverrideReason('');
            }
          }}
          testId="mobile-managed-merge-override"
        >
          <label className="mob-managed-merge-override__field">
            <span>{t('agentHub.managedMerge.overrideReason')}</span>
            <textarea
              rows={5}
              maxLength={500}
              value={overrideReason}
              disabled={decidingMergeId !== null}
              onChange={(event) => setOverrideReason(event.currentTarget.value)}
              data-testid="mobile-managed-merge-override-reason"
            />
          </label>
          <div className="mob-managed-merge-override__actions">
            <button
              type="button"
              className="mob-btn-ghost"
              disabled={decidingMergeId !== null}
              onClick={() => setOverrideRequest(null)}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="mob-btn-danger"
              disabled={decidingMergeId !== null || overrideReason.trim().length < 8}
              onClick={() => void decideMerge(overrideRequest, 'approve', overrideReason.trim())}
              data-testid="mobile-managed-merge-override-confirm"
            >
              {t('agentHub.managedMerge.overrideConfirm')}
            </button>
          </div>
        </MobileActionSheet>
      )}
    </main>
  );
}
