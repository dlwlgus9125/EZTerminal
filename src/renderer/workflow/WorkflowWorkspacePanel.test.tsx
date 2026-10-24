// @vitest-environment jsdom
import { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowCommandSchema, type WorkflowAccess, type WorkflowCommand } from '../../shared/workflow';
import { WorkflowWorkspacePanel } from './WorkflowWorkspacePanel';
import { workflowFixture } from './workflow-fixtures';
import { workflowCanvasFixture } from './workflow-canvas-fixtures';
import type { WorkflowDraftAccess, WorkflowDraftState } from '../../shared/workflow-draft';
import type { DaemonSnapshot } from '../../shared/daemon-protocol';
import type { WorkflowCanvasRendererProps } from './workflow-canvas-types';

vi.mock('../i18n', () => ({ useAppTranslation: () => ({ i18n: { language: 'en' } }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
const button = (name: string): HTMLButtonElement => { const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === name || item.getAttribute('aria-label') === name); if (!node) throw new Error(`Missing button: ${name}`); return node; };
const click = async (name: string): Promise<void> => { await act(async () => button(name).click()); };
const stageDocument = (): string | undefined => document.querySelector<HTMLTextAreaElement>('.workflow-stage textarea')?.value;
const subprojectMenu = async (item: string): Promise<void> => { await click('Subproject actions'); await click(item); };
const edit = async (label: string, value: string): Promise<void> => {
  const node = [...document.querySelectorAll('label')].find(item => item.textContent?.replace('*', '').trim() === label || item.firstChild?.textContent?.trim() === label);
  const control = (node?.htmlFor ? document.getElementById(node.htmlFor) : node?.querySelector('input,textarea,select')) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  if (!control) throw new Error(`Missing input: ${label}`);
  await act(async () => { const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, value); control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); });
};

function fixture() {
  let snapshot = workflowFixture(); const commands: WorkflowCommand[] = []; const open = vi.fn();
  const access: WorkflowAccess = { getWorkflowSnapshot: async () => ({ ok: true, snapshot }), executeWorkflowCommand: async command => {
    commands.push(WorkflowCommandSchema.parse(command)); snapshot = structuredClone(snapshot);
    const selected = snapshot.subprojects.find(item => item.id === command.subprojectId);
    if (command.type === 'workflow.patch' && selected) { selected.graph = command.payload.graph; selected.revision += 1; }
    if (command.type === 'session.link' && selected) { snapshot.sessionLinks.push({ sessionId: command.payload.sessionId, subprojectId: selected.id, nodeId: command.payload.nodeId, scope: command.payload.scope, graphRevision: selected.revision, linkedAt: new Date().toISOString() }); selected.revision += 1; }
    return { ok: true, snapshot, commandId: command.commandId };
  } };
  const render = async (selected = false, mobile = false): Promise<void> => { await act(async () => root.render(<WorkflowWorkspacePanel projectId="project-story" projectName="Project" access={access} mobile={mobile} navigationTarget={selected ? { subprojectId: 'login', nodeId: 'login:research', key: 'test' } : undefined} conversations={[{ id: 'general', title: 'General question' }, { id: 'chat-stage', title: 'Stage conversation' }]} onOpenConversation={open} />)); };
  return { access, commands, open, render };
}

describe('workflow project workspace', () => {
  it('opens the shared draft for ordinary project conversations without creating a session', async () => {
    const state = fixture(); const onNewConversation = vi.fn();
    const daemonAccess = { getDaemonSnapshot: async () => null, sendDaemonCommand: vi.fn() };
    await act(async () => root.render(<WorkflowWorkspacePanel projectId="project-story" projectName="Project" access={state.access}
      daemonAccess={daemonAccess} conversations={[]} onNewConversation={onNewConversation} />));
    await click('New conversation');
    expect(onNewConversation).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-testid="structured-agent-create"]')).toBeNull();
    expect(daemonAccess.sendDaemonCommand).not.toHaveBeenCalled();
  });
  it('preserves the complete stage conversation form while its project is hidden for history', async () => {
    const state = fixture();
    const now = '2026-10-14T00:00:00.000Z';
    const authority: DaemonSnapshot = {
      protocolVersion: 12, revision: 1, eventSequence: 1, generatedAt: now,
      runtime: { keepRunning: false, startAtLogin: false, orchestrationToolsEnabled: true, browserEnabled: false },
      projects: [{ id: 'project-story', name: 'Project', rootPath: 'C:/Project', source: 'native', revision: 1, createdAt: now, updatedAt: now }],
      workspaces: ['main', 'review'].map(id => ({ id, name: id, projectId: 'project-story', rootPath: `C:/Project/${id}`, kind: 'local', revision: 1, createdAt: now, updatedAt: now })),
      providers: ['codex', 'claude'].map(id => ({ id, displayName: id, protocol: id === 'codex' ? 'codex-app-server' : 'claude-agent-sdk', executablePath: id, executableVersion: 'test', argv: [], environmentVariableNames: [], capabilities: ['model:model-story'], enabled: true, health: 'ready', revision: 1, createdAt: now, updatedAt: now })),
      sessions: [], agents: [], agentRelations: [], turns: [], transcriptHeads: [], approvals: [], schedules: [], heartbeats: [],
    };
    const daemonAccess = { getDaemonSnapshot: async () => authority, sendDaemonCommand: vi.fn(async () => { throw new Error('History must not create a conversation.'); }) };
    const onOpenHistory = vi.fn();
    const render = async (active: boolean): Promise<void> => { await act(async () => root.render(<WorkflowWorkspacePanel projectId="project-story" projectName="Project" access={state.access} daemonAccess={daemonAccess} active={active} mobile conversations={[]} navigationTarget={{ subprojectId: 'login', nodeId: 'login:research', key: 'history-test' }} onOpenHistory={onOpenHistory} />)); };
    const changeSelect = async (id: string, value: string): Promise<void> => { const select = document.querySelector<HTMLSelectElement>(`[data-testid="${id}"]`)!; await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); }); };
    await render(true); await click('New stage conversation');
    await changeSelect('structured-agent-provider', 'claude');
    await changeSelect('structured-agent-workspace', 'review');
    await changeSelect('structured-agent-model', '');
    // Start in plan mode (the research stage may already ask for it).
    const startInPlan = document.querySelector<HTMLInputElement>('[data-testid="structured-agent-start-in-plan"]')!;
    if (!startInPlan.checked) await act(async () => startInPlan.click());
    await edit('Message Agent', 'Unsent stage request');
    const composer = document.querySelector<HTMLTextAreaElement>('.structured-agent--draft textarea')!;
    await act(async () => { composer.focus(); composer.setSelectionRange(3, 8); document.dispatchEvent(new Event('selectionchange')); });
    await click('Previous conversations');
    expect(onOpenHistory).toHaveBeenCalledOnce();
    await render(false);
    expect(document.querySelector('.structured-agent--draft')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await render(true);
    const restored = document.querySelector<HTMLTextAreaElement>('.structured-agent--draft textarea')!;
    expect(restored.value).toBe('Unsent stage request');
    expect([restored.selectionStart, restored.selectionEnd]).toEqual([3, 8]);
    expect(document.querySelector<HTMLSelectElement>('[data-testid="structured-agent-provider"]')!.value).toBe('claude');
    expect(document.querySelector<HTMLSelectElement>('[data-testid="structured-agent-workspace"]')!.value).toBe('review');
    expect(document.querySelector<HTMLSelectElement>('[data-testid="structured-agent-model"]')!.value).toBe('');
    expect(document.querySelector<HTMLInputElement>('[data-testid="structured-agent-start-in-plan"]')!.checked).toBe(true);
    expect(daemonAccess.sendDaemonCommand).not.toHaveBeenCalled(); expect(state.commands).toHaveLength(0);
  });
  it('restores an encrypted offline graph for editing, never submits it, and rejects it when another host connects', async () => {
    const snapshot = workflowFixture();
    const saved: WorkflowDraftState = { projectId: snapshot.projectId, hostId: snapshot.hostId, snapshot, drafts: {}, pendingCommand: null, view: { subprojectId: 'login', nodeId: 'login:research', page: 'stage', scrollTop: 0 } };
    const execute = vi.fn();
    const access: WorkflowAccess = { getWorkflowSnapshot: async () => ({ ok: false, error: 'unavailable', message: 'Disconnected' }), executeWorkflowCommand: execute };
    const recovery: WorkflowDraftAccess = { workflowDraftRead: async () => ({ ok: true, snapshot: { projectId: snapshot.projectId, revision: 1, state: saved } }), workflowDraftWrite: async (_, request) => ({ ok: true, snapshot: { projectId: snapshot.projectId, revision: request.expectedRevision + 1, state: request.state } }) };
    const render = async (disabled: boolean, nextAccess = access): Promise<void> => { await act(async () => root.render(<WorkflowWorkspacePanel projectId={snapshot.projectId} projectName="Project" access={nextAccess} recoveryAccess={recovery} disabled={disabled} conversations={[]} />)); };
    await render(true); await edit('Stage document', 'Offline graph edit'); expect(button('Save draft').disabled).toBe(true);
    expect(container.textContent).toContain('Showing the copy stored on this device'); expect(execute).not.toHaveBeenCalled();
    expect(container.querySelectorAll('.workflow-notice')).toHaveLength(1);
    expect(container.querySelector('.workflow-error')).toBeNull();
    const other = { ...snapshot, hostId: 'different-host', subprojects: [] };
    await render(false, { ...access, getWorkflowSnapshot: async () => ({ ok: true, snapshot: other }) });
    expect(container.querySelector('textarea')).toBeNull(); expect(container.textContent).not.toContain('Offline graph edit'); expect(execute).not.toHaveBeenCalled();
  });
  it('excludes host-owned execution, reviewer and proposal conversations from the general list', async () => {
    const snapshot = workflowFixture(); snapshot.managedSessionIds = ['task-session', 'reviewer-session', 'proposal-session'];
    const access: WorkflowAccess = { getWorkflowSnapshot: async () => ({ ok: true, snapshot }), executeWorkflowCommand: async () => { throw new Error('must not mutate'); } };
    await act(async () => root.render(<WorkflowWorkspacePanel projectId={snapshot.projectId} projectName="Project" access={access} conversations={[{ id: 'ordinary', title: 'Ordinary chat' }, { id: 'task-session', title: 'Task transcript' }, { id: 'reviewer-session', title: 'Reviewer transcript' }, { id: 'proposal-session', title: 'AI proposal transcript' }]} />));
    const items = container.querySelector('.workflow-items')!;
    expect(items.textContent).toContain('Ordinary chat');
    expect(items.textContent).not.toContain('Task transcript'); expect(items.textContent).not.toContain('Reviewer transcript'); expect(items.textContent).not.toContain('AI proposal transcript');
    expect([...items.querySelectorAll('button')].filter(button => button.textContent === 'Link to stage')).toHaveLength(1);
  });
  it('lists general conversations and subprojects at the same depth without creating planning entities', async () => {
    const state = fixture(); await state.render();
    expect(container.querySelectorAll('.workflow-items > li')).toHaveLength(3);
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.workflow-item')].find(item => item.textContent?.includes('General question'))!.click());
    expect(state.open).toHaveBeenCalledWith('general'); expect(state.commands).toHaveLength(0);
  });
  it('cancels subproject creation without writing a command', async () => {
    const state = fixture(); await state.render(); await click('New subproject'); await edit('Name', 'Cancelled plan'); await click('Cancel'); expect(state.commands).toHaveLength(0);
  });
  it('preserves node identity and stage document while renaming and switching views', async () => {
    // The stage's place in the flow (its title among them) is edited in "흐름 편집".
    const state = fixture(); await state.render(true); await edit('Stage document', 'Document before navigation'); await click('Edit the flow'); await edit('Stage title', 'Renamed stage'); await click('Done editing the flow');
    expect(stageDocument()).toBe('Document before navigation'); await click('Save draft');
    const command = state.commands[0]; expect(command.type).toBe('workflow.patch'); if (command.type === 'workflow.patch') { expect(command.payload.graph.nodes[0].id).toBe('login:research'); expect(command.payload.graph.nodes[0].title).toBe('Renamed stage'); expect(command.payload.graph.nodes[0].document).toBe('Document before navigation'); }
  });
  it('normalizes blank lines only on save and keeps editable invalid connections', async () => {
    const state = fixture(); await state.render(true); await edit('Acceptance criteria · one per line', 'First\n\nSecond\n'); await edit('Paths it may change · one per line', 'src\n');
    await click('Save draft'); const command = state.commands[0]; if (command.type !== 'workflow.patch') throw new Error('Wrong command'); expect(command.payload.graph.nodes[0].acceptance).toEqual(['First', 'Second']); expect(command.payload.graph.nodes[0].allowedPaths).toEqual(['src']);
  });
  it('opens the same stage conversation instead of duplicating its transcript', async () => {
    const state = fixture(); await state.render(true); await click('Stage conversation'); expect(state.open).toHaveBeenCalledWith('chat-stage'); expect(state.commands).toHaveLength(0);
  });
  it('links an existing conversation by session ID with no document patch', async () => {
    const state = fixture(); await state.render(); await click('Link to stage'); await edit('Subproject', 'login'); await edit('Stage', 'login:research'); await click('Link'); expect(state.commands).toHaveLength(1); expect(state.commands[0]).toMatchObject({ type: 'session.link', subprojectId: 'login', payload: { sessionId: 'general', nodeId: 'login:research' } });
  });
  it('rebases a dirty document after its own session link without hiding actual graph conflicts', async () => {
    const state = fixture(); await state.render(true); await edit('Stage document', 'Keep my unsaved document');
    await click('Back to project items'); await click('Link to stage'); await edit('Subproject', 'login'); await edit('Stage', 'login:research'); await click('Link');
    expect(stageDocument()).toBe('Keep my unsaved document');
    expect(container.textContent).not.toContain('Another window or AI changed');
    await click('Save draft'); expect(state.commands.at(-1)).toMatchObject({ type: 'workflow.patch', expectedRevision: 2 });
    await edit('Stage document', 'Another local edit');
    const current = await state.access.getWorkflowSnapshot('project-story'); if (!current.ok) throw new Error('Missing snapshot');
    const changed = structuredClone(current.snapshot); changed.subprojects[0].revision += 1; changed.subprojects[0].graph.nodes[0].document = 'Changed on another client';
    state.access.getWorkflowSnapshot = async () => ({ ok: true, snapshot: changed });
    await subprojectMenu('Refresh'); expect(container.textContent).toContain('Another window or AI changed');
    expect(stageDocument()).toBe('Another local edit');
  });
  it('uses list editing as the default on touch screens', async () => {
    const state = fixture(); await state.render(true, true); expect(button('List').getAttribute('aria-pressed')).toBe('true'); expect(container.querySelector('.workflow-canvas')).toBeNull(); await click('Graph'); expect(container.querySelector('.workflow-canvas')).not.toBeNull();
  });
  it('reconciles an uncertain command using the exact original envelope', async () => {
    const state = fixture(); const original = state.access.executeWorkflowCommand; let first = true;
    state.access.executeWorkflowCommand = async command => { if (first) { first = false; state.commands.push(command); throw new Error('response lost'); } return original(command); };
    await state.render(true); await edit('Stage document', 'Persist me'); await click('Save draft'); expect(button('Save draft').disabled).toBe(true); await click('Reconcile request'); expect(state.commands[1]).toEqual(state.commands[0]);
  });
  it('restores a creation draft, previews an AI update directly, and requires reconnection after preview expiry', async () => {
    const state = fixture(); const snapshot = workflowFixture(); const graph = structuredClone(snapshot.subprojects[0].graph);
    let saved: WorkflowDraftState = { projectId: snapshot.projectId, hostId: snapshot.hostId, drafts: {}, pendingCommand: null, creation: { id: 'pending-create', title: 'AI configured work', goal: 'Goal', preset: 'custom', mode: 'conversation', graph, previewSessionId: 'setup-session', previewRevision: 1 } };
    const writes: WorkflowDraftState[] = [];
    const recovery: WorkflowDraftAccess = { workflowDraftRead: async () => ({ ok: true, snapshot: { projectId: snapshot.projectId, revision: 0, state: saved } }), workflowDraftWrite: async (_, request) => { writes.push(request.state); saved = request.state; return { ok: true, snapshot: { projectId: snapshot.projectId, revision: request.expectedRevision + 1, state: saved } }; } };
    const requests: string[] = [];
    state.access.workflowPreview = async request => { requests.push(request.action); return { ok: true, preview: request.action === 'open' ? { id: request.previewId, projectId: snapshot.projectId, sessionId: 'setup-session', revision: 0, graph: { ...graph, nodes: graph.nodes.map((node, index) => index === 0 ? { ...node, title: 'AI proposal revision' } : node) } } : null }; };
    await act(async () => root.render(<WorkflowWorkspacePanel projectId={snapshot.projectId} projectName="Project" access={state.access} recoveryAccess={recovery} conversations={[]} />));
    await click('Continue setup');
    expect(button('Create subproject').disabled).toBe(true);
    expect(document.body.textContent).toContain('The host creation draft expired');
    await click('Reconnect saved draft');
    expect(document.body.textContent).toContain('AI proposal revision'); expect(button('Create subproject').disabled).toBe(false);
    await click('From preset'); expect(requests).toContain('discard');
    await act(async () => new Promise(resolve => setTimeout(resolve, 220)));
    expect(writes.at(-1)?.creation?.previewSessionId).toBeUndefined();
    expect(writes.at(-1)?.creation?.mode).toBe('preset');
    await click('Cancel'); expect(state.commands).toHaveLength(0);
  });
  it('lets an execution request that stays unconfirmed go, but never an edit', async () => {
    const snapshot = workflowFixture();
    for (const pendingCommand of [
      { commandId: 'launch-1', projectId: snapshot.projectId, hostId: snapshot.hostId, expectedRevision: 2, subprojectId: 'login', type: 'run.launch' as const, payload: { runId: 'run-1' } },
      { commandId: 'edit-1', projectId: snapshot.projectId, hostId: snapshot.hostId, expectedRevision: 2, subprojectId: 'login', type: 'workflow.undo' as const, payload: { changeId: 'change' } },
    ]) {
      const state = fixture();
      let saved: WorkflowDraftState = { projectId: snapshot.projectId, hostId: snapshot.hostId, drafts: {}, pendingCommand };
      const recovery: WorkflowDraftAccess = { workflowDraftRead: async () => ({ ok: true, snapshot: { projectId: snapshot.projectId, revision: 0, state: saved } }),
        workflowDraftWrite: async (_, request) => { saved = request.state; return { ok: true, snapshot: { projectId: snapshot.projectId, revision: 1, state: request.state } }; } };
      await act(async () => root.render(<WorkflowWorkspacePanel key={pendingCommand.commandId} projectId={snapshot.projectId} projectName="Project" access={state.access} recoveryAccess={recovery} conversations={[]} />));
      expect(document.body.textContent).toContain('The request is not yet confirmed');
      const stop = container.querySelector<HTMLButtonElement>('[data-testid="workflow-pending-discard"]');
      if (pendingCommand.type !== 'run.launch') { expect(stop).toBeNull(); continue; }
      await act(async () => { stop!.click(); });
      await act(async () => new Promise(resolve => setTimeout(resolve, 220)));
      expect(document.body.textContent).not.toContain('The request is not yet confirmed');
      expect(saved.pendingCommand).toBeNull();
      expect(state.commands).toHaveLength(0);
    }
  });
  it('reads the flow again when the host says its runs changed, without waiting for the poll', async () => {
    const state = fixture(); let notify: ((projectId: string) => void) | undefined; let reads = 0;
    const original = state.access.getWorkflowSnapshot;
    state.access.getWorkflowSnapshot = async (id) => { reads += 1; return original(id); };
    state.access.onWorkflowRunsChanged = (listener) => { notify = listener; return () => { notify = undefined; }; };
    await state.render(true);
    const before = reads;
    await act(async () => { notify?.('another-project'); notify?.('project-story'); await new Promise(resolve => setTimeout(resolve, 360)); });
    expect(reads).toBe(before + 1);
  });
  it('runs a flow asked from the board once it is ready, once, and not when it cannot run', async () => {
    const now = '2026-10-25T00:00:00.000Z';
    const authority = { protocolVersion: 12, revision: 1, eventSequence: 1, generatedAt: now, capabilities: ['workflow-launch-v1'],
      runtime: { keepRunning: false, startAtLogin: false, orchestrationToolsEnabled: true, browserEnabled: false }, projects: [], workspaces: [], providers: [],
      sessions: [], agents: [], agentRelations: [], turns: [], transcriptHeads: [], approvals: [], schedules: [], heartbeats: [] } as unknown as DaemonSnapshot;
    const daemonAccess = { getDaemonSnapshot: async () => authority, sendDaemonCommand: vi.fn(), listDaemonProviderModels: async () => ({ ok: true as const, value: [] }) };
    for (const saved of [true, false]) {
      const commands: WorkflowCommand[] = []; const snapshot = workflowFixture();
      if (saved) snapshot.subprojects[0] = { ...snapshot.subprojects[0]!, runSettings: { reviewer: { providerId: 'codex', model: 'model-story' } } };
      const access: WorkflowAccess = { getWorkflowSnapshot: async () => ({ ok: true, snapshot }), executeWorkflowCommand: async command => { commands.push(WorkflowCommandSchema.parse(command)); return { ok: true, snapshot, commandId: command.commandId }; } };
      const render = async (key: string) => { await act(async () => root.render(<WorkflowWorkspacePanel key={String(saved)} projectId={snapshot.projectId} projectName="Project" access={access} daemonAccess={daemonAccess} conversations={[]} navigationTarget={{ subprojectId: 'login', key, launch: true }} />)); };
      await render('board-1');
      await act(async () => new Promise(resolve => setTimeout(resolve, 50)));
      await render('board-1');
      // Without a saved review AI the flow opens and says why; nothing is sent.
      expect(commands.filter(command => command.type === 'run.launch')).toHaveLength(saved ? 1 : 0);
    }
  });
  it('restores the selected stage and its unsaved document without changing the authoritative graph', async () => {
    const state = fixture(); const snapshot = workflowFixture(); const graph = structuredClone(snapshot.subprojects[0].graph); graph.nodes[0].document = 'Unsaved draft';
    const saved: WorkflowDraftState = { projectId: snapshot.projectId, hostId: snapshot.hostId, drafts: { login: { baseRevision: 2, graph } }, pendingCommand: null, view: { subprojectId: 'login', nodeId: graph.nodes[0].id, page: 'stage', scrollTop: 77 } };
    const recovery: WorkflowDraftAccess = { workflowDraftRead: async () => ({ ok: true, snapshot: { projectId: snapshot.projectId, revision: 1, state: saved } }), workflowDraftWrite: async (_, request) => ({ ok: true, snapshot: { projectId: snapshot.projectId, revision: request.expectedRevision + 1, state: request.state } }) };
    await act(async () => root.render(<WorkflowWorkspacePanel projectId={snapshot.projectId} projectName="Project" access={state.access} recoveryAccess={recovery} conversations={[]} />));
    expect(container.querySelector('h2')?.textContent).toBe('Login improvements');
    expect(stageDocument()).toBe('Unsaved draft');
    expect(container.querySelector('section')?.scrollTop).toBe(77); expect(state.commands).toHaveLength(0);
  });
});

describe('WorkflowWorkspacePanel · one canvas', () => {
  it('restores a stored "run" page as the selected stage (its record opens once the flow has run)', async () => {
    const state = fixture(); const snapshot = workflowFixture(); const node = snapshot.subprojects[0].graph.nodes[0];
    const saved: WorkflowDraftState = { projectId: snapshot.projectId, hostId: snapshot.hostId, drafts: {}, pendingCommand: null, view: { subprojectId: 'login', nodeId: node.id, page: 'run', scrollTop: 0 } };
    const recovery: WorkflowDraftAccess = { workflowDraftRead: async () => ({ ok: true, snapshot: { projectId: snapshot.projectId, revision: 1, state: saved } }), workflowDraftWrite: async (_, request) => ({ ok: true, snapshot: { projectId: snapshot.projectId, revision: request.expectedRevision + 1, state: request.state } }) };
    await act(async () => root.render(<WorkflowWorkspacePanel projectId={snapshot.projectId} projectName="Project" access={state.access} recoveryAccess={recovery} conversations={[]} />));
    expect(document.querySelector('.workflow-flow__panel')?.getAttribute('aria-label')).toBe(node.title);
    expect(document.querySelector('[data-testid="workflow-stage-panel"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Each run starts a new conversation for each stage.');
  });
  it('brings the stage panel into view when a stage is opened from elsewhere, once', async () => {
    // Android stacks the panel under the stage list: "Return to this stage" must land on the stage, not the list.
    const scrolled: Array<[Element, ScrollIntoViewOptions | boolean | undefined]> = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, options?: ScrollIntoViewOptions | boolean) { scrolled.push([this, options]); };
    try {
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callback(0); return 0; });
      const state = fixture(); await state.render(true, true);
      const panel = document.querySelector('.workflow-flow__panel');
      expect(scrolled.filter(([element]) => element === panel)).toEqual([[panel, { block: 'start' }]]);
      expect(document.querySelector('[data-testid="workflow-stage-panel"]')).not.toBeNull();
      await click('History'); await click('History');
      expect(scrolled.filter(([element]) => element.classList.contains('workflow-flow__panel'))).toHaveLength(1);
    } finally { Element.prototype.scrollIntoView = original; }
  });
  it('gives a subproject opened from elsewhere its own canvas (fit and camera), not the previous one', async () => {
    const state = fixture(); const mounts: string[] = [];
    function RecordingCanvas({ graph }: WorkflowCanvasRendererProps): JSX.Element {
      const firstStage = useRef(graph.nodes[0]?.id ?? '');
      useEffect(() => { mounts.push(firstStage.current); }, []);
      return <div data-renderer="recording" />;
    }
    const open = async (subprojectId: string) => { await act(async () => root.render(<WorkflowWorkspacePanel projectId="project-story" projectName="Project" access={state.access} canvasRenderer={RecordingCanvas} navigationTarget={{ subprojectId, key: subprojectId }} conversations={[]} />)); };
    await open('login'); await open('payments');
    expect(mounts).toEqual(['login:research', 'payments:research']);
  });
  it('keeps the move buttons in the static graph shown when the canvas fails to load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const state = fixture();
    function FailingCanvas(): JSX.Element { throw new Error('chunk failed'); }
    await act(async () => root.render(<WorkflowWorkspacePanel projectId="project-story" projectName="Project" access={state.access} canvasRenderer={FailingCanvas} navigationTarget={{ subprojectId: 'login', nodeId: 'login:research', key: 'failed' }} conversations={[]} />));
    expect(document.querySelector('[data-renderer="static"]')).not.toBeNull();
    await click('Edit the flow');
    expect(button('Move up on canvas')).toBeTruthy();
  });
  it('records a save that only moved stages as a layout change', async () => {
    const state = fixture(); await state.render(true); await click('Edit the flow');
    await click('Move down on canvas'); await click('Save draft');
    const command = state.commands[0];
    expect(command).toMatchObject({ type: 'workflow.patch', payload: { summary: 'Layout change' } });
  });
  it('approves the waiting stage of a run from its stage panel with the exact activation', async () => {
    const commands: WorkflowCommand[] = []; const scene = workflowCanvasFixture('awaiting-approval', 'en'); const base = workflowFixture();
    const snapshot = { ...base, subprojects: [{ ...base.subprojects[0], graph: scene.graph }, ...base.subprojects.slice(1)], runs: [scene.run!] };
    const access: WorkflowAccess = { getWorkflowSnapshot: async () => ({ ok: true, snapshot }), executeWorkflowCommand: async command => { commands.push(WorkflowCommandSchema.parse(command)); return { ok: true, snapshot, commandId: command.commandId }; } };
    await act(async () => root.render(<WorkflowWorkspacePanel projectId={snapshot.projectId} projectName="Project" access={access} navigationTarget={{ subprojectId: 'login', key: 'run' }} conversations={[]} />));
    expect(document.body.textContent).toContain('Awaiting approval · action needed');
    await click('1 awaiting approval');
    // The stage panel leads with its decision and opens its record.
    expect(document.querySelector('[data-testid="workflow-stage-approval"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="workflow-stage-record"]')?.hasAttribute('open')).toBe(true);
    await click('Approve');
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: 'run.approve', payload: { runId: 'run-login-4', activationId: 'wf:login:approval:1', decision: 'approve' } });
  });
  it('offers no run actions on an archived subproject (the host rejects them)', async () => {
    const scene = workflowCanvasFixture('awaiting-approval', 'en'); const base = workflowFixture();
    const snapshot = { ...base, subprojects: [{ ...base.subprojects[0], status: 'archived' as const, graph: scene.graph }, ...base.subprojects.slice(1)], runs: [scene.run!] };
    const access: WorkflowAccess = { getWorkflowSnapshot: async () => ({ ok: true, snapshot }), executeWorkflowCommand: vi.fn() };
    await act(async () => root.render(<WorkflowWorkspacePanel projectId={snapshot.projectId} projectName="Project" access={access} navigationTarget={{ subprojectId: 'login', nodeId: 'login:approval', key: 'archived' }} conversations={[]} />));
    expect(button('Approve').disabled).toBe(true);
    expect(button('Pause').disabled).toBe(true);
    expect(button('Cancel execution').disabled).toBe(true);
  });
  it("keeps each subproject's canvas camera across History and back, separately per subproject", async () => {
    const state = fixture(); const seen: unknown[] = []; let report: WorkflowCanvasRendererProps['onViewportChange'];
    function CameraCanvas({ initialViewport, onViewportChange }: WorkflowCanvasRendererProps): JSX.Element {
      const first = useRef(initialViewport ?? null);
      useEffect(() => { seen.push(first.current); }, []);
      report = onViewportChange;
      return <div data-renderer="camera" />;
    }
    const open = async (subprojectId: string, key: string) => { await act(async () => root.render(<WorkflowWorkspacePanel projectId="project-story" projectName="Project" access={state.access} canvasRenderer={CameraCanvas} navigationTarget={{ subprojectId, key }} conversations={[]} />)); };
    await open('login', 'a');
    await act(async () => report?.({ x: 10, y: 20, zoom: 0.5 }));
    await click('History'); await click('History');
    await open('payments', 'b');
    await open('login', 'c');
    expect(seen).toEqual([null, { x: 10, y: 20, zoom: 0.5 }, null, { x: 10, y: 20, zoom: 0.5 }]);
  });
  it('opens an archived stage from History as that stage, even if a connection was selected', async () => {
    const base = workflowFixture(); const login = base.subprojects[0];
    const old = { ...login.graph.nodes[0], id: 'login:old', title: 'Old stage', document: 'Old notes' };
    const snapshot = { ...base, subprojects: [{ ...login, archivedNodes: [old] }, ...base.subprojects.slice(1)] };
    const access: WorkflowAccess = { getWorkflowSnapshot: async () => ({ ok: true, snapshot }), executeWorkflowCommand: vi.fn() };
    function EdgePicker({ graph, onSelect }: WorkflowCanvasRendererProps): JSX.Element { return <button type="button" onClick={() => onSelect({ kind: 'edge', id: graph.edges[0].id })}>Pick connection</button>; }
    await act(async () => root.render(<WorkflowWorkspacePanel projectId={snapshot.projectId} projectName="Project" access={access} canvasRenderer={EdgePicker} navigationTarget={{ subprojectId: 'login', key: 'edge' }} conversations={[]} />));
    await click('Pick connection');
    expect(document.querySelector('.workflow-flow__panel')?.getAttribute('aria-label')).toBe('Connection');
    await click('History'); await click('Old stage');
    expect(document.querySelector('.workflow-flow__panel')?.getAttribute('aria-label')).toBe('Old stage');
    expect((document.querySelector('.workflow-stage textarea') as HTMLTextAreaElement).value).toBe('Old notes');
  });
});
