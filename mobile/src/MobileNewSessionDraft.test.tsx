// @vitest-environment jsdom

import { act } from 'react';
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

function changeSelect(testId: string, value: string): void {
  const select = container.querySelector<HTMLSelectElement>(`[data-testid="${testId}"]`)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function fillPrompt(value: string): void {
  const textarea = container.querySelector<HTMLTextAreaElement>(
    '[data-testid="structured-agent-first-prompt"]',
  )!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderDraft(options: {
  readonly state?: DaemonRuntimeViewState;
  readonly contextWorkspaceId?: string;
  readonly agentRecoveryStatus?: MobileAgentCreateRecoveryStatus;
  readonly locale?: 'en' | 'ko';
  readonly onCreateAgent?: ReturnType<typeof vi.fn>;
  readonly onCreateTerminal?: ReturnType<typeof vi.fn>;
  readonly onCreateLocalTerminal?: ReturnType<typeof vi.fn>;
  readonly onRetryAgentRecovery?: ReturnType<typeof vi.fn>;
  readonly onDiscardAgentRecovery?: ReturnType<typeof vi.fn>;
} = {}): void {
  const locale = options.locale ?? 'en';
  act(() => root.render(
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

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('MobileNewSessionDraft', () => {
  it('offers a standalone terminal while structured daemon authority is unavailable', async () => {
    const onCreateLocalTerminal = vi.fn(async () => ({ ok: true as const }));
    renderDraft({ state: { status: 'error', snapshot: null, error: 'invalid-snapshot' }, onCreateLocalTerminal });
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="mobile-new-session-terminal"]')!.click());
    changeSelect('mobile-new-session-project', 'local');
    const open = container.querySelector<HTMLButtonElement>('[data-testid="mobile-new-session-open-terminal"]')!;
    expect(open.disabled).toBe(false);
    expect(onCreateLocalTerminal).not.toHaveBeenCalled();
    act(() => { open.click(); open.click(); }); await flush();
    expect(onCreateLocalTerminal).toHaveBeenCalledOnce();
  });
  it('starts in Agent mode and creates only after an explicit location and first prompt', async () => {
    const onCreateAgent = vi.fn(async () => ({ ok: true as const }));
    renderDraft({ onCreateAgent });

    expect(container.querySelector('[data-testid="mobile-new-session-agent"]')?.getAttribute('aria-pressed'))
      .toBe('true');
    expect(onCreateAgent).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-create"]')?.disabled)
      .toBe(true);

    changeSelect('mobile-new-session-project', 'project-1');
    changeSelect('mobile-new-session-workspace', 'workspace-main');
    fillPrompt('Create the mobile session.');
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-create"]')!.click());
    await flush();

    expect(onCreateAgent).toHaveBeenCalledWith({
      providerId: 'codex',
      workspaceId: 'workspace-main',
      permissionPreset: 'standard',
      initialPrompt: 'Create the mobile session.',
    });
  });

  it('opens Terminal at the selected Workspace without requiring a provider', async () => {
    const onCreateTerminal = vi.fn(async () => ({ ok: true as const }));
    renderDraft({
      state: {
        status: 'ready',
        snapshot: snapshot({ providers: [] }),
      },
      onCreateTerminal,
    });

    changeSelect('mobile-new-session-project', 'project-1');
    changeSelect('mobile-new-session-workspace', 'workspace-main');
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="mobile-new-session-terminal"]')!.click());
    const open = container.querySelector<HTMLButtonElement>('[data-testid="mobile-new-session-open-terminal"]')!;
    expect(open.disabled).toBe(false);
    act(() => open.click());
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
    renderDraft({ agentRecoveryStatus: status, onCreateAgent, onCreateTerminal });

    changeSelect('mobile-new-session-project', 'project-1');
    changeSelect('mobile-new-session-workspace', 'workspace-main');
    fillPrompt('Agent creation remains blocked.');
    expect(container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-create"]')?.disabled)
      .toBe(true);
    const notice = container.querySelector('[data-testid="mobile-new-session-recovery-status"]');
    expect(notice?.getAttribute('role')).toBe(role);
    expect(notice?.textContent).toContain(message);

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="mobile-new-session-terminal"]')!.click());
    const open = container.querySelector<HTMLButtonElement>('[data-testid="mobile-new-session-open-terminal"]')!;
    expect(open.disabled).toBe(false);
    act(() => open.click());
    await flush();

    expect(onCreateAgent).not.toHaveBeenCalled();
    expect(onCreateTerminal).toHaveBeenCalledWith('workspace-main');
  });

  it('localizes unavailable secure recovery without disabling Terminal', () => {
    renderDraft({ agentRecoveryStatus: 'unavailable', locale: 'ko' });

    expect(container.querySelector('[data-testid="mobile-new-session-recovery-status"]')?.textContent)
      .toContain('안전한 Agent 복구 저장소를 사용할 수 없습니다');
    expect(container.textContent).toContain('Terminal 생성은 계속 사용할 수 있습니다');
  });

  it('offers an explicit secure recovery retry only when storage is unavailable', () => {
    const onRetryAgentRecovery = vi.fn();
    renderDraft({ agentRecoveryStatus: 'unavailable', onRetryAgentRecovery });

    const retry = container.querySelector<HTMLButtonElement>(
      '[data-testid="mobile-new-session-recovery-retry"]',
    );
    expect(retry).toBeTruthy();
    act(() => retry!.click());
    expect(onRetryAgentRecovery).toHaveBeenCalledOnce();

    renderDraft({ agentRecoveryStatus: 'loading', onRetryAgentRecovery });
    expect(container.querySelector('[data-testid="mobile-new-session-recovery-retry"]')).toBeNull();
  });

  it('requires confirmation before discarding an irrecoverable record', () => {
    const onDiscardAgentRecovery = vi.fn();
    renderDraft({
      agentRecoveryStatus: 'invalid',
      onRetryAgentRecovery: vi.fn(),
      onDiscardAgentRecovery,
    });

    act(() => container.querySelector<HTMLButtonElement>(
      '[data-testid="mobile-new-session-recovery-discard"]',
    )!.click());
    const dialog = document.body.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('creating another Agent later could duplicate the work');
    expect(onDiscardAgentRecovery).not.toHaveBeenCalled();

    act(() => document.body.querySelector<HTMLButtonElement>(
      '[data-testid="mobile-new-session-recovery-discard-confirm"]',
    )!.click());
    expect(onDiscardAgentRecovery).toHaveBeenCalledOnce();
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('locks a contextual Workspace and keeps it across type changes', async () => {
    const onCreateTerminal = vi.fn(async () => ({ ok: true as const }));
    renderDraft({ contextWorkspaceId: 'workspace-main', onCreateTerminal });

    expect(container.querySelector('[data-testid="mobile-new-session-project"]')).toBeNull();
    expect(container.querySelector('[data-testid="mobile-new-session-locked-workspace"]')?.textContent)
      .toContain('EZTerminal · Main checkout');
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="mobile-new-session-terminal"]')!.click());
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="mobile-new-session-open-terminal"]')!.click());
    await flush();

    expect(onCreateTerminal).toHaveBeenCalledWith('workspace-main');
  });

  it('keeps creation disabled and explains terminal-only safe mode', () => {
    renderDraft({
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
