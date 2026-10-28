import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatAgentPhaseMap, ChatAgentProfile } from '../shared/chat-agent-profiles';
import type { DaemonSnapshot } from '../shared/daemon-protocol';
import { createWorkflowGraph } from '../shared/workflow';
import type { WorkflowTemplate } from '../shared/workflow-templates';
import { ADVISOR_CALLS_PER_TURN, AgentAdvisor } from './agent-advisor';
import { ChatAgentProfileStore } from './chat-agent-profile-store';
import { SettingsAuthority, settingsConversationAllowed, type SettingsAuthorityOptions, type UiSettingsValues } from './settings-authority';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const AI = { sessionId: 'chat-1', turnId: 'turn-1', projectId: 'project-1' };
const DESKTOP = { kind: 'desktop' as const, id: 'renderer-agent-ui' };
const PHONE = { kind: 'android' as const, id: 'phone-1' };

async function setup(options: {
  readonly profiles?: readonly ChatAgentProfile[];
  readonly templates?: readonly WorkflowTemplate[];
  readonly approvalState?: (approvalId: string) => 'pending' | 'expired';
  /** A real store instead of the in-memory one (its writes are queued like the app's). */
  readonly profileStore?: ChatAgentProfileStore;
  readonly workflow?: SettingsAuthorityOptions['workflow'];
} = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'settings-authority-'));
  dirs.push(dir);
  let ui: UiSettingsValues = { theme: 'matrix', uiScale: 100, font: null, effects: { scanlines: true }, effectIntensity: 7, density: 'adaptive', locale: 'ko', scrollback: 5000 };
  let profiles: readonly ChatAgentProfile[] = options.profiles ?? [];
  let phases: ChatAgentPhaseMap = { byProvider: {}, switchModel: false };
  let templates: readonly WorkflowTemplate[] = options.templates ?? [];
  const host: Record<string, boolean> = { orchestration: false, remoteAccess: false, startAtLogin: false };
  const hostWrite = vi.fn(async (key: string, value: boolean) => { host[key] = value; });
  const raiseApproval = vi.fn(async () => 'approval-1');
  const onChanged = vi.fn();
  let id = 0;
  const authority = new SettingsAuthority({
    dir,
    ui: {
      read: async () => ui,
      write: async (patch) => { ui = { ...ui, ...patch } as UiSettingsValues; },
      themes: async () => ['dark', 'light', 'matrix'],
      fonts: [{ id: 'cascadia', label: 'Cascadia Code' }, { id: 'fira-code', label: 'Fira Code' }],
      effectIds: ['scanlines', 'flicker'],
    },
    profiles: options.profileStore ?? {
      list: () => profiles,
      save: async (raw) => { const profile = raw as ChatAgentProfile; profiles = [...profiles.filter((entry) => entry.id !== profile.id), profile]; return { ok: true }; },
      remove: async (raw) => { profiles = profiles.filter((entry) => entry.id !== raw); return { ok: true }; },
      phases: () => phases,
      savePhases: async (raw) => { phases = raw as ChatAgentPhaseMap; return { ok: true }; },
    },
    ...(options.workflow ? { workflow: options.workflow } : {}),
    templates: {
      list: () => templates,
      save: async (raw) => { const input = raw as WorkflowTemplate; templates = [...templates.filter((entry) => entry.id !== input.id), { ...input, createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-29T00:00:00.000Z' }]; return { ok: true }; },
      remove: async (raw) => { templates = templates.filter((entry) => entry.id !== raw); return { ok: true }; },
    },
    host: { read: async (key) => host[key]!, write: hostWrite },
    raiseApproval,
    ...(options.approvalState ? { approvalState: options.approvalState } : {}),
    korean: async () => true,
    onChanged,
    createId: () => `id-${String(++id)}`,
    now: () => new Date('2026-10-29T09:31:00.000Z'),
  });
  await authority.init();
  return {
    authority, dir, hostWrite, raiseApproval, onChanged,
    ui: () => ui, setUi: (next: Partial<UiSettingsValues>) => { ui = { ...ui, ...next }; },
    profiles: () => profiles, setProfiles: (next: readonly ChatAgentProfile[]) => { profiles = next; },
    templates: () => templates,
  };
}

const implement: ChatAgentProfile = { id: 'implement', name: '구현 담당', providerId: 'codex', model: 'gpt-6-astra', permissionPreset: 'standard' };

describe('SettingsAuthority — who may change what is decided by the field', () => {
  it('applies a view setting now, records it, and broadcasts', async () => {
    const { authority, dir, ui, onChanged } = await setup();
    const result = await authority.apply(AI, { domain: 'ui', set: { effects: { scanlines: false }, uiScale: 120 } });
    expect(result.changes.map((change) => change.change)).toEqual(['UI 크기: 100% → 120%', '화면 효과: 주사선: 켬 → 끔']);
    expect(ui()).toMatchObject({ uiScale: 120, effects: { scanlines: false } });
    expect(onChanged).toHaveBeenCalledWith({ domains: ['ui'] });
    const file = JSON.parse(await readFile(path.join(dir, 'settings-changes.json'), 'utf8')) as { changes: Array<Record<string, unknown>> };
    expect(file.changes).toMatchObject([
      { domain: 'ui', target: 'uiScale', before: 100, after: 120, actor: { kind: 'ai', sessionId: 'chat-1', turnId: 'turn-1' } },
      { domain: 'ui', target: 'effects.scanlines', before: true, after: false },
    ]);
  });

  it('refuses an agent edit that raises its permission, even inside other changes; a person applies it from a proposal', async () => {
    const { authority, profiles, raiseApproval } = await setup({ profiles: [implement] });
    const raised = { ...implement, model: 'gpt-6', permissionPreset: 'full-access' as const };
    await expect(authority.apply(AI, { domain: 'agent', profile: raised })).rejects.toMatchObject({ code: 'needs-person' });
    expect(profiles()).toEqual([implement]);
    const proposal = await authority.propose(AI, { domain: 'agent', profile: raised });
    expect(proposal).toMatchObject({ title: '에이전트 "구현 담당" 권한 올리기', desktopOnly: true });
    expect(raiseApproval).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'chat-1', providerRequestId: 'settings-proposal:id-1', risk: 'danger',
      request: expect.objectContaining({ kind: 'tool', input: expect.stringContaining('PC에서만 적용할 수 있습니다.') }),
    }));
  });

  it('applies an agent edit that does not raise the permission, and a new agent up to 승인 후 실행', async () => {
    const { authority, profiles } = await setup({ profiles: [implement] });
    await authority.apply(AI, { domain: 'agent', profile: { ...implement, reasoningEffort: 'high', permissionPreset: 'plan' } });
    await authority.apply(AI, { domain: 'agent', profile: { id: 'review', name: '교차 검토', providerId: 'codex', permissionPreset: 'standard' } });
    expect(profiles().map((profile) => [profile.id, profile.permissionPreset])).toEqual([['implement', 'plan'], ['review', 'standard']]);
    await expect(authority.apply(AI, { domain: 'agent', profile: { id: 'wild', name: '전체', providerId: 'codex', permissionPreset: 'full-access' } })).rejects.toMatchObject({ code: 'needs-person' });
  });

  it('refuses a template stage permission raise and every host switch', async () => {
    const graph = createWorkflowGraph('feature', 'tpl');
    const template: WorkflowTemplate = { id: 'tpl-1', title: '내 절차', description: '', graph: { ...graph, nodes: graph.nodes.map((node) => ({ ...node, permissionPreset: 'plan' as const })) }, createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z' };
    const { authority } = await setup({ templates: [template] });
    const stage = template.graph.nodes[0]!;
    const raised = { id: template.id, title: template.title, description: template.description, graph: { ...template.graph, nodes: template.graph.nodes.map((node) => (node.id === stage.id ? { ...node, permissionPreset: 'standard' as const, allowedPaths: ['src'] } : node)) } };
    await expect(authority.apply(AI, { domain: 'template', template: raised })).rejects.toMatchObject({ code: 'needs-person' });
    await expect(authority.apply(AI, { domain: 'host', set: { remoteAccess: true } })).rejects.toMatchObject({ code: 'needs-person' });
    await expect(authority.apply(AI, { domain: 'host', set: { advisor: true } })).rejects.toMatchObject({ code: 'needs-person' });
    await expect(authority.apply(AI, { domain: 'ui', set: { theme: 'unknown-theme' } })).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('SettingsAuthority — undo', () => {
  it('restores the value only while it still has what the change set; otherwise it reports a conflict', async () => {
    const { authority, ui, setUi } = await setup();
    const [first] = (await authority.apply(AI, { domain: 'ui', set: { theme: 'light' } })).changes;
    expect(await authority.undo(first!.changeId, { kind: 'ai', sessionId: 'chat-1' })).toMatchObject({ ok: true });
    expect(ui().theme).toBe('matrix');
    expect(await authority.undo(first!.changeId, { kind: 'ai', sessionId: 'chat-1' })).toMatchObject({ ok: false, error: 'already-undone' });

    const [second] = (await authority.apply(AI, { domain: 'ui', set: { theme: 'dark' } })).changes;
    setUi({ theme: 'light' });
    expect(await authority.undo(second!.changeId, { kind: 'person', principal: 'desktop', id: 'renderer' })).toMatchObject({ ok: false, error: 'conflict', current: 'light' });
    expect(ui().theme).toBe('light');
    const view = await authority.conversation('chat-1');
    expect(view.changes).toMatchObject([{ target: 'theme', undone: true, conflict: false }, { target: 'theme', undone: false, conflict: true, current: 'light' }]);
  });

  it('leaves an undo that would raise a permission to the person, and only its own conversation’s changes to the AI', async () => {
    const { authority, profiles } = await setup({ profiles: [{ ...implement, permissionPreset: 'full-access' }] });
    const [lowered] = (await authority.apply(AI, { domain: 'agent', profile: { ...implement, permissionPreset: 'plan' } })).changes;
    expect(await authority.undo(lowered!.changeId, { kind: 'ai', sessionId: 'other-chat' })).toMatchObject({ ok: false, error: 'not-found' });
    expect(await authority.undo(lowered!.changeId, { kind: 'ai', sessionId: 'chat-1' })).toMatchObject({ ok: false, error: 'needs-person' });
    expect(await authority.undo(lowered!.changeId, { kind: 'person', principal: 'desktop', id: 'renderer' })).toMatchObject({ ok: true });
    expect(profiles()[0]!.permissionPreset).toBe('full-access');
  });

  it('never overwrites a person’s save that lands while the undo is under way (compared inside the store’s write)', async () => {
    const storeDir = await mkdtemp(path.join(os.tmpdir(), 'settings-authority-store-'));
    dirs.push(storeDir);
    const store = new ChatAgentProfileStore(storeDir);
    await store.init();
    await store.save({ ...implement, permissionPreset: 'full-access' });
    const { authority } = await setup({ profileStore: store });
    const [renamed] = (await authority.apply(AI, { domain: 'agent', profile: { ...implement, name: '구현', permissionPreset: 'full-access' } })).changes;
    // The person lowers it in Settings; the AI's undo is read before that save is written.
    const lowering = store.save({ ...implement, name: '구현', permissionPreset: 'plan' });
    const undone = authority.undo(renamed!.changeId, { kind: 'ai', sessionId: 'chat-1' });
    await lowering;
    expect(await undone).toMatchObject({ ok: false, error: 'conflict' });
    expect(store.list()).toEqual([{ ...implement, name: '구현', permissionPreset: 'plan' }]);
  });
});

describe('SettingsAuthority — an id removed and saved again', () => {
  it('starts it no higher than it was before the removal', async () => {
    const { authority, profiles } = await setup({ profiles: [{ ...implement, permissionPreset: 'plan' }] });
    await authority.apply(AI, { domain: 'agent', remove: 'implement' });
    await expect(authority.apply(AI, { domain: 'agent', profile: { ...implement, permissionPreset: 'standard' } })).rejects.toMatchObject({ code: 'needs-person' });
    await authority.apply(AI, { domain: 'agent', profile: { ...implement, permissionPreset: 'plan' } });
    expect(profiles()).toEqual([{ ...implement, permissionPreset: 'plan' }]);
    // A brand-new id still starts at 승인 후 실행.
    await authority.apply(AI, { domain: 'agent', profile: { ...implement, id: 'fresh', permissionPreset: 'standard' } });
  });

  it('keeps a template’s stage permissions the same way', async () => {
    const graph = createWorkflowGraph('feature', 'tpl');
    const template: WorkflowTemplate = { id: 'tpl-1', title: '내 절차', description: '', graph: { ...graph, nodes: graph.nodes.map((node) => ({ ...node, permissionPreset: 'plan' as const })) }, createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z' };
    const { authority } = await setup({ templates: [template] });
    await authority.apply(AI, { domain: 'template', remove: 'tpl-1' });
    const raised = { id: template.id, title: template.title, description: template.description, graph: { ...template.graph, nodes: template.graph.nodes.map((node) => ({ ...node, permissionPreset: 'standard' as const })) } };
    await expect(authority.apply(AI, { domain: 'template', template: raised })).rejects.toMatchObject({ code: 'needs-person' });
  });
});

describe('SettingsAuthority — proposals', () => {
  it('applies the change shown as the person who pressed it, and records that person', async () => {
    const { authority, profiles, dir } = await setup({ profiles: [implement] });
    await authority.propose(AI, { domain: 'agent', profile: { ...implement, permissionPreset: 'full-access' } });
    const request = { providerRequestId: 'settings-proposal:id-1', decision: 'allow' as const };
    expect(authority.authorizeProposal({ ...request, principal: DESKTOP })).toBeUndefined();
    await authority.proposalResolved({ ...request, principal: DESKTOP });
    expect(profiles()[0]!.permissionPreset).toBe('full-access');
    const file = JSON.parse(await readFile(path.join(dir, 'settings-changes.json'), 'utf8')) as { changes: Array<Record<string, unknown>> };
    expect(file.changes.at(-1)).toMatchObject({ actor: { kind: 'person', principal: 'desktop', id: 'renderer-agent-ui' }, proposedBy: { sessionId: 'chat-1', turnId: 'turn-1' } });
    expect((await authority.conversation('chat-1')).proposals).toMatchObject([{ id: 'id-1', state: 'applied', resolvedBy: 'desktop' }]);
  });

  it('refuses a phone for a PC-only proposal, a whole-conversation allow, and automations; a phone may apply a view proposal', async () => {
    const { authority, hostWrite } = await setup();
    await authority.propose(AI, { domain: 'host', set: { remoteAccess: true } });
    const remote = { providerRequestId: 'settings-proposal:id-1', decision: 'allow' as const };
    expect(authority.authorizeProposal({ ...remote, principal: PHONE })).toMatch(/Only the PC/u);
    expect(authority.authorizeProposal({ ...remote, principal: DESKTOP, response: { kind: 'session' } })).toMatch(/applied once/u);
    expect(authority.authorizeProposal({ ...remote, principal: { kind: 'cli', id: 'automation-runtime' } })).toMatch(/A person decides/u);
    expect(authority.authorizeProposal({ ...remote, principal: { kind: 'mcp', id: 'session-chat-1', sessionId: 'chat-1' } })).toMatch(/A person decides/u);
    // Declining stays possible on the phone.
    expect(authority.authorizeProposal({ ...remote, decision: 'deny', principal: PHONE })).toBeUndefined();
    await authority.proposalResolved({ ...remote, principal: DESKTOP });
    expect(hostWrite).toHaveBeenCalledWith('remoteAccess', true, { principal: 'desktop', id: 'renderer-agent-ui' });

    const view = await authority.propose(AI, { domain: 'ui', set: { theme: 'light' } });
    expect(view.desktopOnly).toBe(false);
    expect(authority.authorizeProposal({ providerRequestId: `settings-proposal:${view.proposalId}`, decision: 'allow', principal: PHONE })).toBeUndefined();
  });

  it('applies nothing when declined, and nothing when the setting changed since it was proposed', async () => {
    const { authority, ui, setUi } = await setup();
    const declined = await authority.propose(AI, { domain: 'ui', set: { theme: 'light' } });
    await authority.proposalResolved({ providerRequestId: `settings-proposal:${declined.proposalId}`, decision: 'deny', principal: DESKTOP });
    expect(ui().theme).toBe('matrix');
    const stale = await authority.propose(AI, { domain: 'ui', set: { theme: 'dark' } });
    setUi({ theme: 'light' });
    await authority.proposalResolved({ providerRequestId: `settings-proposal:${stale.proposalId}`, decision: 'allow', principal: DESKTOP });
    expect(ui().theme).toBe('light');
    expect((await authority.conversation('chat-1')).proposals.map((proposal) => proposal.state)).toEqual(['declined', 'failed']);
  });

  it('applies a 반복 proposal only at the workflow revision it showed (an edit since is not what the person saw)', async () => {
    let revision = 3;
    const write = vi.fn(async () => ({ ok: true as const }));
    const { authority } = await setup({ workflow: { read: async () => ({ title: '정기 점검', revision, autoApprove: false, repeat: null }), write } });
    const repeat = { cadence: 'daily' as const, time: '09:00', timezone: 'Asia/Seoul', enabled: true };
    const stale = await authority.propose(AI, { domain: 'workflow', subprojectId: 'sp-1', set: { repeat } });
    revision = 4;
    await authority.proposalResolved({ providerRequestId: `settings-proposal:${stale.proposalId}`, decision: 'allow', principal: DESKTOP });
    expect(write).not.toHaveBeenCalled();
    const current = await authority.propose(AI, { domain: 'workflow', subprojectId: 'sp-1', set: { repeat } });
    await authority.proposalResolved({ providerRequestId: `settings-proposal:${current.proposalId}`, decision: 'allow', principal: DESKTOP });
    expect(write).toHaveBeenCalledWith('project-1', 'sp-1', { repeat }, { principal: 'desktop', id: 'renderer-agent-ui' }, 4);
    expect((await authority.conversation('chat-1')).proposals.map((proposal) => proposal.state)).toEqual(['failed', 'applied']);
  });

  it('keeps at most three proposals waiting; an expired one no longer counts', async () => {
    let state: 'pending' | 'expired' = 'pending';
    const { authority } = await setup({ approvalState: () => state });
    for (const theme of ['light', 'dark']) await authority.propose(AI, { domain: 'ui', set: { theme } });
    await authority.propose(AI, { domain: 'host', set: { orchestration: true } });
    await expect(authority.propose(AI, { domain: 'host', set: { startAtLogin: true } })).rejects.toMatchObject({ code: 'limit' });
    state = 'expired';
    await expect(authority.propose(AI, { domain: 'host', set: { startAtLogin: true } })).resolves.toMatchObject({ desktopOnly: true });
  });

  it('turns the 자문 switch on only from a person', async () => {
    const { authority } = await setup();
    expect(authority.advisorEnabled()).toBe(false);
    await authority.propose(AI, { domain: 'host', set: { advisor: true } });
    expect(authority.advisorEnabled()).toBe(false);
    await authority.proposalResolved({ providerRequestId: 'settings-proposal:id-1', decision: 'allow', principal: DESKTOP });
    expect(authority.advisorEnabled()).toBe(true);
  });
});

describe('settingsConversationAllowed — only a conversation a person sees directly', () => {
  const base = (): Pick<DaemonSnapshot, 'sessions' | 'agents' | 'agentRelations'> => ({
    sessions: ['chat-1', 'child-1', 'scheduled-agent-0123', 'advisor-1'].map((id) => ({ id, projectId: 'p', workspaceId: 'w', kind: 'agent' as const, title: id, state: 'idle' as const, source: 'structured' as const, revision: 1, createdAt: '', updatedAt: '' })),
    agents: [],
    agentRelations: [{ id: 'r', treeId: 'chat-1', parentSessionId: 'chat-1', childSessionId: 'child-1', owner: 'managed', depth: 1, revision: 1, createdAt: '', updatedAt: '' }],
  });
  it('excludes prepared, scheduled, advisor and child sessions, and turns no person sent', () => {
    const snapshot = base();
    expect(settingsConversationAllowed(snapshot, 'chat-1', { prepared: false })).toBe(true);
    expect(settingsConversationAllowed(snapshot, 'chat-1', { prepared: true })).toBe(false);
    expect(settingsConversationAllowed(snapshot, 'child-1', { prepared: false })).toBe(false);
    expect(settingsConversationAllowed(snapshot, 'scheduled-agent-0123', { prepared: false })).toBe(false);
    expect(settingsConversationAllowed(snapshot, 'advisor-1', { prepared: false })).toBe(false);
    expect(settingsConversationAllowed(snapshot, 'chat-1', { prepared: false, turnPrincipal: 'desktop' })).toBe(true);
    expect(settingsConversationAllowed(snapshot, 'chat-1', { prepared: false, turnPrincipal: 'android' })).toBe(true);
    expect(settingsConversationAllowed(snapshot, 'chat-1', { prepared: false, turnPrincipal: 'cli' })).toBe(false);
    expect(settingsConversationAllowed(snapshot, 'chat-1', { prepared: false, turnPrincipal: null })).toBe(false);
  });
});

describe('AgentAdvisor (자문)', () => {
  const review: ChatAgentProfile = { id: 'review', name: '교차 검토', providerId: 'codex', model: 'gpt-6-astra', reasoningEffort: 'xhigh', permissionPreset: 'standard' };
  function advisor(enabled: boolean, reviewAgent: ChatAgentProfile | null = review) {
    const sessions: Array<{ id: string }> = [];
    const agents: Array<Record<string, unknown>> = [];
    const turns: Array<Record<string, unknown>> = [];
    const commands: Array<{ type: string; payload: Record<string, unknown>; principal: unknown }> = [];
    let id = 0;
    const instance = new AgentAdvisor({
      enabled: () => enabled,
      reviewAgent: () => reviewAgent ?? undefined,
      getSnapshot: () => ({ revision: 1, sessions, agents, turns }) as unknown as DaemonSnapshot,
      execute: async (command) => {
        commands.push(command as never);
        if (command.type === 'agent.create') {
          const sessionId = command.payload.sessionId;
          sessions.push({ id: sessionId });
          agents.push({ sessionId, state: 'idle', queuedTurnCount: 0 });
          turns.push({ id: `turn-${sessionId}`, sessionId, state: 'completed', finishedAt: '2026-10-29T00:00:01.000Z' });
        }
        return { ok: true, status: 'applied', commandId: command.commandId, revision: 2, eventSequence: 2 };
      },
      onEvent: () => () => undefined,
      readTranscript: (sessionId) => [{ id: 'a', sessionId, sequence: 1, turnId: `turn-${sessionId}`, kind: 'assistant-message', text: '그대로 두세요.', isDelta: false, isSensitive: false, createdAt: '' }] as never,
      createId: () => String(++id),
    });
    return { instance, commands };
  }
  const caller = { sessionId: 'chat-1', turnId: 'turn-1', workspaceId: 'workspace-1' };

  it('is off until a person turns it on, and needs a linked review agent', async () => {
    expect(await advisor(false).instance.ask(caller, '이 방향이 맞나요?')).toMatchObject({ ok: false, error: expect.stringContaining('off') });
    expect(await advisor(true, null).instance.ask(caller, '이 방향이 맞나요?')).toMatchObject({ ok: false, error: expect.stringContaining('review agent') });
  });

  it('asks the review agent read-only, ends its conversation, and keeps to the per-turn limit', async () => {
    const { instance, commands } = advisor(true);
    expect(await instance.ask(caller, '이 방향이 맞나요?')).toEqual({ ok: true, answer: '그대로 두세요.', truncated: false });
    expect(commands[0]).toMatchObject({ type: 'agent.create', principal: { kind: 'cli', id: 'advisor-runtime' },
      payload: { sessionId: 'advisor-1', providerId: 'codex', model: 'gpt-6-astra', reasoningEffort: 'xhigh', permissionPreset: 'plan', workspaceId: 'workspace-1' } });
    expect(commands.map((command) => command.type)).toEqual(['agent.create', 'agent.archive']);
    expect(instance.preparedSessionSettings('advisor-1')).toEqual({ permissionPreset: 'plan', reasoningEffort: 'xhigh' });
    expect(instance.preparedSessionSettings('chat-1')).toBeUndefined();
    for (let call = 1; call < ADVISOR_CALLS_PER_TURN; call += 1) await instance.ask(caller, '하나 더');
    expect(await instance.ask(caller, '또 하나')).toMatchObject({ ok: false, error: expect.stringContaining('per turn') });
    expect(await instance.ask({ ...caller, turnId: 'turn-2' }, '다음 차례')).toMatchObject({ ok: true });
  });
});
