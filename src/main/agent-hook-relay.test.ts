import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { AgentHookRelay, buildPowerShellRelayScript, parseAgentHookEvent } from './agent-hook-relay';

const validEvent = {
  provider: 'codex',
  ezSessionId: 'ez-1',
  providerSessionId: 'provider-1',
  cwd: 'C:\\work',
  event: 'PermissionRequest',
  turnId: 'turn-1',
  toolName: 'Bash',
};

describe('AgentHookRelay', () => {
  it('accepts only the public allowlist and never retains extra provider payload fields', () => {
    const parsed = parseAgentHookEvent({
      ...validEvent,
      prompt: 'secret',
      transcript_path: 'secret.jsonl',
      tool_input: { command: 'secret' },
    });
    expect(parsed).toEqual(validEvent);
    expect(JSON.stringify(parsed)).not.toContain('secret');
  });

  it('generates a silent PowerShell relay that constructs the allowlist before POSTing', () => {
    const script = buildPowerShellRelayScript();
    expect(script).toContain('ezSessionId');
    expect(script).toContain('notification_type');
    expect(script).not.toContain('tool_input');
    expect(script).not.toContain('transcript_path');
    expect(script).toContain('exit 0');
  });

  it('binds loopback, requires the bearer, caps input, and dispatches a validated event', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ez-agent-relay-'));
    const seen: unknown[] = [];
    const relay = new AgentHookRelay(dir, (event) => seen.push(event));
    await relay.start();
    expect(readFileSync(relay.scriptPath, 'utf8')).toContain('EZTERMINAL_AGENT_HOOK_DESCRIPTOR');
    const descriptor = JSON.parse(relay.environmentDescriptor) as { url: string; token: string };
    expect(descriptor.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/agent-hook\/v1$/u);

    const denied = await fetch(descriptor.url, { method: 'POST', body: JSON.stringify(validEvent) });
    expect(denied.status).toBe(401);
    const accepted = await fetch(descriptor.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${descriptor.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(validEvent),
    });
    expect(accepted.status).toBe(204);
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toEqual([validEvent]);

    const oversized = await fetch(descriptor.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${descriptor.token}` },
      body: 'x'.repeat(65 * 1024),
    });
    expect(oversized.status).toBe(413);
    await relay.stop();
  });
});
