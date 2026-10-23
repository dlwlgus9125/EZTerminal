// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateWorkflowGraph, type WorkflowGraph } from '../../shared/workflow-graph';
import { WorkflowFlowSurface, type WorkflowFlowSurfaceProps } from './WorkflowFlowSurface';
import { workflowCanvasFixture } from './workflow-canvas-fixtures';
import type { WorkflowCanvasRendererProps } from './workflow-canvas-types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
const text = (_ko: string, en: string) => en;

function props(overrides: Partial<WorkflowFlowSurfaceProps>): WorkflowFlowSurfaceProps {
  const { graph, run } = workflowCanvasFixture('retry-running', 'en');
  return {
    text, savedGraph: graph, draftGraph: null, revision: 4, archivedNodes: [], runs: run ? [run] : [], editLocked: false, commandsDisabled: false,
    issues: [], providers: [], selection: null, onSelectionChange: vi.fn(), section: 'settings', onSectionChange: vi.fn(), pickedRunId: null, onPickRun: vi.fn(),
    runView: false, onRunViewChange: vi.fn(), layout: 'graph', onLayoutChange: vi.fn(), onGraphChange: vi.fn(), onSaveDraft: vi.fn(), onDiscardDraft: vi.fn(),
    onPrepareRun: vi.fn(), onRunCommand: vi.fn(), stageLinks: () => [], canStartStageChat: true, onStartStageChat: vi.fn(), ...overrides,
  };
}

describe('WorkflowFlowSurface', () => {
  it('shows a run frozen from an older version without the draft\'s validation issues', async () => {
    const { graph } = workflowCanvasFixture('retry-running', 'en');
    // The draft lost a model: an issue on the draft, not on the run that froze the valid flow.
    const draft: WorkflowGraph = { ...graph, nodes: graph.nodes.map(node => node.id === 'login:implement' ? { ...node, model: undefined } : node) };
    const issues = validateWorkflowGraph(draft, true);
    expect(issues.some(issue => issue.nodeId === 'login:implement')).toBe(true);
    await act(async () => root.render(<WorkflowFlowSurface {...props({ draftGraph: draft, issues, runView: true })} />));
    expect(container.querySelector('.workflow-flow')?.getAttribute('data-mode')).toBe('run-view');
    expect(container.querySelector('.workflow-node-card__issues')).toBeNull();
    expect(container.querySelector('.workflow-validation')).toBeNull();
    // Back on the draft, the issues are shown again.
    await act(async () => root.render(<WorkflowFlowSurface {...props({ draftGraph: draft, issues, runView: false })} />));
    expect(container.querySelector('.workflow-node-card__issues')).not.toBeNull();
    expect(container.querySelector('.workflow-validation')).not.toBeNull();
  });
  it('keeps showing the run on screen when it finishes, until a newer run appears', async () => {
    const { graph, run } = workflowCanvasFixture('retry-running', 'en');
    const older = { ...run!, runId: 'run-a', createdAt: '2026-10-21T00:00:00.000Z' };
    const newer = { ...run!, runId: 'run-b', createdAt: '2026-10-22T00:00:00.000Z' };
    const shown = () => (container.querySelector('select[aria-label="Execution history"]') as HTMLSelectElement).value;
    await act(async () => root.render(<WorkflowFlowSurface {...props({ savedGraph: graph, runs: [older, newer] })} />));
    expect(shown()).toBe('run-b');
    // run-b finishes while run-a is still running: the person keeps watching run-b.
    await act(async () => root.render(<WorkflowFlowSurface {...props({ savedGraph: graph, runs: [older, { ...newer, state: 'completed' }] })} />));
    expect(shown()).toBe('run-b');
    // A newer run (prepared here or by an AI) takes over.
    const newest = { ...run!, runId: 'run-c', createdAt: '2026-10-23T00:00:00.000Z', state: 'prepared' as const };
    await act(async () => root.render(<WorkflowFlowSurface {...props({ savedGraph: graph, runs: [older, { ...newer, state: 'completed' }, newest] })} />));
    expect(shown()).toBe('run-c');
  });
  it('collapses the stage panel for a wider canvas; going to a stage opens it, canvas clicks do not', async () => {
    const { graph, run } = workflowCanvasFixture('awaiting-approval', 'en');
    let open = true; const onPanelOpenChange = vi.fn((next: boolean) => { open = next; });
    function PickCanvas({ onSelect }: WorkflowCanvasRendererProps): JSX.Element { return <button type="button" onClick={() => onSelect({ kind: 'node', id: 'login:plan' })}>Pick stage</button>; }
    const draw = async (mobile = false) => act(async () => root.render(<WorkflowFlowSurface {...props({ savedGraph: graph, runs: [run!], canvasRenderer: PickCanvas, panelOpen: open, onPanelOpenChange, mobile })} />));
    const toggle = () => container.querySelector<HTMLButtonElement>('.workflow-canvas-header__view button[aria-controls]');
    const press = async (label: string) => act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label || item.getAttribute('aria-label') === label)!.click());
    await draw();
    expect(toggle()?.getAttribute('aria-label')).toBe('Hide stage panel');
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('#' + toggle()!.getAttribute('aria-controls'))).not.toBeNull();
    await press('Hide stage panel'); await draw();
    expect(open).toBe(false);
    expect(container.querySelector('.workflow-flow__panel')?.hasAttribute('hidden')).toBe(true);
    expect(container.querySelector('.workflow-flow__body')?.getAttribute('data-panel')).toBe('collapsed');
    expect(toggle()?.getAttribute('aria-label')).toBe('Show stage panel');
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    // Picking or dragging on the canvas keeps the wide canvas.
    await press('Pick stage');
    expect(onPanelOpenChange).not.toHaveBeenCalledWith(true);
    // Going to a stage on purpose (the approval chip) opens it again.
    await press('1 awaiting approval');
    expect(onPanelOpenChange).toHaveBeenLastCalledWith(true);
    // Android stacks the panel under the canvas: no toggle there.
    await draw(true);
    expect(toggle()).toBeNull();
  });
});
