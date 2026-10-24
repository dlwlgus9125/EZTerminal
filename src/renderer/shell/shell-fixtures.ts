import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonAgent,
  type DaemonApproval,
  type DaemonSession,
  type DaemonSnapshot,
  type ManagedAgentState,
} from '../../shared/daemon-protocol';
import type { WorkflowSnapshot } from '../../shared/workflow';
import { workflowCanvasFixture } from '../workflow/workflow-canvas-fixtures';
import { workflowFixture } from '../workflow/workflow-fixtures';

/**
 * Story/test data for the Board + Desk shell: three projects, conversations in
 * every state, two things waiting on the person and a flow at its approval.
 * Production code never imports this file.
 */
export const SHELL_NOW = '2026-10-24T09:30:00.000Z';
const at = (minutesAgo: number): string => new Date(Date.parse(SHELL_NOW) - minutesAgo * 60_000).toISOString();

interface ConversationSpec {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly provider: 'claude' | 'codex';
  readonly state: ManagedAgentState;
  readonly minutesAgo: number;
  readonly turns?: boolean;
}

const CONVERSATIONS: readonly ConversationSpec[] = [
  { id: 's-notify', projectId: 'p-ez', title: 'Android 승인 알림이 두 번 뜨는 문제', provider: 'claude', state: 'blocked', minutesAgo: 2, turns: true },
  { id: 's-trace', projectId: 'p-ez', title: '알림 경로 추적', provider: 'claude', state: 'done', minutesAgo: 3, turns: true },
  { id: 's-dedupe', projectId: 'p-ez', title: '중복 제거 테스트 작성', provider: 'claude', state: 'working', minutesAgo: 1, turns: true },
  { id: 's-pdf', projectId: 'p-ez', title: '결과 탭 PDF 저장 버튼', provider: 'codex', state: 'blocked', minutesAgo: 6, turns: true },
  { id: 's-font', projectId: 'p-ez', title: '설정 화면 글꼴 미리보기', provider: 'claude', state: 'done', minutesAgo: 40, turns: true },
  { id: 's-merge', projectId: 'p-ez', title: '워크트리 병합 전 검토', provider: 'codex', state: 'done', minutesAgo: 60 * 20, turns: true },
  { id: 's-csv', projectId: 'p-kestrel', title: 'CSV 가져오기 속도 개선', provider: 'codex', state: 'error', minutesAgo: 30, turns: true },
  { id: 's-garnet', projectId: 'p-garnet', title: '랜딩 문구 다듬기', provider: 'claude', state: 'done', minutesAgo: 90, turns: true },
];

function record(minutesAgo: number) {
  return { revision: 1, createdAt: at(minutesAgo + 5), updatedAt: at(minutesAgo) };
}

export function shellSnapshot(options: { readonly waiting?: boolean } = {}): DaemonSnapshot {
  const waiting = options.waiting ?? true;
  const sessions: DaemonSession[] = CONVERSATIONS.map((spec) => ({
    id: spec.id, projectId: spec.projectId, workspaceId: `${spec.projectId}-main`, kind: 'agent', title: spec.title,
    state: spec.state === 'working' ? 'running' : 'idle', source: 'structured', ...record(spec.minutesAgo),
  }));
  const agents: DaemonAgent[] = CONVERSATIONS.map((spec) => ({
    sessionId: spec.id, providerId: spec.provider, permissionPreset: 'standard', queuedTurnCount: 0, orchestrationEnabled: false,
    state: !waiting && spec.state === 'blocked' ? 'done' : spec.state, ...record(spec.minutesAgo),
  }));
  const approvals: DaemonApproval[] = waiting ? [
    { id: 'a-command', sessionId: 's-notify', providerRequestId: 'r1', risk: 'danger', title: 'Run command', state: 'pending',
      request: { v: 1, kind: 'command', command: 'pnpm --dir mobile test -- notifications' }, ...record(2) },
    { id: 'a-question', sessionId: 's-pdf', providerRequestId: 'r2', risk: 'read', title: 'Question', state: 'pending',
      request: { v: 1, kind: 'question', questions: [{ question: 'PDF를 새 창으로 열까요, 바로 저장할까요?', multiSelect: false, options: [{ label: '새 창' }, { label: '바로 저장' }] }] }, ...record(6) },
  ] : [];
  return {
    protocolVersion: DAEMON_PROTOCOL_VERSION, revision: 7, eventSequence: 9, generatedAt: SHELL_NOW,
    runtime: { keepRunning: true, startAtLogin: false, orchestrationToolsEnabled: true, browserEnabled: false },
    projects: [
      { id: 'p-ez', name: 'EZTerminal', rootPath: '<WORKSPACE>/EZTerminal', source: 'native', ...record(1) },
      { id: 'p-garnet', name: 'Garnet', rootPath: '<WORKSPACE>/Garnet', source: 'native', ...record(90) },
      { id: 'p-kestrel', name: 'Kestrel', rootPath: '<WORKSPACE>/Kestrel', source: 'native', ...record(30) },
    ],
    workspaces: ['p-ez', 'p-garnet', 'p-kestrel'].map((projectId) => ({
      id: `${projectId}-main`, projectId, name: 'main', kind: 'local' as const, rootPath: `<WORKSPACE>/${projectId}`, ...record(100),
    })),
    sessions, agents,
    agentRelations: [
      { id: 'rel-1', treeId: 't1', parentSessionId: 's-notify', childSessionId: 's-trace', owner: 'provider-native', depth: 1, ...record(3) },
      { id: 'rel-2', treeId: 't1', parentSessionId: 's-notify', childSessionId: 's-dedupe', owner: 'provider-native', depth: 1, ...record(1) },
    ],
    turns: CONVERSATIONS.filter((spec) => spec.turns).map((spec) => ({
      id: `turn-${spec.id}`, sessionId: spec.id, state: spec.state === 'working' ? 'working' : 'completed',
      ...(spec.state === 'working' ? {} : { finishedAt: at(spec.minutesAgo) }), ...record(spec.minutesAgo),
    })) as unknown as DaemonSnapshot['turns'],
    transcriptHeads: [], approvals, providers: [], schedules: [], heartbeats: [],
  };
}

/** The EZTerminal project's flow: "Login improvements" at its approval stage (run #4). */
export function shellWorkflow(scenario: 'awaiting-approval' | 'completed' | 'retry-running' = 'awaiting-approval'): WorkflowSnapshot {
  const base = workflowFixture();
  const { graph, run } = workflowCanvasFixture(scenario);
  const earlier = workflowCanvasFixture('completed').run!;
  const runs = [1, 2, 3].map((n) => ({ ...earlier, runId: `run-login-${n}`, createdAt: at(60 * 24 * (5 - n)) }));
  return {
    ...base, projectId: 'p-ez',
    subprojects: [{ ...base.subprojects[0]!, id: 'login', title: '로그인 개선', graph }],
    runs: [...runs, { ...run!, createdAt: at(30) }],
  };
}
