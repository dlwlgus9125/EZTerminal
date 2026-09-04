// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeProviderEnablement, ProviderInspection } from '../shared/daemon-provider';
import type {
  DaemonCommand,
  DaemonCommandReceipt,
  DaemonProvider,
  DaemonSnapshot,
} from '../shared/daemon-protocol';
import { rendererCapabilities, type CapabilityAccess } from './capability-access';
import { AppI18nProvider } from './i18n';
import { StructuredProviderSettings } from './StructuredProviderSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = '2026-09-04T09:30:00.000Z';
const DEFAULT_CLAUDE: ClaudeProviderEnablement = {
  enabled: false,
  termsAccepted: false,
  commercialUseApproved: false,
  authenticationPath: 'existing-cli-environment',
  anthropicThirdPartyApproval: false,
};

function inspection(
  providerId: 'codex' | 'claude',
  digest: string,
  available = providerId === 'codex',
): ProviderInspection {
  return {
    reviewDigest: digest,
    probe: {
      providerId,
      displayName: providerId === 'codex' ? 'Codex' : 'Claude Agent',
      protocol: providerId === 'codex' ? 'codex-app-server' : 'claude-agent-sdk',
      available,
      executablePath: providerId === 'codex' ? 'C:\\Tools\\codex.exe' : 'C:\\Tools\\claude.exe',
      executableVersion: '1.2.3',
      argv: providerId === 'codex' ? ['app-server'] : ['--output-format', 'stream-json'],
      environmentVariableNames: providerId === 'codex' ? ['PATH'] : ['PATH', 'ANTHROPIC_API_KEY'],
      capabilities: ['create', 'resume', 'interrupt'],
      reviewNotices: providerId === 'claude' ? [{
        id: 'anthropic-commercial-terms',
        level: 'required',
        title: 'Anthropic commercial terms',
        message: 'Review the applicable terms.',
        url: 'https://www.anthropic.com/legal/commercial-terms',
      }] : [],
      ...(!available && providerId === 'claude'
        ? { unavailableReason: 'CLAUDE_PROVIDER_DISABLED: Claude Agent is disabled.' }
        : {}),
    },
  };
}

function providerRecord(source: ProviderInspection, overrides: Partial<DaemonProvider> = {}): DaemonProvider {
  const probe = source.probe;
  return {
    id: probe.providerId,
    displayName: probe.displayName,
    protocol: probe.protocol,
    executablePath: probe.executablePath,
    executableVersion: probe.executableVersion,
    argv: probe.argv,
    environmentVariableNames: probe.environmentVariableNames,
    capabilities: probe.capabilities,
    enabled: true,
    health: 'ready',
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function snapshot(
  revision = 4,
  providers: readonly DaemonProvider[] = [],
  orchestrationToolsEnabled = false,
): DaemonSnapshot {
  return {
    protocolVersion: 12,
    revision,
    eventSequence: revision,
    generatedAt: NOW,
    runtime: {
      keepRunning: false,
      startAtLogin: false,
      orchestrationToolsEnabled,
      browserEnabled: false,
    },
    projects: [],
    workspaces: [],
    sessions: [],
    agents: [],
    agentRelations: [],
    turns: [],
    transcriptHeads: [],
    approvals: [],
    providers,
    schedules: [],
    heartbeats: [],
  };
}

interface CapabilityOverrides {
  readonly inspect?: CapabilityAccess['structuredProviders']['inspect'];
  readonly setClaude?: CapabilityAccess['structuredProviders']['setClaudeEnablement'];
  readonly getSnapshot?: CapabilityAccess['daemon']['getSnapshot'];
  readonly sendCommand?: CapabilityAccess['daemon']['sendCommand'];
  readonly getLifecycle?: CapabilityAccess['daemon']['getLifecycleSettings'];
  readonly setLifecycle?: CapabilityAccess['daemon']['setLifecycleSettings'];
}

function capabilities(overrides: CapabilityOverrides = {}): CapabilityAccess {
  return {
    ...rendererCapabilities,
    structuredProviders: {
      inspect: overrides.inspect ?? (async (providerId) => ({
        ok: true,
        value: inspection(providerId as 'codex' | 'claude', `${providerId}-digest`),
      })),
      listModels: async () => ({ ok: true, value: [] }),
      getClaudeEnablement: async () => ({ ok: true, value: DEFAULT_CLAUDE }),
      setClaudeEnablement: overrides.setClaude ?? (async (value) => ({ ok: true, value })),
    },
    daemon: {
      getSnapshot: overrides.getSnapshot ?? (async () => snapshot()),
      sendCommand: overrides.sendCommand ?? (async (command) => ({
        ok: true,
        status: 'applied',
        commandId: command.commandId,
        revision: 5,
        eventSequence: 5,
      })),
      getLifecycleSettings: overrides.getLifecycle ?? (async () => ({
        keepRunning: false,
        startAtLogin: false,
      })),
      setLifecycleSettings: overrides.setLifecycle ?? (async (patch) => ({
        keepRunning: patch.keepRunning ?? false,
        startAtLogin: patch.startAtLogin ?? false,
      })),
    },
    files: {
      ...rendererCapabilities.files,
      openExternalHttpUrl: async () => true,
    },
  };
}

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderSettings(access: CapabilityAccess): void {
  act(() => root.render(
    <AppI18nProvider locale="en" languages={['en']}>
      <StructuredProviderSettings capabilities={access} />
    </AppI18nProvider>,
  ));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('StructuredProviderSettings', () => {
  it('invalidates a digest-bound review when a fresh inspection changes identity', async () => {
    let codexChecks = 0;
    const inspect = vi.fn(async (providerId: string) => ({
      ok: true as const,
      value: providerId === 'codex'
        ? inspection('codex', `digest-${++codexChecks}`)
        : inspection('claude', 'claude-digest'),
    }));
    renderSettings(capabilities({ inspect }));
    await flush();

    const review = container.querySelector<HTMLInputElement>('[data-testid="provider-review-codex"]')!;
    act(() => review.click());
    expect(review.checked).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="provider-enable-codex"]')!.disabled).toBe(false);

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="provider-check-codex"]')!.click());
    await flush();

    expect(container.querySelector<HTMLInputElement>('[data-testid="provider-review-codex"]')!.checked).toBe(false);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="provider-enable-codex"]')!.disabled).toBe(true);
  });

  it('guards duplicate provider submissions before React can repaint the disabled button', async () => {
    let resolveReceipt!: (receipt: DaemonCommandReceipt) => void;
    const pendingReceipt = new Promise<DaemonCommandReceipt>((resolve) => { resolveReceipt = resolve; });
    const sendCommand = vi.fn(() => pendingReceipt);
    renderSettings(capabilities({ sendCommand }));
    await flush();

    act(() => container.querySelector<HTMLInputElement>('[data-testid="provider-review-codex"]')!.click());
    const enable = container.querySelector<HTMLButtonElement>('[data-testid="provider-enable-codex"]')!;
    act(() => {
      enable.click();
      enable.click();
    });
    await flush();

    expect(sendCommand).toHaveBeenCalledTimes(1);
    const sent = sendCommand.mock.calls[0][0] as DaemonCommand;
    expect(sent).toMatchObject({ type: 'provider.enable', expectedRevision: 4 });

    resolveReceipt({
      ok: true,
      status: 'applied',
      commandId: sent.commandId,
      revision: 5,
      eventSequence: 5,
    });
    await flush();
  });

  it('requires separate terms, commercial, and conditional third-party claude.ai approval without credential fields', async () => {
    const setClaude = vi.fn(async (value: ClaudeProviderEnablement) => ({ ok: true as const, value }));
    let claudeChecks = 0;
    const inspect = vi.fn(async (providerId: string) => ({
      ok: true as const,
      value: providerId === 'claude'
        ? inspection('claude', `claude-${++claudeChecks}`, claudeChecks > 1)
        : inspection('codex', 'codex'),
    }));
    renderSettings(capabilities({ inspect, setClaude }));
    await flush();

    act(() => container.querySelector<HTMLInputElement>('[data-testid="claude-auth-existing-claude-ai-login"]')!.click());
    act(() => container.querySelector<HTMLInputElement>('[data-testid="claude-terms-accepted"]')!.click());
    act(() => container.querySelector<HTMLInputElement>('[data-testid="claude-commercial-approved"]')!.click());
    act(() => container.querySelector<HTMLInputElement>('[data-testid="provider-review-claude"]')!.click());

    const action = container.querySelector<HTMLButtonElement>('[data-testid="provider-enable-claude"]')!;
    expect(container.querySelector('[data-testid="claude-third-party-approved"]')).not.toBeNull();
    expect(action.disabled).toBe(true);

    act(() => container.querySelector<HTMLInputElement>('[data-testid="claude-third-party-approved"]')!.click());
    act(() => container.querySelector<HTMLInputElement>('[data-testid="provider-review-claude"]')!.click());
    expect(action.disabled).toBe(false);
    act(() => action.click());
    await flush();

    expect(setClaude).toHaveBeenCalledWith({
      enabled: true,
      termsAccepted: true,
      commercialUseApproved: true,
      authenticationPath: 'existing-claude-ai-login',
      anthropicThirdPartyApproval: true,
    });
    expect(container.querySelector('input[type="password"], input[type="text"]')).toBeNull();
    expect(container.textContent).toContain('does not ask for, read, or store API keys');
  });

  it('keeps Start at login dependent on Keep running and accepts the main-owned rollback snapshot', async () => {
    let lifecycle = { keepRunning: false, startAtLogin: false };
    const setLifecycle = vi.fn(async (patch: Partial<typeof lifecycle>) => {
      if (patch.keepRunning === false) lifecycle = { keepRunning: false, startAtLogin: false };
      else if (patch.keepRunning === true) lifecycle = { ...lifecycle, keepRunning: true };
      else if (patch.startAtLogin === true && lifecycle.keepRunning) lifecycle = { ...lifecycle, startAtLogin: true };
      return lifecycle;
    });
    renderSettings(capabilities({ setLifecycle }));
    await flush();

    const keepRunning = container.querySelector<HTMLInputElement>('[data-testid="agent-keep-running"]')!;
    const startAtLogin = container.querySelector<HTMLInputElement>('[data-testid="agent-start-at-login"]')!;
    expect(startAtLogin.disabled).toBe(true);

    act(() => keepRunning.click());
    await flush();
    expect(startAtLogin.disabled).toBe(false);

    act(() => startAtLogin.click());
    await flush();
    expect(startAtLogin.checked).toBe(true);

    act(() => keepRunning.click());
    await flush();
    expect(startAtLogin.checked).toBe(false);
    expect(startAtLogin.disabled).toBe(true);
    expect(setLifecycle).toHaveBeenLastCalledWith({ keepRunning: false });
  });

  it('uses a fresh daemon revision for orchestration and reloads authority after a conflict', async () => {
    const snapshots = [snapshot(4), snapshot(12), snapshot(13, [], true)];
    const getSnapshot = vi.fn(async () => snapshots.shift() ?? snapshot(13, [], true));
    const sendCommand = vi.fn(async (command: DaemonCommand): Promise<DaemonCommandReceipt> => ({
      ok: false,
      status: 'rejected',
      commandId: command.commandId,
      revision: 13,
      error: {
        code: 'revision-conflict',
        message: 'revision changed',
        retryable: true,
        currentRevision: 13,
      },
    }));
    renderSettings(capabilities({ getSnapshot, sendCommand }));
    await flush();

    act(() => container.querySelector<HTMLInputElement>('[data-testid="agent-orchestration-tools"]')!.click());
    await flush();

    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: 'runtime.set-settings',
      expectedRevision: 12,
      payload: { orchestrationToolsEnabled: true },
    }));
    expect(container.querySelector<HTMLInputElement>('[data-testid="agent-orchestration-tools"]')!.checked).toBe(true);
    expect(container.textContent).toContain('latest settings were reloaded');
  });

  it('shows Ready only when the durable provider identity still matches the reviewed probe', async () => {
    const codex = inspection('codex', 'codex-ready');
    renderSettings(capabilities({
      inspect: async (providerId) => ({
        ok: true,
        value: providerId === 'codex' ? codex : inspection('claude', 'claude'),
      }),
      getSnapshot: async () => snapshot(4, [providerRecord(codex)]),
    }));
    await flush();

    const card = container.querySelector('[data-testid="structured-provider-codex"]')!;
    expect(card.textContent).toContain('Ready');
    expect(card.querySelector('[data-testid="provider-disable-codex"]')).not.toBeNull();
  });
});
