import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ApprovalResponse } from '../shared/approval-request';
import type { ConversationFolders } from '../shared/conversation-folders';
import type { AccessLevel } from './agent-permission-copy';
import { readPlanAccess } from './agent-plan-access';
import { releaseProviderAfterClear } from './structured-agent-release';
import { PlanningNavigationContext } from './PlanningWorkspaceDockPanel';
import { AgentResultsContext, AgentResultsOwnerContext, type AgentResultsOwner } from './agent-results/AgentResultsContext';
import { ResultsPublisher } from './agent-results/ResultsPublisher';
import { WorkflowConversationContext, WorkflowConversationUnavailable, useWorkflowConversationScope } from './workflow/WorkflowConversationContext';
import type { IDockviewPanelProps } from 'dockview-react';
import type { AgentLaunchBootstrap } from '../shared/agent-history';
import type { ChatComposerDraft, ChatMessageContext } from '../shared/chat-message';
import type { ChatStateAccess } from './chat-recovery';
import type { ConversationSettings } from '../shared/conversation-start';
import { useChatRecovery } from './use-chat-recovery';
import { useProviderModelCatalogs } from './use-provider-models';
import { desktopFileSearch, pathForDrop } from './conversation-desktop-access';
import { ChatRecoveryNotice } from './ChatRecoveryNotice';
import { NewSessionDraftPanel } from './NewSessionDraftPanel';

import { conversationQueue } from './conversation-queue';
import {
  changeConversationSettings,
  opaqueId,
  queueConversationTurn,
  reconcileConversationSubmit,
  resultOf,
  runConversationLifecycle,
  submitConversationMessage,
  type ConversationCommandAccess,
} from './conversation-commands';
import {
  AGENT_SETTINGS_CAPABILITY,
  createDaemonCommand,
  type DaemonCommand,
  type DaemonCommandReceipt,
  type DaemonSnapshot,
  type DaemonTranscriptItem,
  type ManagedAgentState,
  type PermissionPreset,
} from '../shared/daemon-protocol';
import { nextConversationSettings, planPhaseNote, queuedSettingsFor } from './queued-settings';
import { setStructuredAgentTabStatus, structuredTabStatus, tabProvider } from './structured-agent-tab-status';
import type { DaemonAuthorityAvailability } from '../shared/daemon-authority';
import { isDaemonSessionArchived } from '../shared/daemon-session-visibility';
import { parseTranscriptPayload } from '../shared/transcript-payload';
import { linkedPhaseSettings, type ChatAgentPhaseMap, type ChatAgentProfile } from '../shared/chat-agent-profiles';
import { isRunOwnedWorkspace } from '../shared/workspace-worktree';
import { DelegateAgentDialog, type DelegateAgentRequest, type DelegateMode } from './DelegateAgentDialog';
import { useAppTranslation } from './i18n';
import type { RendererRecoveryStructuredAgentCreate } from '../shared/renderer-recovery';
import { rendererCapabilities, type CapabilityAccess } from './capability-access';
import { createSideQuestionClient } from './side-question/side-question-client';
import { DaemonSafeModeNotice } from './DaemonSafeModeNotice';
import {
  StructuredAgentHeartbeat,
  type StructuredAgentHeartbeatInput,
} from './StructuredAgentHeartbeat';
import {
  StructuredAgentChildTrack,
  StructuredAgentDraftPanel,
  StructuredAgentSessionPanel,
  type StructuredAgentChildTrackItem,
  type StructuredAgentDraftInput,
  type StructuredAgentUiResult,
  type StructuredAgentWorkspaceOption,
} from './StructuredAgentSession';
import {
  createStructuredAgentSession,
  resolvePreferredDaemonWorkspaceId,
  structuredAgentModelOptions,
  structuredAgentProviderOptions,
  structuredAgentSessionTitle,
  structuredAgentWorkspaceOptions,
  type StructuredAgentCreateOutcome,
  type StructuredAgentCreateCommand,
} from './structured-agent-create';
import { type StructuredAgentCreateRecoveryRegistry } from './structured-agent-create-recovery';
import { usePanelPreview } from './shell/panel-preview';
import { useConversationSettings } from './conversation-settings-track';
import { SettingsProposalContext } from './chat/SettingsChangeTrack';
import {
  consumeRendererRecoveryStructuredAgentCreate,
  peekRendererRecoveryStructuredAgentCreate,
} from './renderer-recovery-state';

export { resolvePreferredDaemonWorkspaceId } from './structured-agent-create';

export const STRUCTURED_AGENT_DRAFT_PREFIX = 'structured-draft-';
export const STRUCTURED_AGENT_SESSION_PREFIX = 'structured-session-';

export function isStructuredAgentDockHistoryId(historyId: string): boolean {
  return historyId.startsWith(STRUCTURED_AGENT_DRAFT_PREFIX)
    || historyId.startsWith(STRUCTURED_AGENT_SESSION_PREFIX);
}

export function structuredAgentSessionHistoryId(sessionId: string): string {
  return `${STRUCTURED_AGENT_SESSION_PREFIX}${sessionId}`;
}

export function structuredAgentSessionId(historyId: string): string | null {
  return historyId.startsWith(STRUCTURED_AGENT_SESSION_PREFIX)
    ? historyId.slice(STRUCTURED_AGENT_SESSION_PREFIX.length) || null
    : null;
}

/** `/clear`: the project and settings the conversation that replaces this one starts with. */
export interface StructuredAgentClearRequest {
  readonly project: { readonly projectId: string; readonly name: string };
  readonly settings: ConversationSettings;
  /** Text typed after `/clear`: the new conversation's message box starts with it, unsent. */
  readonly draftText?: string;
  /** In plan mode: the level the cleared conversation's plan was set to run with. */
  readonly planAccess?: AccessLevel;
}

const TRANSCRIPT_PAGE_SIZE = 500;
const TRANSCRIPT_PAGES_PER_YIELD = 10;
/** A reopened conversation loads its newest items first; older ones load on demand. */
const TRANSCRIPT_TAIL_WINDOW = 3 * TRANSCRIPT_PAGE_SIZE;
/** The tail is extended (bounded) until it shows this many prompts, for old delta-heavy sessions. */
const TRANSCRIPT_TAIL_MIN_PROMPTS = 2;
const TRANSCRIPT_TAIL_MAX_EXTENSIONS = 8;
/** A turn in progress: the Results tab's working-folder view reads again when it ends. */
const RESULTS_ACTIVE_STATES = new Set(['starting', 'queued', 'working', 'blocked', 'delivery-uncertain']);
const HEARTBEAT_SESSION_STATES = new Set([
  'starting',
  'queued',
  'working',
  'blocked',
  'idle',
  'delivery-uncertain',
]);

function localUserItem(
  sessionId: string,
  commandId: string,
  sequence: number,
  text: string,
  context?: ChatMessageContext,
): DaemonTranscriptItem {
  return {
    id: `local-${commandId}`,
    sessionId,
    sequence,
    kind: 'user-message',
    text,
    isDelta: false,
    isSensitive: false,
    createdAt: new Date().toISOString(),
    ...(context ? { context } : {}),
  };
}

/** Chat links open in the OS browser; main accepts only credential-free http(s). */
function openLink(url: string): void {
  if (/^https?:/iu.test(url)) void window.ezterminalDesktop?.openExternalHttpUrl(url);
}

export function mergeAuthoritativeTranscript(
  current: readonly DaemonTranscriptItem[],
  incoming: readonly DaemonTranscriptItem[],
): readonly DaemonTranscriptItem[] {
  const bySequence = new Map<number, DaemonTranscriptItem>();
  for (const item of current) bySequence.set(item.sequence, item);
  for (const item of incoming) bySequence.set(item.sequence, item);
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

function optimisticCommandId(item: DaemonTranscriptItem): string | null {
  return item.id.startsWith('local-') ? item.id.slice('local-'.length) || null : null;
}

export function mergeOptimisticTranscript(
  authoritative: readonly DaemonTranscriptItem[],
  optimistic: readonly DaemonTranscriptItem[],
  snapshot: DaemonSnapshot | null,
): readonly DaemonTranscriptItem[] {
  const representedTurnIds = new Set(authoritative.flatMap((item) => item.turnId ? [item.turnId] : []));
  const representedCommandIds = new Set((snapshot?.turns ?? []).flatMap((turn) => (
    representedTurnIds.has(turn.id) ? [turn.commandId] : []
  )));
  const authoritativeIds = new Set(authoritative.map((item) => item.id));
  const pending = optimistic.filter((item) => {
    const commandId = optimisticCommandId(item);
    return !authoritativeIds.has(item.id) && (!commandId || !representedCommandIds.has(commandId));
  });
  const lastSequence = authoritative.at(-1)?.sequence ?? 0;
  return [
    ...authoritative,
    ...pending.map((item, index) => ({ ...item, sequence: lastSequence + index + 1 })),
  ];
}

interface CreatedDraftState extends StructuredAgentDraftInput {
  readonly sessionId: string;
  readonly title: string;
}

interface UncertainDraftState {
  readonly input: StructuredAgentDraftInput;
  readonly outcome: Extract<StructuredAgentCreateOutcome, { readonly kind: 'delivery-uncertain' }>;
}

function recoveryDraftState(
  recovery: RendererRecoveryStructuredAgentCreate,
): UncertainDraftState {
  const payload = recovery.command.payload;
  return {
    input: {
      providerId: payload.providerId,
      ...(payload.model ? { model: payload.model } : {}),
      workspaceId: payload.workspaceId,
      permissionPreset: payload.permissionPreset,
      initialPrompt: payload.initialPrompt,
      ...(recovery.composerDraft ? { draftText: recovery.composerDraft.text, draftSkills: recovery.composerDraft.skills } : {}),
    },
    outcome: {
      kind: 'delivery-uncertain',
      sessionId: recovery.sessionId,
      title: payload.title,
      command: recovery.command,
      message: recovery.phase === 'sending'
        ? 'The Agent command was still being delivered when this panel was restored.'
        : 'The Agent command delivery could not be confirmed.',
    },
  };
}

function recoveryRecord(
  panelId: string,
  historyId: string,
  command: StructuredAgentCreateCommand,
  input: StructuredAgentDraftInput,
): RendererRecoveryStructuredAgentCreate {
  return Object.freeze({
    panelId,
    historyId,
    sessionId: command.payload.sessionId,
    phase: 'sending',
    command,
    ...(input.draftText ? { composerDraft: { text: input.draftText, ...(input.draftSkills?.length ? { skills: input.draftSkills } : {}) } } : {}),
  });
}

/**
 * Renderer-only adapter around the daemon bridge. The semantic surface remains
 * callback-driven; this component only translates Dockview params and v12
 * command receipts into those callbacks.
 */
export function StructuredAgentDockPanel(
  props: IDockviewPanelProps & {
    readonly capabilities?: CapabilityAccess;
    readonly chatStateAccess?: ChatStateAccess;
    readonly createRecoveryRegistry?: StructuredAgentCreateRecoveryRegistry;
    /** Resolves true only after main has accepted the current memory-only checkpoint. */
    readonly persistCreateRecovery?: () => Promise<boolean>;
    readonly onOpenTerminal?: (workspaceId?: string, directory?: string) => Promise<StructuredAgentUiResult>;
    readonly onLaunchCli?: (bootstrap: AgentLaunchBootstrap) => Promise<void>;
    readonly onOpenSettings?: () => void;
    readonly onOpenHistory?: (projectId?: string) => void;
    /** Opens the project editor from the conversation's folder setting. */
    readonly onEditProject?: (projectId: string) => void;
    /** Opens a new conversation in a project (`/new`). */
    readonly onNewConversation?: (project?: { readonly projectId: string; readonly name: string }) => void;
    /** Replaces this tab with a new conversation that starts with these settings (`/clear`). */
    /** `/clear`: true once a new conversation took this tab's place. */
    readonly onClearConversation?: (request: StructuredAgentClearRequest) => boolean;
    readonly onOpenSession?: (input: {
      readonly sessionId: string;
      readonly title?: string;
      readonly providerLabel?: string;
    }) => void;
  },
): JSX.Element {
  const capabilities = props.capabilities ?? rendererCapabilities;
  // Sending from a preview tab keeps it (typing is caught by the tab's wrapper in App).
  const { keep: keepPreview } = usePanelPreview(props.api.id);
  const capabilityClient = useMemo(() => typeof window.ezterminal?.agentCapabilitiesList === 'function' ? {
    list: window.ezterminal.agentCapabilitiesList,
    manage: window.ezterminal.agentCapabilitiesManage,
  } : undefined, []);
  // /btw: asked straight through the preload (never a daemon command), like the capability list.
  const sideQuestionClient = useMemo(() => createSideQuestionClient(typeof window === 'undefined' ? undefined : window.ezterminal), []);
  const createRecoveryRegistry = props.createRecoveryRegistry;
  const persistCreateRecovery = props.persistCreateRecovery;
  const historyId = typeof props.params?.historyId === 'string' ? props.params.historyId : '';
  const projectId = typeof props.params?.projectId === 'string' ? props.params.projectId : undefined;
  const rootId = typeof props.params?.rootId === 'string' ? props.params.rootId : undefined;
  const preferredWorkspaceId = typeof props.params?.workspaceId === 'string'
    ? props.params.workspaceId
    : undefined;
  const restoredSessionId = structuredAgentSessionId(historyId);
  const [sessionId, setSessionId] = useState<string | null>(restoredSessionId);
  const [snapshot, setSnapshot] = useState<DaemonSnapshot | null>(null);
  const [availability, setAvailability] = useState<DaemonAuthorityAvailability | null>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createdDraft, setCreatedDraft] = useState<CreatedDraftState | null>(null);
  const recoveredCreateRef = useRef<RendererRecoveryStructuredAgentCreate | undefined>(undefined);
  const { i18n } = useAppTranslation();
  const korean = (i18n.resolvedLanguage ?? i18n.language).startsWith('ko');
  // 맡기기 / 검토 맡기기: a person hands this chat's work, or a review of it, to a new child.
  const profileAccess = window.ezterminal?.chatAgentProfiles;
  const worktreeAccess = window.ezterminal?.workspaceWorktrees;
  const [delegateMode, setDelegateMode] = useState<DelegateMode | null>(null);
  const [delegateProfiles, setDelegateProfiles] = useState<readonly ChatAgentProfile[]>([]);
  useEffect(() => {
    if (!delegateMode || !profileAccess) return undefined;
    let alive = true;
    void profileAccess.list().then((profiles) => { if (alive) setDelegateProfiles(profiles); }).catch(() => undefined);
    return () => { alive = false; };
  }, [delegateMode, profileAccess]);
  // 단계 연결: the plan approval dock says which agent implements the approved plan.
  const planApprovalPending = (snapshot?.approvals ?? []).some((approval) => (
    approval.sessionId === sessionId && approval.state === 'pending' && approval.request?.kind === 'plan'
  ));
  const [phaseLinks, setPhaseLinks] = useState<{ readonly profiles: readonly ChatAgentProfile[]; readonly phases: ChatAgentPhaseMap } | null>(null);
  useEffect(() => {
    if (!planApprovalPending || !profileAccess?.phases) return undefined;
    let alive = true;
    void Promise.all([profileAccess.list(), profileAccess.phases()])
      .then(([profiles, phases]) => { if (alive) setPhaseLinks({ profiles, phases }); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [planApprovalPending, profileAccess]);
  // 대화로 설정 바꾸기: what this conversation's AI changed (되돌리기) and proposed (decided in the approval dock).
  const sessionApprovals = useMemo(() => (snapshot?.approvals ?? []).filter((approval) => approval.sessionId === sessionId), [snapshot?.approvals, sessionId]);
  const conversationSettings = useConversationSettings({ sessionId: sessionId ?? '', approvals: sessionApprovals, korean, access: window.ezterminal?.settingsChanges });
  const settingsProposals = useMemo(() => ({ ko: korean, proposal: conversationSettings.proposal }), [korean, conversationSettings.proposal]);
  const checkpointCreateRef = useRef<RendererRecoveryStructuredAgentCreate | undefined>(undefined);
  const [uncertainDraft, setUncertainDraft] = useState<UncertainDraftState | null>(() => {
    const registered = createRecoveryRegistry?.get(props.api.id);
    const checkpoint = registered
      ? undefined
      : peekRendererRecoveryStructuredAgentCreate(props.api.id);
    const recovery = registered ?? checkpoint;
    recoveredCreateRef.current = recovery;
    checkpointCreateRef.current = checkpoint;
    return recovery ? recoveryDraftState(recovery) : null;
  });
  const [localItems, setLocalItems] = useState<readonly DaemonTranscriptItem[]>([]);
  const earlyDraft = useRef<{ sessionId: string; draft: ChatComposerDraft } | null>(null);
  const authorizedProjectId = snapshot?.sessions.find((candidate) => candidate.id === sessionId)?.projectId;
  const workflowNavigation = useContext(PlanningNavigationContext);
  // Desktop only: this tab's Results tab (Android and stories have no host).
  const resultsHost = useContext(AgentResultsContext);
  const resultsPanelOwnerId = props.api.id;
  const resultsOwner = useMemo<AgentResultsOwner | null>(() => (resultsHost
    ? { ownerPanelId: resultsPanelOwnerId, open: (request) => { resultsHost.open(resultsPanelOwnerId, request); } }
    : null), [resultsHost, resultsPanelOwnerId]);
  const workflowAccess = useMemo(() => typeof window.ezterminal?.getWorkflowSnapshot === 'function' ? { getWorkflowSnapshot: (id: string) => window.ezterminal.getWorkflowSnapshot(id), executeWorkflowCommand: window.ezterminal.executeWorkflowCommand.bind(window.ezterminal) } : undefined, []);
  const workflowContext = useWorkflowConversationScope(workflowAccess, authorizedProjectId, sessionId);
  const chatRecovery = useChatRecovery(authorizedProjectId, sessionId, props.chatStateAccess);
  const pendingSubmit = chatRecovery.view.pendingSubmit?.command ?? null;
  useEffect(() => {
    if (chatRecovery.controller && earlyDraft.current?.sessionId === sessionId) {
      chatRecovery.controller.updateDraft(earlyDraft.current.draft);
      earlyDraft.current = null;
    }
  }, [chatRecovery.controller, sessionId]);
  const [authoritativeItems, setAuthoritativeItems] = useState<readonly DaemonTranscriptItem[]>([]);
  const [transcriptLoading, setTranscriptLoading] = useState(restoredSessionId !== null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const providerModelCatalogs = useProviderModelCatalogs(snapshot, capabilities);
  const snapshotRef = useRef<DaemonSnapshot | null>(null);
  const refreshInFlight = useRef<Promise<DaemonSnapshot | null> | null>(null);
  const authoritativeItemsRef = useRef<readonly DaemonTranscriptItem[]>([]);
  const transcriptCursorRef = useRef(0);
  const transcriptTargetRef = useRef(0);
  const transcriptSessionRef = useRef<string | null>(restoredSessionId);
  const transcriptGenerationRef = useRef(0);
  const transcriptInFlightRef = useRef<Promise<void> | null>(null);
  /** Sequence below the oldest loaded item; 0 once the whole transcript is loaded. */
  const transcriptFloorRef = useRef(0);
  const [transcriptFloor, setTranscriptFloor] = useState(0);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const earlierInFlightRef = useRef(false);
  const tailExtensionsRef = useRef(0);

  useEffect(() => {
    const recovery = recoveredCreateRef.current;
    if (recovery) createRecoveryRegistry?.register(recovery);
    const checkpoint = checkpointCreateRef.current;
    if (checkpoint) {
      consumeRendererRecoveryStructuredAgentCreate(
        checkpoint.panelId,
        checkpoint.command.commandId,
      );
      checkpointCreateRef.current = undefined;
    }
  }, [createRecoveryRegistry]);

  const refresh = useCallback(async (): Promise<DaemonSnapshot | null> => {
    if (refreshInFlight.current) return refreshInFlight.current;
    setLoading(true);
    const request = Promise.resolve()
      .then(() => capabilities.daemon.getSnapshot())
      .then((next) => {
        if (!next) {
          setLoadError('The Agent daemon did not return a project snapshot.');
          return null;
        }
        if (snapshotRef.current && next.revision < snapshotRef.current.revision) {
          setLoadError(null);
          return snapshotRef.current;
        }
        snapshotRef.current = next;
        setSnapshot(next);
        setLoadError(null);
        return next;
      })
      .catch(() => {
        setLoadError('The Agent daemon could not be reached.');
        return null;
      })
      .finally(() => {
        setLoading(false);
        refreshInFlight.current = null;
      });
    refreshInFlight.current = request;
    return request;
  }, [capabilities]);

  const syncTranscript = useCallback((
    targetSessionId: string,
    targetSequence = 0,
  ): Promise<void> => {
    if (transcriptSessionRef.current !== targetSessionId) return Promise.resolve();
    transcriptTargetRef.current = Math.max(transcriptTargetRef.current, targetSequence);
    if (
      targetSequence > 0
      && transcriptCursorRef.current >= transcriptTargetRef.current
    ) return Promise.resolve();
    if (transcriptInFlightRef.current) return transcriptInFlightRef.current;
    if (transcriptCursorRef.current === 0 && authoritativeItemsRef.current.length === 0
      && transcriptTargetRef.current > TRANSCRIPT_TAIL_WINDOW) {
      const floor = transcriptTargetRef.current - TRANSCRIPT_TAIL_WINDOW;
      transcriptCursorRef.current = floor;
      transcriptFloorRef.current = floor;
      setTranscriptFloor(floor);
    }
    const generation = transcriptGenerationRef.current;
    let shouldContinue = false;
    let failed = false;
    const run = async (): Promise<void> => {
      setTranscriptLoading(authoritativeItemsRef.current.length === 0);
      setTranscriptError(null);
      try {
        for (let pageIndex = 0; pageIndex < TRANSCRIPT_PAGES_PER_YIELD; pageIndex += 1) {
          if (
            transcriptGenerationRef.current !== generation
            || transcriptSessionRef.current !== targetSessionId
          ) return;
          const afterSequence = transcriptCursorRef.current;
          const page = await capabilities.daemon.getTranscript(
            targetSessionId,
            afterSequence,
            TRANSCRIPT_PAGE_SIZE,
          );
          if (
            transcriptGenerationRef.current !== generation
            || transcriptSessionRef.current !== targetSessionId
          ) return;
          const validPage = page
            .filter((item) => (
              item.sessionId === targetSessionId
              && Number.isSafeInteger(item.sequence)
              && item.sequence > afterSequence
            ))
            .sort((left, right) => left.sequence - right.sequence);
          if (validPage.some((item, index) => item.sequence !== afterSequence + index + 1)) {
            throw new Error('The Agent transcript page contains a sequence gap.');
          }
          if (validPage.length > 0) {
            const next = mergeAuthoritativeTranscript(authoritativeItemsRef.current, validPage);
            authoritativeItemsRef.current = next;
            transcriptCursorRef.current = next.at(-1)?.sequence ?? afterSequence;
            setAuthoritativeItems(next);
          }
          const target = transcriptTargetRef.current;
          if (validPage.length === 0) {
            if (target > transcriptCursorRef.current) {
              throw new Error('The Agent transcript is temporarily incomplete.');
            }
            shouldContinue = false;
            return;
          }
          if (transcriptCursorRef.current >= target && page.length < TRANSCRIPT_PAGE_SIZE) {
            shouldContinue = false;
            return;
          }
          if (transcriptCursorRef.current <= afterSequence) {
            throw new Error('The Agent transcript did not advance.');
          }
          shouldContinue = true;
        }
      } catch {
        shouldContinue = false;
        failed = true;
        if (
          transcriptGenerationRef.current === generation
          && transcriptSessionRef.current === targetSessionId
        ) {
          setTranscriptError('The Agent transcript could not be loaded.');
        }
      } finally {
        if (
          transcriptGenerationRef.current === generation
          && transcriptSessionRef.current === targetSessionId
        ) setTranscriptLoading(false);
      }
    };
    const promise = run().finally(() => {
      if (transcriptInFlightRef.current === promise) {
        transcriptInFlightRef.current = null;
        if (
          !failed
          && (shouldContinue || transcriptTargetRef.current > transcriptCursorRef.current)
          && transcriptGenerationRef.current === generation
          && transcriptSessionRef.current === targetSessionId
        ) queueMicrotask(() => { void syncTranscript(targetSessionId, transcriptTargetRef.current); });
      }
    });
    transcriptInFlightRef.current = promise;
    return promise;
  }, [capabilities]);

  const loadEarlierTranscript = useCallback(async (): Promise<void> => {
    const targetSessionId = transcriptSessionRef.current;
    const floor = transcriptFloorRef.current;
    if (!targetSessionId || floor <= 0 || earlierInFlightRef.current) return;
    const generation = transcriptGenerationRef.current;
    earlierInFlightRef.current = true;
    setLoadingEarlier(true);
    try {
      const from = Math.max(0, floor - TRANSCRIPT_PAGE_SIZE);
      const page = await capabilities.daemon.getTranscript(targetSessionId, from, floor - from);
      if (transcriptGenerationRef.current !== generation || transcriptSessionRef.current !== targetSessionId) return;
      const validPage = page
        .filter((item) => item.sessionId === targetSessionId && Number.isSafeInteger(item.sequence) && item.sequence > from && item.sequence <= floor)
        .sort((left, right) => left.sequence - right.sequence);
      if (validPage.length !== floor - from || validPage.some((item, index) => item.sequence !== from + index + 1)) {
        throw new Error('The earlier Agent transcript page contains a sequence gap.');
      }
      const next = mergeAuthoritativeTranscript(authoritativeItemsRef.current, validPage);
      authoritativeItemsRef.current = next;
      setAuthoritativeItems(next);
      transcriptFloorRef.current = from;
      setTranscriptFloor(from);
    } catch {
      if (transcriptGenerationRef.current === generation) setTranscriptError('Earlier messages could not be loaded.');
    } finally {
      earlierInFlightRef.current = false;
      if (transcriptGenerationRef.current === generation) setLoadingEarlier(false);
    }
  }, [capabilities]);

  // A tail of streamed deltas can hold less than one exchange; extend it a few pages.
  useEffect(() => {
    // Judge the tail only once some of it has arrived.
    if (transcriptFloor <= 0 || loadingEarlier || authoritativeItems.length === 0
      || tailExtensionsRef.current >= TRANSCRIPT_TAIL_MAX_EXTENSIONS) return;
    const prompts = authoritativeItems.filter((item) => item.kind === 'user-message').length;
    if (prompts >= TRANSCRIPT_TAIL_MIN_PROMPTS) return;
    tailExtensionsRef.current += 1;
    void loadEarlierTranscript();
  }, [authoritativeItems, loadEarlierTranscript, loadingEarlier, transcriptFloor]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve()
      .then(() => capabilities.daemon.getAvailability())
      .then((next) => {
        if (!cancelled) setAvailability(next);
      })
      .catch(() => {
        if (!cancelled) setAvailability(null);
      });
    return () => { cancelled = true; };
  }, [capabilities]);

  useEffect(() => {
    if (availability === undefined || availability?.state === 'legacy-only-safe-mode') return;
    void refresh();
  }, [availability, refresh]);

  useEffect(() => {
    transcriptGenerationRef.current += 1;
    transcriptSessionRef.current = sessionId;
    transcriptTargetRef.current = 0;
    transcriptCursorRef.current = 0;
    transcriptInFlightRef.current = null;
    transcriptFloorRef.current = 0;
    setTranscriptFloor(0);
    tailExtensionsRef.current = 0;
    authoritativeItemsRef.current = [];
    setAuthoritativeItems([]);
    setLocalItems((current) => current.filter((item) => item.sessionId === sessionId));
    setTranscriptError(null);
    setTranscriptLoading(sessionId !== null);
    if (sessionId && availability !== undefined && availability?.state !== 'legacy-only-safe-mode') {
      // Without a snapshot the head is unknown; the snapshot effect starts the load at the tail.
      const head = snapshotRef.current?.transcriptHeads.find((candidate) => candidate.sessionId === sessionId);
      if (snapshotRef.current) void syncTranscript(sessionId, head?.lastSequence ?? 0);
    } else if (availability?.state === 'legacy-only-safe-mode') {
      setTranscriptLoading(false);
    }
    return () => {
      transcriptGenerationRef.current += 1;
    };
  }, [availability, sessionId, syncTranscript]);

  useEffect(() => {
    if (!sessionId || !snapshot) return;
    const head = snapshot.transcriptHeads.find((candidate) => candidate.sessionId === sessionId);
    void syncTranscript(sessionId, head?.lastSequence ?? 0);
  }, [sessionId, snapshot, syncTranscript]);

  useEffect(() => {
    if (availability === undefined || availability?.state === 'legacy-only-safe-mode') return undefined;
    let queued = false;
    return capabilities.daemon.observeEvents((event) => {
      if (event.kind === 'transcript.appended') {
        if (event.payload.sessionId === transcriptSessionRef.current) void syncTranscript(event.payload.sessionId, event.payload.toSequence);
        // Appends (streamed deltas several times a second) do not change the snapshot.
        return;
      }
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        void refresh();
      });
    }, () => {
      setLoadError('The Agent daemon event stream is unavailable.');
    });
  }, [availability, capabilities, refresh, syncTranscript]);

  useEffect(() => {
    const next = structuredAgentSessionId(historyId);
    if (next) setSessionId(next);
  }, [historyId]);

  const sendCommand = useCallback(async (command: DaemonCommand): Promise<DaemonCommandReceipt | null> => {
    const receipt = await Promise.resolve()
      .then(() => capabilities.daemon.sendCommand(command))
      .catch(() => null);
    if (receipt?.ok) {
      if (snapshotRef.current && receipt.revision >= snapshotRef.current.revision) {
        snapshotRef.current = {
          ...snapshotRef.current,
          revision: receipt.revision,
          eventSequence: receipt.eventSequence,
        };
        setSnapshot(snapshotRef.current);
      }
      void refresh();
    }
    return receipt;
  }, [capabilities, refresh]);

  const latestSnapshot = useCallback(async (): Promise<DaemonSnapshot | null> => {
    // A read already in flight may predate the command that just committed; a command
    // built on it is refused as stale. Let it land, then read again.
    if (refreshInFlight.current) await refreshInFlight.current;
    return await refresh();
  }, [refresh]);

  const finishCreatedDraft = useCallback((
    outcome: Extract<StructuredAgentCreateOutcome, { readonly kind: 'created' | 'delivery-uncertain' }>,
    draftText?: string,
    draftSkills?: ChatComposerDraft['skills'],
  ): StructuredAgentUiResult => {
    const createdInput = outcome.command.payload;
    const nextHistoryId = structuredAgentSessionHistoryId(outcome.sessionId);
    if (draftText) earlyDraft.current = { sessionId: outcome.sessionId, draft: { text: draftText, ...(draftSkills?.length ? { skills: draftSkills } : {}) } };
    setCreatedDraft({
      providerId: createdInput.providerId,
      ...(createdInput.model ? { model: createdInput.model } : {}),
      workspaceId: createdInput.workspaceId,
      permissionPreset: createdInput.permissionPreset,
      initialPrompt: createdInput.initialPrompt,
      sessionId: outcome.sessionId,
      title: outcome.title,
    });
    setSessionId(outcome.sessionId);
    setLocalItems(createdInput.initialPrompt ? [localUserItem(
      outcome.sessionId,
      outcome.command.commandId,
      1,
      createdInput.initialPrompt,
    )] : []);
    setUncertainDraft(null);
    props.api.updateParameters({
      ...(props.api.getParameters?.() ?? props.params ?? {}),
      historyId: nextHistoryId,
      ...(createdInput.providerId === 'codex' || createdInput.providerId === 'claude'
        ? { provider: createdInput.providerId }
        : {}),
    });
    props.api.setTitle(outcome.title);
    // Clear escrow only after Dockview carries the durable Session identity, so
    // the immediate prompt-free checkpoint cannot regress to a blank draft.
    createRecoveryRegistry?.clear(props.api.id, outcome.command.commandId);
    return { ok: true };
  }, [createRecoveryRegistry, props.api, props.params]);

  const create = useCallback(async (input: StructuredAgentDraftInput): Promise<StructuredAgentUiResult> => {
    let registeredCommandId = uncertainDraft?.outcome.command.commandId;
    const registerPreparedCommand = async (command: StructuredAgentCreateCommand): Promise<void> => {
      if (!createRecoveryRegistry || !persistCreateRecovery) {
        throw new Error('Desktop Agent recovery escrow is unavailable.');
      }
      registeredCommandId = command.commandId;
      if (!createRecoveryRegistry.register(recoveryRecord(props.api.id, historyId, command, input))) {
        throw new Error('Desktop Agent recovery escrow is at capacity.');
      }
      if (!(await persistCreateRecovery())) {
        throw new Error('Desktop Agent recovery escrow could not be confirmed.');
      }
    };
    const access = {
      getSnapshot: latestSnapshot,
      sendCommand: async (command: Extract<DaemonCommand, { readonly type: 'agent.create' }>) => {
        const receipt = await sendCommand(command);
        if (!receipt) throw new Error('The Agent daemon is unavailable.');
        return receipt;
      },
    };
    let outcome: StructuredAgentCreateOutcome;
    if (uncertainDraft) {
      const authority = await latestSnapshot();
      if (!authority) {
        return {
          ok: false,
          message: 'The Agent daemon is unavailable. Delivery was not retried.',
        };
      }
      const alreadyCreated = authority.sessions.some((candidate) => (
        candidate.id === uncertainDraft.outcome.sessionId
        && candidate.kind === 'agent'
        && candidate.source === 'structured'
      ));
      if (alreadyCreated) return finishCreatedDraft(uncertainDraft.outcome, uncertainDraft.input.draftText, uncertainDraft.input.draftSkills);

      const replay = await sendCommand(uncertainDraft.outcome.command);
      if (!replay || (!replay.ok && replay.status === 'delivery-uncertain')) {
        createRecoveryRegistry?.markDeliveryUncertain(
          props.api.id,
          uncertainDraft.outcome.command.commandId,
        );
        if (replay && !replay.ok) {
          setUncertainDraft({
            input,
            outcome: {
              ...uncertainDraft.outcome,
              receipt: replay,
              message: replay.error.message,
            },
          });
        }
        return {
          ok: false,
          message: 'Delivery is still unconfirmed. Send this locked draft again after the connection recovers.',
        };
      }
      if (replay.ok) {
        outcome = {
          kind: 'created',
          sessionId: uncertainDraft.outcome.sessionId,
          title: uncertainDraft.outcome.title,
          command: uncertainDraft.outcome.command,
          receipt: replay,
        };
      } else if (replay.error.code === 'revision-conflict') {
        outcome = await createStructuredAgentSession(input, {
          access,
          principal: { kind: 'desktop', id: 'renderer-agent-ui' },
          createId: opaqueId,
          sessionId: uncertainDraft.outcome.sessionId,
          onCommandPrepared: registerPreparedCommand,
        });
      } else {
        const confirmation = await latestSnapshot();
        const createdDespiteReceipt = confirmation?.sessions.some((candidate) => (
          candidate.id === uncertainDraft.outcome.sessionId
          && candidate.kind === 'agent'
          && candidate.source === 'structured'
        ));
        if (createdDespiteReceipt) return finishCreatedDraft(uncertainDraft.outcome, uncertainDraft.input.draftText, uncertainDraft.input.draftSkills);
        setUncertainDraft(null);
        createRecoveryRegistry?.clear(props.api.id, uncertainDraft.outcome.command.commandId);
        return { ok: false, message: replay.error.message };
      }
    } else {
      outcome = await createStructuredAgentSession(input, {
        access,
        principal: { kind: 'desktop', id: 'renderer-agent-ui' },
        createId: opaqueId,
        onCommandPrepared: registerPreparedCommand,
      });
    }
    if (outcome.kind === 'created') return finishCreatedDraft(outcome, input.draftText, input.draftSkills);
    if (outcome.kind === 'delivery-uncertain') {
      createRecoveryRegistry?.markDeliveryUncertain(props.api.id, outcome.command.commandId);
      setUncertainDraft({ input, outcome });
      return {
        ok: false,
        message: 'Delivery could not be confirmed. This exact draft is locked; choose Create Agent again to verify or safely retry the same session.',
      };
    }
    setUncertainDraft(null);
    if (registeredCommandId) createRecoveryRegistry?.clear(props.api.id, registeredCommandId);
    return { ok: false, message: outcome.message };
  }, [
    createRecoveryRegistry,
    finishCreatedDraft,
    historyId,
    latestSnapshot,
    persistCreateRecovery,
    props.api.id,
    sendCommand,
    uncertainDraft,
  ]);

  const providers = useMemo(
    () => structuredAgentProviderOptions(snapshot, providerModelCatalogs),
    [providerModelCatalogs, snapshot],
  );
  const workspaces = useMemo(
    () => structuredAgentWorkspaceOptions(snapshot, projectId),
    [projectId, snapshot],
  );
  const initialWorkspaceId = useMemo(() => resolvePreferredDaemonWorkspaceId(
    workspaces,
    projectId,
    rootId,
    preferredWorkspaceId,
  ), [preferredWorkspaceId, projectId, rootId, workspaces]);
  const transcriptItems = useMemo(
    () => mergeOptimisticTranscript(authoritativeItems, localItems, snapshot),
    [authoritativeItems, localItems, snapshot],
  );

  useEffect(() => {
    const visibleLocalIds = new Set(transcriptItems.flatMap((item) => (
      item.id.startsWith('local-') ? [item.id] : []
    )));
    setLocalItems((current) => {
      const next = current.filter((item) => visibleLocalIds.has(item.id));
      return next.length === current.length ? current : next;
    });
  }, [transcriptItems]);

  // Tab dot: live state, plus "done" for a turn that finished while this tab was not in front.
  const tabAgent = snapshot?.agents.find((candidate) => candidate.sessionId === sessionId);
  const tabProviderLabel = snapshot?.providers.find((candidate) => candidate.id === tabAgent?.providerId)?.displayName;
  const [unseenDone, setUnseenDone] = useState(false);
  const previousAgentState = useRef<ManagedAgentState | undefined>(undefined);
  useEffect(() => {
    const previous = previousAgentState.current;
    previousAgentState.current = tabAgent?.state;
    const wasActive = previous === 'starting' || previous === 'queued' || previous === 'working' || previous === 'blocked';
    if (wasActive && (tabAgent?.state === 'idle' || tabAgent?.state === 'done') && props.api.isActive === false) setUnseenDone(true);
  }, [props.api, tabAgent?.state]);
  useEffect(() => {
    const disposable = props.api.onDidActiveChange?.((event) => { if (event.isActive) setUnseenDone(false); });
    return () => disposable?.dispose();
  }, [props.api]);
  const tabStatus = structuredTabStatus(tabAgent?.state, unseenDone);
  const tabProviderId = tabAgent?.providerId;
  useEffect(() => {
    setStructuredAgentTabStatus(props.api.id, tabStatus && tabProviderId ? {
      status: tabStatus, provider: tabProvider(tabProviderId), ...(tabProviderLabel ? { providerLabel: tabProviderLabel } : {}),
    } : undefined);
  }, [props.api.id, tabProviderId, tabProviderLabel, tabStatus]);
  useEffect(() => () => setStructuredAgentTabStatus(props.api.id, undefined), [props.api.id]);
  // The folders this conversation works in, as main hands them to the AI. Asked again when the
  // project's workspaces change (its folders were edited). Desktop only: Android keeps its header.
  const readFolders = window.ezterminalDesktop?.getConversationFolders;
  const folderSession = sessionId ? snapshot?.sessions.find((candidate) => candidate.id === sessionId) : undefined;
  const folderKey = useMemo(() => folderSession ? JSON.stringify([folderSession.id, folderSession.workspaceId, ...(snapshot?.workspaces ?? [])
    .filter((workspace) => workspace.projectId === folderSession.projectId)
    .map((workspace) => [workspace.id, workspace.rootPath, workspace.archivedAt ?? ''])]) : '', [folderSession, snapshot?.workspaces]);
  const [conversationFolders, setConversationFolders] = useState<ConversationFolders>();
  useEffect(() => {
    if (!readFolders || !folderKey || !sessionId) { setConversationFolders(undefined); return undefined; }
    let alive = true;
    void readFolders({ sessionId }).then((found) => { if (alive) setConversationFolders(found ?? undefined); }).catch(() => undefined);
    return () => { alive = false; };
  }, [readFolders, folderKey, sessionId]);

  if (availability?.state === 'legacy-only-safe-mode' && (sessionId || !props.onOpenTerminal)) {
    return (
      <div className="structured-agent-safe-mode" data-testid="structured-agent-safe-mode">
        <DaemonSafeModeNotice availability={availability} showRecoveryPath />
      </div>
    );
  }

  if (!sessionId) {
    if (props.onOpenTerminal && props.onLaunchCli) {
      return <NewSessionDraftPanel
          initialIntent={{ kind: 'agent' }}
        snapshot={snapshot}
        projectId={projectId}
        workspaceId={initialWorkspaceId ?? (preferredWorkspaceId ? `${projectId && rootId ? `${projectId}.${rootId}.` : ''}${preferredWorkspaceId}` : undefined)}
        access={window.ezterminal}
        onTerminal={props.onOpenTerminal}
        onLaunchCli={props.onLaunchCli}
        onSettings={props.onOpenSettings}
        agent={{
          capabilityClient,
          onOpenHistory: props.onOpenHistory ? () => props.onOpenHistory?.(projectId) : undefined,
          providers, workspaces,
          initialProviderId: uncertainDraft?.input.providerId,
          initialModel: uncertainDraft?.input.model,
          initialWorkspaceId: uncertainDraft?.input.workspaceId ?? initialWorkspaceId,
          initialPermissionPreset: uncertainDraft?.input.permissionPreset,
          initialPrompt: uncertainDraft?.input.initialPrompt,
          initialDraftText: uncertainDraft?.input.draftText,
          initialDraftSkills: uncertainDraft?.input.draftSkills,
          deliveryRecovery: uncertainDraft !== null,
          loading: loading || availability?.state === 'legacy-only-safe-mode',
          loadError, onRetry: () => void refresh(), onCreate: create,
        }}
      />;
    }
    return (
      <StructuredAgentDraftPanel
        capabilityClient={capabilityClient}
        onOpenHistory={props.onOpenHistory ? () => props.onOpenHistory?.(projectId) : undefined}
        providers={providers}
        workspaces={workspaces}
        initialProviderId={uncertainDraft?.input.providerId}
        initialModel={uncertainDraft?.input.model}
        initialWorkspaceId={uncertainDraft?.input.workspaceId ?? initialWorkspaceId}
        initialPermissionPreset={uncertainDraft?.input.permissionPreset}
        initialPrompt={uncertainDraft?.input.initialPrompt}
        initialDraftText={uncertainDraft?.input.draftText}
        initialDraftSkills={uncertainDraft?.input.draftSkills}
        deliveryRecovery={uncertainDraft !== null}
        loading={loading}
        loadError={loadError}
        onRetry={() => void refresh()}
        onCreate={create}
      />
    );
  }

  const session = snapshot?.sessions.find((candidate) => candidate.id === sessionId);
  const agent = snapshot?.agents.find((candidate) => candidate.sessionId === sessionId);
  const workspace = snapshot?.workspaces.find((candidate) => candidate.id === session?.workspaceId)
    ?? snapshot?.workspaces.find((candidate) => candidate.id === createdDraft?.workspaceId);
  const providerId = agent?.providerId ?? createdDraft?.providerId ?? '';
  const provider = snapshot?.providers.find((candidate) => candidate.id === providerId);
  // agent-settings-v2: the pills show what the next request uses; the line says what the running one uses.
  const queuesSettings = snapshot?.capabilities?.includes(AGENT_SETTINGS_CAPABILITY) === true;
  const pendingSettings = queuesSettings ? snapshot?.pendingAgentSettings?.[sessionId] : undefined;
  const nextSettings = agent ? nextConversationSettings(agent, pendingSettings) : undefined;
  const currentModel = nextSettings?.model ?? createdDraft?.model;
  const modelOptions = structuredAgentModelOptions(provider?.capabilities ?? [], currentModel, providerModelCatalogs[providerId]);
  const queuedSettings = agent && queuesSettings ? queuedSettingsFor(agent, pendingSettings, {
    cancel: () => { void changeConversationSettings(commandAccess, sessionId, { clearPending: true }); },
    scope: (scope, reasoningEffort) => { void changeConversationSettings(commandAccess, sessionId, { reasoningEffort, scope }); },
  }) : undefined;
  const implementLink = planApprovalPending && phaseLinks && agent
    ? linkedPhaseSettings(phaseLinks.phases, phaseLinks.profiles, agent.providerId, 'implement')
    : undefined;
  const phaseNote = implementLink && agent ? planPhaseNote({
    korean,
    providerLabel: provider?.displayName ?? agent.providerId,
    agentName: implementLink.profile.name,
    ...(implementLink.model ? { linkedModel: implementLink.model } : {}),
    ...(implementLink.reasoningEffort ? { linkedEffort: implementLink.reasoningEffort } : {}),
    ...(agent.model ? { currentModel: agent.model } : {}),
    ...(agent.reasoningEffort ? { currentEffort: agent.reasoningEffort } : {}),
    modelLabel: (model) => modelOptions.find((option) => option.id === model)?.label ?? model,
  }) : undefined;
  const workspaceOption: StructuredAgentWorkspaceOption = workspace
    ? { id: workspace.id, label: workspace.name, kind: workspace.kind, path: workspace.rootPath }
    : { id: createdDraft?.workspaceId ?? '', label: 'Workspace unavailable', kind: 'local' };
  const workspaceRoot = workspace?.rootPath;
  const fileSearch = desktopFileSearch(workspaceRoot);
  // Until main answers, the setting shows the working folder alone, so the header never flips
  // from the folder line to the setting as the conversation opens.
  const shownFolders = conversationFolders
    ?? (readFolders && workspace ? { primary: workspace.rootPath, additional: [], missing: [] } : undefined);

  const commandAccess: ConversationCommandAccess = { latestSnapshot, sendCommand };
  const showSent = (commandId: string, prompt: string, context?: ChatMessageContext): void => {
    setLocalItems((current) => current.some((item) => item.id === `local-${commandId}`)
      ? current
      : [...current, localUserItem(sessionId, commandId, current.length + 1, prompt, context)]);
    void syncTranscript(sessionId);
  };

  const runSessionCommand = (
    type: 'agent.submit' | 'agent.interrupt-and-submit',
    prompt: string,
    context?: ChatMessageContext,
  ): Promise<StructuredAgentUiResult> => submitConversationMessage(commandAccess, {
    sessionId, recovery: chatRecovery.controller, type, prompt, ...(context ? { context } : {}),
    onAccepted: (commandId) => showSent(commandId, prompt, context),
  });

  const reconcileSubmit = (): Promise<StructuredAgentUiResult> => reconcileConversationSubmit(commandAccess, {
    recovery: chatRecovery.controller,
    onAccepted: ({ commandId, payload }) => showSent(commandId, payload.prompt, payload.context),
  });

  const changeSettings = (settings: {
    readonly model?: string;
    readonly permissionPreset?: PermissionPreset;
    readonly reasoningEffort?: string;
  }): Promise<StructuredAgentUiResult> => changeConversationSettings(commandAccess, sessionId, settings);

  const resolveApproval = async (
    approvalId: string,
    decision: 'allow' | 'deny',
    response?: ApprovalResponse,
  ): Promise<StructuredAgentUiResult> => {
    const authority = await latestSnapshot();
    if (!authority) return { ok: false, message: 'The Agent daemon is unavailable.' };
    const commandId = opaqueId('command');
    const receipt = await sendCommand(createDaemonCommand({
      commandId,
      idempotencyKey: commandId,
      expectedRevision: authority.revision,
      issuedAt: new Date().toISOString(),
      principal: { kind: 'desktop', id: 'renderer-agent-ui' },
      type: 'permission.resolve',
      // Older hosts validate this payload strictly and would reject the extra field.
      payload: { approvalId, decision, ...(response && authority.capabilities?.includes('approval-response-v1') ? { response } : {}) },
    }));
    return receipt ? resultOf(receipt) : { ok: false, message: 'The Agent daemon is unavailable.' };
  };

  const activeRelation = snapshot?.agentRelations.find((relation) => (
    relation.childSessionId === sessionId && relation.detachedAt === undefined
  ));
  const owner = activeRelation?.owner ?? 'managed';
  const directChildren = (snapshot?.agentRelations ?? [])
    .filter((relation) => relation.parentSessionId === sessionId && relation.detachedAt === undefined)
    .flatMap((relation): StructuredAgentChildTrackItem[] => {
      const childSession = snapshot?.sessions.find((candidate) => candidate.id === relation.childSessionId);
      const childAgent = snapshot?.agents.find((candidate) => candidate.sessionId === relation.childSessionId);
      if (!childSession || !childAgent) return [];
      const childProvider = snapshot?.providers.find((candidate) => candidate.id === childAgent.providerId);
      return [{
        sessionId: childSession.id,
        title: childSession.title,
        providerLabel: childProvider?.displayName ?? childAgent.providerId,
        state: childAgent.state,
        owner: relation.owner,
      }];
    });

  // A provider-owned subagent leads back to its parent and says when the parent holds its approval.
  const parentSession = activeRelation
    ? snapshot?.sessions.find((candidate) => candidate.id === activeRelation.parentSessionId)
    : undefined;
  const subagentType = owner === 'provider-native'
    ? transcriptItems.flatMap((item) => {
        const payload = item.payload ? parseTranscriptPayload(item.payload) : undefined;
        return payload?.type === 'subagent' && payload.role === 'instruction' && payload.subagentType ? [payload.subagentType] : [];
      })[0]
    : undefined;
  const parentApprovalPending = owner === 'provider-native' && (snapshot?.approvals ?? []).some((approval) => (
    approval.state === 'pending' && approval.request?.subagent?.sessionId === sessionId
  ));

  const delegate = async (mode: DelegateMode, request: DelegateAgentRequest): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> => {
    const profile = delegateProfiles.find((entry) => entry.id === request.profileId);
    if (!profile || !session) return { ok: false, error: 'This conversation or profile is no longer available.' };
    let workspaceId: string;
    if (request.workspace.kind === 'new-worktree') {
      if (!worktreeAccess) return { ok: false, error: 'New worktrees can be created on the desktop only.' };
      const created = await worktreeAccess.create(session.projectId, request.workspace.branch);
      if (!created.ok) return { ok: false, error: created.message };
      workspaceId = created.value.workspaceId;
    } else {
      workspaceId = request.workspace.workspaceId;
    }
    const childSessionId = opaqueId('agent');
    const title = mode === 'review'
      ? `${korean ? '검토' : 'Review'} · ${session.title}`
      : structuredAgentSessionTitle(request.instruction) || profile.name;
    // The worktree sync moves the revision on; one retry reads the new one.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const authority = await latestSnapshot();
      if (!authority) return { ok: false, error: 'The Agent daemon is unavailable.' };
      const commandId = opaqueId('command');
      const receipt = await sendCommand(createDaemonCommand({
        commandId,
        idempotencyKey: commandId,
        expectedRevision: authority.revision,
        issuedAt: new Date().toISOString(),
        principal: { kind: 'desktop', id: 'renderer-agent-ui' },
        type: 'agent.create',
        payload: {
          sessionId: childSessionId, workspaceId, title, providerId: profile.providerId,
          ...(profile.model ? { model: profile.model } : {}),
          ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
          permissionPreset: profile.permissionPreset, initialPrompt: request.instruction, parentSessionId: sessionId,
          ...(request.reportBack ? { reportBack: true } : {}),
        },
      }));
      if (!receipt) return { ok: false, error: 'The Agent daemon did not answer. Check the child list before trying again.' };
      if (receipt.ok) return { ok: true };
      if (receipt.error.code !== 'revision-conflict') return { ok: false, error: receipt.error.message };
    }
    return { ok: false, error: 'The project changed while handing off. Try again.' };
  };
  const lastPrompt = [...transcriptItems].reverse().find((item) => item.kind === 'user-message')?.text.trim();
  const delegateInstruction = !session ? '' : delegateMode === 'review'
    ? korean
      ? `"${session.title}" 대화에서 바뀐 내용을 검토해 줘. 파일은 고치지 말고, git diff로 변경을 확인해서 문제와 위험, 빠진 테스트를 알려 줘.`
      : `Review what changed in the "${session.title}" conversation. Do not edit files; read the changes with git diff and report problems, risks and missing tests.`
    : korean
      ? `"${session.title}" 대화의 작업을 이어서 해 줘.${lastPrompt ? `\n\n지금까지의 요청:\n${lastPrompt}` : ''}`
      : `Continue the work of the "${session.title}" conversation.${lastPrompt ? `\n\nWhat was asked so far:\n${lastPrompt}` : ''}`;

  const openRelatedSession = (targetSessionId: string): void => {
    const targetSession = snapshot?.sessions.find((candidate) => candidate.id === targetSessionId);
    const targetAgent = snapshot?.agents.find((candidate) => candidate.sessionId === targetSessionId);
    const targetProvider = snapshot?.providers.find((candidate) => candidate.id === targetAgent?.providerId);
    props.onOpenSession?.({
      sessionId: targetSessionId,
      ...(targetSession ? { title: targetSession.title } : {}),
      ...(targetProvider ? { providerLabel: targetProvider.displayName } : {}),
    });
  };

  const runLifecycleCommand = (
    type: 'agent.cancel' | 'agent.archive' | 'agent.detach',
  ): Promise<StructuredAgentUiResult> => runConversationLifecycle(commandAccess, sessionId, type);

  const configureHeartbeat = async (
    input: StructuredAgentHeartbeatInput,
  ): Promise<StructuredAgentUiResult> => {
    const authority = await latestSnapshot();
    if (!authority) return { ok: false, message: 'The Agent daemon is unavailable.' };
    const currentAgent = authority.agents.find((candidate) => candidate.sessionId === sessionId);
    const currentSession = authority.sessions.find((candidate) => candidate.id === sessionId);
    if (!currentAgent || !currentSession) {
      return { ok: false, message: 'This Agent session is no longer available.' };
    }
    const relation = authority.agentRelations.find((candidate) => (
      candidate.childSessionId === sessionId && candidate.detachedAt === undefined
    ));
    if (relation?.owner === 'provider-native') {
      return { ok: false, message: 'This provider-owned subagent is read-only.' };
    }
    const commandId = opaqueId('command');
    const receipt = await sendCommand(createDaemonCommand({
      commandId,
      idempotencyKey: commandId,
      expectedRevision: authority.revision,
      issuedAt: new Date().toISOString(),
      principal: { kind: 'desktop', id: 'renderer-agent-ui' },
      type: 'heartbeat.configure',
      payload: { sessionId, ...input },
    }));
    return receipt ? resultOf(receipt) : { ok: false, message: 'The Agent daemon is unavailable.' };
  };

  const runHeartbeatNow = async (): Promise<StructuredAgentUiResult> => {
    const authority = await latestSnapshot();
    if (!authority) return { ok: false, message: 'The Agent daemon is unavailable.' };
    const heartbeat = authority.heartbeats.find((candidate) => candidate.sessionId === sessionId);
    if (!heartbeat?.enabled) return { ok: false, message: 'This heartbeat is no longer active.' };
    const commandId = opaqueId('command');
    const receipt = await sendCommand(createDaemonCommand({
      commandId,
      idempotencyKey: commandId,
      expectedRevision: authority.revision,
      issuedAt: new Date().toISOString(),
      principal: { kind: 'desktop', id: 'renderer-agent-ui' },
      type: 'heartbeat.trigger',
      payload: { sessionId },
    }));
    return receipt ? resultOf(receipt) : { ok: false, message: 'The Agent daemon is unavailable.' };
  };

  const enableAutomationHost = async (): Promise<StructuredAgentUiResult> => {
    const lifecycle = await capabilities.daemon
      .setLifecycleSettings({ keepRunning: true, startAtLogin: true })
      .catch(() => null);
    if (!lifecycle?.keepRunning || !lifecycle.startAtLogin) {
      return { ok: false, message: 'Keep running and Start at login could not be enabled.' };
    }
    await refresh();
    return { ok: true };
  };

  const heartbeat = snapshot?.heartbeats.find((candidate) => candidate.sessionId === sessionId);
  const sessionTurns = (snapshot?.turns ?? []).filter((turn) => turn.sessionId === sessionId);
  const automationReady = snapshot?.runtime.keepRunning === true && snapshot.runtime.startAtLogin === true;
  const historyOnly = session !== undefined && isDaemonSessionArchived(session, agent) || workflowContext.scope?.readOnly === true;
  const heartbeatAvailable = owner === 'managed'
    && !historyOnly
    && session !== undefined
    && agent !== undefined
    && HEARTBEAT_SESSION_STATES.has(agent.state);

  return (<SettingsProposalContext.Provider value={settingsProposals}><AgentResultsOwnerContext.Provider value={resultsOwner}>
    {resultsOwner && sessionId && (
      <ResultsPublisher
        key={sessionId}
        ownerPanelId={resultsOwner.ownerPanelId}
        sessionId={sessionId}
        title={session?.title ?? createdDraft?.title ?? ''}
        providerLabel={provider?.displayName ?? (providerId || 'Agent')}
        {...(workspaceRoot ? { workspaceRoot } : {})}
        items={transcriptItems}
        children={directChildren}
        transcriptFloor={transcriptFloor}
        loaded={!transcriptLoading && snapshot !== null}
        historyOnly={historyOnly}
        turnActive={agent ? RESULTS_ACTIVE_STATES.has(agent.state) : false}
        readTranscriptPage={(after, limit) => capabilities.daemon.getTranscript(sessionId, after, limit)}
        {...(props.onOpenSession ? { openRelatedSession } : {})}
        {...(session && workflowNavigation ? { openProjectFiles: () => workflowNavigation.openFiles(session.projectId) } : {})}
      />
    )}
    <StructuredAgentSessionPanel
      onOpenProjectFiles={session && workflowNavigation ? () => workflowNavigation.openFiles(session.projectId) : undefined}
      viewStateKey={props.params?.conversationId ? `desktop:conversation:${props.params.conversationId}` : undefined}
      onOpenHistory={props.onOpenHistory ? () => props.onOpenHistory?.(session?.projectId ?? projectId) : undefined}
      capabilityClient={capabilityClient}
      sessionId={sessionId}
      title={session?.title ?? createdDraft?.title ?? 'Agent session'}
      providerId={providerId}
      providerLabel={provider?.displayName ?? (providerId || 'Agent')}
      usage={snapshot?.agentUsage?.[sessionId]}
      workspace={workspaceOption}
      {...(shownFolders ? { folders: shownFolders } : {})}
      {...(session && props.onEditProject ? { onEditProject: () => props.onEditProject?.(session.projectId) } : {})}
      model={currentModel}
      modelOptions={modelOptions}
      permissionPreset={nextSettings?.permissionPreset ?? createdDraft?.permissionPreset ?? 'standard'}
      queueSettings={queuesSettings && !historyOnly}
      {...(queuedSettings && !historyOnly ? { queuedSettings } : {})}
      {...(phaseNote ? { planPhaseNote: phaseNote } : {})}
      awaitingFirstMessage={!historyOnly && (agent ? agent.state === 'idle' && !agent.providerSessionId && !snapshot?.turns.some((turn) => turn.sessionId === sessionId) : Boolean(createdDraft && !createdDraft.initialPrompt))}
      state={historyOnly ? 'archived' : agent?.state ?? (createdDraft ? createdDraft.initialPrompt ? 'starting' : 'idle' : loading ? 'starting' : 'error')}
      queuedCount={agent?.queuedTurnCount ?? 0}
      queueItems={conversationQueue(sessionId, snapshot?.turns ?? [], transcriptItems)}
      onQueueAction={!historyOnly && owner === 'managed' && snapshot?.capabilities?.includes('agent-queue')
        ? (item, action) => queueConversationTurn(commandAccess, sessionId, item, action)
        : undefined}
      items={transcriptItems}
      turns={sessionTurns}
      approvals={sessionApprovals}
      approvalResponses={snapshot?.capabilities?.includes('approval-response-v1') === true}
      approvalSession={snapshot?.capabilities?.includes('approval-session-v1') === true}
      planProposals={snapshot?.capabilities?.includes('plan-proposal-v1') === true}
      effortSupported={snapshot?.capabilities?.includes('agent-effort-v1') === true}
      {...(nextSettings?.reasoningEffort ? { reasoningEffort: nextSettings.reasoningEffort } : {})}
      onOpenLink={openLink}
      {...(fileSearch ? { fileSearch } : {})}
      pathForDrop={pathForDrop}
      hasEarlier={transcriptFloor > 0}
      loadingEarlier={loadingEarlier}
      onLoadEarlier={() => void loadEarlierTranscript()}
      transcriptLoading={transcriptLoading && transcriptItems.length === 0}
      transcriptError={transcriptError ?? loadError ?? (!createdDraft && !loading && snapshot && !session
        ? 'This Agent session is no longer available.'
        : null)}
      disabled={!snapshot && !loading}
      historyOnly={historyOnly}
      workflowContext={workflowContext.scope ? <WorkflowConversationContext scope={workflowContext.scope} onRefresh={workflowContext.refreshReferences} busy={workflowContext.loading} error={workflowContext.error} onReturn={workflowNavigation?.openWorkflow ? () => { const scope = workflowContext.scope!; workflowNavigation.openWorkflow!(scope.projectId, snapshot?.projects.find(project => project.id === scope.projectId)?.name ?? scope.projectId, scope.subprojectId, scope.nodeId); } : undefined} /> : workflowContext.error ? <WorkflowConversationUnavailable message={workflowContext.error} onRetry={workflowContext.retry} /> : undefined}
      owner={owner}
      {...(parentSession && props.onOpenSession ? { parent: { sessionId: parentSession.id, title: parentSession.title } } : {})}
      {...(subagentType ? { subagentType } : {})}
      parentApprovalPending={parentApprovalPending}
      {...(!historyOnly && conversationSettings.track ? { settingsTrack: conversationSettings.track } : {})}
      childTrack={directChildren.length > 0 && props.onOpenSession ? (
        <StructuredAgentChildTrack items={directChildren} onSelectSession={openRelatedSession} />
      ) : undefined}
      heartbeatActive={heartbeatAvailable && heartbeat?.enabled === true}
      heartbeatControl={heartbeatAvailable ? (
        <StructuredAgentHeartbeat
          defaultOpen
          sessionId={sessionId}
          value={heartbeat}
          automationReady={automationReady}
          disabled={!snapshot || loading}
          onSave={configureHeartbeat}
          onRunNow={runHeartbeatNow}
          onEnableHost={enableAutomationHost}
        />
      ) : undefined}
      onRetryTranscript={() => {
        void refresh();
        if (sessionId) void syncTranscript(sessionId, transcriptTargetRef.current);
      }}
      supportsMessageContext={provider?.protocol === 'codex-app-server' || provider?.protocol === 'claude-agent-sdk'}
      {...(!historyOnly && owner === 'managed' && sideQuestionClient ? { sideQuestion: {
        client: sideQuestionClient, available: snapshot?.sideQuestionSessionIds?.includes(sessionId) === true,
      } } : {})}
      draftState={chatRecovery.controller ? chatRecovery.view.draft : undefined}
      onDraftChange={(draft) => {
        if (chatRecovery.controller) chatRecovery.controller.updateDraft(draft);
        else earlyDraft.current = { sessionId, draft };
      }}
      sendDisabled={chatRecovery.view.status !== 'ready' || workflowContext.loading}
      sendDisabledReason={chatRecovery.view.status === 'loading' ? 'Restoring secure draft…' : chatRecovery.view.message}
      recoveryControl={<ChatRecoveryNotice controller={chatRecovery.controller} view={chatRecovery.view} />}
      deliveryUncertain={pendingSubmit !== null}
      onReconcileDelivery={reconcileSubmit}
      onSend={(prompt, context) => { keepPreview(); return runSessionCommand('agent.submit', prompt, context); }}
      onInterruptAndSend={historyOnly ? undefined : (prompt, context) => { keepPreview(); return runSessionCommand('agent.interrupt-and-submit', prompt, context); }}
      onChangeSettings={historyOnly ? undefined : changeSettings}
      onResolveApproval={historyOnly ? undefined : resolveApproval}
      onOpenRelatedSession={props.onOpenSession ? openRelatedSession : undefined}
      onCancel={!historyOnly && owner === 'managed' && session && agent ? () => runLifecycleCommand('agent.cancel') : undefined}
      onArchive={!historyOnly && owner === 'managed' && session && agent ? () => runLifecycleCommand('agent.archive') : undefined}
      onDetach={!historyOnly && owner === 'managed' && session && agent && activeRelation
        ? () => runLifecycleCommand('agent.detach')
        : undefined}
      onDelegate={!historyOnly && owner !== 'provider-native' && session && agent && profileAccess ? setDelegateMode : undefined}
      {...(props.onNewConversation && session ? { onNewConversation: () => props.onNewConversation!({
        projectId: session.projectId, name: snapshot?.projects.find((project) => project.id === session.projectId)?.name ?? session.projectId,
      }) } : {})}
      {...(props.onClearConversation && !historyOnly && session && agent ? { onClearConversation: (draftText?: string) => {
        const replaced = props.onClearConversation!({
          project: { projectId: session.projectId, name: snapshot?.projects.find((project) => project.id === session.projectId)?.name ?? session.projectId },
          settings: { providerId: agent.providerId, workspaceId: session.workspaceId, permissionPreset: agent.permissionPreset,
            ...(agent.model ? { model: agent.model } : {}), ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}) },
          ...(draftText ? { draftText } : {}),
          ...(agent.permissionPreset === 'plan' ? { planAccess: readPlanAccess(session.id) } : {}),
        });
        // The replaced conversation stays in history; its provider process need not live on until quit.
        if (replaced) void releaseProviderAfterClear(capabilities.daemon, session.id, () => opaqueId('command'));
      } } : {})}
    />
    {delegateMode && session && (
      <DelegateAgentDialog
        open
        onOpenChange={(open) => { if (!open) setDelegateMode(null); }}
        mode={delegateMode}
        profiles={delegateProfiles}
        providerLabels={Object.fromEntries((snapshot?.providers ?? []).map((entry) => [entry.id, entry.displayName]))}
        workspaces={structuredAgentWorkspaceOptions(snapshot, session.projectId).filter((entry) => !isRunOwnedWorkspace(entry.id))
          .map((entry) => ({ id: entry.id, label: entry.label, kind: entry.kind === 'worktree' ? 'worktree' as const : 'local' as const }))}
        defaultWorkspaceId={session.workspaceId}
        initialInstruction={delegateInstruction}
        allowNewWorktree={Boolean(worktreeAccess)}
        {...(props.onOpenSettings ? { onManageProfiles: props.onOpenSettings } : {})}
        onSubmit={(request) => delegate(delegateMode, request)}
      />
    )}
  </AgentResultsOwnerContext.Provider></SettingsProposalContext.Provider>);
}
