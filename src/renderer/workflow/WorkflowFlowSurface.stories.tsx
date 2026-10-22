import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState, type ComponentType } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { validateWorkflowGraph, type WorkflowGraph } from '../../shared/workflow-graph';
import { AppI18nProvider } from '../i18n';
import type { WorkflowPanelSection } from './workflow-canvas-model';
import { workflowCanvasFixture, type WorkflowCanvasScenario } from './workflow-canvas-fixtures';
import type { CanvasSelection, WorkflowCanvasRendererProps } from './workflow-canvas-types';
import { useWorkflowCopy } from './workflow-copy';
import { WorkflowFlowCanvas } from './WorkflowFlowCanvas';
import { WorkflowFlowSurface } from './WorkflowFlowSurface';
import { WorkflowStaticGraph } from './WorkflowStaticGraph';
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
  readonly renderer?: 'react-flow' | 'static' | 'broken';
  /** First visible column and zoom of the fixed story camera (deterministic screenshots). */
  readonly camera?: { readonly column: number; readonly zoom: number };
  readonly width?: number;
}

function Broken(): JSX.Element { throw new Error('The canvas chunk failed to load (story).'); }
const RENDERERS: Record<NonNullable<FlowStoryProps['renderer']>, ComponentType<WorkflowCanvasRendererProps>> = { 'react-flow': WorkflowFlowCanvas, static: WorkflowStaticGraph, broken: Broken };
const COLUMN = 248 + 96;

function draftOf(graph: WorkflowGraph, draft: Draft): WorkflowGraph | null {
  if (draft === 'invalid') return { ...graph, nodes: graph.nodes.map(node => node.id === 'login:implement' ? { ...node, model: undefined } : node) };
  if (draft === 'diverged') return { ...graph, nodes: graph.nodes.map(node => node.id === 'login:design' ? { ...node, instructions: `${node.instructions} (+)`, position: { x: node.position.x, y: node.position.y + 180 } } : node) };
  return null;
}

function FlowStory({ scenario, select, section: initialSection = 'settings', draft = 'none', runView: initialRunView = false, mobile = false, layout: initialLayout, renderer = 'react-flow', camera, locale = 'ko' }: FlowStoryProps): JSX.Element {
  const text = useWorkflowCopy();
  const fixture = useMemo(() => workflowCanvasFixture(scenario, locale), [scenario, locale]);
  const [draftGraph, setDraftGraph] = useState<WorkflowGraph | null>(() => draftOf(fixture.graph, draft));
  const [selection, setSelection] = useState<CanvasSelection>(select ? { kind: select.kind, id: select.kind === 'edge' ? select.key : `login:${select.key}` } : null);
  const [section, setSection] = useState(initialSection);
  const [runView, setRunView] = useState(initialRunView);
  const [layout, setLayout] = useState<'graph' | 'list'>(initialLayout ?? (mobile ? 'list' : 'graph'));
  const issues = validateWorkflowGraph(draftGraph ?? fixture.graph, true);
  const viewport = camera ? { x: 24 - (40 + camera.column * COLUMN) * camera.zoom, y: 120 - 40 * camera.zoom, zoom: camera.zoom } : undefined;
  return <WorkflowFlowSurface text={text} mobile={mobile} savedGraph={fixture.graph} draftGraph={draftGraph} revision={4} archivedNodes={[]} runs={fixture.run ? [fixture.run] : []}
    editLocked={false} commandsDisabled={false} issues={issues} providers={[{ id: 'codex', label: 'Codex', models: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra' }] }, { id: 'claude', label: 'Claude Code', models: [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }] }] as never}
    selection={selection} onSelectionChange={setSelection} section={section} onSectionChange={setSection} pickedRunId={null} onPickRun={fn()} runView={runView} onRunViewChange={setRunView}
    layout={layout} onLayoutChange={setLayout} onGraphChange={setDraftGraph} onSaveDraft={fn()} onDiscardDraft={() => setDraftGraph(null)} onPrepareRun={fn()} onRunCommand={fn()}
    stageLinks={nodeId => nodeId === 'login:implement' ? [{ sessionId: 'chat-impl', title: locale === 'ko' ? '로그인 오류 처리 방향 논의' : 'Discuss login error handling', graphRevision: 3 }] : []}
    canStartStageChat onStartStageChat={fn()} onOpenConversation={fn()} onOpenResults={fn()} onOpenAttemptResult={fn()}
    canvasRenderer={RENDERERS[renderer]} initialViewport={viewport} />;
}
function Frame(props: FlowStoryProps): JSX.Element {
  const locale = props.locale ?? 'ko';
  return <AppI18nProvider locale={locale} languages={[locale]}>
    <div className="workflow-workspace" style={{ width: props.width ? `${props.width}px` : '100%', height: '100vh', boxSizing: 'border-box' }}><FlowStory {...props} /></div>
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
const centre = (element: Element) => { const box = element.getBoundingClientRect(); return { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }; };
async function dragBetween(from: Element, to: Element): Promise<void> {
  const start = centre(from); const end = centre(to);
  const fire = (target: EventTarget, type: string, at: { clientX: number; clientY: number }) => target.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, composed: true, button: 0, buttons: type.endsWith('up') ? 0 : 1, pointerId: 1, isPrimary: true, ...at } as PointerEventInit));
  fire(from, 'pointerdown', start); fire(from, 'mousedown', start);
  for (let step = 1; step <= 8; step += 1) { const at = { clientX: start.clientX + (end.clientX - start.clientX) * step / 8, clientY: start.clientY + (end.clientY - start.clientY) * step / 8 }; fire(document, 'pointermove', at); fire(document, 'mousemove', at); await new Promise(resolve => requestAnimationFrame(resolve)); }
  fire(to, 'pointerup', end); fire(to, 'mouseup', end); fire(document, 'pointerup', end); fire(document, 'mouseup', end);
}

/** The first scene: the saved flow was prepared and started; its state sits on the editable canvas. */
export const JustStarted: Story = { args: { scenario: 'just-started', camera: { column: 0, zoom: 0.72 } } };
export const AwaitingApprovalSelected: Story = { args: { scenario: 'awaiting-approval', select: { kind: 'node', key: 'approval' }, section: 'run', camera: { column: 3, zoom: 0.72 } } };
export const RetryRoundTwo: Story = { args: { scenario: 'retry-running', select: { kind: 'node', key: 'implement' }, section: 'run', camera: { column: 1, zoom: 0.6 } } };
export const RetryLimitReached: Story = { args: { scenario: 'retry-exhausted', select: { kind: 'node', key: 'condition' }, section: 'run', camera: { column: 1, zoom: 0.6 } } };
export const CompletedAwaitingIntegration: Story = { args: { scenario: 'completed', camera: { column: 2, zoom: 0.6 } } };
export const IntegratedByAutoApprove: Story = { args: { scenario: 'integrated-auto', select: { kind: 'node', key: 'approval' }, section: 'run', camera: { column: 3, zoom: 0.72 } } };
export const Cancelled: Story = { args: { scenario: 'cancelled', camera: { column: 0, zoom: 0.6 } } };
export const ParallelJoin: Story = { args: { scenario: 'parallel-join', select: { kind: 'node', key: 'join' }, section: 'run', camera: { column: 1, zoom: 0.62 } } };
export const Prepared: Story = { args: { scenario: 'prepared', camera: { column: 0, zoom: 0.6 } } };
export const DraftWithIssue: Story = { args: { scenario: 'edit', draft: 'invalid', camera: { column: 1, zoom: 0.72 } } };
export const EditingStageSettings: Story = { args: { scenario: 'edit', select: { kind: 'node', key: 'implement' }, section: 'settings', camera: { column: 1, zoom: 0.72 } } };
export const StageDocumentAndChats: Story = { args: { scenario: 'edit', select: { kind: 'node', key: 'implement' }, section: 'stage', camera: { column: 1, zoom: 0.72 } } };
export const DraftDiffersFromRun: Story = { args: { scenario: 'retry-running', draft: 'diverged', camera: { column: 0, zoom: 0.6 } } };
export const FrozenRunView: Story = { args: { scenario: 'retry-running', draft: 'diverged', runView: true, select: { kind: 'node', key: 'implement' }, section: 'run', camera: { column: 1, zoom: 0.6 } } };
export const RetryEdgeSelected: Story = { args: { scenario: 'retry-running', select: { kind: 'edge', key: 'login:retry' }, camera: { column: 1, zoom: 0.6 } } };
export const Narrow: Story = { args: { scenario: 'awaiting-approval', select: { kind: 'node', key: 'approval' }, section: 'run', width: 800, camera: { column: 4, zoom: 0.6 } } };
export const MobileList: Story = { args: { scenario: 'retry-running', mobile: true, renderer: 'static', width: 390 } };
export const StaticFallback: Story = { args: { scenario: 'awaiting-approval', renderer: 'broken' } };
export const EnglishAwaitingApproval: Story = { args: { scenario: 'awaiting-approval', locale: 'en', select: { kind: 'node', key: 'approval' }, section: 'run', camera: { column: 3, zoom: 0.72 } } };

/** Drag from an output port to another stage's input adds exactly one connection. */
export const ConnectByDrag: Story = {
  args: { scenario: 'edit', camera: { column: 0, zoom: 0.9 } },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelectorAll('.react-flow__node').length).toBe(7));
    await waitFor(() => expect(canvasElement.querySelector('[data-id="login:plan"] .react-flow__handle-right[data-handleid="failed"]')).not.toBeNull());
    const before = edges(canvasElement);
    await dragBetween(canvasElement.querySelector('[data-id="login:plan"] [data-handleid="failed"]')!, canvasElement.querySelector('[data-id="login:design"] [data-handleid="in"]')!);
    await waitFor(() => expect(edges(canvasElement)).toBe(before + 1));
  },
};
/** Keyboard only: Tab to a connection, select it, Delete removes it. */
export const DeleteConnectionByKeyboard: Story = {
  args: { scenario: 'edit', camera: { column: 0, zoom: 0.9 } },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(edges(canvasElement)).toBeGreaterThan(0));
    const before = edges(canvasElement);
    (canvasElement.querySelector('.react-flow__edge') as HTMLElement).focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('{Delete}');
    await waitFor(() => expect(edges(canvasElement)).toBe(before - 1));
  },
};
/** Keyboard only: select a stage and move it with the arrow keys; the draft records the move. */
export const MoveStageByKeyboard: Story = {
  args: { scenario: 'edit', camera: { column: 0, zoom: 0.9 } },
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
  },
};
