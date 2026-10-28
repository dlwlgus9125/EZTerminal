import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import type { ChatAgentPhaseMap, ChatAgentProfile, ChatAgentProfileAccess } from '../../shared/chat-agent-profiles';
import type { DaemonTranscriptItem } from '../../shared/daemon-protocol';
import type { WorkflowRepeat, WorkflowRepeatStatus } from '../../shared/workflow';
import { validateWorkflowGraph, type WorkflowIssue, type WorkflowNode } from '../../shared/workflow-graph';
import { WorkflowCheckConsent } from '../workflow/WorkflowCheckConsent';
import { SettingsChangeTrack } from '../chat/SettingsChangeTrack';
import { AppI18nProvider } from '../i18n';
import { shellSnapshot } from '../shell/shell-fixtures';
import { KO_CAPABILITIES, SettingsFixture } from '../shell/tool-screen-fixtures';
import { DesktopUiPreferencesProvider } from '../ui-preferences';
import { SidebarShell } from '../workbench/SidebarShell';
import '../workbench/workbench.css';
import '../shell/shell.css';
import { StructuredAgentSessionPanel, type StructuredAgentSessionPanelProps } from '../StructuredAgentSession';
import { ActionSheet } from '../ui';
import type { WorkflowPanelSection } from '../workflow/workflow-canvas-model';
import type { CanvasSelection, WorkflowCanvasRendererProps } from '../workflow/workflow-canvas-types';
import { useWorkflowCopy } from '../workflow/workflow-copy';
import { WorkflowAgentList } from '../workflow/WorkflowAgentList';
import { WorkflowAnswerBox } from '../workflow/WorkflowAnswerBox';
import { WorkflowFlowCanvas } from '../workflow/WorkflowFlowCanvas';
import { WorkflowFlowSurface } from '../workflow/WorkflowFlowSurface';
import { WorkflowStageAgent } from '../workflow/WorkflowStageAgent';
import { WorkflowStaticGraph } from '../workflow/WorkflowStaticGraph';
import { WorkflowTemplatePicker, WorkflowTemplateSave } from '../workflow/WorkflowTemplateDialog';
import { CHAIN_HINTS, CHECK_DECORATIONS, CHECK_GRAPH, HARNESS_GRAPH, HARNESS_PHASES, HARNESS_PROFILES, HARNESS_TEMPLATES, STORY_EFFORTS, STORY_PERMISSIONS, STORY_REVIEWS, harnessAgents, harnessDecorations, harnessRun } from './harness-fixtures';
import '../index.css';
import '../structured-agent.css';
import '../workflow/workflow.css';
import '../mobile-shared.css';
import '../../../mobile/src/mobile.css';
import '../../../mobile/src/workbench.css';
import '../../../mobile/src/mobile-shell.css';
import '../workbench/phone-screens.css';

/**
 * 시안 (2026-10, Phase B): 워크플로 하네스 — agents in Settings with 단계 연결, queued settings in the input box,
 * agents placed on workflow stages (drag or 배정) with 이어서 chains, templates, checks, an answer stage, and
 * settings changed from a conversation. Production components; the new pieces are presentational and not
 * wired into the app yet (that waits for the person's approval of this mockup).
 */
const meta = {
  title: 'Production/Harness/Mockup',
  parameters: { layout: 'fullscreen', a11y: { test: 'error' } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const NOW = '2026-10-28T09:30:00.000Z';
function item(id: string, sequence: number, kind: DaemonTranscriptItem['kind'], text: string, overrides: Partial<DaemonTranscriptItem> = {}): DaemonTranscriptItem {
  return { id, sessionId: 'harness-chat', turnId: `turn-${Math.ceil(sequence / 2)}`, sequence, kind, text, isDelta: false, isSensitive: false, createdAt: NOW, ...overrides };
}

function Desk({ children, width, height }: { readonly children: ReactNode; readonly width?: number; readonly height?: number }): JSX.Element {
  return <AppI18nProvider locale="ko" languages={['ko']}>
    <div style={{ width: width ? `min(${width}px, 100vw)` : '100vw', height: height ? `min(${height}px, 100vh)` : '100vh', boxSizing: 'border-box', padding: 12, overflow: 'hidden' }}>{children}</div>
  </AppI18nProvider>;
}

// ── 1. Settings › AI: 에이전트 + 단계 연결 ───────────────────────────────────────────────────────────────
function storyProfilesAccess(): ChatAgentProfileAccess {
  let profiles: readonly ChatAgentProfile[] = HARNESS_PROFILES;
  let phases: ChatAgentPhaseMap = HARNESS_PHASES;
  return {
    list: async () => profiles,
    save: async profile => { profiles = [...profiles.filter(entry => entry.id !== profile.id), profile]; return { ok: true, profiles }; },
    remove: async id => { profiles = profiles.filter(entry => entry.id !== id); return { ok: true, profiles }; },
    phases: async () => phases,
    savePhases: async next => { phases = next; return { ok: true, phases }; },
  };
}
/** The settings screen reads the profiles from the desktop bridge; the story lends it one for this render. */
function WithProfiles({ children }: { readonly children: ReactNode }): JSX.Element {
  const [access] = useState(() => {
    const value = storyProfilesAccess();
    const host = window as unknown as { ezterminal?: Record<string, unknown> };
    host.ezterminal = { ...(host.ezterminal ?? {}), chatAgentProfiles: value };
    return value;
  });
  // Strict mode runs the cleanup once between two mounts: set it again on every mount.
  useEffect(() => {
    const host = window as unknown as { ezterminal?: Record<string, unknown> };
    host.ezterminal = { ...(host.ezterminal ?? {}), chatAgentProfiles: access };
    return () => { if (host.ezterminal) delete host.ezterminal.chatAgentProfiles; };
  }, [access]);
  return <>{children}</>;
}
/** The settings fixture with a host snapshot, so the AI names resolve and no "runtime unavailable" shows. */
const SETTINGS_CAPABILITIES = { ...KO_CAPABILITIES, daemon: { ...KO_CAPABILITIES.daemon, getSnapshot: async () => shellSnapshot() } } as typeof KO_CAPABILITIES;

/** 설정 › AI: agents (who: AI · model · effort · permission · when to use) and which one each phase uses. */
export const SettingsAgents: Story = {
  render: () => <Desk>
    <DesktopUiPreferencesProvider capabilities={KO_CAPABILITIES}>
      <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
        <SidebarShell destination="settings" title="설정" width={420} overlayBelow={0} onClose={() => undefined} onWidthChange={() => undefined}>
          <WithProfiles><SettingsFixture requestedCategory="agents" capabilities={SETTINGS_CAPABILITIES} /></WithProfiles>
        </SidebarShell>
        <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex' }}>
          <StructuredAgentSessionPanel {...chatBase} state="working" items={approvedItems} reasoningEffort="medium" queueSettings />
        </div>
      </div>
    </DesktopUiPreferencesProvider>
  </Desk>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByTestId('agent-phase-settings')).toBeVisible(), { timeout: 10_000 });
    canvas.getByTestId('agent-phase-settings').scrollIntoView({ block: 'center' });
  },
};

// ── 2. Input box: queued settings, effort scope, phase switch ───────────────────────────────────────────
const chatBase: StructuredAgentSessionPanelProps = {
  sessionId: 'harness-chat', title: '로그인 오류 안내 개선', providerId: 'claude', providerLabel: 'Claude',
  workspace: { id: 'ws-ez', label: 'EZTerminal', kind: 'local', path: 'C:\\Working\\EZTerminal' },
  model: 'claude-opus-5-5', modelOptions: [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }, { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }],
  permissionPreset: 'standard', state: 'idle', queuedCount: 0, items: [], effortSupported: true, reasoningEffort: 'high',
  folders: { primary: 'C:\\Working\\EZTerminal', additional: [], missing: [] }, onCancel: fn(async () => ({ ok: true as const })),
  usage: { fiveHour: { usedPercent: 24 }, weekly: { usedPercent: 21 }, limitsObservedAt: Date.parse(NOW), contextPercent: 38, contextObservedAt: Date.parse(NOW) },
  onSend: fn(async () => ({ ok: true as const })), onInterruptAndSend: fn(async () => ({ ok: true as const })),
  onChangeSettings: fn(async () => ({ ok: true as const })), onResolveApproval: fn(async () => ({ ok: true as const })),
};
/** A turn the person started; while it runs they pick a lower effort for the next request (queued). */
const workingItems: readonly DaemonTranscriptItem[] = [
  item('u1', 1, 'user-message', '로그인 오류 안내를 구현해 줘. 테스트도 같이 고쳐 줘.'),
  item('a1', 2, 'assistant-message', 'src/login/LoginForm.tsx의 오류 분기부터 바꾸겠습니다. 잠금 안내 문구는 계획의 3번 항목을 따릅니다…'),
];
/** After the plan was approved: the host applied the implement agent of this AI (단계 연결) and says so. */
const approvedItems: readonly DaemonTranscriptItem[] = [
  item('p0', 1, 'user-message', '계획대로 실행'),
  item('n1', 2, 'notice', '계획 승인 → Claude 구현 설정 적용: 노력 높음 → 보통 · 권한 승인 후 실행 (설정 › AI › 단계 연결)'),
  item('a1', 3, 'assistant-message', 'src/login/LoginForm.tsx의 오류 분기부터 바꾸겠습니다. 잠금 안내 문구는 계획의 3번 항목을 따릅니다…'),
];
/** A Codex plan waiting for approval: the dock says which agent runs it. */
const planItems: readonly DaemonTranscriptItem[] = [
  item('q1', 1, 'user-message', '로그인 실패 잠금 기능 계획을 세워 줘.', { turnId: 'turn-plan' }),
  item('q2', 2, 'reasoning', '- 5회 실패 후 10분 잠금', { turnId: 'turn-plan', payload: { v: 1, type: 'plan', markdown: '1. LoginForm에 실패 횟수 표시\n2. 5회 실패 후 10분 잠금 (서버 응답 423)\n3. 잠금 안내 문구와 남은 시간\n4. 단위 테스트 6개 추가' } }),
];
function Chat({ props, width = 1100, height = 760, mobile = false }: { readonly props: Partial<StructuredAgentSessionPanelProps>; readonly width?: number; readonly height?: number; readonly mobile?: boolean }): JSX.Element {
  const [scope, setScope] = useState<'once' | 'keep'>('once');
  const content = <StructuredAgentSessionPanel {...chatBase} {...props} {...(props.effortScope ? { effortScope: { value: scope, onChange: setScope } } : {})} {...(mobile ? { variant: 'mobile' as const, compactHeader: true } : {})} />;
  if (mobile) return <Phone>{content}</Phone>;
  return <Desk width={width + 24} height={height + 24}><div style={{ width: '100%', height: '100%' }}>{content}</div></Desk>;
}

/** While a turn runs, changes are queued: the line says what this turn uses and what the next request will use. */
export const ComposerQueued: Story = {
  render: () => <Chat props={{ state: 'working', items: workingItems, queueSettings: true, reasoningEffort: 'medium', pendingSettings: { current: 'Opus 5.5 · 높음', next: 'Opus 5.5 · 보통 · 이후 계속', onCancel: fn() }, effortScope: { value: 'keep', onChange: fn() } }} />,
};
/** Plan approval: the dock says which agent of this AI runs the approved plan (단계 연결), before the person presses it. */
export const ComposerPlanApproval: Story = {
  render: () => <Chat props={{ providerId: 'codex', providerLabel: 'Codex', model: 'gpt-6-astra', modelOptions: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra' }], reasoningEffort: 'xhigh', permissionPreset: 'plan', items: planItems,
    turns: [{ id: 'turn-plan', sessionId: 'harness-chat', commandId: 'command-plan', state: 'completed', revision: 2, createdAt: NOW, updatedAt: NOW }],
    planPhaseNote: "구현은 '구현 담당'(Codex · GPT-6-Astra · 보통 · 승인 후 실행)으로 시작합니다 · 설정 › AI › 단계 연결" }} />,
};
/** The effort menu picks the level (it closes on a pick); the queued line then says for how long: 다음 요청 1회만 / 이후 계속. */
export const ComposerEffortScope: Story = {
  render: () => <Chat props={{ state: 'working', items: workingItems, queueSettings: true, reasoningEffort: 'medium', pendingSettings: { current: 'Opus 5.5 · 높음', next: 'Opus 5.5 · 보통', onCancel: fn() }, effortScope: { value: 'once', onChange: fn() } }} />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('radio', { name: '다음 요청 1회만' })).toBeChecked();
    await userEvent.click(within(canvasElement).getByTestId('structured-agent-live-effort'));
    await waitFor(() => expect(within(document.body).getByRole('menuitemradio', { name: '보통' })).toBeVisible());
  },
};

// ── 3. Workflow canvas: agents placed on stages ─────────────────────────────────────────────────────────
const PROVIDERS = [{ id: 'codex', label: 'Codex', models: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra' }] }, { id: 'claude', label: 'Claude', models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }] }];
interface CanvasProps {
  readonly select?: string;
  readonly agentsOpen?: boolean;
  readonly dragging?: string;
  readonly dropOn?: string;
  readonly implementWithoutAgent?: boolean;
  readonly missingOn?: string;
  readonly answerWaiting?: boolean;
  readonly approvalWaiting?: boolean;
  /** Overlay a run stopped where the person is needed. */
  readonly run?: 'answer' | 'approval';
  readonly extraIssues?: readonly WorkflowIssue[];
  readonly repeat?: { readonly value: WorkflowRepeat; readonly status?: WorkflowRepeatStatus; readonly note?: ReactNode };
  readonly panelOpen?: boolean;
  readonly mobile?: boolean;
  readonly sheet?: boolean;
  /** The 정기 점검 template instead of 개발 절차. */
  readonly periodic?: boolean;
  readonly slot?: (node: WorkflowNode) => { readonly settings?: ReactNode; readonly top?: ReactNode; readonly kindLabel?: string; readonly instructionsLabel?: string; readonly conversationHint?: string; readonly statusLabel?: string } | undefined;
}
function Canvas({ select, agentsOpen = true, dragging, dropOn, implementWithoutAgent, missingOn, answerWaiting, approvalWaiting, run, extraIssues = [], repeat, panelOpen = true, mobile = false, sheet = false, periodic = false, slot }: CanvasProps): JSX.Element {
  const text = useWorkflowCopy();
  const runs = useMemo(() => run ? [harnessRun(run)] : [], [run]);
  const graph = periodic ? CHECK_GRAPH : HARNESS_GRAPH;
  const [selection, setSelection] = useState<CanvasSelection>(select ? { kind: 'node', id: `${periodic ? 'chk' : 'dev'}:${select}` } : null);
  const [section, setSection] = useState<WorkflowPanelSection>('settings');
  // Decision 15: a narrow window starts with the agent list folded.
  const [open, setOpen] = useState(() => agentsOpen && (typeof window === 'undefined' || window.innerWidth >= 1200));
  const [layout, setLayout] = useState<'graph' | 'list'>(mobile ? 'list' : 'graph');
  const decorations = useMemo(() => periodic ? CHECK_DECORATIONS : harnessDecorations({ dropOn, implementWithoutAgent, missingOn, answerWaiting, approvalWaiting }), [answerWaiting, approvalWaiting, dropOn, implementWithoutAgent, missingOn, periodic]);
  const issues = [...validateWorkflowGraph(graph, true), ...extraIssues];
  const selected = selection?.kind === 'node' ? graph.nodes.find(node => node.id === selection.id) : undefined;
  const Renderer: ComponentType<WorkflowCanvasRendererProps> = mobile ? WorkflowStaticGraph : WorkflowFlowCanvas;
  return <div className="workflow-workspace" data-mobile={mobile || undefined} style={{ width: '100%', height: '100%', boxSizing: 'border-box' }}>
    <WorkflowFlowSurface text={text} mobile={mobile} savedGraph={graph} draftGraph={null} revision={6} archivedNodes={[]} runs={runs}
      {...(run === 'answer' ? { awaitingLabel: (count: number) => `답변 대기 ${count}` } : {})}
      {...(repeat ? { repeatStatus: repeat.status, repeatNote: repeat.note } : {})}
      editLocked={false} commandsDisabled={false} issues={issues} providers={PROVIDERS as never}
      selection={selection} onSelectionChange={setSelection} section={section} onSectionChange={setSection} pickedRunId={null} onPickRun={fn()} runView={false} onRunViewChange={fn()}
      layout={layout} onLayoutChange={setLayout} onGraphChange={fn()} onSaveDraft={fn()} onDiscardDraft={fn()} onRunCommand={fn()}
      subproject={{ id: 'dev', status: 'active', autoApprove: false, runSettings: { reviewer: { providerId: 'codex', model: 'gpt-6-astra' } }, repeat: repeat?.value ?? { cadence: 'daily', time: '09:00', timezone: 'Asia/Seoul', enabled: false } }}
      onSaveRepeat={fn()}
      structure={false} onStructureChange={fn()} onLaunch={fn()} onSaveReviewer={fn()} onAutoApprove={fn()} stageLinks={() => []} canStartStageChat onStartStageChat={fn()} onOpenConversation={fn()}
      canvasRenderer={Renderer} panelOpen={panelOpen} onPanelOpenChange={fn()}
      decorations={decorations.nodes} edgeDecorations={decorations.edges}
      panelTop={mobile ? undefined : <WorkflowAgentList text={text} agents={harnessAgents({ 'agent-design': 3, 'agent-build': implementWithoutAgent ? 0 : 1, 'agent-review': 1 })} open={open} onOpenChange={setOpen}
        targetStage={selected?.title} dragging={dragging} onAssign={fn()} onManage={fn()} />}
      stageSlots={slot} />
    {mobile && <ActionSheet open={sheet} onOpenChange={fn()} title={text('에이전트 배정', 'Assign an agent')} closeLabel={text('닫기', 'Close')}>
      <WorkflowAgentList text={text} variant="sheet" agents={harnessAgents()} open onOpenChange={fn()} targetStage={selected?.title} onAssign={fn()} />
    </ActionSheet>}
  </div>;
}
function DeskCanvas(props: CanvasProps): JSX.Element { return <Desk><Canvas {...props} /></Desk>; }

const stageAgent = (overrides: Partial<Parameters<typeof WorkflowStageAgent>[0]> = {}) => (node: WorkflowNode) => node.operation !== 'agent' ? undefined : {
  ...(CHAIN_HINTS[node.id] ? { conversationHint: CHAIN_HINTS[node.id] } : {}),
  settings: <WorkflowStageAgent text={(ko: string) => ko} disabled={false}
    agent={{ name: '설계 담당', detail: 'Claude · Opus 5.5 · 승인 후 실행', tone: 'claude', effortLabel: '높음', permissionLabel: '승인 후 실행' }}
    session={{ value: 'continue', from: '계획' }} effort={{ value: 'medium', options: STORY_EFFORTS }}
    permission={{ value: 'standard', options: STORY_PERMISSIONS, note: '바꿀 수 있는 경로: src/renderer/' }}
    checks={[]} review={{ value: 'run', options: STORY_REVIEWS }} onChange={fn()} onReplace={fn()} onRemove={fn()} onConfirmCheck={fn()} onAddCheck={fn()} {...overrides} />,
};

/** The canvas: agents from Settings at the top of the side panel; 설계 담당 runs 요구 정리 → 계획 → 시안 in one conversation. */
export const CanvasAgents: Story = { render: () => <DeskCanvas select="mock" slot={stageAgent()} /> };
/** Dragging 구현 담당 from the list onto 구현: the stage shows where it will land. */
export const CanvasDragging: Story = { render: () => <DeskCanvas select="implement" dragging="agent-build" dropOn="dev:implement" implementWithoutAgent slot={stageAgent({ agent: undefined, session: { value: 'fresh', reason: '앞 단계(시안 승인)와 에이전트가 다릅니다. 새 대화로 시작합니다.' } })} /> };
/** A check command decides pass or fail; a new or changed command waits until a person allows it once. */
export const CanvasChecks: Story = {
  render: () => <DeskCanvas select="implement" agentsOpen={false} slot={stageAgent({
    agent: { name: '구현 담당', detail: 'Codex · GPT-6-Astra · 승인 후 실행', tone: 'codex', effortLabel: '보통', permissionLabel: '승인 후 실행' },
    session: { value: 'fresh', reason: '앞 단계가 사람 승인이고 에이전트가 달라 새 대화로 시작합니다.' }, effort: { value: '', options: STORY_EFFORTS.map(option => option.value === '' ? { ...option, label: '기본 (보통)' } : option) },
    permission: { value: 'standard', options: STORY_PERMISSIONS, note: '바꿀 수 있는 경로: src/, test/' },
    checks: [{ id: 'c1', command: 'pnpm test', consent: 'confirmed' }, { id: 'c2', command: 'pnpm typecheck', consent: 'needed' }],
    review: { value: 'off', options: STORY_REVIEWS, note: '검토를 끄면 확인 명령이 모두 통과해야 다음으로 갑니다. 명령이 없으면 뒤에 사람 확인 단계가 있어야 하고, 그 확인은 자동 승인으로 넘어가지 않습니다.' },
  })} />,
};
/** A stage that waits for the person's answer (amber): no AI runs; the answer goes to 계획 in the same conversation. */
export const CanvasAnswer: Story = {
  render: () => <DeskCanvas select="answer" agentsOpen={false} answerWaiting run="answer" slot={node => node.id === 'dev:answer' ? { top: <AnswerDemo />, kindLabel: '답변 기다림', instructionsLabel: '물어볼 내용', statusLabel: '답변 대기 · 조치 필요' } : undefined} />,
};
function AnswerDemo(): JSX.Element {
  const text = useWorkflowCopy();
  const [value, setValue] = useState('잠금은 5회 실패 후 10분. 관리자 해제는 이번 범위 밖입니다.');
  return <WorkflowAnswerBox text={text} from="요구 정리" value={value} onChange={setValue} onSend={fn()} onOpenResult={fn()}
    question={'1. 로그인을 몇 번 틀리면 잠글까요? (지금은 잠금 없음)\n2. 잠금을 관리자가 풀 수 있어야 하나요?'} />;
}
/** Approval with a comment: 승인, or send it back to 시안 with what to change (the same conversation redoes it). */
export const CanvasApproval: Story = {
  render: () => <DeskCanvas select="approval" agentsOpen={false} approvalWaiting run="approval" slot={node => node.id === 'dev:approval' ? { top: <ApprovalDemo />, kindLabel: '사람 승인 · 의견', instructionsLabel: '승인할 내용', statusLabel: '승인 대기 · 의견 가능' } : undefined} />,
};
function ApprovalDemo(): JSX.Element {
  const text = useWorkflowCopy();
  const [value, setValue] = useState('잠금 안내 문구에 남은 시간(분)을 함께 보여 주세요.');
  return <WorkflowAnswerBox text={text} from="교차 검토" value={value} onChange={setValue} onOpenResult={fn()} decision={{ returnsTo: '시안', onApprove: fn(), onReturn: fn() }}
    question={'검토를 거친 시안으로 구현해도 될까요? 교차 검토 의견 2건은 반영됐습니다.'} />;
}
/** A workflow from a cloned repository names an agent this PC does not have: readable, but it will not run until reassigned. */
export const CanvasMissingAgent: Story = {
  render: () => <DeskCanvas select="implement" missingOn="dev:implement" extraIssues={[{ code: 'missing-agent', message: '이 PC에 없는 에이전트입니다. 다시 배정하세요.', nodeId: 'dev:implement' }]} slot={stageAgent({ agent: { name: '구현 담당', detail: '', tone: 'codex', missing: true, permissionLabel: '승인 후 실행' }, session: { value: 'fresh', reason: '에이전트를 다시 배정하면 정할 수 있습니다.' } })} />,
};

// ── 4. Templates ────────────────────────────────────────────────────────────────────────────────────────
function Templates({ save = false }: { readonly save?: boolean }): JSX.Element {
  return <Desk><TemplatesInner save={save} /></Desk>;
}
function TemplatesInner({ save }: { readonly save: boolean }): JSX.Element {
  const text = useWorkflowCopy();
  const [selected, setSelected] = useState('tpl-dev');
  const [name, setName] = useState(save ? '개발 절차 (EZTerminal)' : '로그인 오류 안내 개선');
  const [description, setDescription] = useState('설계 담당이 이어서 계획·시안, 구현 후 pnpm test');
  const [keep, setKeep] = useState(true);
  return <><Canvas agentsOpen={false} />
    {save
      ? <WorkflowTemplateSave text={text} open name={name} description={description} keepAgents={keep} onNameChange={setName} onDescriptionChange={setDescription} onKeepAgentsChange={setKeep} onSave={fn()} onClose={fn()} />
      : <WorkflowTemplatePicker text={text} open templates={HARNESS_TEMPLATES} selected={selected} name={name} onSelect={setSelected} onNameChange={setName} onCreate={fn()} onClose={fn()} />}
  </>;
}
/** 새 워크플로: the two built-in templates and one saved here, each with its stages and what it needs. */
export const TemplatePicker: Story = { render: () => <Templates /> };
/** ⋯ › 템플릿으로 저장: stages, instructions and checks — and optionally the agents placed on them. */
export const TemplateSave: Story = { render: () => <Templates save /> };

// ── 5. Settings changed from a conversation ─────────────────────────────────────────────────────────────
const settingsItems: readonly DaemonTranscriptItem[] = [
  item('s-u1', 1, 'user-message', '스캔라인 효과는 끄고, 검토만 하는 Codex 에이전트 하나 만들어 줘. 구현 담당은 전체 권한으로 바꾸고, 폰에서도 쓰게 원격 접속도 켜 줘.'),
  item('s-a1', 2, 'assistant-message', '스캔라인 효과를 끄고 에이전트 "교차 검토"(Codex · GPT-6-Astra · 매우 높음 · 계획만)를 만들었습니다. 되돌리려면 아래에서 누르세요.\n\n구현 담당의 권한을 올리는 것과 원격 접속은 제가 직접 바꿀 수 없어 제안으로 올렸습니다. 확인 후 적용해 주세요.'),
];
const track = (onPhone = false) => <SettingsChangeTrack ko onPhone={onPhone} onUndo={fn()} onApply={fn()} onDecline={fn()} onOpenSettings={fn()}
  changes={[{ id: 'ch1', label: '화면 효과: 스캔라인 켬 → 끔', at: '09:31' }, { id: 'ch2', label: '에이전트 추가: 교차 검토 (Codex · 매우 높음 · 계획만)', at: '09:31' }]}
  proposals={[{ id: 'p0', title: '에이전트 "구현 담당" 권한 올리기', rows: [{ name: '권한', before: '승인 후 실행', after: '전체 권한' }], risk: '에이전트를 고치는 일이지만 권한을 올리는 변경이라 제안으로만 올라옵니다. 워크플로 단계에서는 전체 권한이 승인 후 실행으로 낮춰집니다.' },
    { id: 'p1', title: '원격 접속 켜기', desktopOnly: true, rows: [{ name: '원격 접속', before: '끔', after: '켬 (Tailscale 100.64.0.10)' }],
    risk: '켜면 페어링한 폰이 이 PC의 터미널과 대화를 조작할 수 있습니다. 페어링 코드는 따로 확인합니다.' }]} />;
/** The AI changed two settings directly (with 되돌리기) and could only propose remote access (a person applies it). */
export const ChatSettingsChange: Story = { render: () => <Chat props={{ items: settingsItems, settingsTrack: track() }} /> };

// ── 6. Phone ────────────────────────────────────────────────────────────────────────────────────────────
function Phone({ children }: { readonly children: ReactNode }): JSX.Element {
  return <AppI18nProvider locale="ko" languages={['ko']}><div className="phone-i4-frame mobile-workbench-coordinator" data-testid="phone-harness-frame">{children}</div></AppI18nProvider>;
}
/** Phone: no dragging — 배정 opens this sheet for the selected stage. */
export const PhoneAssignSheet: Story = {
  parameters: { layout: 'centered' },
  render: () => <Phone><Canvas mobile sheet select="implement" implementWithoutAgent /></Phone>,
};
/** Phone: the stage panel's 에이전트 배정 opens the sheet (no dragging on a phone). */
export const PhoneStageAssign: Story = {
  parameters: { layout: 'centered' },
  render: () => <Phone><Canvas mobile select="implement" implementWithoutAgent slot={stageAgent({ agent: undefined, onAssign: fn(), session: { value: 'fresh', reason: '에이전트를 배정하면 정할 수 있습니다.' } })} /></Phone>,
  play: async ({ canvasElement }) => {
    const target = await within(canvasElement).findByTestId('workflow-stage-agent');
    target.scrollIntoView({ block: 'start' });
  },
};
/** Phone: the same queued line in the conversation's input box. */
export const PhoneComposerQueued: Story = {
  parameters: { layout: 'centered' },
  render: () => <Chat mobile props={{ state: 'working', items: workingItems, queueSettings: true, reasoningEffort: 'medium', pendingSettings: { current: '높음', next: '보통 · 승인 후 실행', onCancel: fn() } }} />,
};
/** Phone: the AI's settings changes; a PC-only proposal is shown but applied from the PC. */
export const PhoneSettingsChange: Story = {
  parameters: { layout: 'centered' },
  render: () => <Chat mobile props={{ items: settingsItems, settingsTrack: track(true) }} />,
};

// ── 7. Review round (Codex · advisor): states the first pictures did not show ──────────────────────────────
/** Claude: the approval continues the same turn, so this implementation keeps the current settings and the implement agent applies from the next request (until probe 2 shows the turn can be split). */
export const ComposerPlanApprovalClaude: Story = {
  render: () => <Chat props={{ reasoningEffort: 'high', permissionPreset: 'plan', items: planItems,
    turns: [{ id: 'turn-plan', sessionId: 'harness-chat', commandId: 'command-plan', state: 'completed', revision: 2, createdAt: NOW, updatedAt: NOW }],
    planPhaseNote: "Claude는 승인 뒤 같은 차례로 이어집니다. 이번 구현은 지금 설정(Opus 5.5 · 높음)으로 하고, 다음 요청부터 'Claude 구현'(보통)을 씁니다" }} />,
};
/** 확인하고 허용: exactly what runs, where, and why it is asked again (here: the stage changed the script the command calls). */
export const CanvasCheckConsent: Story = {
  render: () => <Desk><Canvas select="implement" agentsOpen={false} slot={stageAgent({
    agent: { name: '구현 담당', detail: 'Codex · GPT-6-Astra · 승인 후 실행', tone: 'codex', effortLabel: '보통', permissionLabel: '승인 후 실행' },
    session: { value: 'fresh', reason: '앞 단계가 사람 승인이고 에이전트가 달라 새 대화로 시작합니다.' },
    checks: [{ id: 'c1', command: 'pnpm test', consent: 'confirmed' }, { id: 'c2', command: 'pnpm typecheck', consent: 'needed' }],
    review: { value: 'off', options: STORY_REVIEWS, note: '검토를 끄면 확인 명령이 모두 통과해야 다음으로 갑니다. 명령이 없으면 뒤에 사람 확인 단계가 있어야 하고, 그 확인은 자동 승인으로 넘어가지 않습니다.' },
  })} />
    <ConsentDemo />
  </Desk>,
};
function ConsentDemo(): JSX.Element {
  const text = useWorkflowCopy();
  return <WorkflowCheckConsent text={text} open command="pnpm typecheck" location="<작업 폴더>\.ezterminal\runs\run-dev-1\구현 (이 단계의 결과)" reason="script-changed"
    resolved={{ label: 'package.json의 typecheck', value: 'tsc --noEmit && pnpm typecheck:mobile-e2e' }} before="tsc --noEmit" onAllow={fn()} onClose={fn()} />;
}
/** 정기 점검 with 반복: the schedule runs the confirmed v6 while the edited v7 waits for a look; an unchanged result skipped the AI summary. */
export const CanvasRepeat: Story = {
  render: () => <DeskCanvas periodic select="sum" agentsOpen={false} slot={stageAgent({
    agent: { name: '빠른 조사', detail: 'Claude · Sonnet 5.5 · 계획만', tone: 'claude', effortLabel: '낮음', permissionLabel: '계획만' },
    session: { value: 'continue', from: '의존성·테스트 확인' }, effort: { value: '', options: STORY_EFFORTS.map(option => option.value === '' ? { ...option, label: '기본 (낮음)' } : option) },
    permission: { value: 'plan', options: STORY_PERMISSIONS }, checks: [],
    review: { value: 'off', options: STORY_REVIEWS, note: '요약은 검토 끔. 확인 명령 결과가 지난번과 같으면 이 단계는 건너뜁니다. 뒤의 결과 확인은 사람이 합니다(자동 승인으로 넘어가지 않음).' },
  })} repeat={{
    value: { cadence: 'daily', time: '09:00', timezone: 'Asia/Seoul', enabled: true },
    status: { nextAt: '2026-10-30T00:00:00.000Z' },
    note: <RepeatNote />,
  }} />,
};
function RepeatNote(): JSX.Element {
  return <div className="workflow-repeat-note" role="status">
    <p><strong>예약 실행은 v6(확인한 버전)으로 돕니다.</strong> 편집본 v7은 아직 확인하지 않아 예약에 쓰지 않습니다.</p>
    <p className="workflow-repeat-note__actions"><button type="button">v7로 다시 확인</button><button type="button">v6 보기</button><button type="button">바뀐 점 비교</button></p>
    <p>마지막 실행 10/29 09:00 · 확인 명령 결과가 지난번과 같아 <strong>AI 요약을 건너뜀</strong> · <button type="button">검사 결과 보기</button> (명령이 실패하거나 시간 초과면 건너뛰지 않습니다)</p>
  </div>;
}
/** A narrow window (1024 · 150%): the stage panel starts folded so the canvas keeps readable cards; selecting a stage opens it. */
export const CanvasNarrow: Story = { render: () => <DeskCanvas agentsOpen={false} panelOpen={false} /> };
/** The AI's changes over time: undo refused after a later change (shows the difference instead), a proposal resolved on the phone, an expired one. */
export const ChatSettingsStates: Story = {
  render: () => <Chat props={{ items: settingsItems, settingsTrack: <SettingsChangeTrack ko onUndo={fn()} onShowDiff={fn()} onApply={fn()} onDecline={fn()}
    changes={[{ id: 'ch1', label: '화면 효과: 스캔라인 켬 → 끔', at: '09:31', conflict: true }, { id: 'ch2', label: '에이전트 추가: 교차 검토', at: '09:31', undone: true }]}
    proposals={[
      { id: 'p1', title: '원격 접속 켜기', desktopOnly: true, state: 'resolved-elsewhere', detail: 'PC에서 09:40에 적용', rows: [{ name: '원격 접속', before: '끔', after: '켬' }], risk: '페어링한 폰이 이 PC를 조작할 수 있습니다.' },
      { id: 'p2', title: '반복 켜기 · 정기 점검 매일 09:00', state: 'expired', rows: [{ name: '반복', before: '끔', after: '매일 09:00' }], risk: '자동으로 실행이 시작됩니다.' },
    ]} /> }} />,
};
/** A new phone on a PC that does not know agents yet (older EZTerminal): no 배정, it says why and keeps today's AI · 모델 fields. */
export const PhoneOldHost: Story = {
  parameters: { layout: 'centered' },
  render: () => <Phone><Canvas mobile select="implement" implementWithoutAgent slot={() => ({ top: <p className="workflow-notice" role="status">이 PC의 EZTerminal은 아직 에이전트 배정을 모릅니다. PC를 업데이트하면 단계에 에이전트를 놓을 수 있습니다. 지금은 단계마다 AI·모델을 고릅니다.</p> })} /></Phone>,
  play: async ({ canvasElement }) => {
    const target = await within(canvasElement).findByTestId('workflow-stage-panel');
    target.scrollIntoView({ block: 'start' });
  },
};