// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionRun } from '../../shared/planning-execution';
import { WorkflowFlowSurface, type WorkflowFlowSurfaceProps } from './WorkflowFlowSurface';
import { WorkflowStagePanel, type WorkflowStagePanelProps } from './WorkflowStagePanel';
import { workflowCanvasFixture } from './workflow-canvas-fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
const text = (_ko: string, en: string) => en;

describe('WorkflowStagePanel', () => {
  const scene = workflowCanvasFixture('awaiting-approval', 'en');
  const base = (overrides: Partial<WorkflowStagePanelProps>): WorkflowStagePanelProps => ({
    text, graph: scene.graph, node: scene.graph.nodes[0]!, archived: false, editable: true, structure: false, run: scene.run!, runNumber: 4, scope: null,
    providers: [{ id: 'codex', label: 'Codex', models: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra' }] }],
    catalogs: { codex: [{ id: 'gpt-6-astra', displayName: 'GPT-6-Astra', isDefault: true, supportsReasoning: true, reasoningEfforts: ['low', 'high'] }] },
    commandsDisabled: false, links: [], canStartChat: true, onChange: vi.fn(), onApprove: vi.fn(), onStartChat: vi.fn(), ...overrides,
  });

  it('asks the person to approve what the run froze, not an unsaved draft of it', async () => {
    const approval = scene.graph.nodes.find((node) => node.operation === 'approval')!;
    const frozen = scene.run!.preparation.workflow!.graph.nodes.find((node) => node.id === approval.id)!;
    await act(async () => root.render(<WorkflowStagePanel {...base({ node: { ...approval, instructions: 'An unsaved draft question' } })} />));
    const asked = container.querySelector('[data-testid="workflow-stage-approval"] p')!.textContent;
    expect(asked).not.toContain('An unsaved draft question');
    expect(asked).toBe(frozen.instructions || 'Approve execution after this stage.');
  });

  it('lists only the efforts the chosen model offers, and locks a working stage’s title in its structure too', async () => {
    const stage = { ...scene.graph.nodes.find((node) => node.operation === 'agent')!, providerId: 'codex', model: 'gpt-6-astra' };
    await act(async () => root.render(<WorkflowStagePanel {...base({ node: stage, structure: true, scope: 'locked' })} />));
    const efforts = [...container.querySelectorAll<HTMLOptionElement>('[data-testid="workflow-stage-effort"] option')].map((option) => option.value);
    expect(efforts).toEqual(['', 'low', 'high']);
    expect(container.querySelector<HTMLFieldSetElement>('[data-testid="workflow-stage-fields"]')!.disabled).toBe(true);
    const title = [...container.querySelectorAll('label')].find((label) => label.textContent?.trim() === 'Stage title');
    const input = (title?.htmlFor ? document.getElementById(title.htmlFor) : title?.querySelector('input')) as HTMLInputElement;
    expect(input.readOnly).toBe(true);
  });
});

describe('the edit scope the flow shows', () => {
  const props = (overrides: Partial<WorkflowFlowSurfaceProps>): WorkflowFlowSurfaceProps => {
    const { graph, run } = workflowCanvasFixture('just-started', 'en');
    return { text, savedGraph: graph, draftGraph: null, revision: 4, archivedNodes: [], runs: run ? [run] : [], editLocked: false, commandsDisabled: false,
      issues: [], providers: [], selection: { kind: 'node', id: 'login:implement' }, onSelectionChange: vi.fn(), section: 'settings', onSectionChange: vi.fn(), pickedRunId: null, onPickRun: vi.fn(),
      runView: false, onRunViewChange: vi.fn(), layout: 'list', onLayoutChange: vi.fn(), onGraphChange: vi.fn(), onSaveDraft: vi.fn(), onDiscardDraft: vi.fn(),
      subproject: { id: 'login', status: 'active' }, structure: false, onStructureChange: vi.fn(), onLaunch: vi.fn(), onSaveReviewer: vi.fn(), onAutoApprove: vi.fn(),
      onRunCommand: vi.fn(), stageLinks: () => [], canStartStageChat: true, onStartStageChat: vi.fn(), ...overrides };
  };
  const scope = () => container.querySelector('[data-testid="workflow-stage-scope"]')?.getAttribute('data-scope') ?? null;

  it('says "this run" only while the flow keeps the run’s stages and connections and the host binds edits', async () => {
    await act(async () => root.render(<WorkflowFlowSurface {...props({})} />));
    expect(scope()).toBe('this-run');
    // A structural change in the draft (its role) applies from the next run.
    const { graph } = workflowCanvasFixture('just-started', 'en');
    const draft = { ...graph, nodes: graph.nodes.map((node) => node.id === 'login:implement' ? { ...node, role: 'review' as const, instructions: 'Edited' } : node) };
    await act(async () => root.render(<WorkflowFlowSurface {...props({ draftGraph: draft })} />));
    expect(scope()).toBe('next-run');
    // An older host keeps the prepared settings: every change is for the next run.
    await act(async () => root.render(<WorkflowFlowSurface {...props({ savedRunSettings: false })} />));
    expect(scope()).toBe('next-run');
  });

  it('locks a working stage even while an older finished run is shown', async () => {
    const { run } = workflowCanvasFixture('just-started', 'en');
    const working = { ...run!, tasks: run!.tasks.map((task) => task.taskId === 'login:implement' ? { ...task, state: 'running' as const } : task) } as ExecutionRun;
    const finished = { ...run!, runId: 'older', createdAt: '2026-10-01T00:00:00.000Z', state: 'completed' as const } as ExecutionRun;
    await act(async () => root.render(<WorkflowFlowSurface {...props({ runs: [finished, working], pickedRunId: 'older' })} />));
    expect(scope()).toBe('locked');
    expect(container.querySelector<HTMLFieldSetElement>('[data-testid="workflow-stage-fields"]')!.disabled).toBe(true);
  });
});
