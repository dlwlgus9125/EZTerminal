import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  DaemonCommand,
  DaemonCommandReceipt,
  DaemonSnapshot,
} from '../shared/daemon-protocol';
import { AgentOrchestrationMcpServer } from './agent-orchestration-mcp-server';

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
    providers: [],
    schedules: [],
    heartbeats: [],
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
        permissionPreset: 'plan',
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
        permissionPreset: 'plan',
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
