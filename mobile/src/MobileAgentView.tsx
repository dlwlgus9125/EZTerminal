import { Bot, Check, History, Plus } from 'lucide-react';
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

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
import {
  StructuredAgentChildTrack,
  type StructuredAgentDraftInput,
  type StructuredAgentUiResult,
  type StructuredAgentWorkspaceOption,
} from '../../src/renderer/StructuredAgentSession';
import {
  createStructuredAgentSession,
  structuredAgentProviderOptions,
  structuredAgentWorkspaceOptions,
  type StructuredAgentCreateAccess,
  type StructuredAgentCreateOutcome,
} from '../../src/renderer/structured-agent-create';
import { IconButton } from '../../src/renderer/ui';
import {
  createDaemonCommand,
  type DaemonCommand,
  type DaemonTranscriptItem,
  type ManagedAgentState,
  type PermissionPreset,
} from '../../src/shared/daemon-protocol';
import { isDaemonSessionArchived } from '../../src/shared/daemon-session-visibility';
import { MobileActionSheet } from './MobileActionSheet';
import {
  MobileDaemonNavigator,
  type MobileDaemonNavigatorLocation,
  type MobileDaemonNavigatorVisibility,
} from './MobileDaemonNavigator';
import { MobileNewSessionDraft } from './MobileNewSessionDraft';
import { useMobileNavigationHistory } from './MobileNavigationHistory';
import { MobilePageHeader } from './MobilePageHeader';
import { MobileAgentProjects } from './MobileAgentProjects';
import { MobileStructuredAgentSession } from './MobileStructuredAgentSession';
import { sessionViewKey } from '../../src/renderer/session-view-state';
import { useLiveTerminalSessions, withLiveTerminalSessions } from '../../src/renderer/use-live-terminal-sessions';
import { useMobileToast } from './MobileToast';
import type {
  DaemonRuntimeViewState,
  WsEzTerminalTransport,
} from './transport/ws-ezterminal';
import type {
  MobileWorkspaceTerminalFailureReason,
  MobileWorkspaceTerminalResult,
} from './workspace-terminal';
import {
  mobileAgentCreateRecoveryFromCommand,
  type MobileAgentCreateRecoveryController,
  type UncertainAgentCreate,
} from './mobile-agent-create-recovery-store';

export type { UncertainAgentCreate } from './mobile-agent-create-recovery-store';

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

const EMPTY_STRUCTURED_TRANSCRIPTS: Readonly<Record<string, readonly DaemonTranscriptItem[]>> = {};
const EMPTY_TRANSCRIPT: readonly DaemonTranscriptItem[] = [];
const TRANSCRIPT_PAGE_SIZE = 500;
const TRANSCRIPT_PAGES_PER_YIELD = 10;

interface MobileNewSessionTarget {
  readonly workspaceId?: string;
}

interface PendingCreatedAgent {
  readonly sessionId: string;
  readonly commandId: string;
  readonly title: string;
  readonly input: StructuredAgentDraftInput;
  readonly projectId: string;
  readonly workspace: StructuredAgentWorkspaceOption;
  readonly providerLabel: string;
  readonly localItem: DaemonTranscriptItem;
}

const CREATE_FAILURE_COPY = {
  en: {
    'invalid-prompt': 'Enter a first prompt before creating the Agent session.',
    'daemon-unavailable': 'The Agent service is unavailable. Reconnect and try again.',
    'recovery-unavailable': 'Secure Agent recovery storage is unavailable. Agent creation is disabled to prevent a duplicate session. Terminal creation remains available.',
    'provider-not-ready': 'The selected Agent provider is not ready. Finish setup on Desktop and try again.',
    'workspace-unavailable': 'The selected Workspace is no longer available. Refresh and choose an active Workspace.',
    'command-rejected': 'The Agent session could not be created. Refresh the Desktop state and try again.',
  },
  ko: {
    'invalid-prompt': 'Agent 세션을 만들려면 첫 프롬프트를 입력하세요.',
    'daemon-unavailable': 'Agent 서비스에 연결할 수 없습니다. 다시 연결한 뒤 시도하세요.',
    'recovery-unavailable': '안전한 Agent 복구 저장소를 사용할 수 없습니다. 중복 세션 생성을 막기 위해 Agent 생성이 비활성화되었습니다. Terminal 생성은 계속 사용할 수 있습니다.',
    'provider-not-ready': '선택한 Agent Provider를 사용할 수 없습니다. Desktop에서 설정을 마친 뒤 다시 시도하세요.',
    'workspace-unavailable': '선택한 Workspace를 더 이상 사용할 수 없습니다. 새로 고친 뒤 활성 Workspace를 선택하세요.',
    'command-rejected': 'Agent 세션을 만들지 못했습니다. Desktop 상태를 새로 고친 뒤 다시 시도하세요.',
  },
} as const;

const SECURE_RECOVERY_FAILURE_COPY = {
  en: 'Secure Agent recovery storage is unavailable. Agent creation is disabled to prevent a duplicate session. Terminal creation remains available.',
  ko: '안전한 Agent 복구 저장소를 사용할 수 없습니다. 중복 세션 생성을 막기 위해 Agent 생성이 비활성화되었습니다. Terminal 생성은 계속 사용할 수 있습니다.',
} as const;

const TERMINAL_FAILURE_COPY: Readonly<Record<
  'en' | 'ko',
  Readonly<Record<MobileWorkspaceTerminalFailureReason, string>>
>> = {
  en: {
    'authority-refresh-failed': 'Could not refresh the Desktop Workspace state. Reconnect and try again.',
    'authority-unavailable': 'The Desktop Workspace state is unavailable. Reconnect and try again.',
    'workspace-unavailable': 'This Workspace is no longer available. Refresh Agents and choose an active Workspace.',
    'workspace-root-unavailable': 'This Workspace has no runnable directory. Open it on Desktop and try again.',
    'surface-open-failed': 'Could not open a Terminal for this Workspace.',
  },
  ko: {
    'authority-refresh-failed': 'Desktop의 Workspace 상태를 새로 고치지 못했습니다. 다시 연결한 뒤 시도하세요.',
    'authority-unavailable': 'Desktop의 Workspace 상태를 사용할 수 없습니다. 다시 연결한 뒤 시도하세요.',
    'workspace-unavailable': '이 Workspace를 더 이상 사용할 수 없습니다. Agents를 새로 고친 뒤 활성 Workspace를 선택하세요.',
    'workspace-root-unavailable': '이 Workspace에는 실행할 수 있는 디렉터리가 없습니다. Desktop에서 연 뒤 다시 시도하세요.',
    'surface-open-failed': '이 Workspace의 Terminal을 열지 못했습니다.',
  },
};

function sameStructuredAgentDraft(
  left: StructuredAgentDraftInput,
  right: StructuredAgentDraftInput,
): boolean {
  return left.providerId === right.providerId
    && left.model === right.model
    && left.workspaceId === right.workspaceId
    && left.permissionPreset === right.permissionPreset
    && left.initialPrompt.trim() === right.initialPrompt.trim();
}

function mergeTranscriptPages(
  current: readonly DaemonTranscriptItem[],
  incoming: readonly DaemonTranscriptItem[],
): readonly DaemonTranscriptItem[] {
  const bySequence = new Map<number, DaemonTranscriptItem>();
  for (const item of current) bySequence.set(item.sequence, item);
  for (const item of incoming) bySequence.set(item.sequence, item);
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

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
  onCreateWorkspaceTerminal,
  onCreateLocalTerminal,
  newSessionRequest = 0,
  initialSessionId,
  onActiveSessionChange,
  onNewSessionRequestConsumed,
  onLaunchAgent,
  onResumeHistory,
  transport,
  daemonRuntimeState = INITIAL_DAEMON_RUNTIME_STATE,
  structuredTranscripts = EMPTY_STRUCTURED_TRANSCRIPTS,
  agentCreateRecovery,
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
  readonly onCreateWorkspaceTerminal?: (workspaceId: string) => Promise<MobileWorkspaceTerminalResult>;
  readonly onCreateLocalTerminal?: () => Promise<StructuredAgentUiResult>;
  readonly newSessionRequest?: number;
  readonly initialSessionId?: string | null;
  readonly onActiveSessionChange?: (sessionId: string | null) => void;
  readonly onNewSessionRequestConsumed?: () => void;
  readonly transport?: WsEzTerminalTransport;
  readonly daemonRuntimeState?: DaemonRuntimeViewState;
  /** Optional transcript seed used by tests and hosts that already own a page cache. */
  readonly structuredTranscripts?: Readonly<Record<string, readonly DaemonTranscriptItem[]>>;
  /** Workspace-owned durable recovery boundary. Missing controllers fail Agent creation closed. */
  readonly agentCreateRecovery?: MobileAgentCreateRecoveryController;
}): JSX.Element {
  const { t, i18n } = useAppTranslation();
  const liveTerminalIds = useLiveTerminalSessions(transport);
  const navigationSnapshot = useMemo(() => withLiveTerminalSessions(daemonRuntimeState.snapshot, liveTerminalIds), [daemonRuntimeState.snapshot, liveTerminalIds]);
  const showToast = useMobileToast();
  const navigation = useMobileNavigationHistory();
  const detailLayerId = `mobile-agent-detail-${useId()}`;
  const newSessionButtonRef = useRef<HTMLButtonElement>(null);
  const [filter, setFilter] = useState<AgentFilter>('all');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [decidingMergeId, setDecidingMergeId] = useState<string | null>(null);
  const [overrideRequest, setOverrideRequest] = useState<ManagedMergeRequest | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [diff, setDiff] = useState<MobileDiffView | null>(null);
  const [selectedDaemonSessionId, setSelectedDaemonSessionId] = useState<string | null>(initialSessionId ?? null);
  useEffect(() => { onActiveSessionChange?.(selectedDaemonSessionId); }, [onActiveSessionChange, selectedDaemonSessionId]);
  const [newSessionTarget, setNewSessionTarget] = useState<MobileNewSessionTarget | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pendingCreatedAgent, setPendingCreatedAgent] = useState<PendingCreatedAgent | null>(null);
  const [preparedAgentCreate, setPreparedAgentCreate] = useState<UncertainAgentCreate | null>(
    agentCreateRecovery?.recovery ?? null,
  );
  const uncertainAgentCreate = preparedAgentCreate ?? agentCreateRecovery?.recovery ?? null;
  const [daemonNavigatorVisibility, setDaemonNavigatorVisibility]
    = useState<MobileDaemonNavigatorVisibility>('active');
  const [daemonNavigatorLocation, setDaemonNavigatorLocation]
    = useState<MobileDaemonNavigatorLocation>({ projectId: null, workspaceId: null });
  const [loadedTranscriptSessionId, setLoadedTranscriptSessionId] = useState<string | null>(null);
  const [authoritativeTranscript, setAuthoritativeTranscript] = useState<readonly DaemonTranscriptItem[]>([]);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState<'load' | 'gap' | null>(null);
  const diffRequestGeneration = useRef(0);
  const daemonRevisionRef = useRef(daemonRuntimeState.snapshot?.revision ?? 0);
  const transcriptSessionRef = useRef<string | null>(null);
  const transcriptTargetRef = useRef(0);
  const transcriptCursorRef = useRef(0);
  const transcriptGenerationRef = useRef(0);
  const transcriptInFlightRef = useRef<Promise<void> | null>(null);
  const transcriptItemsRef = useRef<readonly DaemonTranscriptItem[]>([]);
  const handledGapRef = useRef<string | null>(null);
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const language: 'en' | 'ko' = locale.startsWith('ko') ? 'ko' : 'en';

  useEffect(() => {
    setPreparedAgentCreate(agentCreateRecovery?.recovery ?? null);
  }, [agentCreateRecovery?.recovery]);
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
  const selectedTranscriptSeed = useMemo<readonly DaemonTranscriptItem[]>(() => (
    selectedDaemonSessionId
      ? pendingCreatedAgent?.sessionId === selectedDaemonSessionId
        ? mergeTranscriptPages(
            [pendingCreatedAgent.localItem],
            structuredTranscripts[selectedDaemonSessionId] ?? EMPTY_TRANSCRIPT,
          )
        : structuredTranscripts[selectedDaemonSessionId] ?? EMPTY_TRANSCRIPT
      : EMPTY_TRANSCRIPT
  ), [pendingCreatedAgent, selectedDaemonSessionId, structuredTranscripts]);
  const selectedTranscriptHead = selectedDaemonSessionId
    ? daemonRuntimeState.snapshot?.transcriptHeads.find((head) => (
      head.sessionId === selectedDaemonSessionId
    ))?.lastSequence ?? 0
    : 0;

  const syncTranscript = useCallback((
    targetSessionId: string,
    targetSequence = 0,
  ): Promise<void> => {
    if (
      transcriptSessionRef.current !== targetSessionId
      || !transport
      || typeof transport.getDaemonTranscript !== 'function'
    ) return Promise.resolve();
    transcriptTargetRef.current = Math.max(transcriptTargetRef.current, targetSequence);
    if (targetSequence > 0 && transcriptCursorRef.current >= transcriptTargetRef.current) {
      return Promise.resolve();
    }
    if (transcriptInFlightRef.current) return transcriptInFlightRef.current;
    const generation = transcriptGenerationRef.current;
    let shouldContinue = false;
    let failed = false;
    const run = async (): Promise<void> => {
      setTranscriptLoading(transcriptItemsRef.current.length === 0);
      setTranscriptError(null);
      try {
        for (let pageIndex = 0; pageIndex < TRANSCRIPT_PAGES_PER_YIELD; pageIndex += 1) {
          if (
            transcriptGenerationRef.current !== generation
            || transcriptSessionRef.current !== targetSessionId
          ) return;
          const afterSequence = transcriptCursorRef.current;
          const page = await transport.getDaemonTranscript(
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
            const next = mergeTranscriptPages(transcriptItemsRef.current, validPage);
            transcriptItemsRef.current = next;
            transcriptCursorRef.current = next.at(-1)?.sequence ?? afterSequence;
            setAuthoritativeTranscript(next);
          }
          const target = transcriptTargetRef.current;
          if (validPage.length === 0) {
            if (target > transcriptCursorRef.current) {
              throw new Error('The Agent transcript is temporarily incomplete.');
            }
            shouldContinue = false;
            return;
          }
          if (transcriptCursorRef.current >= target && validPage.length < TRANSCRIPT_PAGE_SIZE) {
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
        ) setTranscriptError('load');
      } finally {
        if (
          transcriptGenerationRef.current === generation
          && transcriptSessionRef.current === targetSessionId
        ) {
          setTranscriptLoading(false);
          if (!failed) setTranscriptError(null);
        }
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
  }, [transport]);

  const reloadTranscript = useCallback((
    targetSessionId: string,
    targetSequence?: number,
  ): Promise<void> => {
    if (transcriptSessionRef.current !== targetSessionId) return Promise.resolve();
    const nextTarget = Math.max(transcriptTargetRef.current, targetSequence ?? 0);
    transcriptGenerationRef.current += 1;
    transcriptTargetRef.current = nextTarget;
    transcriptCursorRef.current = 0;
    transcriptInFlightRef.current = null;
    setTranscriptError(null);
    setTranscriptLoading(true);
    return syncTranscript(targetSessionId, nextTarget);
  }, [syncTranscript]);

  useEffect(() => {
    if (daemonRuntimeState.snapshot) {
      daemonRevisionRef.current = daemonRuntimeState.snapshot.revision;
    }
  }, [daemonRuntimeState.snapshot]);

  useEffect(() => {
    if (selectedDaemonSessionId && daemonRuntimeState.snapshot && !daemonRuntimeState.snapshot.sessions.some((session) => (
      session.id === selectedDaemonSessionId
      && session.kind === 'agent'
      && session.source === 'structured'
    )) && pendingCreatedAgent?.sessionId !== selectedDaemonSessionId) {
      setSelectedDaemonSessionId(null);
    }
  }, [daemonRuntimeState.snapshot, pendingCreatedAgent?.sessionId, selectedDaemonSessionId]);

  useEffect(() => {
    transcriptGenerationRef.current += 1;
    transcriptSessionRef.current = selectedDaemonSessionId;
    transcriptTargetRef.current = 0;
    transcriptInFlightRef.current = null;
    const seed = mergeTranscriptPages([], selectedTranscriptSeed);
    const seedIsContiguous = seed.every((item, index) => item.sequence === index + 1);
    transcriptCursorRef.current = seedIsContiguous ? seed.at(-1)?.sequence ?? 0 : 0;
    transcriptItemsRef.current = seed;
    setLoadedTranscriptSessionId(selectedDaemonSessionId);
    setAuthoritativeTranscript(seed);
    setTranscriptError(null);
    const canLoad = Boolean(
      selectedDaemonSessionId
      && transport
      && typeof transport.getDaemonTranscript === 'function'
    );
    setTranscriptLoading(canLoad && seed.length === 0);
    if (selectedDaemonSessionId && canLoad) {
      void syncTranscript(selectedDaemonSessionId);
    }
    return () => {
      transcriptGenerationRef.current += 1;
    };
  }, [selectedDaemonSessionId, selectedTranscriptSeed, syncTranscript, transport]);

  useEffect(() => {
    if (selectedDaemonSessionId) {
      void syncTranscript(selectedDaemonSessionId, selectedTranscriptHead);
    }
  }, [selectedDaemonSessionId, selectedTranscriptHead, syncTranscript]);

  useEffect(() => {
    if (!transport) return undefined;
    const subscribe = typeof transport.setDaemonEventsSubscribed === 'function'
      ? transport.setDaemonEventsSubscribed(true).catch(() => undefined)
      : Promise.resolve();
    const stop = typeof transport.onDaemonEvent === 'function'
      ? transport.onDaemonEvent((event, continuity) => {
          const currentSessionId = transcriptSessionRef.current;
          if (!currentSessionId) return;
          if (continuity === 'gap' || continuity === 'revision-regression') {
            const target = event.kind === 'transcript.appended'
              && event.payload.sessionId === currentSessionId
              ? event.payload.toSequence
              : transcriptTargetRef.current;
            void reloadTranscript(currentSessionId, target);
            setTranscriptError('gap');
            return;
          }
          if (
            continuity !== 'duplicate'
            && event.kind === 'transcript.appended'
            && event.payload.sessionId === currentSessionId
          ) void syncTranscript(currentSessionId, event.payload.toSequence);
        })
      : () => undefined;
    void subscribe;
    return () => {
      stop();
      if (typeof transport.setDaemonEventsSubscribed === 'function') {
        void transport.setDaemonEventsSubscribed(false).catch(() => undefined);
      }
    };
  }, [reloadTranscript, syncTranscript, transport]);

  useEffect(() => {
    if (daemonRuntimeState.error !== 'event-gap' || !selectedDaemonSessionId) {
      handledGapRef.current = null;
      return;
    }
    const key = `${selectedDaemonSessionId}:${daemonRuntimeState.snapshot?.eventSequence ?? 'unknown'}`;
    if (handledGapRef.current === key) return;
    handledGapRef.current = key;
    void reloadTranscript(selectedDaemonSessionId, selectedTranscriptHead);
    setTranscriptError('gap');
  }, [
    daemonRuntimeState.error,
    daemonRuntimeState.snapshot?.eventSequence,
    reloadTranscript,
    selectedDaemonSessionId,
    selectedTranscriptHead,
  ]);

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
      setNewSessionTarget(null);
      setSelectedDaemonSessionId(sessionId);
    }
    onFocusSession(sessionId);
  };

  const clearSettledAgentCreate = useCallback(async (): Promise<boolean> => {
    setPreparedAgentCreate(null);
    return agentCreateRecovery ? agentCreateRecovery.clear() : false;
  }, [agentCreateRecovery]);

  const finishAgentCreation = useCallback(async (
    input: StructuredAgentDraftInput,
    outcome: Extract<StructuredAgentCreateOutcome, { readonly kind: 'created' | 'delivery-uncertain' }>,
    snapshotOverride = daemonRuntimeState.snapshot,
  ): Promise<StructuredAgentUiResult> => {
    await clearSettledAgentCreate();
    const workspaceRecord = snapshotOverride?.workspaces.find((workspace) => (
      workspace.id === input.workspaceId
    ));
    const workspace = structuredAgentWorkspaceOptions(snapshotOverride).find((option) => (
      option.id === input.workspaceId
    )) ?? {
      id: input.workspaceId,
      label: workspaceRecord?.name ?? input.workspaceId,
      kind: workspaceRecord?.kind ?? 'local',
      path: workspaceRecord?.rootPath ?? '',
    };
    const providerLabel = structuredAgentProviderOptions(snapshotOverride).find((provider) => (
      provider.id === input.providerId
    ))?.label ?? input.providerId;
    const createdAt = new Date().toISOString();

    if (outcome.kind === 'created') daemonRevisionRef.current = outcome.receipt.revision;
    setPendingCreatedAgent({
      sessionId: outcome.sessionId,
      commandId: outcome.command.commandId,
      title: outcome.title,
      input,
      projectId: workspaceRecord?.projectId ?? '',
      workspace,
      providerLabel,
      localItem: {
        id: `local-${outcome.command.commandId}`,
        sessionId: outcome.sessionId,
        sequence: 1,
        kind: 'user-message',
        text: input.initialPrompt.trim(),
        isDelta: false,
        isSensitive: false,
        createdAt,
      },
    });
    setNewSessionTarget(null);
    setSelectedDaemonSessionId(outcome.sessionId);
    if (transport && typeof transport.getDaemonSnapshot === 'function') {
      void transport.getDaemonSnapshot().catch(() => null);
    }
    return { ok: true };
  }, [clearSettledAgentCreate, daemonRuntimeState.snapshot, transport]);

  const createAgentSession = useCallback(async (
    input: StructuredAgentDraftInput,
  ): Promise<StructuredAgentUiResult> => {
    if (!transport || disconnected) {
      return {
        ok: false,
        message: locale.startsWith('ko')
          ? '데스크톱에 다시 연결한 뒤 Agent 세션을 만드세요.'
          : 'Reconnect to Desktop before creating an Agent session.',
      };
    }
    if (!agentCreateRecovery || agentCreateRecovery.status !== 'ready') {
      return { ok: false, message: SECURE_RECOVERY_FAILURE_COPY[language] };
    }

    let prepareFailed = false;
    let preparedThisAttempt = false;
    const access: StructuredAgentCreateAccess = {
      getSnapshot: () => transport.getDaemonSnapshot(),
      sendCommand: async (command) => {
        const recovery = mobileAgentCreateRecoveryFromCommand(command);
        const prepared = await agentCreateRecovery.prepare(command).catch(() => false);
        if (!prepared) {
          prepareFailed = true;
          setPreparedAgentCreate(null);
          throw new Error('Secure mobile Agent recovery storage is unavailable.');
        }
        preparedThisAttempt = true;
        setPreparedAgentCreate(recovery);
        return transport.sendDaemonCommand(command);
      },
    };
    let outcome: StructuredAgentCreateOutcome;
    if (uncertainAgentCreate) {
      if (!sameStructuredAgentDraft(uncertainAgentCreate.input, input)) {
        return {
          ok: false,
          message: locale.startsWith('ko')
            ? '이전 Agent 생성 결과를 확인할 수 없습니다. 중복 생성을 막기 위해 기존 초안 그대로 다시 Send 하세요.'
            : 'The previous Agent creation is still uncertain. Restore the same draft and Send again to avoid a duplicate session.',
        };
      }

      const latest = await transport.getDaemonSnapshot().catch(() => null);
      if (!latest) {
        return { ok: false, message: CREATE_FAILURE_COPY[language]['daemon-unavailable'] };
      }
      const alreadyCreated = latest?.sessions.some((session) => (
        session.id === uncertainAgentCreate.outcome.sessionId
        && session.kind === 'agent'
        && session.source === 'structured'
      ));
      if (alreadyCreated) {
        return finishAgentCreation(input, uncertainAgentCreate.outcome, latest);
      }

      const replay = await transport.sendDaemonCommand(uncertainAgentCreate.outcome.command)
        .catch(() => null);
      if (!replay || (!replay.ok && replay.status === 'delivery-uncertain')) {
        if (replay && !replay.ok) {
          setPreparedAgentCreate({
            input,
            outcome: {
              ...uncertainAgentCreate.outcome,
              receipt: replay,
              message: replay.error.message,
            },
          });
        }
        return {
          ok: false,
          message: locale.startsWith('ko')
            ? '전송 결과를 아직 확인할 수 없습니다. 연결을 확인한 뒤 같은 초안으로 다시 Send 하세요.'
            : 'Delivery is still unconfirmed. Check the connection, then Send the same draft again.',
        };
      }
      if (replay.ok) {
        outcome = {
          kind: 'created',
          sessionId: uncertainAgentCreate.outcome.sessionId,
          title: uncertainAgentCreate.outcome.title,
          command: uncertainAgentCreate.outcome.command,
          receipt: replay,
        };
      } else if (replay.error.code === 'revision-conflict') {
        outcome = await createStructuredAgentSession(input, {
          access,
          principal: { kind: 'android', id: 'mobile-agent-ui' },
          sessionId: uncertainAgentCreate.outcome.sessionId,
        });
      } else {
        const confirmation = await transport.getDaemonSnapshot().catch(() => null);
        const createdDespiteReceipt = confirmation?.sessions.some((session) => (
          session.id === uncertainAgentCreate.outcome.sessionId
          && session.kind === 'agent'
          && session.source === 'structured'
        ));
        if (createdDespiteReceipt) {
          return finishAgentCreation(input, uncertainAgentCreate.outcome, confirmation);
        }
        if (!(await clearSettledAgentCreate())) {
          return { ok: false, message: SECURE_RECOVERY_FAILURE_COPY[language] };
        }
        return { ok: false, message: CREATE_FAILURE_COPY[language]['command-rejected'] };
      }
    } else {
      outcome = await createStructuredAgentSession(input, {
        access,
        principal: { kind: 'android', id: 'mobile-agent-ui' },
      });
    }

    if (prepareFailed) {
      return { ok: false, message: SECURE_RECOVERY_FAILURE_COPY[language] };
    }
    if (outcome.kind === 'rejected' && outcome.reason === 'recovery-unavailable') {
      return { ok: false, message: SECURE_RECOVERY_FAILURE_COPY[language] };
    }
    if (outcome.kind === 'created') return finishAgentCreation(input, outcome);
    if (outcome.kind === 'delivery-uncertain') {
      setPreparedAgentCreate({ input, outcome });
      return {
        ok: false,
        message: locale.startsWith('ko')
          ? '전송 결과를 확인할 수 없습니다. 이 초안을 유지한 채 다시 Send 하면 동일 세션을 확인하고 안전하게 재시도합니다.'
          : 'Delivery could not be confirmed. Keep this draft and Send again to verify or safely retry the same session.',
      };
    }
    if ((uncertainAgentCreate || preparedThisAttempt) && !(await clearSettledAgentCreate())) {
      return { ok: false, message: SECURE_RECOVERY_FAILURE_COPY[language] };
    }
    return { ok: false, message: CREATE_FAILURE_COPY[language][outcome.reason] };
  }, [
    agentCreateRecovery,
    clearSettledAgentCreate,
    disconnected,
    finishAgentCreation,
    language,
    locale,
    transport,
    uncertainAgentCreate,
  ]);

  const createTerminalSession = useCallback(async (
    workspaceId: string,
  ): Promise<StructuredAgentUiResult> => {
    if (!onCreateWorkspaceTerminal) {
      return {
        ok: false,
        message: locale.startsWith('ko')
          ? '이 클라이언트에서는 Workspace Terminal을 열 수 없습니다.'
          : 'This client cannot open a Workspace Terminal.',
      };
    }
    try {
      const result = await onCreateWorkspaceTerminal(workspaceId);
      return result.ok
        ? { ok: true }
        : { ok: false, message: TERMINAL_FAILURE_COPY[language][result.reason] };
    } catch {
      return {
        ok: false,
        message: TERMINAL_FAILURE_COPY[language]['surface-open-failed'],
      };
    }
  }, [language, locale, onCreateWorkspaceTerminal]);

  const terminalCreationLock = useRef(false);
  const [terminalCreationError, setTerminalCreationError] = useState<{ workspaceId: string; message: string } | null>(null);
  const requestTerminalSession = async (workspaceId: string): Promise<void> => {
    if (terminalCreationLock.current) return;
    terminalCreationLock.current = true;
    setTerminalCreationError(null);
    try {
      const result = await createTerminalSession(workspaceId);
      if (!result.ok) setTerminalCreationError({ workspaceId, message: result.message });
    } finally { terminalCreationLock.current = false; }
  };

  const openNewSession = useCallback((workspaceId?: string): void => {
    setSelectedDaemonSessionId(null);
    setNewSessionTarget({
      ...(uncertainAgentCreate?.input.workspaceId
        ? { workspaceId: uncertainAgentCreate.input.workspaceId }
        : workspaceId ? { workspaceId } : {}),
    });
  }, [uncertainAgentCreate]);

  useEffect(() => {
    if (!newSessionRequest) return;
    openNewSession();
    onNewSessionRequestConsumed?.();
  }, [newSessionRequest, onNewSessionRequestConsumed, openNewSession]);

  useEffect(() => {
    if (!uncertainAgentCreate) return;
    setSelectedDaemonSessionId(null);
    setNewSessionTarget({ workspaceId: uncertainAgentCreate.input.workspaceId });
  }, [uncertainAgentCreate]);

  const closeDetailState = useCallback((): void => {
    setHistoryOpen(false);
    setNewSessionTarget(null);
    setSelectedDaemonSessionId(null);
    queueMicrotask(() => newSessionButtonRef.current?.focus());
  }, []);
  const detailOpen = historyOpen || newSessionTarget !== null || selectedDaemonSessionId !== null;
  useEffect(() => {
    if (!detailOpen) return undefined;
    return navigation.pushLayer({
      id: detailLayerId,
      kind: 'page',
      onBack: closeDetailState,
    });
  }, [closeDetailState, detailLayerId, detailOpen, navigation]);
  const closeDetailFromUi = useCallback((): void => {
    navigation.closeLayer(detailLayerId, 'ui');
  }, [detailLayerId, navigation]);

  const dispatchDaemonCommand = async (command: DaemonCommand) => {
    if (!transport || disconnected) return { ok: false as const, message: 'Not connected to EZTerminal.' };
    const receipt = await transport.sendDaemonCommand(command).catch(() => null);
    if (!receipt) return { ok: false as const, message: 'The command could not be delivered.' };
    if (!receipt.ok) return { ok: false as const, message: receipt.error.message };
    daemonRevisionRef.current = receipt.revision;
    return { ok: true as const };
  };

  const authoritativeDaemonSession = daemonRuntimeState.snapshot?.sessions.find((session) => (
    session.id === selectedDaemonSessionId && session.kind === 'agent' && session.source === 'structured'
  ));
  const authoritativeDaemonAgent = daemonRuntimeState.snapshot?.agents.find((agent) => (
    agent.sessionId === selectedDaemonSessionId
  ));
  const authoritativeDaemonWorkspace = daemonRuntimeState.snapshot?.workspaces.find((workspace) => (
    workspace.id === authoritativeDaemonSession?.workspaceId
  ));
  const pendingSelection = pendingCreatedAgent?.sessionId === selectedDaemonSessionId
    ? pendingCreatedAgent
    : undefined;
  const optimisticTimestamp = pendingSelection?.localItem.createdAt ?? new Date().toISOString();
  const selectedDaemonSession = authoritativeDaemonSession ?? (pendingSelection ? {
    id: pendingSelection.sessionId,
    projectId: pendingSelection.projectId,
    workspaceId: pendingSelection.workspace.id,
    kind: 'agent' as const,
    title: pendingSelection.title,
    state: 'starting' as const,
    source: 'structured' as const,
    revision: daemonRevisionRef.current,
    createdAt: optimisticTimestamp,
    updatedAt: optimisticTimestamp,
  } : undefined);
  const selectedDaemonAgent = authoritativeDaemonAgent ?? (pendingSelection ? {
    sessionId: pendingSelection.sessionId,
    providerId: pendingSelection.input.providerId,
    ...(pendingSelection.input.model ? { model: pendingSelection.input.model } : {}),
    permissionPreset: pendingSelection.input.permissionPreset,
    state: 'queued' as const,
    queuedTurnCount: 1,
    orchestrationEnabled: true,
    revision: daemonRevisionRef.current,
    createdAt: optimisticTimestamp,
    updatedAt: optimisticTimestamp,
  } : undefined);
  const selectedDaemonWorkspace = authoritativeDaemonWorkspace ?? (pendingSelection ? {
    id: pendingSelection.workspace.id,
    projectId: pendingSelection.projectId,
    name: pendingSelection.workspace.label,
    kind: pendingSelection.workspace.kind,
    rootPath: pendingSelection.workspace.path,
    revision: daemonRevisionRef.current,
    createdAt: optimisticTimestamp,
    updatedAt: optimisticTimestamp,
  } : undefined);
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

  if (historyOpen && transport && onResumeHistory && onLaunchAgent) return (
    <main className="mob-page" data-testid="mobile-project-history-page">
      <MobilePageHeader title={t('sessionNavigation.projectHistory')} backLabel={t('common.back')} onBack={closeDetailState} />
      <div className="mob-page__body"><MobileAgentProjects transport={transport} onResumeHistory={onResumeHistory} onLaunchAgent={onLaunchAgent} hideLaunchActions /></div>
    </main>
  );

  if (newSessionTarget) {
    return (
      <MobileNewSessionDraft
        initialIntent={{ kind: 'agent', agentMode: 'cli' }}
        state={daemonRuntimeState}
        disconnected={disconnected}
        contextWorkspaceId={newSessionTarget.workspaceId}
        initialAgentDraft={uncertainAgentCreate?.input}
        agentRecoveryStatus={agentCreateRecovery?.status ?? 'unavailable'}
        onBack={closeDetailFromUi}
        onRetry={() => {
          if (transport && typeof transport.getDaemonSnapshot === 'function') {
            void transport.getDaemonSnapshot();
          }
        }}
        onRetryAgentRecovery={() => void agentCreateRecovery?.reload()}
        onDiscardAgentRecovery={() => void agentCreateRecovery?.discard()}
        onCreateAgent={createAgentSession}
        onCreateTerminal={createTerminalSession}
        onCreateLocalTerminal={onCreateLocalTerminal}
        launchAccess={transport}
        onLaunchCli={onLaunchAgent}
      />
    );
  }

  if (selectedDaemonSession && selectedDaemonAgent && selectedDaemonWorkspace) {
    const selectedTranscript = loadedTranscriptSessionId === selectedDaemonSession.id
      ? authoritativeTranscript
      : selectedTranscriptSeed;
    const visibleTranscriptError = daemonRuntimeState.error === 'event-gap'
      || transcriptError === 'gap'
      ? locale.startsWith('ko')
        ? '일부 대화 업데이트를 놓쳐 최신 원본을 다시 불러오는 중입니다…'
        : 'Some transcript updates were missed. Reloading the authoritative state…'
      : transcriptError === 'load'
        ? locale.startsWith('ko')
          ? 'Agent 대화를 불러오지 못했습니다. 기존 대화는 계속 표시됩니다.'
          : 'The Agent transcript could not be loaded. Existing messages are still shown.'
        : null;
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
    const archivedHistory = isDaemonSessionArchived(selectedDaemonSession, selectedDaemonAgent);
    const canCancel = !providerOwned
      && selectedDaemonAgent.providerSessionId !== undefined
      && DAEMON_CANCELLABLE_STATES.has(selectedDaemonAgent.state);
    const canArchive = !providerOwned
      && selectedDaemonAgent.currentTurnId === undefined
      && !archivedHistory
      && DAEMON_ARCHIVABLE_STATES.has(selectedDaemonAgent.state);
    const canDetach = selectedDaemonRelation?.owner === 'managed'
      && !archivedHistory;
    return (
      <MobileStructuredAgentSession
        viewStateKey={transport ? sessionViewKey(transport, `agent:${selectedDaemonSession.id}`) : undefined}
        sessionId={selectedDaemonSession.id}
        title={selectedDaemonSession.title}
        providerId={selectedDaemonAgent.providerId}
        providerLabel={selectedDaemonProvider?.displayName
          ?? pendingSelection?.providerLabel
          ?? selectedDaemonAgent.providerId}
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
        items={selectedTranscript}
        approvals={(daemonRuntimeState.snapshot?.approvals ?? []).filter((approval) => (
          approval.sessionId === selectedDaemonSession.id
        ))}
        transcriptLoading={loadedTranscriptSessionId === selectedDaemonSession.id && transcriptLoading}
        transcriptError={visibleTranscriptError}
        disabled={disconnected || !transport}
        historyOnly={archivedHistory}
        {...(selectedDaemonRelation ? { owner: selectedDaemonRelation.owner } : {})}
        {...(selectedDaemonChildren.length > 0 ? {
          childTrack: (
            <StructuredAgentChildTrack
              items={selectedDaemonChildren}
              onSelectSession={selectSession}
            />
          ),
        } : {})}
        onBack={closeDetailFromUi}
        onRetryTranscript={() => {
          void reloadTranscript(selectedDaemonSession.id, selectedTranscriptHead);
          if (transport && typeof transport.getDaemonSnapshot === 'function') {
            void transport.getDaemonSnapshot();
          }
        }}
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
        {...(!providerOwned && !archivedHistory ? {
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
      <MobilePageHeader
        title={t('mobile.agents')}
        backLabel={t('common.back')}
        backTestId="mobile-agent-close"
        onBack={onBack}
        status={counts.attention > 0 ? (
          <span data-testid="agent-attention-summary">
            {t('mobile.agentView.waitingCount', { value: counts.attention })}
          </span>
        ) : undefined}
        actions={(
          <div className="mob-agent-projects__head-actions">
          {transport && onResumeHistory && onLaunchAgent && <IconButton icon={History} aria-label={t('sessionNavigation.projectHistory')} onClick={() => setHistoryOpen(true)} data-testid="mobile-project-history" />}
          <IconButton
            ref={newSessionButtonRef}
            icon={Plus}
            variant="primary"
            size="md"
            aria-label={t('agentHub.newAgentRun')}
            onClick={() => openNewSession()}
            data-testid="mobile-agent-new-session"
          />
          </div>
        )}
      />

      {disconnected && <div className="mob-empty" role="status">{t('agentHub.reconnecting')}</div>}

      {!navigationSnapshot && <div className="mob-agent-filters" role="group" aria-label={t('mobile.agentView.filterLabel')}>
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
      </div>}

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
            ...(!navigationSnapshot ? visible.filter((item) => bucketOf(item.status) !== 'attention') : []),
          ].map((item) => {
            if (item === null) {
              return (
                <Fragment key="daemon-projects">
                {terminalCreationError && <p role="alert">{terminalCreationError.message} <button type="button" className="mob-cta" disabled={disconnected} onClick={() => void requestTerminalSession(terminalCreationError.workspaceId)}>{t('common.retry')}</button></p>}
                <MobileDaemonNavigator
                  state={{ ...daemonRuntimeState, snapshot: navigationSnapshot }}
                  visibility={daemonNavigatorVisibility}
                  onVisibilityChange={setDaemonNavigatorVisibility}
                  initialLocation={daemonNavigatorLocation}
                  onLocationChange={setDaemonNavigatorLocation}
                  onRetry={() => {
                    void transport!.getDaemonSnapshot();
                  }}
                  onSelectSession={selectSession}
                  terminalAccess={transport}
                  onNewTerminal={(workspaceId) => void requestTerminalSession(workspaceId)}
                  onCreateSession={(workspaceId) => void requestTerminalSession(workspaceId)}
                  onCreateAgent={openNewSession}
                  activities={snapshot.items}
                />
                </Fragment>
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
