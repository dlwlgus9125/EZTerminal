import { afterEach, describe, expect, it } from 'vitest';

import type { DaemonEvent, DaemonSnapshot } from '../shared/daemon-protocol';
import { AgentOrchestrationMcpServer } from './agent-orchestration-mcp-server';

const NOW = '2026-10-17T00:00:00.000Z';
const servers: AgentOrchestrationMcpServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.stop())); });

function snapshot(childWorking: boolean): DaemonSnapshot {
  const stamp = { revision: 1, createdAt: NOW, updatedAt: NOW };
  const session = (id: string) => ({ ...stamp, id, projectId: 'p', workspaceId: 'w', kind: 'agent' as const, title: id, state: 'idle' as const, source: 'structured' as const });
  const agent = (sessionId: string, working = false) => ({ ...stamp, sessionId, providerId: 'codex', permissionPreset: 'standard' as const,
    state: working ? 'working' as const : 'idle' as const, queuedTurnCount: 0, orchestrationEnabled: true, ...(working ? { currentTurnId: 't' } : {}) });
  return {
    protocolVersion: 12, revision: 1, eventSequence: 1, generatedAt: NOW,
    runtime: { keepRunning: false, startAtLogin: false, orchestrationToolsEnabled: true, browserEnabled: false },
    projects: [{ ...stamp, id: 'p', name: 'P', rootPath: 'C:\\repo', source: 'native' }],
    workspaces: [{ ...stamp, id: 'w', projectId: 'p', name: 'W', kind: 'local', rootPath: 'C:\\repo' }],
    sessions: [session('lead'), session('child')],
    agents: [agent('lead'), agent('child', childWorking)],
    agentRelations: [{ ...stamp, id: 'r', treeId: 'lead', parentSessionId: 'lead', childSessionId: 'child', owner: 'managed', depth: 1 }],
    turns: childWorking ? [{ ...stamp, id: 't', sessionId: 'child', commandId: 'c', state: 'working' }] : [],
    transcriptHeads: [], approvals: [],
    providers: [{ ...stamp, id: 'codex', displayName: 'Codex', protocol: 'codex-app-server', executablePath: 'codex', executableVersion: '1', argv: [],
      environmentVariableNames: [], capabilities: [], enabled: true, health: 'ready' }],
    schedules: [], heartbeats: [],
  };
}

describe('wait_agent over a real socket', () => {
  it('holds one call past the server\u2019s 30s request-receive timeout', async () => {
    let current = snapshot(true);
    const listeners = new Set<(event: DaemonEvent) => void>();
    const server = new AgentOrchestrationMcpServer({ authority: {
      getSnapshot: () => current, execute: async () => { throw new Error('unused'); },
      readTranscript: () => [], onEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    } });
    servers.push(server);
    await server.start();
    const descriptor = server.descriptorForSession('lead');
    const started = Date.now();
    setTimeout(() => {
      current = snapshot(false);
      for (const listener of [...listeners]) listener({ kind: 'entity.upserted', payload: { entityType: 'agent', entityId: 'child' } } as DaemonEvent);
    }, 35_000);
    const response = await fetch(descriptor.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${descriptor.bearerToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait_agent', arguments: { sessionId: 'child', timeoutSeconds: 60 } } }) });
    const body = await response.json() as { result: { content: Array<{ text: string }> } };
    expect(Date.now() - started).toBeGreaterThanOrEqual(34_000);
    expect(JSON.parse(body.result.content[0]!.text)).toMatchObject({ finished: true });
  }, 60_000);
});
