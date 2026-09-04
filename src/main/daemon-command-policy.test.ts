import { describe, expect, it } from 'vitest';

import {
  DAEMON_PROTOCOL_VERSION,
  createDaemonCommand,
  type DaemonCommand,
  type DaemonCommandType,
  type DaemonPrincipal,
} from '../shared/daemon-protocol';
import { authorizeDaemonCommand } from './daemon-command-policy';

function command(
  type: DaemonCommandType,
  payload: Record<string, unknown>,
  principal: DaemonPrincipal,
): DaemonCommand {
  return {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    commandId: `command-${type}`,
    idempotencyKey: `test:${type}`,
    expectedRevision: 0,
    issuedAt: '2026-09-04T10:00:00.000Z',
    principal,
    type,
    payload,
  } as DaemonCommand;
}

const descendants = new Set(['child', 'grandchild']);
const context = {
  isManagedDescendant: (root: string, candidate: string) => root === 'parent' && descendants.has(candidate),
};

describe('daemon command authorization', () => {
  it('allows authenticated desktop and CLI principals through to entity validation', () => {
    for (const kind of ['desktop', 'cli'] as const) {
      const input = createDaemonCommand({
        commandId: `command-${kind}`,
        idempotencyKey: `test:${kind}`,
        expectedRevision: 0,
        issuedAt: '2026-09-04T10:00:00.000Z',
        principal: { kind, id: kind },
        type: 'runtime.set-settings',
        payload: { keepRunning: true },
      });
      expect(authorizeDaemonCommand(input as DaemonCommand, context)).toEqual({ allowed: true });
    }
  });

  it('keeps Desktop-host capabilities out of Android commands', () => {
    const android = { kind: 'android' as const, id: 'paired-phone' };
    expect(authorizeDaemonCommand(command('agent.submit', { sessionId: 'child', prompt: 'Continue' }, android), context).allowed).toBe(true);
    expect(authorizeDaemonCommand(command('provider.enable', {}, android), context)).toMatchObject({
      allowed: false,
      error: { code: 'unauthorized', retryable: false },
    });
    expect(authorizeDaemonCommand(command('browser.open', { sessionId: 'browser', workspaceId: 'ws', url: 'https://example.com' }, android), context).allowed).toBe(false);
  });

  it('allows an MCP capability to create only a direct child', () => {
    const mcp = { kind: 'mcp' as const, id: 'capability', sessionId: 'parent' };
    expect(authorizeDaemonCommand(command('agent.create', { parentSessionId: 'parent' }, mcp), context).allowed).toBe(true);
    expect(authorizeDaemonCommand(command('agent.create', { parentSessionId: 'someone-else' }, mcp), context).allowed).toBe(false);
  });

  it('limits MCP follow-ups and lifecycle actions to managed descendants', () => {
    const mcp = { kind: 'mcp' as const, id: 'capability', sessionId: 'parent' };
    expect(authorizeDaemonCommand(command('agent.submit', { sessionId: 'grandchild', prompt: 'Check' }, mcp), context).allowed).toBe(true);
    expect(authorizeDaemonCommand(command('agent.cancel', { sessionId: 'unrelated' }, mcp), context).allowed).toBe(false);
    expect(authorizeDaemonCommand(command('agent.cancel', { sessionId: 'parent' }, mcp), context).allowed).toBe(false);
    expect(authorizeDaemonCommand(command('permission.resolve', { approvalId: 'approval', decision: 'allow' }, mcp), context).allowed).toBe(false);
  });

  it('does not let provider event channels mutate daemon state', () => {
    const provider = { kind: 'provider' as const, id: 'codex-runtime', sessionId: 'child' };
    expect(authorizeDaemonCommand(command('agent.submit', { sessionId: 'child', prompt: 'loop' }, provider), context)).toMatchObject({
      allowed: false,
      error: { code: 'unauthorized' },
    });
  });
});
