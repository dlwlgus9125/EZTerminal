import type { ProviderModel } from '../../shared/daemon-provider';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState, type ComponentType } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import type { ExecutionRun } from '../../shared/planning-execution';
import type { WorkflowRepeat, WorkflowRepeatStatus } from '../../shared/workflow';
import { validateWorkflowGraph, type WorkflowGraph, type WorkflowNode } from '../../shared/workflow-graph';
import { AppI18nProvider } from '../i18n';
import type { WorkflowPanelSection } from './workflow-canvas-model';
import { workflowCanvasFixture, workflowCanvasRuns, type WorkflowCanvasScenario } from './workflow-canvas-fixtures';
import type { CanvasSelection, WorkflowCanvasRendererProps } from './workflow-canvas-types';
import { useWorkflowCopy } from './workflow-copy';
import { WorkflowFlowCanvas } from './WorkflowFlowCanvas';
import { WorkflowFlowSurface } from './WorkflowFlowSurface';
import { WorkflowStaticGraph } from './WorkflowStaticGraph';
import { useWorkflowScale } from './use-workflow-scale';
import '../index.css';
import './workflow.css';

type Draft = 'none' | 'invalid' | 'diverged';
interface FlowStoryProps {
  readonly scenario: WorkflowCanvasScenario;
  readonly locale?: 'ko' | 'en';
  readonly select?: { readonly kind: 'node' | 'edge'; readonly key: string };
  readonly section?: WorkflowPanelSection;
  readonly draft?: Draft;
  readonly runView?: boolean;
  readonly mobile?: boolean;
  readonly layout?: 'graph' | 'list';
  /** 'flaky' fails once like a rejected lazy chunk, then loads after "다시 불러오기". */
  readonly renderer?: 'react-flow' | 'static' | 'flaky';
  /** First visible column and zoom of the fixed story camera (deterministic screenshots). */
  readonly camera?: { readonly column: number; readonly zoom: number };
  readonly width?: number;
  /** A flow saved by the old editor: 240-unit spacing for 210px nodes. */
  readonly legacyLayout?: boolean;
  readonly twoRuns?: boolean;
  /** The selected stage was deleted from the draft; its document and chats stay reachable. */
  readonly archived?: boolean;
  readonly empty?: boolean;
  /** Render inside the real dock structure (filled flow view) with this pane height. */
  readonly paneHeight?: number;
  /** Start with the stage panel hidden (the header toggle brings it back). */
  readonly panelCollapsed?: boolean;
  /** Start in "흐름 편집" (stages can be added, moved and connected). */
  readonly structure?: boolean;
  readonly autoApprove?: boolean;
  /** 반복 on a host that runs it (workflow-repeat-v1): the saved setting and what the host says about it. */
  readonly repeat?: { readonly value: WorkflowRepeat; readonly status?: WorkflowRepeatStatus };
}

/** The efforts each fixture model offers (the stage panel lists only these). */
const STORY_CATALOGS: Readonly<Record<string, readonly ProviderModel[]>> = {
  codex: [{ id: 'gpt-6-astra', displayName: 'GPT-6-Astra', isDefault: true, supportsReasoning: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] }],
  claude: [{ id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', isDefault: true, supportsReasoning: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] }],
};

const COLUMN = 248 + 96;
function draftOf(graph: WorkflowGraph, draft: Draft): WorkflowGraph | null {
  if (draft === 'invalid') return { ...graph, nodes: graph.nodes.map(node => node.id === 'login:implement' ? { ...node, model: undefined } : node) };
  if (draft === 'diverged') return { ...graph, nodes: graph.nodes.map(node => node.id === 'login:design' ? { ...node, role: 'review' as const, instructions: `${node.instructions} (+)`, position: { x: node.position.x, y: node.position.y + 180 } } : node) };
  return null;
}
function Failing(): JSX.Element { throw new Error('The canvas chunk failed to load (story).'); }

function FlowStory({ scenario, legacyLayout = false, twoRuns = false, archived = false, empty = false, select, section: initialSection = 'settings', draft = 'none', runView: initialRunView = false, mobile = false, layout: initialLayout, renderer = 'react-flow', camera, locale = 'ko', panelCollapsed = false, structure: initialStructure = false, autoApprove = false, repeat }: FlowStoryProps): JSX.Element {
  const text = useWorkflowCopy();
  const fixture = useMemo(() => {
    if (twoRuns) { const value = workflowCanvasRuns(locale); return { graph: value.graph, runs: value.runs, archivedNodes: [] as WorkflowNode[] }; }
    const value = workflowCanvasFixture(scenario, locale);
    let graph = legacyLayout ? { ...value.graph, nodes: value.graph.nodes.map((node, index) => ({ ...node, position: { x: 80 + index * 240, y: 80 } })) } : value.graph;
    let archivedNodes: WorkflowNode[] = [];
    if (archived) { archivedNodes = graph.nodes.filter(node => node.id === 'login:design'); graph = { ...graph, nodes: graph.nodes.filter(node => node.id !== 'login:design'), edges: graph.edges.filter(edge => edge.from !== 'login:design' && edge.to !== 'login:design') }; }
    if (empty) graph = { entryNodeId: null, nodes: [], edges: [] };
    return { graph, runs: value.run ? [value.run] as ExecutionRun[] : [], archivedNodes };
  }, [archived, empty, legacyLayout, locale, scenario, twoRuns]);
  const [draftGraph, setDraftGraph] = useState<WorkflowGraph | null>(() => draftOf(fixture.graph, draft));
  const [selection, setSelection] = useState<CanvasSelection>(select ? { kind: select.kind, id: select.kind === 'edge' ? select.key : `login:${select.key}` } : null);
  const [section, setSection] = useState(initialSection);
  const [runView, setRunView] = useState(initialRunView);
  const [pickedRunId, setPickedRunId] = useState<string | null>(null);
  const [layout, setLayout] = useState<'graph' | 'list'>(initialLayout ?? (mobile ? 'list' : 'graph'));
  const [reloaded, setReloaded] = useState(false);
  const [panelOpen, setPanelOpen] = useState(!panelCollapsed);
  const [structure, setStructure] = useState(initialStructure === true);
  const scale = useWorkflowScale();
  const issues = validateWorkflowGraph(draftGraph ?? fixture.graph, true);
  const viewport = camera ? { x: 24 - (40 + camera.column * COLUMN) * scale * camera.zoom, y: 120 - 40 * scale * camera.zoom, zoom: camera.zoom } : undefined;
  const Renderer: ComponentType<WorkflowCanvasRendererProps> = renderer === 'static' ? WorkflowStaticGraph : renderer === 'flaky' && !reloaded ? Failing : WorkflowFlowCanvas;
  return <WorkflowFlowSurface text={text} mobile={mobile} savedGraph={fixture.graph} draftGraph={draftGraph} revision={4} archivedNodes={fixture.archivedNodes} runs={fixture.runs}
    editLocked={false} commandsDisabled={false} issues={issues} providers={[{ id: 'codex', label: 'Codex', models: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra' }] }, { id: 'claude', label: 'Claude Code', models: [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }] }] as never}
    selection={selection} onSelectionChange={setSelection} section={section} onSectionChange={setSection} pickedRunId={pickedRunId} onPickRun={setPickedRunId} runView={runView} onRunViewChange={setRunView}
    layout={layout} onLayoutChange={setLayout} onGraphChange={setDraftGraph} onSaveDraft={fn()} onDiscardDraft={() => setDraftGraph(null)} onRunCommand={fn()}
    subproject={{ id: 'login', status: 'active', autoApprove, runSettings: { reviewer: { providerId: 'codex', model: 'gpt-6-astra' } }, ...(repeat ? { repeat: repeat.value } : {}) }} catalogs={STORY_CATALOGS}
    {...(repeat ? { onSaveRepeat: fn(), repeatStatus: repeat.status } : {})}
    structure={structure} onStructureChange={setStructure} onLaunch={fn()} onSaveReviewer={fn()} onAutoApprove={fn()}
    stageLinks={nodeId => nodeId === 'login:implement' || nodeId === 'login:design' ? [{ sessionId: 'chat-impl', title: locale === 'ko' ? '로그인 오류 처리 방향 논의' : 'Discuss login error handling', graphRevision: 3 }] : []}
    canStartStageChat onStartStageChat={fn()} onOpenConversation={fn()} onOpenResults={fn()} onOpenAttemptResult={fn()}
    canvasRenderer={Renderer} onReloadCanvas={() => setReloaded(true)} initialViewport={viewport} panelOpen={panelOpen} onPanelOpenChange={setPanelOpen} />;
}
function Frame(props: FlowStoryProps): JSX.Element {
  const locale = props.locale ?? 'ko';
  return <AppI18nProvider locale={locale} languages={[locale]}>
    {props.paneHeight
      ? <div className="workflow-workspace" data-view="flow" style={{ width: props.width ? `${props.width}px` : '100%', height: `${props.paneHeight}px`, boxSizing: 'border-box' }}><div className="workflow-flow-host"><FlowStory {...props} /></div></div>
      : <div className="workflow-workspace" data-mobile={props.mobile || undefined} style={{ width: props.width ? `${props.width}px` : '100%', height: '100vh', boxSizing: 'border-box' }}><FlowStory {...props} /></div>}
  </AppI18nProvider>;
}

const meta = {
  title: 'Production/Workflow/Flow canvas',
  component: Frame,
  parameters: { layout: 'fullscreen', a11y: { test: 'error' } },
} satisfies Meta<typeof Frame>;
export default meta;
type Story = StoryObj<typeof meta>;

const edges = (root: HTMLElement) => root.querySelectorAll('.react-flow__edge').length;
/** Edges draw after their stages are measured (later on a slow runner): wait until the count holds still. */
async function settledEdges(root: HTMLElement): Promise<number> {
  let last = -1;
  await waitFor(() => { const now = edges(root); const held = now === last && now > 0; last = now; expect(held).toBe(true); }, { interval: 200, timeout: 10_000 });
  return last;
}
const centre = (element: Element) => { const box = element.getBoundingClientRect(); return { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }; };
async function dragBetween(from: Element, to: Element): Promise<void> {
  const start = centre(from); const end = centre(to);
  const fire = (target: EventTarget, type: string, at: { clientX: number; clientY: number }) => target.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, composed: true, button: 0, buttons: type.endsWith('up') ? 0 : 1, pointerId: 1, isPrimary: true, ...at } as PointerEventInit));
  fire(from, 'pointerdown', start); fire(from, 'mousedown', start);
  for (let step = 1; step <= 8; step += 1) { const at = { clientX: start.clientX + (end.clientX - start.clientX) * step / 8, clientY: start.clientY + (end.clientY - start.clientY) * step / 8 }; fire(document, 'pointermove', at); fire(document, 'mousemove', at); await new Promise(resolve => requestAnimationFrame(resolve)); }
  fire(to, 'pointerup', end); fire(to, 'mouseup', end); fire(document, 'pointerup', end); fire(document, 'mouseup', end);
}

/**
 * 2.0 approved reference `flow-run-view` (I2): a run going on with its approval waiting, the run bar and
 * the approval stage's column open. In the Storybook locale and the window's width (no pinned frame).
 */
export const RunReference: Story = {
  args: { scenario: 'awaiting-approval', select: { kind: 'node', key: 'approval' }, section: 'run', camera: { column: 3, zoom: 0.72 } },
  render: (args, context) => <Frame {...args} locale={context.globals.locale === 'en' ? 'en' : 'ko'} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByTestId('workflow-run-bar')).resolves.toBeVisible();
    await expect(canvas.findByTestId('workflow-stage-approval')).resolves.toBeVisible();
    await expect(canvas.getByTestId('workflow-run-phase')).toHaveTextContent('#1');
  },
};
/** The first scene: the saved flow was prepared and started; its state sits on the editable canvas. */
export const JustStarted: Story = { args: { scenario: 'just-started', camera: { column: 0, zoom: 0.72 } } };
export const AwaitingApprovalSelected: Story = { args: { scenario: 'awaiting-approval', select: { kind: 'node', key: 'approval' }, section: 'run', camera: { column: 3, zoom: 0.72 } } };
export const RetryRoundTwo: Story = { args: { scenario: 'retry-running', select: { kind: 'node', key: 'implement' }, section: 'run', camera: { column: 1, zoom: 0.6 } } };
export const IndependentReview: Story = { args: { scenario: 'reviewing', select: { kind: 'node', key: 'implement' }, section: 'run', camera: { column: 0, zoom: 0.72 } } };
export const RetryLimitReached: Story = { args: { scenario: 'retry-exhausted', select: { kind: 'node', key: 'condition' }, section: 'run', camera: { column: 1, zoom: 0.6 } } };
export const CompletedAwaitingIntegration: Story = { args: { scenario: 'completed', camera: { column: 2, zoom: 0.6 } } };
export const IntegratedByAutoApprove: Story = { args: { scenario: 'integrated-auto', select: { kind: 'node', key: 'approval' }, section: 'run', camera: { column: 3, zoom: 0.72 } } };
export const CancellationPending: Story = { args: { scenario: 'cancel-pending', select: { kind: 'node', key: 'approval' }, section: 'run', camera: { column: 3, zoom: 0.72 } } };
export const Cancelled: Story = { args: { scenario: 'cancelled', select: { kind: 'node', key: 'implement' }, section: 'run', camera: { column: 0, zoom: 0.6 } } };
export const ParallelJoin: Story = { args: { scenario: 'parallel-join', select: { kind: 'node', key: 'join' }, section: 'run', camera: { column: 1, zoom: 0.62 } } };
/** The stage panel hidden for a wider canvas; the header toggle (and going to a stage) brings it back. */
export const PanelCollapsed: Story = { args: { scenario: 'awaiting-approval', panelCollapsed: true, camera: { column: 2, zoom: 0.72 } } };
/** Hidden panel: the approval chip goes to the stage and shows its panel again. */
export const CollapsedPanelOpensOnJump: Story = {
  args: { scenario: 'awaiting-approval', panelCollapsed: true, camera: { column: 2, zoom: 0.72 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvasElement.querySelector('.workflow-flow__panel')).not.toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: /승인 대기 1|1 awaiting approval/u }));
    await expect(canvas.findByRole('button', { name: /^(승인|Approve)$/u })).resolves.toBeVisible();
    await expect(canvas.getByRole('button', { name: /단계 패널 접기|Hide stage panel/u })).toHaveAttribute('aria-expanded', 'true');
  },
};
export const Prepared: Story = { args: { scenario: 'prepared', camera: { column: 0, zoom: 0.6 } } };
/** 반복 every Monday at 09:00 in Seoul: the next run and how the last one went, on the run bar. */
export const RepeatWeekly: Story = {
  args: { scenario: 'completed', camera: { column: 2, zoom: 0.6 }, repeat: {
    value: { cadence: 'weekly', weekday: 1, time: '09:00', timezone: 'Asia/Seoul', enabled: true },
    status: { nextAt: '2026-11-02T00:00:00.000Z', last: { key: '2026-10-26', occurrenceAt: '2026-10-26T00:00:00.000Z', state: 'started', at: '2026-10-26T00:00:02.000Z', runId: 'run-login-4' } } } },
  play: async ({ canvasElement }) => {
    const group = await within(canvasElement).findByTestId('workflow-repeat');
    expect(within(group).getByTestId('workflow-repeat-cadence')).toHaveValue('weekly');
    expect(within(group).getByTestId('workflow-repeat-weekday')).toHaveValue('1');
    expect(within(group).getByTestId('workflow-repeat-status').textContent).toMatch(/2026|11/u);
  },
};
/** 반복 on in the flow file but not confirmed on this PC (it came with the project folder): it says so and offers 켜기. */
export const RepeatUnconfirmed: Story = {
  args: { scenario: 'completed', camera: { column: 2, zoom: 0.6 }, repeat: { value: { cadence: 'daily', time: '07:30', timezone: 'Asia/Seoul', enabled: true }, status: { blocked: 'unconfirmed' } } },
  play: async ({ canvasElement }) => {
    expect(await within(canvasElement).findByTestId('workflow-repeat-confirm')).toBeVisible();
  },
};
export const TwoRunsWithPicker: Story = { args: { scenario: 'retry-running', twoRuns: true, camera: { column: 1, zoom: 0.6 } } };
export const DraftWithIssue: Story = { args: { scenario: 'edit', draft: 'invalid', camera: { column: 1, zoom: 0.72 } } };
export const EditingStageSettings: Story = { args: { scenario: 'edit', select: { kind: 'node', key: 'implement' }, section: 'settings', camera: { column: 1, zoom: 0.72 } } };
export const StageDocumentAndChats: Story = { args: { scenario: 'edit', select: { kind: 'node', key: 'implement' }, section: 'stage', camera: { column: 1, zoom: 0.72 } } };
export const ArchivedStageSelected: Story = { args: { scenario: 'edit', archived: true, select: { kind: 'node', key: 'design' }, section: 'stage', camera: { column: 0, zoom: 0.72 } } };
export const DraftDiffersFromRun: Story = { args: { scenario: 'retry-running', draft: 'diverged', camera: { column: 0, zoom: 0.6 } } };
export const FrozenRunView: Story = { args: { scenario: 'retry-running', draft: 'diverged', runView: true, select: { kind: 'node', key: 'implement' }, section: 'run', camera: { column: 1, zoom: 0.6 } } };
export const RetryEdgeSelected: Story = { args: { scenario: 'retry-running', select: { kind: 'edge', key: 'login:retry' }, camera: { column: 1, zoom: 0.6 } } };
export const LegacyOverlappingLayout: Story = { args: { scenario: 'edit', legacyLayout: true, camera: { column: 0, zoom: 0.72 } } };
export const Narrow: Story = { args: { scenario: 'awaiting-approval', select: { kind: 'node', key: 'approval' }, section: 'run', width: 800, camera: { column: 4, zoom: 0.6 } } };
export const MobileList: Story = { args: { scenario: 'retry-running', mobile: true, renderer: 'static', width: 390 } };
export const EnglishAwaitingApproval: Story = { args: { scenario: 'awaiting-approval', locale: 'en', select: { kind: 'node', key: 'approval' }, section: 'run', camera: { column: 3, zoom: 0.72 } } };

/** The lazy canvas failed once: the static graph keeps the flow usable, and reloading recovers. */
export const CanvasRecoversAfterReload: Story = {
  args: { scenario: 'awaiting-approval', renderer: 'flaky', camera: { column: 3, zoom: 0.72 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByRole('alert')).resolves.toBeVisible();
    await expect(canvasElement.querySelector('[data-renderer="static"]')).not.toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: /캔버스 다시 불러오기|Reload the canvas/u }));
    await waitFor(() => expect(canvasElement.querySelector('[data-renderer="react-flow"]')).not.toBeNull());
  },
};
/** No stages yet: the panel offers the first one, which is added, selected and opened in settings. */
export const EmptyFlowAddFirstStage: Story = {
  args: { scenario: 'edit', empty: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /첫 AI 작업 단계 추가|Add a first AI task/u }));
    await waitFor(() => expect(canvasElement.querySelectorAll('.react-flow__node').length).toBe(1));
    await expect(canvas.findByTestId('workflow-stage-panel')).resolves.toBeVisible();
    // Adding the first stage opens "흐름 편집" (its structure is editable).
    await expect(canvas.findByTestId('workflow-stage-structure')).resolves.toBeVisible();
  },
};
/** The approval chip selects the waiting stage: its panel leads with the decision and opens its record. */
export const ApprovalChipOpensStage: Story = {
  args: { scenario: 'awaiting-approval', camera: { column: 0, zoom: 0.6 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /승인 대기 1|1 awaiting approval/u }));
    await expect(canvas.findByTestId('workflow-stage-approval')).resolves.toBeVisible();
    await expect(canvas.findByRole('button', { name: /^(승인|Approve)$/u })).resolves.toBeEnabled();
  },
};
/** A short dock pane: the flow fits the pane, and jumping to a stage scrolls nothing outside the panel. */
export const ShortDockPane: Story = {
  args: { scenario: 'awaiting-approval', width: 950, paneHeight: 460, camera: { column: 0, zoom: 0.6 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pane = canvasElement.querySelector<HTMLElement>('.workflow-workspace')!;
    const fits = () => {
      const body = canvasElement.querySelector('.workflow-flow__body')!.getBoundingClientRect();
      const panel = canvasElement.querySelector('.workflow-flow__panel')!.getBoundingClientRect();
      const canvasBox = canvasElement.querySelector('.workflow-canvas[data-renderer]')!.getBoundingClientRect();
      return { paneOverflow: pane.scrollHeight - pane.clientHeight, panelBelowBody: Math.round(panel.bottom - body.bottom), canvasBelowBody: Math.round(canvasBox.bottom - body.bottom) };
    };
    await waitFor(() => expect(canvasElement.querySelector('.react-flow__node')).not.toBeNull());
    await expect(fits()).toEqual({ paneOverflow: 0, panelBelowBody: 0, canvasBelowBody: 0 });
    await userEvent.click(await canvas.findByRole('button', { name: /승인 대기 1|1 awaiting approval/u }));
    await expect(canvas.findByRole('button', { name: /^(승인|Approve)$/u })).resolves.toBeVisible();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await expect(pane.scrollTop).toBe(0);
    await expect(fits()).toEqual({ paneOverflow: 0, panelBelowBody: 0, canvasBelowBody: 0 });
  },
};
/** A stage added past the visible area is centred and selected, so the person sees what they added. */
export const AddStageRevealsIt: Story = {
  args: { scenario: 'edit', structure: true, camera: { column: 0, zoom: 0.9 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvasElement.querySelectorAll('.react-flow__node').length).toBe(7));
    await userEvent.click(canvas.getByRole('button', { name: /^(단계 추가|Add stage)$/u }));
    await userEvent.click(await within(document.body).findByRole('menuitem', { name: /^(AI 작업|AI task)$/u }));
    await waitFor(() => expect(canvasElement.querySelectorAll('.react-flow__node').length).toBe(8));
    const pane = canvasElement.querySelector('.react-flow')!.getBoundingClientRect();
    const added = [...canvasElement.querySelectorAll<HTMLElement>('.react-flow__node')].find(node => node.dataset.id?.startsWith('node-'))!;
    await waitFor(() => {
      const box = added.getBoundingClientRect();
      expect(box.left >= pane.left && box.right <= pane.right && box.top >= pane.top && box.bottom <= pane.bottom).toBe(true);
    });
    await expect(canvas.findByTestId('workflow-stage-structure')).resolves.toBeVisible();
  },
};
/** Drag from an output port to another stage's input adds exactly one connection. */
export const ConnectByDrag: Story = {
  args: { scenario: 'edit', structure: true, camera: { column: 0, zoom: 0.9 } },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelectorAll('.react-flow__node').length).toBe(7));
    await waitFor(() => expect(canvasElement.querySelector('[data-id="login:plan"] .react-flow__handle-right[data-handleid="failed"]')).not.toBeNull());
    const before = await settledEdges(canvasElement);
    await dragBetween(canvasElement.querySelector('[data-id="login:plan"] [data-handleid="failed"]')!, canvasElement.querySelector('[data-id="login:design"] [data-handleid="in"]')!);
    await waitFor(() => expect(edges(canvasElement)).toBe(before + 1));
  },
};
/** Changing a stage's operation changes its ports; the new ports connect and their connections draw. */
export const NewPortsAfterOperationChange: Story = {
  args: { scenario: 'edit', structure: true, select: { kind: 'node', key: 'plan' }, section: 'settings', camera: { column: 0, zoom: 0.9 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvasElement.querySelector('[data-id="login:plan"] [data-handleid="next"]')).not.toBeNull());
    // Parallel and approval cards have the same size, so React Flow sees no resize between them.
    await userEvent.selectOptions(canvas.getByLabelText(/^(동작|Operation)$/u), 'parallel');
    await waitFor(() => expect(canvasElement.querySelector('[data-id="login:plan"] [data-handleid="failed"]')).toBeNull());
    await new Promise(resolve => setTimeout(resolve, 300));
    await userEvent.selectOptions(canvas.getByLabelText(/^(동작|Operation)$/u), 'approval');
    await waitFor(() => expect(canvasElement.querySelector('[data-id="login:plan"] [data-handleid="approved"]')).not.toBeNull());
    const before = await settledEdges(canvasElement);
    await dragBetween(canvasElement.querySelector('[data-id="login:plan"] [data-handleid="approved"]')!, canvasElement.querySelector('[data-id="login:design"] [data-handleid="in"]')!);
    await waitFor(() => expect(edges(canvasElement)).toBe(before + 1));
  },
};
/** Keyboard only: Tab to a connection, select it, Delete removes it. */
export const DeleteConnectionByKeyboard: Story = {
  args: { scenario: 'edit', structure: true, camera: { column: 0, zoom: 0.9 } },
  play: async ({ canvasElement }) => {
    const before = await settledEdges(canvasElement);
    (canvasElement.querySelector('.react-flow__edge') as HTMLElement).focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('{Delete}');
    await waitFor(() => expect(edges(canvasElement)).toBe(before - 1));
  },
};
/** Keyboard only: select a stage and move it with the arrow keys; Escape clears the selection. */
export const MoveStageByKeyboard: Story = {
  args: { scenario: 'edit', structure: true, camera: { column: 0, zoom: 0.9 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvasElement.querySelector('[data-id="login:plan"]')).not.toBeNull());
    const node = canvasElement.querySelector('[data-id="login:plan"]') as HTMLElement;
    const before = node.style.transform;
    node.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    await waitFor(() => expect(node.style.transform).not.toBe(before));
    await expect(canvas.findByText(/미저장 변경|Unsaved changes/u)).resolves.toBeVisible();
    await userEvent.keyboard('{Escape}');
    await expect(canvas.findByRole('heading', { name: /흐름 요약|Flow summary/u })).resolves.toBeVisible();
  },
};
/** Choosing a connection after a stage shows the connection, not an empty panel (selection order). */
export const SwitchStageToConnection: Story = {
  args: { scenario: 'edit', camera: { column: 0, zoom: 0.9 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvasElement.querySelector('[data-id="login:plan"]')).not.toBeNull());
    await userEvent.click(canvasElement.querySelector('[data-id="login:plan"] .workflow-node-card__title')!);
    await expect(canvas.findByRole('heading', { name: '기획' })).resolves.toBeVisible();
    (canvasElement.querySelector('.react-flow__edge') as HTMLElement).focus();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.findByRole('heading', { name: /다음|Next/u })).resolves.toBeVisible();
    await expect(canvas.findByRole('combobox', { name: /연결 조건|Connection outcome/u })).resolves.toBeVisible();
  },
};
