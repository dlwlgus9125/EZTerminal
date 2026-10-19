import { describe, expect, it } from 'vitest';

import { DAEMON_PROTOCOL_VERSION } from '../../../src/shared/daemon-protocol';
import { isDaemonSnapshot, isDaemonTranscriptItem } from './ws-transport-contract';

/**
 * Hosts with the 2.0 chat overhaul add optional fields (transcript `payload`,
 * approval `request`, agent `reasoningEffort`) under capability flags rather
 * than a protocol bump. These validators also ship in already-installed phones,
 * so they must keep accepting snapshots and pages that carry the new fields.
 */
describe('structured payload compatibility', () => {
  it('accepts a snapshot with approval requests, agent effort and new capabilities', () => {
    const snapshot = {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      capabilities: ['agent-queue', 'transcript-payload-v1', 'approval-request-v1', 'approval-response-v1', 'agent-effort-v1'],
      revision: 3,
      eventSequence: 9,
      generatedAt: '2026-10-15T00:00:00.000Z',
      runtime: { keepRunning: true, startAtLogin: false, orchestrationToolsEnabled: true, browserEnabled: false },
      projects: [], workspaces: [], sessions: [], agentRelations: [], turns: [], transcriptHeads: [],
      providers: [], schedules: [], heartbeats: [], migrationReceipts: [],
      agents: [{ sessionId: 'session-1', providerId: 'claude', reasoningEffort: 'high', permissionPreset: 'standard', state: 'blocked' }],
      approvals: [{
        id: 'approval-1', sessionId: 'session-1', providerRequestId: 'request-1', risk: 'danger', title: 'Run command',
        state: 'pending', request: { v: 1, kind: 'command', command: 'pnpm test', callId: 'toolu_1' },
      }],
    };
    expect(isDaemonSnapshot(snapshot)).toBe(true);
  });

  it('accepts a snapshot that carries reply usage', () => {
    const snapshot = {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      capabilities: ['agent-queue', 'agent-usage-v1'],
      revision: 3,
      eventSequence: 9,
      generatedAt: '2026-10-20T00:00:00.000Z',
      runtime: { keepRunning: true, startAtLogin: false, orchestrationToolsEnabled: true, browserEnabled: false },
      projects: [], workspaces: [], sessions: [], agentRelations: [], turns: [], transcriptHeads: [], approvals: [],
      providers: [], schedules: [], heartbeats: [],
      agents: [{ sessionId: 'session-1', providerId: 'codex', permissionPreset: 'standard', state: 'idle' }],
      agentUsage: { 'session-1': { weekly: { usedPercent: 26, resetsAt: 1_792_472_286_000 }, contextPercent: 3, observedAt: 1 } },
    };
    expect(isDaemonSnapshot(snapshot)).toBe(true);
  });

  it('accepts transcript items that carry a structured payload', () => {
    const item = {
      id: 'item-1', sessionId: 'session-1', sequence: 4, kind: 'tool-call', text: 'Read\n{"file_path":"README.md"}',
      isDelta: false, isSensitive: false, createdAt: '2026-10-15T00:00:00.000Z',
      payload: { v: 1, type: 'tool', callId: 'toolu_1', name: 'Read', category: 'read', phase: 'call', status: 'running', target: 'README.md' },
    };
    expect(isDaemonTranscriptItem(item, 'session-1')).toBe(true);
  });
});
