import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  APPROVAL_GATE_WINDOW_MS,
  AgentHookRelay,
  RELAY_APPROVAL_TIMEOUT_SEC,
  buildDecisionPayload,
  buildPowerShellRelayScript,
  canGateProvider,
  parseAgentHookEvent,
} from './agent-hook-relay';

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

  it('carries tool text only for the event that can be decided', () => {
    const approval = parseAgentHookEvent({ ...validEvent, command: 'rm -rf out' });
    expect(approval).toMatchObject({ command: 'rm -rf out' });

    // Every other hook is pure observability and has no business quoting the
    // user's tool input, so the field is dropped rather than trusted.
    const lifecycle = parseAgentHookEvent({ ...validEvent, event: 'Stop', command: 'rm -rf out' });
    expect(lifecycle).not.toHaveProperty('command');
    expect(JSON.stringify(lifecycle)).not.toContain('rm -rf');
  });

  it('generates a silent PowerShell relay that constructs the allowlist before POSTing', () => {
    const script = buildPowerShellRelayScript();
    expect(script).toContain('ezSessionId');
    expect(script).toContain('notification_type');
    // One string is lifted out of tool_input — never the object, and never the
    // transcript or prompt that sit beside it.
    expect(script).toContain('tool_input');
    // Field names, not prose: the script must never read these out of stdin.
    expect(script).not.toContain('transcript_path');
    expect(script).not.toContain("'prompt'");
    expect(script).not.toContain("'prompt_id'");
    expect(script).toContain("if ($isApproval) { $sanitized['command'] = Read-ToolInputText $inputObject }");
    expect(script).toContain('exit 0');
  });

  it('waits only on the approval hook, and only as long as the gate can', () => {
    const script = buildPowerShellRelayScript();
    expect(script).toContain('$timeoutSec = 2');
    expect(script).toContain(`if ($isApproval) { $timeoutSec = ${RELAY_APPROVAL_TIMEOUT_SEC} }`);
    expect(RELAY_APPROVAL_TIMEOUT_SEC * 1000).toBeGreaterThan(APPROVAL_GATE_WINDOW_MS);
  });

  it('speaks the decision grammar it can verify, and stays quiet otherwise', () => {
    expect(JSON.parse(buildDecisionPayload('claude', 'allow') ?? 'null')).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(JSON.parse(buildDecisionPayload('claude', 'deny') ?? 'null')).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } },
    });
    // Codex accepts the same hook registration, but nothing documents what it
    // reads back. A guess here would be a gate that silently does nothing.
    expect(buildDecisionPayload('codex', 'allow')).toBeNull();
    expect(canGateProvider('codex')).toBe(false);
    expect(canGateProvider('claude')).toBe(true);
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

  it('holds the approval hook open and answers it with the provider payload', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ez-agent-relay-gate-'));
    const seen: unknown[] = [];
    let release: (decision: 'allow' | 'deny' | null) => void = () => undefined;
    const relay = new AgentHookRelay(
      dir,
      (event) => seen.push(event),
      () => new Promise((resolve) => { release = resolve; }),
    );
    await relay.start();
    const descriptor = JSON.parse(relay.environmentDescriptor) as { url: string; token: string };
    const approvalEvent = { ...validEvent, provider: 'claude', command: 'rm -rf out' };

    const inFlight = fetch(descriptor.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${descriptor.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(approvalEvent),
    });
    // The consumer has to see the request before it can be asked to decide it.
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    release('deny');

    const response = await inFlight;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } },
    });
    await relay.stop();
  });

  it('answers nothing at all when the gate declines, which is the provider prompt', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ez-agent-relay-open-'));
    const relay = new AgentHookRelay(dir, () => undefined, () => Promise.resolve(null));
    await relay.start();
    const descriptor = JSON.parse(relay.environmentDescriptor) as { url: string; token: string };

    const response = await fetch(descriptor.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${descriptor.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...validEvent, provider: 'claude', command: 'ls' }),
    });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    await relay.stop();
  });

  it('never parks a provider it cannot answer', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ez-agent-relay-codex-'));
    const resolver = vi.fn(() => new Promise<'allow' | null>(() => undefined));
    const relay = new AgentHookRelay(dir, () => undefined, resolver);
    await relay.start();
    const descriptor = JSON.parse(relay.environmentDescriptor) as { url: string; token: string };

    // `validEvent` is codex. Parking it would hang the hook for nothing.
    const response = await fetch(descriptor.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${descriptor.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...validEvent, command: 'rm -rf out' }),
    });
    expect(response.status).toBe(204);
    expect(resolver).not.toHaveBeenCalled();
    await relay.stop();
  });
});
