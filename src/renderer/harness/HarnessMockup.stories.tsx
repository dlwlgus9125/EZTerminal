import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import type { ChatAgentPhaseMap, ChatAgentProfile, ChatAgentProfileAccess } from '../../shared/chat-agent-profiles';
import type { DaemonTranscriptItem } from '../../shared/daemon-protocol';
import type { WorkflowRepeat, WorkflowRepeatStatus } from '../../shared/workflow';
import type { WorkflowCheckStatus } from '../../shared/workflow-checks';
import { validateWorkflowGraph, type WorkflowGraph } from '../../shared/workflow-graph';
import { SettingsChangeTrack } from '../chat/SettingsChangeTrack';
import { AppI18nProvider } from '../i18n';
import { shellSnapshot } from '../shell/shell-fixtures';
import { KO_CAPABILITIES, SettingsFixture } from '../shell/tool-screen-fixtures';
import { DesktopUiPreferencesProvider } from '../ui-preferences';
import { SidebarShell } from '../workbench/SidebarShell';
import '../workbench/workbench.css';
import '../shell/shell.css';
import { StructuredAgentSessionPanel, type StructuredAgentSessionPanelProps } from '../StructuredAgentSession';
import type { WorkflowPanelSection } from '../workflow/workflow-canvas-model';
import type { CanvasSelection, WorkflowCanvasRendererProps } from '../workflow/workflow-canvas-types';
import { useWorkflowCopy } from '../workflow/workflow-copy';
import { useWorkflowHarness } from '../workflow/use-workflow-harness';
import { WorkflowFlowCanvas } from '../workflow/WorkflowFlowCanvas';
import { WorkflowFlowSurface } from '../workflow/WorkflowFlowSurface';
import { WorkflowRepeatPinned } from '../workflow/WorkflowRunBar';
import { WorkflowStaticGraph } from '../workflow/WorkflowStaticGraph';
import { WorkflowTemplatePicker, WorkflowTemplateSave } from '../workflow/WorkflowTemplateDialog';
import {
  CHECK_GRAPH, HARNESS_CATALOGS, HARNESS_CHECK_STATUSES, HARNESS_GRAPH, HARNESS_PHASES, HARNESS_PROFILES, HARNESS_PROVIDERS, HARNESS_TEMPLATES,
  harnessCheckAccess, harnessGraph, harnessProfileAccess, harnessRun, harnessSubproject,
} from './harness-fixtures';
import '../index.css';
import '../structured-agent.css';
import '../workflow/workflow.css';
import '../mobile-shared.css';
import '../../../mobile/src/mobile.css';
import '../../../mobile/src/workbench.css';
import '../../../mobile/src/mobile-shell.css';
import '../workbench/phone-screens.css';

/**
 * 시안 (2026-10, Phase B, approved): 워크플로 하네스 — agents in Settings with 단계 연결, queued settings in the input box,
 * agents placed on workflow stages (drag or 배정) with 이어서 chains, templates, checks, an answer stage, and
 * settings changed from a conversation. The canvas stories now run the app's own wiring (useWorkflowHarness) on
 * v18 workflows, so what they show is what the flow screen does.
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

// ── 3. Workflow canvas: agents placed on stages (the app's wiring) ────────────────────────────────────
interface CanvasProps {
  /** The selected stage (its key without the flow prefix). */
  readonly select?: string;
  readonly graph?: WorkflowGraph;
  /** Overlay a run stopped where the person is needed (or, for 정기 점검, after a skipped summary). */
  readonly run?: 'answer' | 'approval' | 'skipped';
  readonly agentsOpen?: boolean;
  readonly panelOpen?: boolean;
  readonly profiles?: readonly ChatAgentProfile[];
  readonly statuses?: readonly WorkflowCheckStatus[];
  readonly repeat?: { readonly value: WorkflowRepeat; readonly status?: WorkflowRepeatStatus; readonly pinned?: number };
  /** Centre this stage once (a story that drags onto it). */
  readonly reveal?: string;
  readonly mobile?: boolean;
  /** The phone's PC is older (or has no agents): no catalog comes with the flow. */
  readonly noCatalog?: boolean;
}
function Canvas({ select, graph: saved = HARNESS_GRAPH, run, agentsOpen: initialAgentsOpen = true, panelOpen = true, profiles = HARNESS_PROFILES, statuses = HARNESS_CHECK_STATUSES, repeat, reveal, mobile = false, noCatalog = false }: CanvasProps): JSX.Element {
  const text = useWorkflowCopy();
  const prefix = saved === CHECK_GRAPH ? 'chk' : 'dev';
  const subproject = useMemo(() => harnessSubproject(saved, repeat ? { repeat: repeat.value, revision: 7 } : {}), [saved, repeat]);
  const [draft, setDraft] = useState<WorkflowGraph | null>(null);
  const graph = draft ?? saved;
  const runs = useMemo(() => run ? [harnessRun(run)] : [], [run]);
  const [selection, setSelection] = useState<CanvasSelection>(select ? { kind: 'node', id: `${prefix}:${select}` } : null);
  const [section, setSection] = useState<WorkflowPanelSection>(run ? 'run' : 'settings');
  const [agentsOpen, setAgentsOpen] = useState(initialAgentsOpen);
  const [layout, setLayout] = useState<'graph' | 'list'>(mobile ? 'list' : 'graph');
  const [profileAccess] = useState(() => harnessProfileAccess(profiles));
  const [checkAccess] = useState(() => harnessCheckAccess(statuses));
  const [revealRequest, setRevealRequest] = useState(reveal ? { nodeId: `${prefix}:${reveal}`, key: reveal } : undefined);
  const harness = useWorkflowHarness({
    mobile, active: true, text, projectId: 'project-story', subproject, graph,
    ...(mobile ? (noCatalog ? {} : { catalog: profiles }) : { profileAccess, checkAccess }),
    providers: HARNESS_PROVIDERS, catalogs: HARNESS_CATALOGS, selectedNodeId: selection?.kind === 'node' ? selection.id : null, canEdit: () => true, commandsDisabled: false,
    agentsOpen, onAgentsOpenChange: setAgentsOpen, onGraphChange: setDraft, onRunCommand: fn(), onOpenAttemptResult: fn(),
  });
  const issues = validateWorkflowGraph(graph, true, harness.profileIds ? { profileIds: harness.profileIds } : {});
  const Renderer: ComponentType<WorkflowCanvasRendererProps> = mobile ? WorkflowStaticGraph : WorkflowFlowCanvas;
  return <div className="workflow-workspace" data-mobile={mobile || undefined} style={{ width: '100%', height: '100%', boxSizing: 'border-box' }}>
    <WorkflowFlowSurface text={text} mobile={mobile} savedGraph={saved} draftGraph={draft} revision={subproject.revision} archivedNodes={[]} runs={runs}
      editLocked={false} commandsDisabled={false} issues={issues} providers={HARNESS_PROVIDERS} catalogs={HARNESS_CATALOGS}
      selection={selection} onSelectionChange={setSelection} section={section} onSectionChange={setSection} pickedRunId={null} onPickRun={fn()} runView={false} onRunViewChange={fn()}
      layout={layout} onLayoutChange={setLayout} onGraphChange={setDraft} onSaveDraft={fn()} onDiscardDraft={() => setDraft(null)} onRunCommand={fn()}
      subproject={subproject} savedRunSettings {...(repeat ? { onSaveRepeat: fn(), repeatStatus: repeat.status } : {})}
      repeatNote={repeat?.pinned !== undefined ? <WorkflowRepeatPinned text={text} pinned={repeat.pinned} revision={subproject.revision} disabled={false} onConfirm={fn()} /> : undefined}
      structure={false} onStructureChange={fn()} onLaunch={fn()} onSaveReviewer={fn()} onAutoApprove={fn()} stageLinks={() => []} canStartStageChat onStartStageChat={fn()} onOpenConversation={fn()}
      canvasRenderer={Renderer} panelOpen={panelOpen} onPanelOpenChange={fn()} revealRequest={revealRequest} onRevealHandled={() => setRevealRequest(undefined)}
      decorations={harness.decorations} edgeDecorations={harness.edgeDecorations} panelTop={harness.panelTop} stageSlots={harness.stageSlots} onDropAgent={harness.onDropAgent} />
    {harness.dialog}
  </div>;
}
function DeskCanvas(props: CanvasProps): JSX.Element { return <Desk><Canvas {...props} /></Desk>; }
/** The 구현 stage before an agent is placed on it. */
const IMPLEMENT_EMPTY = harnessGraph({ 'dev:implement': { agent: undefined } });

/** Drags an agent row of the list over a stage card (and drops it when asked), as the browser's drag and drop does. */
async function dragAgent(canvasElement: HTMLElement, agent: string, stage: string, drop: boolean): Promise<void> {
  const row = (await within(canvasElement).findByText(agent)).closest('li')!;
  const card = await waitFor(() => { const element = canvasElement.querySelector<HTMLElement>(`.react-flow__node[data-id="${stage}"] .workflow-node-card`); expect(element).not.toBeNull(); return element!; });
  const data = new DataTransfer();
  row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
  const point = () => { const box = card.getBoundingClientRect(); return { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }; };
  await waitFor(() => { const { clientX, clientY } = point(); expect(document.elementsFromPoint(clientX, clientY).some(hit => card.contains(hit))).toBe(true); });
  card.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data, ...point() }));
  if (drop) { card.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data, ...point() })); row.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data })); }
}

/** The canvas: agents from Settings at the top of the side panel; 설계 담당 runs 요구 정리 → 계획 → 시안 in one conversation. */
export const CanvasAgents: Story = { render: () => <DeskCanvas select="mock" /> };
/** Dragging 구현 담당 from the list onto 구현: the stage shows where it will land. */
export const CanvasDragging: Story = {
  render: () => <DeskCanvas select="implement" graph={IMPLEMENT_EMPTY} reveal="implement" />,
  play: async ({ canvasElement }) => {
    await dragAgent(canvasElement, '구현 담당', 'dev:implement', false);
    await waitFor(() => expect(canvasElement.querySelector('[data-node-id="dev:implement"][data-drop-target]')).not.toBeNull());
  },
};
/** Dropping it places the agent: the card names it and the stage takes its AI, model, effort and permission. */
export const CanvasDropAssigns: Story = {
  render: () => <DeskCanvas select="implement" graph={IMPLEMENT_EMPTY} reveal="implement" />,
  play: async ({ canvasElement }) => {
    await dragAgent(canvasElement, '구현 담당', 'dev:implement', true);
    await waitFor(() => expect(canvasElement.querySelector('[data-node-id="dev:implement"] .workflow-node-card__agent-name')?.textContent).toBe('구현 담당'));
    await expect(within(canvasElement).getByTestId('workflow-stage-agent')).toHaveTextContent('구현 담당');
  },
};
/** 배정 with a 전체 권한 agent: workflows never run with full access, so the stage takes 승인 후 실행 and says so. */
export const CanvasFullAccessLowered: Story = {
  render: () => <DeskCanvas select="implement" graph={IMPLEMENT_EMPTY} />,
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole('button', { name: "전체 권한 구현을(를) '구현'에 배정" }));
    await expect(within(canvasElement).findByText(/승인 후 실행으로 낮췄습니다/u)).resolves.toBeVisible();
  },
};
/** A check command decides pass or fail; a new or changed command waits until a person allows it once. */
export const CanvasChecks: Story = { render: () => <DeskCanvas select="implement" agentsOpen={false} /> };
/** A stage that waits for the person's answer (amber): no AI runs; the answer goes to 계획 in the same conversation. */
export const CanvasAnswer: Story = { render: () => <DeskCanvas select="answer" agentsOpen={false} run="answer" /> };
/** Approval with a note: 승인, or send it back to 시안 with what to change (the same conversation redoes it). */
export const CanvasApproval: Story = { render: () => <DeskCanvas select="approval" agentsOpen={false} run="approval" /> };
/** A workflow from a cloned repository names an agent this PC does not have: readable, but it will not run until reassigned. */
export const CanvasMissingAgent: Story = { render: () => <DeskCanvas select="implement" profiles={HARNESS_PROFILES.filter(profile => profile.id !== 'agent-build')} /> };

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
/** Phone: no dragging — 에이전트 배정 opens this sheet for the selected stage (the PC's agents come with the flow). */
export const PhoneAssignSheet: Story = {
  parameters: { layout: 'centered' },
  render: () => <Phone><Canvas mobile select="implement" graph={IMPLEMENT_EMPTY} /></Phone>,
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole('button', { name: '에이전트 배정' }));
    await waitFor(() => expect(within(document.body).getByRole('button', { name: "구현 담당을(를) '구현'에 배정" })).toBeVisible());
  },
};
/** Phone: the stage panel's 에이전트 배정 opens the sheet (no dragging on a phone); checks are allowed on the PC. */
export const PhoneStageAssign: Story = {
  parameters: { layout: 'centered' },
  render: () => <Phone><Canvas mobile select="implement" graph={IMPLEMENT_EMPTY} /></Phone>,
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
/** Claude: when the implement agent changes the settings, the approval ends the plan turn and the implementation starts as a new request with that agent (probe 2). */
export const ComposerPlanApprovalClaude: Story = {
  render: () => <Chat props={{ reasoningEffort: 'high', permissionPreset: 'plan', items: planItems,
    turns: [{ id: 'turn-plan', sessionId: 'harness-chat', commandId: 'command-plan', state: 'completed', revision: 2, createdAt: NOW, updatedAt: NOW }],
    planPhaseNote: "구현은 'Claude 구현'(Claude · Opus 5.5 · 보통)으로 시작합니다 · 설정 › AI › 단계 연결" }} />,
};
/** 확인하고 허용: exactly what runs, where, the script it calls and why it is asked again (the stage changed that script). */
export const CanvasCheckConsent: Story = {
  render: () => <DeskCanvas select="implement" agentsOpen={false} />,
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole('button', { name: '확인하고 허용' }));
    await waitFor(() => expect(within(document.body).getByRole('button', { name: '이 명령 허용' })).toBeVisible());
  },
};
/** 정기 점검 with 반복: the schedule runs the confirmed v6 while the edited v7 waits for a look; an unchanged result skipped the AI summary. */
export const CanvasRepeat: Story = {
  render: () => <DeskCanvas graph={CHECK_GRAPH} select="sum" agentsOpen={false} run="skipped"
    repeat={{ value: { cadence: 'daily', time: '09:00', timezone: 'Asia/Seoul', enabled: true }, status: { nextAt: '2026-10-30T00:00:00.000Z', pinnedRevision: 6 }, pinned: 6 }} />,
};
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
/**
 * A phone whose PC sends no agents with the flow (an older EZTerminal, or none saved): no 배정, the stage keeps its
 * AI · 모델 fields. (The two cannot be told apart from the reply, so no "update the PC" line.)
 */
export const PhoneOldHost: Story = {
  parameters: { layout: 'centered' },
  render: () => <Phone><Canvas mobile noCatalog select="implement" graph={IMPLEMENT_EMPTY} /></Phone>,
  play: async ({ canvasElement }) => {
    const target = await within(canvasElement).findByTestId('workflow-stage-panel');
    target.scrollIntoView({ block: 'start' });
  },
};
