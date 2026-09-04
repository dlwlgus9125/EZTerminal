import { describe, expect, it, vi } from 'vitest';

import type { DaemonSnapshot } from '../shared/daemon-protocol';
import type { AgentProviderAdapter, ProviderProbeResult } from './agent-provider-adapter';
import {
  AgentProviderRegistry,
  createProviderReviewDigest,
} from './agent-provider-registry';

const probe: ProviderProbeResult = {
  providerId: 'codex',
  displayName: 'Codex',
  protocol: 'codex-app-server',
  available: true,
  executablePath: 'C:\\Tools\\codex.exe',
  executableVersion: '0.152.1',
  argv: ['app-server', '--listen', 'stdio://'],
  environmentVariableNames: ['PATH'],
  capabilities: ['create', 'resume', 'interrupt', 'approvals'],
};

function adapter(overrides: Partial<AgentProviderAdapter> = {}): AgentProviderAdapter {
  return {
    providerId: 'codex',
    probe: vi.fn(async () => probe),
    listModels: vi.fn(async () => []),
    createSession: vi.fn(),
    resumeSession: vi.fn(),
    submit: vi.fn(),
    interrupt: vi.fn(),
    setSettings: vi.fn(),
    resolveApproval: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    reconcile: vi.fn(async () => ({ commands: [], transcriptItems: [] })),
    disposeSession: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  };
}

function snapshot(provider = {
  id: 'codex',
  displayName: 'Codex',
  protocol: 'codex-app-server' as const,
  executablePath: probe.executablePath,
  executableVersion: probe.executableVersion,
  argv: probe.argv,
  environmentVariableNames: probe.environmentVariableNames,
  capabilities: probe.capabilities,
  enabled: true,
  health: 'ready' as const,
  revision: 1,
  createdAt: '2026-09-04T10:00:00.000Z',
  updatedAt: '2026-09-04T10:00:00.000Z',
}): Pick<DaemonSnapshot, 'providers'> {
  return { providers: [provider] };
}

describe('AgentProviderRegistry', () => {
  it('binds enablement to the exact executable review', async () => {
    const registry = new AgentProviderRegistry([adapter()]);
    const reviewDigest = createProviderReviewDigest(probe);

    await expect(registry.authorizeEnable({
      providerId: probe.providerId,
      displayName: probe.displayName,
      protocol: probe.protocol,
      executablePath: probe.executablePath,
      executableVersion: probe.executableVersion,
      argv: probe.argv,
      environmentVariableNames: probe.environmentVariableNames,
      capabilities: probe.capabilities,
      reviewDigest,
    })).resolves.toMatchObject({
      ok: true,
      value: { id: 'codex', enabled: true, health: 'ready' },
    });

    await expect(registry.authorizeEnable({
      providerId: probe.providerId,
      displayName: probe.displayName,
      protocol: probe.protocol,
      executablePath: 'C:\\Other\\codex.exe',
      executableVersion: probe.executableVersion,
      argv: probe.argv,
      environmentVariableNames: probe.environmentVariableNames,
      capabilities: probe.capabilities,
      reviewDigest,
    })).resolves.toMatchObject({ ok: false, code: 'review-mismatch' });
  });

  it('fails closed when a probe is unavailable or changes after review', async () => {
    const unavailable = { ...probe, available: false, unavailableReason: 'Sign in first.' };
    const registry = new AgentProviderRegistry([adapter({ probe: vi.fn(async () => unavailable) })]);
    await expect(registry.authorizeEnable({
      providerId: probe.providerId,
      displayName: probe.displayName,
      protocol: probe.protocol,
      executablePath: probe.executablePath,
      executableVersion: probe.executableVersion,
      argv: probe.argv,
      environmentVariableNames: probe.environmentVariableNames,
      capabilities: probe.capabilities,
      reviewDigest: createProviderReviewDigest(unavailable),
    })).resolves.toEqual({ ok: false, code: 'provider-unavailable', message: 'Sign in first.' });
  });

  it('returns adapters only for the durable enabled and healthy projection', () => {
    const providerAdapter = adapter();
    const registry = new AgentProviderRegistry([providerAdapter]);
    expect(registry.enabledAdapter(snapshot(), 'codex')).toEqual({ ok: true, value: providerAdapter });
    expect(registry.enabledAdapter(snapshot({ ...snapshot().providers[0]!, enabled: false }), 'codex'))
      .toMatchObject({ ok: false, code: 'provider-unavailable' });
  });

  it('disposes every adapter and reports aggregate failures', async () => {
    const first = adapter({ providerId: 'first', dispose: vi.fn(async () => { throw new Error('first failed'); }) });
    const second = adapter({ providerId: 'second', dispose: vi.fn(async () => { throw new Error('second failed'); }) });
    const registry = new AgentProviderRegistry([first, second]);

    await expect(registry.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.dispose).toHaveBeenCalledOnce();
  });
});
