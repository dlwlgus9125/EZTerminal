import type { IpcMainInvokeEvent } from 'electron';

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_CLAUDE_PROVIDER_ENABLEMENT,
  type ClaudeProviderEnablement,
  type ProviderInspection,
  type ProviderRegistryResult,
} from '../shared/daemon-provider';
import {
  installDaemonProviderIpc,
  type DaemonProviderIpc,
  type DaemonProviderIpcChannel,
} from './daemon-provider-ipc';

class FakeIpc implements DaemonProviderIpc {
  readonly handlers = new Map<DaemonProviderIpcChannel, (
    event: IpcMainInvokeEvent,
    ...args: unknown[]
  ) => unknown>();

  handle(
    channel: DaemonProviderIpcChannel,
    handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void {
    this.handlers.set(channel, handler);
  }

  removeHandler(channel: DaemonProviderIpcChannel): void {
    this.handlers.delete(channel);
  }

  invoke(channel: DaemonProviderIpcChannel, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`Missing handler: ${channel}`);
    return Promise.resolve(handler({} as IpcMainInvokeEvent, ...args));
  }
}

const inspection: ProviderInspection = {
  probe: {
    providerId: 'claude',
    displayName: 'Claude Agent',
    protocol: 'claude-agent-sdk',
    available: true,
    executablePath: 'C:\\Tools\\claude.exe',
    executableVersion: '2.1.260',
    argv: [],
    environmentVariableNames: ['PATH', 'ANTHROPIC_API_KEY'],
    capabilities: ['create', 'resume'],
    reviewNotices: [{
      id: 'anthropic-terms',
      level: 'required',
      title: 'Anthropic terms',
      message: 'Review required.',
      url: 'https://www.anthropic.com/legal/commercial-terms',
    }],
  },
  reviewDigest: 'a'.repeat(64),
};

const enabledPolicy: ClaudeProviderEnablement = {
  enabled: true,
  termsAccepted: true,
  commercialUseApproved: true,
  authenticationPath: 'api-key-environment',
  anthropicThirdPartyApproval: false,
};

function fixture(options: { readonly principal?: boolean } = {}) {
  const ipc = new FakeIpc();
  let stored = { ...DEFAULT_CLAUDE_PROVIDER_ENABLEMENT };
  const registry = {
    inspect: vi.fn(async (): Promise<ProviderRegistryResult<ProviderInspection>> => ({
      ok: true,
      value: inspection,
    })),
    listModels: vi.fn(async () => ({
      ok: true as const,
      value: [{
        id: 'sonnet',
        displayName: 'Claude Sonnet',
        supportsReasoning: true,
        isDefault: true,
      }],
    })),
  };
  const claudeStore = {
    load: vi.fn(async () => ({ ...stored })),
    save: vi.fn(async (value: ClaudeProviderEnablement) => { stored = { ...value }; }),
  };
  const claudeAdapter = {
    setEnablement: vi.fn(async (value: ClaudeProviderEnablement) => {
      await claudeStore.save(value);
      return { ...value };
    }),
  };
  const resolveDesktopPrincipal = vi.fn(() => (
    options.principal === false ? null : 'desktop:1:renderer-1'
  ));
  const reportError = vi.fn();
  const uninstall = installDaemonProviderIpc({
    ipc,
    registry,
    claudeAdapter,
    claudeStore,
    resolveDesktopPrincipal,
    reportError,
  });
  return {
    ipc,
    registry,
    claudeStore,
    claudeAdapter,
    resolveDesktopPrincipal,
    reportError,
    uninstall,
  };
}

describe('daemon provider IPC', () => {
  it('requires a desktop principal for every operation', async () => {
    const subject = fixture({ principal: false });

    await expect(subject.ipc.invoke('daemon:inspect-provider', 'client', 'claude'))
      .resolves.toMatchObject({ ok: false, code: 'desktop-principal-required' });
    await expect(subject.ipc.invoke('daemon:list-provider-models', 'client', 'claude'))
      .resolves.toMatchObject({ ok: false, code: 'desktop-principal-required' });
    await expect(subject.ipc.invoke('daemon:get-claude-enablement', 'client'))
      .resolves.toMatchObject({ ok: false, code: 'desktop-principal-required' });
    await expect(subject.ipc.invoke('daemon:set-claude-enablement', 'client', enabledPolicy))
      .resolves.toMatchObject({ ok: false, code: 'desktop-principal-required' });

    expect(subject.registry.inspect).not.toHaveBeenCalled();
    expect(subject.registry.listModels).not.toHaveBeenCalled();
    expect(subject.claudeStore.load).not.toHaveBeenCalled();
    expect(subject.claudeAdapter.setEnablement).not.toHaveBeenCalled();
  });

  it('strictly validates provider ids, payload keys, and exact argument counts', async () => {
    const subject = fixture();

    await expect(subject.ipc.invoke('daemon:inspect-provider', 'client', ' claude'))
      .resolves.toMatchObject({ ok: false, code: 'invalid-input' });
    await expect(subject.ipc.invoke('daemon:list-provider-models', 'client', 'claude', 'extra'))
      .resolves.toMatchObject({ ok: false, code: 'invalid-input' });
    await expect(subject.ipc.invoke('daemon:get-claude-enablement', 'client', 'extra'))
      .resolves.toMatchObject({ ok: false, code: 'invalid-input' });
    await expect(subject.ipc.invoke('daemon:set-claude-enablement', 'client', {
      ...enabledPolicy,
      apiKey: 'never-accepted',
    })).resolves.toMatchObject({ ok: false, code: 'invalid-input' });

    expect(subject.registry.inspect).not.toHaveBeenCalled();
    expect(subject.registry.listModels).not.toHaveBeenCalled();
    expect(subject.claudeAdapter.setEnablement).not.toHaveBeenCalled();
  });

  it('routes inspection, models, and persisted Claude enablement through their owners', async () => {
    const subject = fixture();

    await expect(subject.ipc.invoke('daemon:inspect-provider', 'client', 'claude'))
      .resolves.toEqual({ ok: true, value: inspection });
    await expect(subject.ipc.invoke('daemon:list-provider-models', 'client', 'claude'))
      .resolves.toMatchObject({ ok: true, value: [{ id: 'sonnet' }] });
    await expect(subject.ipc.invoke('daemon:get-claude-enablement', 'client'))
      .resolves.toEqual({ ok: true, value: DEFAULT_CLAUDE_PROVIDER_ENABLEMENT });
    await expect(subject.ipc.invoke('daemon:set-claude-enablement', 'client', enabledPolicy))
      .resolves.toEqual({ ok: true, value: enabledPolicy });
    await expect(subject.ipc.invoke('daemon:get-claude-enablement', 'client'))
      .resolves.toEqual({ ok: true, value: enabledPolicy });

    expect(subject.registry.inspect).toHaveBeenCalledWith('claude');
    expect(subject.registry.listModels).toHaveBeenCalledWith('claude');
    expect(subject.claudeAdapter.setEnablement).toHaveBeenCalledWith(enabledPolicy);
  });

  it('fails closed at terms, commercial-use, and claude.ai prior-approval gates', async () => {
    const subject = fixture();
    const cases: readonly [Partial<ClaudeProviderEnablement>, string][] = [
      [{ termsAccepted: false }, 'CLAUDE_TERMS_REQUIRED'],
      [{ commercialUseApproved: false }, 'CLAUDE_COMMERCIAL_APPROVAL_REQUIRED'],
      [{
        authenticationPath: 'existing-claude-ai-login',
        anthropicThirdPartyApproval: false,
      }, 'CLAUDE_THIRD_PARTY_AUTHORIZATION_REQUIRED'],
    ];

    for (const [patch, code] of cases) {
      await expect(subject.ipc.invoke('daemon:set-claude-enablement', 'client', {
        ...enabledPolicy,
        ...patch,
      })).resolves.toMatchObject({ ok: false, code });
    }

    expect(subject.claudeAdapter.setEnablement).not.toHaveBeenCalled();
    expect(subject.claudeStore.save).not.toHaveBeenCalled();
  });

  it('does not expose registry or persistence error details to the renderer', async () => {
    const subject = fixture();
    subject.registry.inspect.mockResolvedValueOnce({
      ok: false,
      code: 'provider-incompatible',
      message: 'raw provider error containing secret-value',
    });
    subject.claudeAdapter.setEnablement.mockRejectedValueOnce(
      new Error('disk error containing secret-value'),
    );

    const inspected = await subject.ipc.invoke('daemon:inspect-provider', 'client', 'claude');
    const persisted = await subject.ipc.invoke(
      'daemon:set-claude-enablement',
      'client',
      enabledPolicy,
    );

    expect(JSON.stringify(inspected)).not.toContain('secret-value');
    expect(JSON.stringify(persisted)).not.toContain('secret-value');
    expect(subject.reportError).toHaveBeenCalledOnce();
  });

  it('uninstalls every exact handler once', () => {
    const subject = fixture();
    expect(subject.ipc.handlers.size).toBe(4);

    subject.uninstall();
    subject.uninstall();

    expect(subject.ipc.handlers.size).toBe(0);
  });
});
