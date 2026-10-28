// @vitest-environment jsdom
// The approved harness canvas wired into the flow screen: agents placed by 배정 and by dropping on a stage, the stage's
// own conversation, review and checks reaching the draft, check allowance with its digest, answers and approval notes
// sent as run commands, a missing agent, the narrow-window start and a run refused for checks this PC has not allowed.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSnapshot } from '../../shared/daemon-protocol';
import { WORKFLOW_REPEAT_CAPABILITY, WorkflowCommandSchema, type WorkflowAccess, type WorkflowCommand, type WorkflowSnapshot } from '../../shared/workflow';
import type { ExecutionRun } from '../../shared/planning-execution';
import type { WorkflowGraph } from '../../shared/workflow-graph';
import { HARNESS_CHECK_STATUSES, HARNESS_PROFILES, harnessCheckAccess, harnessGraph, harnessProfileAccess, harnessRun, harnessSubproject } from '../harness/harness-fixtures';
import { WORKFLOW_AGENT_DRAG_TYPE } from './workflow-canvas-types';
import { workflowFixture } from './workflow-fixtures';
import { WorkflowWorkspacePanel } from './WorkflowWorkspacePanel';
import type { WorkflowCheckAccess } from './use-workflow-harness';

vi.mock('../i18n', () => ({ useAppTranslation: () => ({ i18n: { language: 'en' } }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
const width = window.innerWidth;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 }); });
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width }); delete document.documentElement.dataset.uiScale;
  delete (document as { elementsFromPoint?: unknown }).elementsFromPoint;
});
const flush = async () => { for (let index = 0; index < 4; index += 1) await act(async () => { await Promise.resolve(); }); };
const button = (name: string): HTMLButtonElement => {
  const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === name || item.getAttribute('aria-label') === name);
  if (!node) throw new Error(`Missing button: ${name}`);
  return node;
};
const click = async (name: string) => { await act(async () => button(name).click()); await flush(); };
const setValue = async (control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => {
  await act(async () => {
    const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, value);
    control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
};
const labelled = (label: string) => {
  const node = [...document.querySelectorAll('label')].find(item => item.textContent?.trim() === label);
  const control = node?.htmlFor ? document.getElementById(node.htmlFor) : null;
  if (!control) throw new Error(`Missing field: ${label}`);
  return control as HTMLTextAreaElement;
};

function setup(options: { graph?: WorkflowGraph; runs?: readonly ExecutionRun[]; nodeId?: string; profiles?: typeof HARNESS_PROFILES; checks?: WorkflowCheckAccess; refuse?: string; pinned?: number; daemon?: boolean } = {}) {
  const subproject = harnessSubproject(options.graph ?? harnessGraph(), options.pinned !== undefined ? { repeat: { cadence: 'daily', time: '09:00', timezone: 'Asia/Seoul', enabled: true } } : {});
  let snapshot: WorkflowSnapshot = { ...workflowFixture(), subprojects: [subproject], sessionLinks: [], runs: [...(options.runs ?? [])],
    ...(options.pinned !== undefined ? { repeatStatus: { dev: { pinnedRevision: options.pinned } } } : {}) };
  const commands: WorkflowCommand[] = [];
  let runsChanged: ((projectId: string) => void) | undefined;
  const access: WorkflowAccess = {
    onWorkflowRunsChanged: listener => { runsChanged = listener; return () => { runsChanged = undefined; }; },
    getWorkflowSnapshot: async () => ({ ok: true, snapshot }),
    executeWorkflowCommand: async command => {
      commands.push(WorkflowCommandSchema.parse(command));
      if (options.refuse) return { ok: false, error: options.refuse, message: 'Allow these checks on this PC before running: pnpm typecheck' };
      snapshot = structuredClone(snapshot);
      const selected = snapshot.subprojects.find(item => item.id === command.subprojectId);
      if (command.type === 'workflow.patch' && selected) { selected.graph = command.payload.graph; selected.revision += 1; }
      return { ok: true, snapshot, commandId: command.commandId };
    },
  };
  const daemonAccess = options.daemon ? { getDaemonSnapshot: async () => ({ providers: [], capabilities: [WORKFLOW_REPEAT_CAPABILITY] }) as unknown as DaemonSnapshot, sendDaemonCommand: async () => { throw new Error('unused'); } } : undefined;
  const render = async () => {
    await act(async () => root.render(<WorkflowWorkspacePanel projectId="project-story" projectName="Project" access={access} conversations={[]} daemonAccess={daemonAccess}
      agentProfiles={harnessProfileAccess(options.profiles ?? HARNESS_PROFILES)} checkAccess={options.checks ?? harnessCheckAccess()}
      navigationTarget={{ subprojectId: 'dev', ...(options.nodeId ? { nodeId: options.nodeId } : {}), key: 'harness' }} />));
    await flush();
  };
  const saved = (nodeId: string) => {
    const patch = [...commands].reverse().find(command => command.type === 'workflow.patch');
    if (patch?.type !== 'workflow.patch') throw new Error('No workflow.patch was sent');
    return patch.payload.graph.nodes.find(node => node.id === nodeId)!;
  };
  /** The host moved the runs on: the panel reads them again (after its 300 ms debounce). */
  const replaceRuns = async (runs: readonly ExecutionRun[]) => {
    snapshot = { ...structuredClone(snapshot), runs: [...runs] };
    await act(async () => { runsChanged?.('project-story'); await new Promise(resolve => setTimeout(resolve, 350)); });
    await flush();
  };
  return { commands, render, saved, replaceRuns };
}
const IMPLEMENT_EMPTY = harnessGraph({ 'dev:implement': { agent: undefined } });

describe('the harness canvas in the flow screen', () => {
  it('배정 places the agent on the selected stage and lowers 전체 권한 to 승인 후 실행, saying so', async () => {
    const state = setup({ graph: IMPLEMENT_EMPTY, nodeId: 'dev:implement' });
    await state.render();
    await click('Assign 전체 권한 구현 to \'구현\'');
    expect(container.querySelector('.workflow-stage-agent__notice')?.textContent).toContain('this stage runs with approval instead');
    expect(container.querySelector('[data-node-id="dev:implement"] .workflow-node-card__agent-name')?.textContent).toBe('전체 권한 구현');
    await click('Save draft');
    expect(state.saved('dev:implement')).toMatchObject({ agent: { profileId: 'agent-full', name: '전체 권한 구현', providerId: 'codex', model: 'gpt-6-astra' }, providerId: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high', permissionPreset: 'standard' });
  });

  it('an agent dropped on an AI stage card (found under the pointer) is placed on it', async () => {
    const state = setup({ graph: IMPLEMENT_EMPTY, nodeId: 'dev:plan' });
    await state.render();
    const card = container.querySelector<HTMLElement>('[data-node-id="dev:implement"]')!;
    (document as { elementsFromPoint?: unknown }).elementsFromPoint = vi.fn(() => [card.querySelector('.workflow-node-card__title')!, card]);
    const cell = container.querySelector<HTMLElement>('.workflow-flow__canvas')!;
    const drag = (type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { clientX: 40, clientY: 40, dataTransfer: { types: [WORKFLOW_AGENT_DRAG_TYPE], getData: (kind: string) => kind === WORKFLOW_AGENT_DRAG_TYPE ? 'agent-build' : '', dropEffect: 'none' } });
      cell.dispatchEvent(event);
      return event;
    };
    let over!: Event;
    await act(async () => { over = drag('dragover'); });
    expect(over.defaultPrevented).toBe(true);
    expect(container.querySelector('[data-node-id="dev:implement"][data-drop-target]')).not.toBeNull();
    await act(async () => { drag('drop'); });
    await flush();
    expect(container.querySelector('[data-node-id="dev:implement"][data-drop-target]')).toBeNull();
    // The dropped-on stage is selected, so its settings show the agent.
    expect(container.querySelector('[data-testid="workflow-stage-agent"]')?.textContent).toContain('구현 담당');
    await click('Save draft');
    expect(state.saved('dev:implement')).toMatchObject({ agent: { profileId: 'agent-build' }, reasoningEffort: 'medium', permissionPreset: 'standard' });
  });

  it('the stage’s conversation choice, review and a new check reach the draft graph (ids stable)', async () => {
    const state = setup({ nodeId: 'dev:plan' });
    await state.render();
    // 계획 continues 요구 정리 (same agent, an answer stage between): both choices are open.
    const fresh = container.querySelector<HTMLInputElement>('[data-testid="workflow-stage-agent"] input[value="fresh"]')!;
    expect(container.querySelector<HTMLInputElement>('[data-testid="workflow-stage-agent"] input[value="continue"]')!.disabled).toBe(false);
    expect(container.querySelector('[data-testid="workflow-stage-agent"]')?.textContent).toContain('Claude keeps its cache when only the effort changes');
    await act(async () => fresh.click());
    await setValue(container.querySelector<HTMLSelectElement>('[data-testid="workflow-stage-agent-review"]')!, 'off');
    await click('Add a check');
    await setValue(container.querySelector<HTMLInputElement>('input[aria-label="Check command to add"]')!, 'pnpm lint');
    await click('Add');
    expect(container.querySelector('[data-testid="workflow-stage-checks"]')?.textContent).toContain('Allow it once saved');
    await click('Save draft');
    expect(state.saved('dev:plan')).toMatchObject({ session: 'fresh', review: { mode: 'off' }, checks: [{ id: 'check-1', command: 'pnpm lint' }] });
  });

  it('확인하고 허용 shows what runs and allows it with the digest of the saved check', async () => {
    const allowed: unknown[][] = [];
    const base = harnessCheckAccess(HARNESS_CHECK_STATUSES);
    const checks: WorkflowCheckAccess = { status: base.status, allow: async (...args) => { allowed.push(args); return base.allow(...args); } };
    const state = setup({ nodeId: 'dev:implement', checks });
    await state.render();
    const rows = () => [...container.querySelectorAll('.workflow-check')].map(row => [row.querySelector('code')?.textContent, row.getAttribute('data-consent')]);
    expect(rows()).toEqual([['pnpm test', 'confirmed'], ['pnpm typecheck', 'needed']]);
    await click('Review and allow');
    expect(document.body.textContent).toContain('This stage’s result changed the script the command calls');
    expect(document.body.textContent).toContain('package.json#typecheck');
    await click('Allow this command');
    expect(allowed).toEqual([['project-story', 'dev', 'dev:implement', 'typecheck', 'digest-typecheck']]);
    expect(rows()).toEqual([['pnpm test', 'confirmed'], ['pnpm typecheck', 'confirmed']]);
  });

  it('an answer stage waiting in the run sends the person’s answer as run.answer', async () => {
    const state = setup({ runs: [harnessRun('answer')], nodeId: 'dev:answer' });
    await state.render();
    expect(container.querySelector('[data-testid="workflow-stage-state"]')?.textContent).toContain('Awaiting your answer');
    expect(button('1 awaiting your answer')).toBeTruthy();
    await setValue(labelled('Answer'), '5 tries, 10 minutes');
    await click('Send answer');
    expect(state.commands.at(-1)).toMatchObject({ type: 'run.answer', payload: { runId: 'run-dev-1', activationId: 'wf:dev:answer:0', answer: '5 tries, 10 minutes' } });
  });

  it('an answer written in one run is not shown or sent in the next run, whose activation id is the same', async () => {
    const state = setup({ runs: [harnessRun('answer')], nodeId: 'dev:answer' });
    await state.render();
    await setValue(labelled('Answer'), 'for the first run');
    await state.replaceRuns([{ ...harnessRun('answer'), runId: 'run-dev-2' }]);
    expect(labelled('Answer').value).toBe('');
    await setValue(labelled('Answer'), 'for the second run');
    await click('Send answer');
    expect(state.commands.at(-1)).toMatchObject({ type: 'run.answer', payload: { runId: 'run-dev-2', activationId: 'wf:dev:answer:0', answer: 'for the second run' } });
  });

  it('an approval that returns to a stage sends a rejection with the note (run.approve comment)', async () => {
    const state = setup({ runs: [harnessRun('approval')], nodeId: 'dev:approval' });
    await state.render();
    expect(button('Send back to \'시안\' with the comment').disabled).toBe(true);
    await setValue(labelled('Comment'), 'Show the minutes left');
    await click('Send back to \'시안\' with the comment');
    expect(state.commands.at(-1)).toMatchObject({ type: 'run.approve', payload: { runId: 'run-dev-1', activationId: 'wf:dev:approval:0', decision: 'reject', comment: 'Show the minutes left' } });
  });

  it('a stage naming an agent this PC does not have says so on the card, in its settings and before running', async () => {
    const state = setup({ profiles: HARNESS_PROFILES.filter(profile => profile.id !== 'agent-build') });
    await state.render();
    expect(container.querySelector('[data-node-id="dev:implement"]')?.textContent).toContain('Agent not on this PC · reassign');
    expect(container.querySelector('.workflow-validation')?.textContent).toContain('This stage names an agent that is not in Settings');
    await act(async () => container.querySelector<HTMLElement>('.workflow-static__node[aria-label^="구현"]')!.click());
    await flush();
    expect(container.querySelector('[data-testid="workflow-stage-agent"]')?.textContent).toContain('This agent is not in this PC’s Settings');
  });

  it('a narrow window (1440 at 130%) starts with the stage panel and the agent list folded; choosing a stage opens the panel', async () => {
    document.documentElement.dataset.uiScale = '130';
    const state = setup();
    await state.render();
    expect(container.querySelector<HTMLElement>('.workflow-flow__panel')!.hidden).toBe(true);
    expect(container.querySelector('.workflow-agents__toggle')?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => container.querySelector<HTMLElement>('.workflow-static__node[aria-label^="시안"]')!.click());
    await flush();
    expect(container.querySelector<HTMLElement>('.workflow-flow__panel')!.hidden).toBe(false);
    expect(container.querySelector('[data-testid="workflow-stage-panel"] h3')?.textContent).toBe('시안');
  });

  it('a narrow window opens the folded panel for a stage asked for by name (a link or a notification)', async () => {
    document.documentElement.dataset.uiScale = '130';
    const state = setup({ nodeId: 'dev:mock' });
    await state.render();
    expect(container.querySelector<HTMLElement>('.workflow-flow__panel')!.hidden).toBe(false);
    expect(container.querySelector('[data-testid="workflow-stage-panel"] h3')?.textContent).toBe('시안');
  });

  it('an approval whose rejection ends the run keeps 승인 · 거부 (no "send back" box)', async () => {
    const graph = harnessGraph();
    const stopped: WorkflowGraph = { ...graph, edges: graph.edges.map(edge => edge.from === 'dev:approval' && edge.outcome === 'rejected' ? { ...edge, to: 'dev:done' } : edge) };
    const run = harnessRun('approval');
    const state = setup({ graph: stopped, runs: [{ ...run, preparation: { ...run.preparation, workflow: { ...run.preparation.workflow!, graph: stopped } } }], nodeId: 'dev:approval' });
    await state.render();
    expect(container.querySelector('[data-testid="workflow-stage-approval"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="workflow-stage-approval-comment"]')).toBeNull();
  });

  it('a wide window starts with both open', async () => {
    const state = setup();
    await state.render();
    expect(container.querySelector<HTMLElement>('.workflow-flow__panel')!.hidden).toBe(false);
    expect(container.querySelector('.workflow-agents__toggle')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('a request refused for checks this PC has not allowed points at them', async () => {
    const state = setup({ graph: harnessGraph({ 'dev:plan': { instructions: '바뀐 지시' } }), refuse: 'unconfirmed-command' });
    await state.render();
    await act(async () => container.querySelector<HTMLElement>('.workflow-static__node[aria-label^="계획"]')!.click());
    await setValue(container.querySelector<HTMLSelectElement>('[data-testid="workflow-stage-agent-effort"]')!, 'low');
    await click('Save draft');
    const notice = container.querySelector('[data-testid="workflow-unallowed-checks"]');
    expect(notice?.textContent).toContain('구현: pnpm typecheck');
    await click('구현: pnpm typecheck');
    expect(container.querySelector('[data-testid="workflow-stage-panel"] h3')?.textContent).toBe('구현');
  });

  it('반복 pinned to a confirmed revision says so and re-confirms the edited one through the repeat save', async () => {
    const state = setup({ pinned: 4, daemon: true });
    await state.render();
    expect(container.querySelector('[data-testid="workflow-repeat-pinned"]')?.textContent).toContain('Scheduled: v4 · edited: v6');
    await click('Confirm v6');
    expect(state.commands.at(-1)).toMatchObject({ type: 'subproject.update', payload: { repeat: { cadence: 'daily', time: '09:00', enabled: true } } });
  });
});
