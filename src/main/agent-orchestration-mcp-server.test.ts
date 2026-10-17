import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  DaemonCommand,
  DaemonCommandReceipt,
  DaemonSnapshot,
} from '../shared/daemon-protocol';
import { AgentOrchestrationMcpServer } from './agent-orchestration-mcp-server';
import { WorkflowAuthority } from './workflow-authority';
import { LocalMutationIngress } from './local-mutation-ingress';
import { createWorkflowGraph } from '../shared/workflow';

const NOW = '2026-09-04T00:00:00.000Z';
const servers: AgentOrchestrationMcpServer[] = [];

function snapshot(): DaemonSnapshot {
  return {
    protocolVersion: 12,
    revision: 7,
    eventSequence: 12,
    generatedAt: NOW,
    runtime: {
      keepRunning: false,
      startAtLogin: false,
      orchestrationToolsEnabled: true,
      browserEnabled: false,
    },
    projects: [{
      id: 'project-1', name: 'Project', rootPath: 'C:\\repo', source: 'native',
      revision: 1, createdAt: NOW, updatedAt: NOW,
    }],
    workspaces: [{
      id: 'workspace-1', projectId: 'project-1', name: 'Workspace', kind: 'local',
      rootPath: 'C:\\repo', revision: 1, createdAt: NOW, updatedAt: NOW,
    }],
    sessions: [{
      id: 'lead-1', projectId: 'project-1', workspaceId: 'workspace-1', kind: 'agent',
      title: 'Lead', state: 'idle', source: 'structured',
      revision: 2, createdAt: NOW, updatedAt: NOW,
    }],
    agents: [{
      sessionId: 'lead-1', providerId: 'codex', permissionPreset: 'standard', state: 'idle',
      queuedTurnCount: 0, orchestrationEnabled: true,
      revision: 2, createdAt: NOW, updatedAt: NOW,
    }],
    agentRelations: [],
    turns: [],
    transcriptHeads: [],
    approvals: [],
    providers: [{
      id: 'codex', displayName: 'Codex', protocol: 'codex-app-server',
      executablePath: 'C:\\tools\\codex.exe', executableVersion: '1.0.0', argv: ['app-server'],
      environmentVariableNames: [], capabilities: ['sessions'], reviewDigest: 'reviewed-codex',
      enabled: true, health: 'ready',
      revision: 1, createdAt: NOW, updatedAt: NOW,
    }],
    schedules: [],
    heartbeats: [],
  };
}

function withOwnerPermission(
  current: DaemonSnapshot,
  permissionPreset: DaemonSnapshot['agents'][number]['permissionPreset'],
): DaemonSnapshot {
  return {
    ...current,
    agents: current.agents.map((agent) => (
      agent.sessionId === 'lead-1' ? { ...agent, permissionPreset } : agent
    )),
  };
}

function withManagedChild(
  current: DaemonSnapshot,
  permissionPreset: DaemonSnapshot['agents'][number]['permissionPreset'],
): DaemonSnapshot {
  const ownerSession = current.sessions.find((session) => session.id === 'lead-1')!;
  return {
    ...current,
    sessions: [...current.sessions, {
      ...ownerSession,
      id: 'child-1',
      title: 'Child',
    }],
    agents: [...current.agents, {
      sessionId: 'child-1', providerId: 'codex', permissionPreset, state: 'idle',
      queuedTurnCount: 0, orchestrationEnabled: true,
      revision: 1, createdAt: NOW, updatedAt: NOW,
    }],
    agentRelations: [...current.agentRelations, {
      id: 'relation-1', treeId: 'lead-1', parentSessionId: 'lead-1', childSessionId: 'child-1',
      owner: 'managed', depth: 1,
      revision: 1, createdAt: NOW, updatedAt: NOW,
    }],
  };
}

function withSecondProject(current: DaemonSnapshot): DaemonSnapshot {
  const project = current.projects[0]!;
  const workspace = current.workspaces[0]!;
  const session = current.sessions[0]!;
  const agent = current.agents[0]!;
  return {
    ...current,
    projects: [...current.projects, {
      ...project,
      id: 'project-2',
      name: 'Other Project',
      rootPath: 'C:\\other',
    }],
    workspaces: [...current.workspaces, {
      ...workspace,
      id: 'workspace-2',
      projectId: 'project-2',
      name: 'Other Workspace',
      rootPath: 'C:\\other',
    }],
    sessions: [...current.sessions, {
      ...session,
      id: 'lead-2',
      projectId: 'project-2',
      workspaceId: 'workspace-2',
      title: 'Other Lead',
    }],
    agents: [...current.agents, {
      ...agent,
      sessionId: 'lead-2',
    }],
  };
}

function applied(command: DaemonCommand): DaemonCommandReceipt {
  return {
    ok: true,
    status: 'applied',
    commandId: command.commandId,
    revision: 8,
    eventSequence: 13,
  };
}

async function post(
  endpoint: string,
  token: string | undefined,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<{ readonly status: number; readonly value: Record<string, unknown> | null }> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    value: response.status === 202 ? null : await response.json() as Record<string, unknown>,
  };
}

function rpc(id: number, method: string, params?: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

describe('AgentOrchestrationMcpServer', () => {
  it.each([
    { label: 'native Codex request metadata', meta: { threadId: 'native-thread', progressToken: 1 } },
    { label: 'string progress metadata', meta: { progressToken: 'native-progress' } },
    { label: 'empty request metadata', meta: {} },
    { label: 'no request metadata', meta: undefined },
  ])('reads workflows with $label without passing metadata to workflow authority', async ({ meta }) => {
    const read = vi.fn(async () => ({ ok: true as const, snapshot: { projectId: 'project-1' } }));
    const service = { previewForSession: () => undefined } as unknown as import('./workflow-service').WorkflowService;
    const workflow = { read } as unknown as WorkflowAuthority;
    const server = new AgentOrchestrationMcpServer({ authority: { getSnapshot: () => snapshot(), execute: vi.fn() }, workflow: () => ({ service, authority: workflow }), workflowAllowed: () => true });
    servers.push(server);
    await server.start();
    const descriptor = server.descriptorForSession('lead-1');
    const result = await post(descriptor.endpoint, descriptor.bearerToken, rpc(1, 'tools/call', {
      name: 'workflow_read', arguments: {}, ...(meta === undefined ? {} : { _meta: meta }),
    }));
    expect(result).toMatchObject({ status: 200, value: { result: { content: [{ text: '{"ok":true,"snapshot":{"projectId":"project-1"},"preview":null}' }] } } });
    expect(read.mock.calls).toEqual([['project-1']]);
  });
  it('rejects malformed tool-call metadata and extra envelope fields before dispatch', async () => {
    const read = vi.fn();
    const service = { previewForSession: () => undefined } as unknown as import('./workflow-service').WorkflowService;
    const server = new AgentOrchestrationMcpServer({ authority: { getSnapshot: () => snapshot(), execute: vi.fn() }, workflow: () => ({ service, authority: { read } as unknown as WorkflowAuthority }), workflowAllowed: () => true });
    servers.push(server);
    await server.start();
    const descriptor = server.descriptorForSession('lead-1');
    for (const invalid of [
      { _meta: null }, { _meta: [] }, { _meta: 'metadata' },
      { _meta: { progressToken: null } }, { _meta: { progressToken: true } },
      { _meta: { progressToken: {} } }, { _meta: { progressToken: 1.5 } },
      { _meta: {}, projectId: 'project-2' },
    ]) {
      expect(await post(descriptor.endpoint, descriptor.bearerToken, rpc(1, 'tools/call', {
        name: 'workflow_read', arguments: {}, ...invalid,
      }))).toMatchObject({ value: { error: { code: -32602 } } });
    }
    expect(read).not.toHaveBeenCalled();
  });
  it('keeps workflow arguments strict and the session principal authoritative when metadata is present', async () => {
    const execute = vi.fn(async () => ({ ok: false as const, error: 'conflict', message: 'revision conflict' }));
    const service = {} as unknown as import('./workflow-service').WorkflowService;
    const server = new AgentOrchestrationMcpServer({ authority: { getSnapshot: () => snapshot(), execute: vi.fn() }, workflow: () => ({ service, authority: { execute } as unknown as WorkflowAuthority }), workflowAllowed: () => true });
    servers.push(server);
    await server.start();
    const descriptor = server.descriptorForSession('lead-1');
    const command = { type: 'subproject.update', commandId: 'command-1', projectId: 'project-1', hostId: 'host-1', subprojectId: 'subproject-1', expectedRevision: 2, payload: { title: 'Edited' } };
    const meta = { progressToken: 1, threadId: 'forged-thread', principal: { kind: 'desktop', id: 'forged-owner' }, commandId: 'forged-command', expectedRevision: 99, projectId: 'project-2' };
    for (const args of [
      { ...command, _meta: {} }, { ...command, principal: meta.principal },
      { ...command, projectId: 'project-2' }, { ...command, expectedRevision: undefined },
      { ...command, commandId: undefined }, { ...command, payload: { title: 'Edited', bypass: true } },
    ]) {
      expect(await post(descriptor.endpoint, descriptor.bearerToken, rpc(1, 'tools/call', {
        name: 'workflow_command', arguments: args, _meta: meta,
      }))).toMatchObject({ value: { result: { isError: true } } });
    }
    expect(execute).not.toHaveBeenCalled();
    expect(await post(descriptor.endpoint, descriptor.bearerToken, rpc(2, 'tools/call', {
      name: 'workflow_command', arguments: command, _meta: meta,
    }))).toMatchObject({ value: { result: { isError: true, content: [{ text: '{"ok":false,"error":"conflict","message":"revision conflict"}' }] } } });
    expect(execute.mock.calls).toEqual([[command, { kind: 'ai', id: 'session:lead-1', sessionId: 'lead-1' }]]);
  });
  it('offers workflow tools on a zero-turn ordinary session and fences preview edits during shutdown', async () => {
    const base = snapshot(); const current = { ...base, runtime: { ...base.runtime, orchestrationToolsEnabled: false } };
    let allowed = true;
    const editPreview = vi.fn(async () => ({ ok: true as const, preview: null }));
    const service = { editPreview, previewForSession: () => undefined } as unknown as import('./workflow-service').WorkflowService;
    const ingress = new LocalMutationIngress('workflow test');
    const workflow = new WorkflowAuthority({ service, ready: Promise.resolve(), ingress, available: () => true });
    const server = new AgentOrchestrationMcpServer({ authority: { getSnapshot: () => current, execute: vi.fn() }, workflow: () => ({ service, authority: workflow }), workflowAllowed: () => allowed });
    servers.push(server); await server.start(); const descriptor = server.descriptorForSession('lead-1');
    const listed = await post(descriptor.endpoint, descriptor.bearerToken, rpc(1, 'tools/list'));
    expect(JSON.stringify(listed.value)).toContain('preview_workflow'); expect(JSON.stringify(listed.value)).not.toContain('spawn_agent');
    const args = { commandId: 'preview-edit', previewId: 'preview', expectedRevision: 0, graph: createWorkflowGraph('research', 'preview') };
    expect(await post(descriptor.endpoint, descriptor.bearerToken, rpc(2, 'tools/call', { name: 'preview_workflow', arguments: args }))).toMatchObject({ value: { result: { content: [{ text: '{"ok":true,"preview":null}' }] } } });
    expect(editPreview).toHaveBeenCalledOnce();
    await ingress.closeAndDrain();
    expect(await post(descriptor.endpoint, descriptor.bearerToken, rpc(3, 'tools/call', { name: 'preview_workflow', arguments: args }))).toMatchObject({ value: { result: { isError: true } } });
    expect(editPreview).toHaveBeenCalledOnce();
    allowed = false;
    const blocked = await post(descriptor.endpoint, descriptor.bearerToken, rpc(4, 'tools/list'));
    expect(JSON.stringify(blocked.value)).not.toContain('preview_workflow');
  });
  it('binds only a capability endpoint and negotiates stateless MCP', async () => {
    const authority = {
      getSnapshot: () => snapshot(),
      execute: vi.fn(async (command: DaemonCommand) => applied(command)),
    };
    const server = new AgentOrchestrationMcpServer({ authority });
    servers.push(server);
    await server.start();
    const descriptor = server.descriptorForSession('lead-1');

    const unauthorized = await post(descriptor.endpoint, undefined, rpc(1, 'initialize'));
    expect(unauthorized.status).toBe(401);
    const crossOrigin = await post(
      descriptor.endpoint,
      descriptor.bearerToken,
      rpc(1, 'initialize'),
      { origin: 'https://attacker.example' },
    );
    expect(crossOrigin.status).toBe(403);

    const initialized = await post(descriptor.endpoint, descriptor.bearerToken, rpc(2, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    }));
    expect(initialized).toMatchObject({
      status: 200,
      value: {
        jsonrpc: '2.0',
        id: 2,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: { listChanged: false } },
        },
      },
    });
    const notification = await post(descriptor.endpoint, descriptor.bearerToken, {
      jsonrpc: '2.0', method: 'notifications/initialized',
    });
    expect(notification).toEqual({ status: 202, value: null });
  });

  it('creates only a direct child in the owner workspace with an MCP principal', async () => {
    const commands: DaemonCommand[] = [];
    const ids = ['child-id', 'command-id'];
    const authority = {
      getSnapshot: () => snapshot(),
      execute: vi.fn(async (command: DaemonCommand) => {
        commands.push(command);
        return applied(command);
      }),
    };
    const server = new AgentOrchestrationMcpServer({
      authority,
      createId: () => ids.shift()!,
    });
    servers.push(server);
    await server.start();
    const descriptor = server.descriptorForSession('lead-1');
    const response = await post(descriptor.endpoint, descriptor.bearerToken, rpc(3, 'tools/call', {
      name: 'create_agent',
      arguments: {
        providerId: 'claude',
        title: 'Research',
        prompt: 'Investigate this module.',
        permissionPreset: 'standard',
      },
    }));

    expect(response.status).toBe(200);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      commandId: 'mcp-command-command-id',
      expectedRevision: 7,
      principal: { kind: 'mcp', id: 'session-lead-1', sessionId: 'lead-1' },
      type: 'agent.create',
      payload: {
        sessionId: 'agent-child-id',
        workspaceId: 'workspace-1',
        providerId: 'claude',
        parentSessionId: 'lead-1',
        initialPrompt: 'Investigate this module.',
        permissionPreset: 'standard',
      },
    });
  });

  it('lists saved profiles and starts a child from one within the owner permission', async () => {
    const current = withOwnerPermission(snapshot(), 'standard');
    const commands: DaemonCommand[] = [];
    const authority = {
      getSnapshot: () => current,
      execute: vi.fn(async (command: DaemonCommand) => {
        commands.push(command);
        return applied(command);
      }),
    };
    const profiles = [
      { id: 'reviewer', name: 'Careful reviewer', providerId: 'claude', model: 'opus', reasoningEffort: 'high', permissionPreset: 'plan' as const, whenToUse: 'Review without editing.' },
      { id: 'builder', name: 'Builder', providerId: 'codex', permissionPreset: 'full-access' as const },
    ];
    const ids = ['profile-child', 'profile-command'];
    const server = new AgentOrchestrationMcpServer({ authority, createId: () => ids.shift()!, listProfiles: () => profiles });
    servers.push(server);
    await server.start();
    const descriptor = server.descriptorForSession('lead-1');

    const listed = await post(descriptor.endpoint, descriptor.bearerToken, rpc(4, 'tools/list'));
    expect((listed.value?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toContain('list_profiles');
    const read = await post(descriptor.endpoint, descriptor.bearerToken, rpc(5, 'tools/call', { name: 'list_profiles', arguments: {} }));
    const body = JSON.parse((read.value?.result as { content: Array<{ text: string }> }).content[0]!.text) as { profiles: Array<{ profileId: string; usable: boolean; whenToUse?: string }> };
    expect(body.profiles).toEqual([
      expect.objectContaining({ profileId: 'reviewer', usable: true, whenToUse: 'Review without editing.' }),
      expect.objectContaining({ profileId: 'builder', usable: false }),
    ]);

    await post(descriptor.endpoint, descriptor.bearerToken, rpc(6, 'tools/call', {
      name: 'create_agent', arguments: { profileId: 'reviewer', prompt: 'Review the login change.' },
    }));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: 'agent.create',
      payload: { title: 'Careful reviewer', providerId: 'claude', model: 'opus', reasoningEffort: 'high', permissionPreset: 'plan', parentSessionId: 'lead-1' },
    });

    const above = await post(descriptor.endpoint, descriptor.bearerToken, rpc(7, 'tools/call', {
      name: 'create_agent', arguments: { profileId: 'builder', prompt: 'Escalate.' },
    }));
    const mixed = await post(descriptor.endpoint, descriptor.bearerToken, rpc(8, 'tools/call', {
      name: 'create_agent', arguments: { profileId: 'reviewer', providerId: 'codex', prompt: 'Both.' },
    }));
    const unknown = await post(descriptor.endpoint, descriptor.bearerToken, rpc(9, 'tools/call', {
      name: 'create_agent', arguments: { profileId: 'missing', prompt: 'Nobody.' },
    }));
    for (const response of [above, mixed, unknown]) expect(JSON.stringify(response.value)).toMatch(/isError|error/u);
    expect(commands).toHaveLength(1);
  });

  it('caps omitted plan-owner child permissions at plan and advertises the same ceiling', async () => {
    const current = withOwnerPermission(snapshot(), 'plan');
    const commands: DaemonCommand[] = [];
    const ids = ['plan-child', 'plan-command'];
    const authority = {
      getSnapshot: () => current,
      execute: vi.fn(async (command: DaemonCommand) => {
        commands.push(command);
        return applied(command);
      }),
    };
    const server = new AgentOrchestrationMcpServer({
      authority,
      createId: () => ids.shift()!,
    });
    servers.push(server);
    await server.start();
    const descriptor = server.descriptorForSession('lead-1');

    const listed = await post(descriptor.endpoint, descriptor.bearerToken, rpc(4, 'tools/list'));
    const definitions = (listed.value?.result as {
      tools: Array<{
        name: string;
        description: string;
        inputSchema: { properties: { permissionPreset?: { enum: string[] } } };
      }>;
    }).tools;
    const createDefinition = definitions.find((tool) => tool.name === 'create_agent')!;
    expect(createDefinition.inputSchema.properties.permissionPreset?.enum).toEqual(['plan']);
    expect(createDefinition.description).toContain('defaults to plan');

    await post(descriptor.endpoint, descriptor.bearerToken, rpc(5, 'tools/call', {
      name: 'create_agent',
      arguments: { providerId: 'codex', prompt: 'Stay within the plan capability.' },
    }));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: 'agent.create',
      payload: { permissionPreset: 'plan', parentSessionId: 'lead-1' },
    });
  });

  it('rejects plan-to-full create and set requests before authority mutation', async () => {
    const current = withManagedChild(withOwnerPermission(snapshot(), 'plan'), 'plan');
    const authority = {
      getSnapshot: () => current,
      execute: vi.fn(async (command: DaemonCommand) => applied(command)),
    };
    const server = new AgentOrchestrationMcpServer({ authority });
    servers.push(server);
    await server.start();
    const descriptor = server.descriptorForSession('lead-1');

    const create = await post(descriptor.endpoint, descriptor.bearerToken, rpc(6, 'tools/call', {
      name: 'create_agent',
      arguments: {
        providerId: 'codex', prompt: 'Escalate.', permissionPreset: 'full-access',
      },
    }));
    const set = await post(descriptor.endpoint, descriptor.bearerToken, rpc(7, 'tools/call', {
      name: 'set_agent',
      arguments: { sessionId: 'child-1', permissionPreset: 'full-access' },
    }));

    expect(create).toMatchObject({ value: { result: { isError: true } } });
    expect(set).toMatchObject({ value: { result: { isError: true } } });
    expect(authority.execute).not.toHaveBeenCalled();
  });

  it('prevents a downgraded owner capability from messaging a higher-permission child', async () => {
    let current = withManagedChild(withOwnerPermission(snapshot(), 'full-access'), 'full-access');
    const authority = {
      getSnapshot: () => current,
      execute: vi.fn(async (command: DaemonCommand) => applied(command)),
    };
    const server = new AgentOrchestrationMcpServer({ authority });
    servers.push(server);
    await server.start();
    const descriptor = server.descriptorForSession('lead-1');

    current = withOwnerPermission(current, 'plan');
    const sent = await post(descriptor.endpoint, descriptor.bearerToken, rpc(8, 'tools/call', {
      name: 'send_message',
      arguments: { sessionId: 'child-1', prompt: 'Continue with elevated access.' },
    }));

    expect(sent).toMatchObject({ value: { result: { isError: true } } });
    expect(authority.execute).not.toHaveBeenCalled();

    const canceled = await post(descriptor.endpoint, descriptor.bearerToken, rpc(9, 'tools/call', {
      name: 'cancel_agent',
      arguments: { sessionId: 'child-1' },
    }));
    expect(canceled.status).toBe(200);
    expect(authority.execute).toHaveBeenCalledOnce();
    expect(authority.execute.mock.calls[0]?.[0]).toMatchObject({
      type: 'agent.cancel', payload: { sessionId: 'child-1' },
    });
  });

  it('allows a full-access owner to configure a full-access managed child', async () => {
    const current = withManagedChild(withOwnerPermission(snapshot(), 'full-access'), 'full-access');
    const commands: DaemonCommand[] = [];
    const authority = {
      getSnapshot: () => current,
      execute: vi.fn(async (command: DaemonCommand) => {
        commands.push(command);
        return applied(command);
      }),
    };
    const server = new AgentOrchestrationMcpServer({ authority, createId: () => 'full-command' });
    servers.push(server);
    await server.start();
    const descriptor = server.descriptorForSession('lead-1');

    const configured = await post(descriptor.endpoint, descriptor.bearerToken, rpc(10, 'tools/call', {
      name: 'set_agent',
      arguments: {
        sessionId: 'child-1', model: 'trusted-model', permissionPreset: 'full-access',
      },
    }));

    expect(configured.status).toBe(200);
    expect((configured.value?.result as { isError?: boolean }).isError).toBeUndefined();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: 'agent.set-settings',
      payload: {
        sessionId: 'child-1', model: 'trusted-model', permissionPreset: 'full-access',
      },
    });
  });

  it('archives only through the session-scoped managed-descendant command surface', async () => {
    const current = snapshot();
    const revisioned = current.sessions[0]!;
    const childSession: DaemonSnapshot['sessions'][number] = {
      revision: revisioned.revision,
      createdAt: revisioned.createdAt,
      updatedAt: revisioned.updatedAt,
      id: 'child-1', projectId: 'project-1', workspaceId: 'workspace-1', kind: 'agent',
      title: 'Child', state: 'completed', source: 'structured',
    };
    const childAgent: DaemonSnapshot['agents'][number] = {
      revision: revisioned.revision,
      createdAt: revisioned.createdAt,
      updatedAt: revisioned.updatedAt,
      sessionId: 'child-1', providerId: 'codex', permissionPreset: 'standard', state: 'done',
      queuedTurnCount: 0, orchestrationEnabled: true,
    };
    const relation: DaemonSnapshot['agentRelations'][number] = {
      revision: revisioned.revision,
      createdAt: revisioned.createdAt,
      updatedAt: revisioned.updatedAt,
      id: 'relation-1', treeId: 'lead-1', parentSessionId: 'lead-1', childSessionId: 'child-1',
      owner: 'managed', depth: 1,
    };
    const scoped = {
      ...current,
      sessions: [...current.sessions, childSession],
      agents: [...current.agents, childAgent],
      agentRelations: [relation],
    };
    const commands: DaemonCommand[] = [];
    const authority = {
      getSnapshot: () => scoped,
      execute: vi.fn(async (command: DaemonCommand) => {
        commands.push(command);
        return applied(command);
      }),
    };
    const server = new AgentOrchestrationMcpServer({ authority, createId: () => 'archive-command' });
    servers.push(server);
    await server.start();
    const descriptor = server.descriptorForSession('lead-1');

    const listed = await post(descriptor.endpoint, descriptor.bearerToken, rpc(4, 'tools/list'));
    const definitions = (listed.value?.result as { tools: Array<{ name: string }> }).tools;
    const toolNames = definitions.map((tool) => tool.name);
    expect(toolNames).toContain('archive_agent');
    expect(toolNames.some((name) => /project|provider|schedule/u.test(name))).toBe(false);

    const archived = await post(descriptor.endpoint, descriptor.bearerToken, rpc(5, 'tools/call', {
      name: 'archive_agent', arguments: { sessionId: 'child-1' },
    }));
    expect(archived.status).toBe(200);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      principal: { kind: 'mcp', id: 'session-lead-1', sessionId: 'lead-1' },
      type: 'agent.archive',
      payload: { sessionId: 'child-1' },
    });

    const unrelated = await post(descriptor.endpoint, descriptor.bearerToken, rpc(6, 'tools/call', {
      name: 'archive_agent', arguments: { sessionId: 'unrelated-1' },
    }));
    const result = unrelated.value?.result as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(commands).toHaveLength(1);
  });

  it('rotates bearer capabilities and revokes them when orchestration is disabled', async () => {
    const current = snapshot();
    const tokens = ['a'.repeat(40), 'b'.repeat(40)];
    const authority = {
      getSnapshot: () => current,
      execute: vi.fn(async (command: DaemonCommand) => applied(command)),
    };
    const server = new AgentOrchestrationMcpServer({
      authority,
      createToken: () => tokens.shift()!,
    });
    servers.push(server);
    await server.start();
    const first = server.descriptorForSession('lead-1');
    const second = server.descriptorForSession('lead-1');

    await expect(post(first.endpoint, first.bearerToken, rpc(1, 'ping')))
      .resolves.toMatchObject({ status: 401 });
    await expect(post(second.endpoint, second.bearerToken, rpc(2, 'ping')))
      .resolves.toMatchObject({ status: 200 });

    (current.runtime as { orchestrationToolsEnabled: boolean }).orchestrationToolsEnabled = false;
    const disabled = await post(second.endpoint, second.bearerToken, rpc(3, 'tools/list'));
    expect(disabled).toMatchObject({
      status: 200,
      value: { error: { code: -32002 } },
    });
  });

  it('revokes every issued capability for one Project after its sessions leave the snapshot', async () => {
    let current = withSecondProject(withManagedChild(snapshot(), 'standard'));
    const authority = {
      getSnapshot: () => current,
      execute: vi.fn(async (command: DaemonCommand) => applied(command)),
    };
    const server = new AgentOrchestrationMcpServer({ authority });
    servers.push(server);
    await server.start();
    const lead = server.descriptorForSession('lead-1');
    const child = server.descriptorForSession('child-1');
    const unrelated = server.descriptorForSession('lead-2');

    current = {
      ...current,
      projects: current.projects.filter((project) => project.id !== 'project-1'),
      workspaces: current.workspaces.filter((workspace) => workspace.projectId !== 'project-1'),
      sessions: current.sessions.filter((session) => session.projectId !== 'project-1'),
      agents: current.agents.filter((agent) => agent.sessionId === 'lead-2'),
      agentRelations: [],
    };
    server.revokeProject('project-1');
    server.revokeProject('project-1');

    for (const descriptor of [lead, child]) {
      await expect(post(descriptor.endpoint, descriptor.bearerToken, rpc(10, 'ping')))
        .resolves.toMatchObject({ status: 401 });
    }
    await expect(post(unrelated.endpoint, unrelated.bearerToken, rpc(11, 'ping')))
      .resolves.toMatchObject({ status: 200 });
    expect(authority.execute).not.toHaveBeenCalled();
  });

  it('rejects descriptor issuance when a delayed create afterCommit loses to Project revocation', async () => {
    let current = snapshot();
    const createToken = vi.fn(() => 'c'.repeat(40));
    const authority = {
      getSnapshot: () => current,
      execute: vi.fn(async (command: DaemonCommand) => applied(command)),
    };
    const server = new AgentOrchestrationMcpServer({ authority, createToken });
    servers.push(server);
    await server.start();
    const issuedBeforeRevoke = server.descriptorForSession('lead-1');
    server.revokeProject('project-1');
    createToken.mockClear();

    current = {
      ...current,
      projects: current.projects.map((project) => ({ ...project, archivedAt: NOW })),
    };
    const delayedCreateAfterCommit = (): unknown => server.descriptorForSession('lead-1');

    expect(delayedCreateAfterCommit).toThrow('capability is no longer active');
    expect(createToken).not.toHaveBeenCalled();
    await expect(post(issuedBeforeRevoke.endpoint, issuedBeforeRevoke.bearerToken, rpc(12, 'ping')))
      .resolves.toMatchObject({ status: 401 });
    expect(authority.execute).not.toHaveBeenCalled();
  });

  it('invalidates an existing capability when the owner provider is disabled or unhealthy', async () => {
    let current = snapshot();
    const authority = {
      getSnapshot: () => current,
      execute: vi.fn(async (command: DaemonCommand) => applied(command)),
    };
    const server = new AgentOrchestrationMcpServer({ authority });
    servers.push(server);
    await server.start();
    const descriptor = server.descriptorForSession('lead-1');

    current = {
      ...current,
      providers: current.providers.map((provider) => ({ ...provider, enabled: false })),
    };
    const disabled = await post(descriptor.endpoint, descriptor.bearerToken, rpc(11, 'ping'));
    expect(disabled).toMatchObject({ value: { error: { code: -32002 } } });

    current = {
      ...current,
      providers: current.providers.map((provider) => ({
        ...provider,
        enabled: true,
        health: 'unavailable',
      })),
    };
    const unhealthy = await post(descriptor.endpoint, descriptor.bearerToken, rpc(12, 'initialize'));
    expect(unhealthy).toMatchObject({ value: { error: { code: -32002 } } });
    expect(authority.execute).not.toHaveBeenCalled();
  });

  it('invalidates an existing capability when its Project or Workspace is archived', async () => {
    let current = snapshot();
    const authority = {
      getSnapshot: () => current,
      execute: vi.fn(async (command: DaemonCommand) => applied(command)),
    };
    const server = new AgentOrchestrationMcpServer({ authority });
    servers.push(server);
    await server.start();
    const descriptor = server.descriptorForSession('lead-1');

    current = {
      ...current,
      projects: current.projects.map((project) => ({ ...project, archivedAt: NOW })),
    };
    await expect(post(descriptor.endpoint, descriptor.bearerToken, rpc(13, 'tools/list')))
      .resolves.toMatchObject({ value: { error: { code: -32002 } } });

    current = {
      ...snapshot(),
      workspaces: snapshot().workspaces.map((workspace) => ({ ...workspace, archivedAt: NOW })),
    };
    await expect(post(descriptor.endpoint, descriptor.bearerToken, rpc(14, 'initialize')))
      .resolves.toMatchObject({ value: { error: { code: -32002 } } });
    expect(authority.execute).not.toHaveBeenCalled();
  });

  it('retries only optimistic revision conflicts with a fresh command identity', async () => {
    const base = snapshot();
    const current: DaemonSnapshot = {
      ...base,
      agentRelations: [{
        id: 'retry-relation', treeId: 'lead-1', parentSessionId: 'lead-1', childSessionId: 'child-1',
        owner: 'managed', depth: 1, revision: 1, createdAt: NOW, updatedAt: NOW,
      }],
    };
    let calls = 0;
    const authority = {
      getSnapshot: () => current,
      execute: vi.fn(async (command: DaemonCommand): Promise<DaemonCommandReceipt> => {
        calls += 1;
        if (calls === 1) {
          (current as { revision: number }).revision = 8;
          return {
            ok: false,
            status: 'rejected',
            commandId: command.commandId,
            revision: 8,
            error: {
              code: 'revision-conflict', message: 'retry', retryable: true, currentRevision: 8,
            },
          };
        }
        return applied(command);
      }),
    };
    let id = 0;
    const server = new AgentOrchestrationMcpServer({ authority, createId: () => `id-${++id}` });
    servers.push(server);
    await server.start();
    const descriptor = server.descriptorForSession('lead-1');
    await post(descriptor.endpoint, descriptor.bearerToken, rpc(4, 'tools/call', {
      name: 'interrupt_agent', arguments: { sessionId: 'child-1' },
    }));

    expect(authority.execute).toHaveBeenCalledTimes(2);
    const [first, second] = authority.execute.mock.calls.map(([command]) => command);
    expect(first.commandId).not.toBe(second.commandId);
    expect(second.expectedRevision).toBe(8);
  });
});
