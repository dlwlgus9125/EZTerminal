// @vitest-environment jsdom

import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppI18nProvider } from '../../src/renderer/i18n';
import type { DaemonSnapshot } from '../../src/shared/daemon-protocol';
import { MobileNewSessionDraft } from './MobileNewSessionDraft';
import type { MobileAgentCreateRecoveryStatus } from './mobile-agent-create-recovery-store';
import type { DaemonRuntimeViewState } from './transport/ws-ezterminal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = '2026-09-06T00:00:00.000Z';

function snapshot(overrides: Partial<DaemonSnapshot> = {}): DaemonSnapshot {
  return {
    protocolVersion: 12,
    revision: 9,
    eventSequence: 14,
    generatedAt: NOW,
    runtime: {
      keepRunning: true,
      startAtLogin: false,
      orchestrationToolsEnabled: true,
      browserEnabled: false,
    },
    projects: [{
      id: 'project-1', name: 'EZTerminal', rootPath: 'C:\\Working\\EZTerminal', source: 'native',
      revision: 1, createdAt: NOW, updatedAt: NOW,
    }],
    workspaces: [{
      id: 'workspace-main', projectId: 'project-1', name: 'Main checkout', kind: 'local',
      rootPath: 'C:\\Working\\EZTerminal', revision: 1, createdAt: NOW, updatedAt: NOW,
    }],
    sessions: [],
    agents: [],
    agentRelations: [],
    turns: [],
    transcriptHeads: [],
    approvals: [],
    providers: [{
      id: 'codex', displayName: 'Codex', protocol: 'codex-app-server', executablePath: 'codex',
      executableVersion: '0.153.4', argv: ['app-server'], environmentVariableNames: [],
      capabilities: ['model:gpt-5.6'], enabled: true, health: 'ready', revision: 1,
      createdAt: NOW, updatedAt: NOW,
    }],
    schedules: [],
    heartbeats: [],
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

async function changeSelect(testId: string, value: string): Promise<void> {
  const select = container.querySelector<HTMLSelectElement>(`[data-testid="${testId}"]`)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}



async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderDraft(options: {
  readonly state?: DaemonRuntimeViewState;
  readonly contextWorkspaceId?: string;
  readonly agentRecoveryStatus?: MobileAgentCreateRecoveryStatus;
  readonly locale?: 'en' | 'ko';
  readonly onCreateAgent?: ComponentProps<typeof MobileNewSessionDraft>['onCreateAgent'];
  readonly onCreateTerminal?: ComponentProps<typeof MobileNewSessionDraft>['onCreateTerminal'];
  readonly onCreateLocalTerminal?: ComponentProps<typeof MobileNewSessionDraft>['onCreateLocalTerminal'];
  readonly onRetryAgentRecovery?: ComponentProps<typeof MobileNewSessionDraft>['onRetryAgentRecovery'];
  readonly onDiscardAgentRecovery?: ComponentProps<typeof MobileNewSessionDraft>['onDiscardAgentRecovery'];
} = {}): Promise<void> {
  const locale = options.locale ?? 'en';
  await act(async () => root.render(
    <AppI18nProvider locale={locale} languages={[locale]}>
      <MobileNewSessionDraft
        state={options.state ?? { status: 'ready', snapshot: snapshot() }}
        contextWorkspaceId={options.contextWorkspaceId}
        agentRecoveryStatus={options.agentRecoveryStatus ?? 'ready'}
        onBack={() => undefined}
        onRetry={() => undefined}
        onRetryAgentRecovery={options.onRetryAgentRecovery}
        onCreateLocalTerminal={options.onCreateLocalTerminal}
        onDiscardAgentRecovery={options.onDiscardAgentRecovery}
        onCreateAgent={options.onCreateAgent ?? vi.fn(async () => ({ ok: true as const }))}
        onCreateTerminal={options.onCreateTerminal ?? vi.fn(async () => ({ ok: true as const }))}
      />
    </AppI18nProvider>,
  ));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('MobileNewSessionDraft', () => {
  it('offers a standalone terminal while structured daemon authority is unavailable', async () => {
    const onCreateLocalTerminal = vi.fn(async () => ({ ok: true as const }));
    await renderDraft({ state: { status: 'error', snapshot: null, error: 'invalid-snapshot' }, onCreateLocalTerminal });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mobile-new-session-terminal"]')!.click());
    await changeSelect('mobile-new-session-project', 'local');
    const open = container.querySelector<HTMLButtonElement>('[data-testid="mobile-new-session-open-terminal"]')!;
    expect(open.disabled).toBe(false);
    expect(onCreateLocalTerminal).not.toHaveBeenCalled();
    await act(async () => { open.click(); open.click(); }); await flush();
    expect(onCreateLocalTerminal).toHaveBeenCalledOnce();
  });
  it('starts in Terminal mode and requires an explicit choice of app chat before Send', async () => {
    const onCreateAgent = vi.fn(async () => ({ ok: true as const }));
    await renderDraft({ onCreateAgent });
    expect(container.querySelector('[data-testid="mobile-new-session-terminal"]')?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mobile-new-session-agent"]')!.click());
    expect(container.querySelector('[data-testid="mobile-new-session-conversation"]')).toBeNull();

    expect(container.querySelector('[data-testid="mobile-new-session-agent"]')?.getAttribute('aria-pressed'))
      .toBe('true');
    expect(onCreateAgent).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-create"]')?.disabled)
      .toBe(true);

    await changeSelect('mobile-new-session-project', 'project-1');
    await changeSelect('mobile-new-session-workspace', 'workspace-main');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-create"]')!.click());
    await flush();

    expect(onCreateAgent).toHaveBeenCalledWith({
      providerId: 'codex',
      workspaceId: 'workspace-main',
      permissionPreset: 'standard',
    });
  });

  it('opens Terminal at the selected Workspace without requiring a provider', async () => {
    const onCreateTerminal = vi.fn(async () => ({ ok: true as const }));
    await renderDraft({
      state: {
        status: 'ready',
        snapshot: snapshot({ providers: [] }),
      },
      onCreateTerminal,
    });

    await changeSelect('mobile-new-session-project', 'project-1');
    await changeSelect('mobile-new-session-workspace', 'workspace-main');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mobile-new-session-terminal"]')!.click());
    const open = container.querySelector<HTMLButtonElement>('[data-testid="mobile-new-session-open-terminal"]')!;
    expect(open.disabled).toBe(false);
    await act(async () => open.click());
    await flush();

    expect(onCreateTerminal).toHaveBeenCalledWith('workspace-main');
    expect(container.textContent).toContain('Finish provider setup in Desktop Settings');
  });

  it.each([
    ['loading' as const, 'Checking secure Agent recovery before creation', 'status'],
    ['unavailable' as const, 'Secure Agent recovery storage is unavailable', 'alert'],
    ['invalid' as const, 'pending Agent recovery record is damaged', 'alert'],
  ])('disables only Agent creation while recovery is %s', async (status, message, role) => {
    const onCreateAgent = vi.fn(async () => ({ ok: true as const }));
    const onCreateTerminal = vi.fn(async () => ({ ok: true as const }));
    await renderDraft({ agentRecoveryStatus: status, onCreateAgent, onCreateTerminal });

    await changeSelect('mobile-new-session-project', 'project-1');
    await changeSelect('mobile-new-session-workspace', 'workspace-main');
    expect(container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-create"]')?.disabled)
      .toBe(true);
    const notice = container.querySelector('[data-testid="mobile-new-session-recovery-status"]');
    expect(notice?.getAttribute('role')).toBe(role);
    expect(notice?.textContent).toContain(message);

    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mobile-new-session-terminal"]')!.click());
    const open = container.querySelector<HTMLButtonElement>('[data-testid="mobile-new-session-open-terminal"]')!;
    expect(open.disabled).toBe(false);
    await act(async () => open.click());
    await flush();

    expect(onCreateAgent).not.toHaveBeenCalled();
    expect(onCreateTerminal).toHaveBeenCalledWith('workspace-main');
  });

  it('localizes unavailable secure recovery without disabling Terminal', async () => {
    await renderDraft({ agentRecoveryStatus: 'unavailable', locale: 'ko' });

    expect(container.querySelector('[data-testid="mobile-new-session-recovery-status"]')?.textContent)
      .toContain('안전한 Agent 복구 저장소를 사용할 수 없습니다');
    expect(container.textContent).toContain('Terminal 생성은 계속 사용할 수 있습니다');
  });

  it('offers an explicit secure recovery retry only when storage is unavailable', async () => {
    const onRetryAgentRecovery = vi.fn();
    await renderDraft({ agentRecoveryStatus: 'unavailable', onRetryAgentRecovery });

    const retry = container.querySelector<HTMLButtonElement>(
      '[data-testid="mobile-new-session-recovery-retry"]',
    );
    expect(retry).toBeTruthy();
    await act(async () => retry!.click());
    expect(onRetryAgentRecovery).toHaveBeenCalledOnce();

    await renderDraft({ agentRecoveryStatus: 'loading', onRetryAgentRecovery });
    expect(container.querySelector('[data-testid="mobile-new-session-recovery-retry"]')).toBeNull();
  });

  it('requires confirmation before discarding an irrecoverable record', async () => {
    const onDiscardAgentRecovery = vi.fn();
    await renderDraft({
      agentRecoveryStatus: 'invalid',
      onRetryAgentRecovery: vi.fn(),
      onDiscardAgentRecovery,
    });

    await act(async () => container.querySelector<HTMLButtonElement>(
      '[data-testid="mobile-new-session-recovery-discard"]',
    )!.click());
    const dialog = document.body.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('creating another Agent later could duplicate the work');
    expect(onDiscardAgentRecovery).not.toHaveBeenCalled();

    await act(async () => document.body.querySelector<HTMLButtonElement>(
      '[data-testid="mobile-new-session-recovery-discard-confirm"]',
    )!.click());
    expect(onDiscardAgentRecovery).toHaveBeenCalledOnce();
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('locks a contextual Workspace and keeps it across type changes', async () => {
    const onCreateTerminal = vi.fn(async () => ({ ok: true as const }));
    await renderDraft({ contextWorkspaceId: 'workspace-main', onCreateTerminal });

    expect(container.querySelector('[data-testid="mobile-new-session-project"]')).toBeNull();
    expect(container.querySelector('[data-testid="mobile-new-session-locked-workspace"]')?.textContent)
      .toContain('EZTerminal · Main checkout');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mobile-new-session-terminal"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mobile-new-session-open-terminal"]')!.click());
    await flush();

    expect(onCreateTerminal).toHaveBeenCalledWith('workspace-main');
  });

  it('keeps creation disabled and explains terminal-only safe mode', async () => {
    await renderDraft({
      state: {
        status: 'safe-mode',
        snapshot: null,
        availability: {
          state: 'legacy-only-safe-mode',
          initializationCode: 'future-schema',
          databaseDisposition: 'preserved',
          supportedSchemaVersion: 3,
          currentSchemaVersion: 4,
        },
      },
    });

    expect(container.textContent).toContain('terminal-only safe mode');
    expect(container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-create"]')?.disabled)
      .toBe(true);
  });
});
