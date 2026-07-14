import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DestroySessionGuardResult,
  RunStartedInfo,
  SessionInfo,
} from '../../src/shared/ipc';
import type { AgentActivity } from '../../src/shared/agent';
import { MobileNavigationHistoryProvider } from './MobileNavigationHistory';
import { SessionSwitcher } from './SessionSwitcher';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION: SessionInfo = { sessionId: 'session-1', cwd: '/work' };
let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => window.history.replaceState({}, ''));

function makeTransport(
  runs: readonly RunStartedInfo[],
  activityItems: readonly AgentActivity[] = [],
) {
  const listSessions = vi.fn(async (): Promise<readonly SessionInfo[]> => [SESSION]);
  const createSession = vi.fn(async (): Promise<SessionInfo> => SESSION);
  const listRuns = vi.fn(async (): Promise<readonly RunStartedInfo[]> => runs);
  const destroySessionGuarded = vi.fn<WsEzTerminalTransport['destroySessionGuarded']>(
    async (): Promise<DestroySessionGuardResult> => ({ ok: true }),
  );
  let removedListener: ((sessionId: string) => void) | null = null;
  const transport = {
    isAuthed: true,
    listSessions,
    onConnectionStateChange: vi.fn((listener: (state: 'connected') => void) => {
      listener('connected');
      return () => undefined;
    }),
    onSessionAdded: vi.fn(() => () => undefined),
    onSessionRemoved: vi.fn((listener: (sessionId: string) => void) => {
      removedListener = listener;
      return () => {
        removedListener = null;
      };
    }),
    createSession,
    listRuns,
    getAgentActivitySnapshot: vi.fn(async () => ({ revision: 0, items: activityItems })),
    destroySessionGuarded,
  } as unknown as WsEzTerminalTransport;
  return {
    transport,
    listSessions,
    createSession,
    listRuns,
    destroySessionGuarded,
    emitRemoved: (sessionId: string) => removedListener?.(sessionId),
  };
}

async function clickAndFlush(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function renderSwitcher(transport: WsEzTerminalTransport): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MobileNavigationHistoryProvider>
        <SessionSwitcher
          variant="page"
          transport={transport}
          onSelect={vi.fn()}
          onDisconnect={vi.fn()}
        />
      </MobileNavigationHistoryProvider>,
    );
    await Promise.resolve();
  });
  return container;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
  window.history.replaceState({}, '');
});

describe('SessionSwitcher recovery states', () => {
  it('shows a retryable error instead of leaving loading visible', async () => {
    const { transport, listSessions } = makeTransport([]);
    listSessions.mockRejectedValueOnce(new Error('Desktop did not respond.'));
    const element = await renderSwitcher(transport);

    expect(element.querySelector('[role="alert"]')?.textContent).toContain('Desktop did not respond.');
    expect(element.textContent).not.toContain('Loading…');

    await clickAndFlush(element.querySelector<HTMLButtonElement>('.session-list-error .btn')!);
    expect(element.querySelector('[data-testid="session-item"]')).not.toBeNull();
  });

  it('reports create failure and allows a later retry', async () => {
    const { transport, createSession } = makeTransport([]);
    createSession.mockRejectedValueOnce(new Error('Connection lost.'));
    const element = await renderSwitcher(transport);
    const create = element.querySelector<HTMLButtonElement>('[data-testid="session-create"]')!;

    await clickAndFlush(create);
    expect(element.querySelector('.session-create-error')?.textContent).toContain('Connection lost.');
    expect(create.disabled).toBe(false);
  });
});

describe('SessionSwitcher risky destruction', () => {
  it('destroys an idle session immediately', async () => {
    const { transport, destroySessionGuarded } = makeTransport([]);
    const element = await renderSwitcher(transport);
    await clickAndFlush(
      element.querySelector<HTMLButtonElement>('[data-testid="session-destroy"]')!,
    );
    expect(destroySessionGuarded).toHaveBeenCalledWith(SESSION.sessionId, []);
    expect(element.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('guards an active SSH session and makes Cancel the default action', async () => {
    const { transport, destroySessionGuarded } = makeTransport([
      {
        sessionId: SESSION.sessionId,
        runId: 'run-1',
        commandText: 'ssh-connect prod',
        executionKind: 'ssh',
      },
    ]);
    const element = await renderSwitcher(transport);
    const destroyButton = element.querySelector<HTMLButtonElement>('[data-testid="session-destroy"]')!;
    destroyButton.focus();
    await clickAndFlush(destroyButton);

    const dialog = element.querySelector('[role="alertdialog"]');
    const cancel = element.querySelector<HTMLButtonElement>('[data-testid="session-destroy-cancel"]')!;
    expect(dialog?.textContent).toContain('active SSH connection');
    expect(document.activeElement).toBe(cancel);
    expect(destroySessionGuarded).not.toHaveBeenCalled();

    await act(async () => {
      cancel.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(document.activeElement).toBe(destroyButton);
  });

  it('uses Android Back to dismiss the shared destroy sheet and restore focus', async () => {
    const { transport } = makeTransport([{
      sessionId: SESSION.sessionId,
      runId: 'run-1',
      commandText: 'build',
      executionKind: 'local',
    }]);
    const element = await renderSwitcher(transport);
    const destroyButton = element.querySelector<HTMLButtonElement>('[data-testid="session-destroy"]')!;
    destroyButton.focus();
    await clickAndFlush(destroyButton);

    act(() => {
      window.history.replaceState({}, '');
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    });
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

    expect(element.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(destroyButton);
  });

  it('destroys only after explicit confirmation for an active command', async () => {
    const { transport, destroySessionGuarded } = makeTransport([
      {
        sessionId: SESSION.sessionId,
        runId: 'run-1',
        commandText: 'build',
        executionKind: 'local',
      },
    ]);
    const element = await renderSwitcher(transport);
    await clickAndFlush(
      element.querySelector<HTMLButtonElement>('[data-testid="session-destroy"]')!,
    );
    await clickAndFlush(
      element.querySelector<HTMLButtonElement>('[data-testid="session-destroy-confirm"]')!,
    );
    expect(destroySessionGuarded).toHaveBeenCalledWith(SESSION.sessionId, ['run-1']);
  });

  it('dismisses the guard when the backend removes the session independently', async () => {
    const { transport, destroySessionGuarded, emitRemoved } = makeTransport([
      {
        sessionId: SESSION.sessionId,
        runId: 'run-1',
        commandText: 'build',
        executionKind: 'local',
      },
    ]);
    const element = await renderSwitcher(transport);
    await clickAndFlush(
      element.querySelector<HTMLButtonElement>('[data-testid="session-destroy"]')!,
    );
    expect(element.querySelector('[role="alertdialog"]')).not.toBeNull();

    act(() => emitRemoved(SESSION.sessionId));
    expect(element.querySelector('[role="alertdialog"]')).toBeNull();
    expect(destroySessionGuarded).not.toHaveBeenCalled();
  });

  it('guards an agent workflow even when no command run is listed', async () => {
    const { transport, destroySessionGuarded } = makeTransport([], [{
      id: 'agent-1',
      sessionId: SESSION.sessionId,
      provider: 'codex',
      cwd: SESSION.cwd,
      status: 'waiting',
      createdAt: 1,
      updatedAt: 2,
    }]);
    const element = await renderSwitcher(transport);
    await clickAndFlush(
      element.querySelector<HTMLButtonElement>('[data-testid="session-destroy"]')!,
    );
    expect(element.querySelector('[role="alertdialog"]')?.textContent).toContain('active agent workflow');
    expect(destroySessionGuarded).not.toHaveBeenCalled();
  });

  it('requires reconfirmation when the active run set changes during confirmation', async () => {
    const { transport, listRuns, destroySessionGuarded } = makeTransport([
      {
        sessionId: SESSION.sessionId,
        runId: 'run-1',
        commandText: 'build',
        executionKind: 'local',
      },
    ]);
    const element = await renderSwitcher(transport);
    await clickAndFlush(
      element.querySelector<HTMLButtonElement>('[data-testid="session-destroy"]')!,
    );

    listRuns.mockResolvedValue([
      {
        sessionId: SESSION.sessionId,
        runId: 'run-2',
        commandText: 'deploy',
        executionKind: 'local',
      },
    ]);
    await clickAndFlush(
      element.querySelector<HTMLButtonElement>('[data-testid="session-destroy-confirm"]')!,
    );

    expect(destroySessionGuarded).not.toHaveBeenCalled();
    expect(element.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'activity that could not be identified',
    );

    await clickAndFlush(
      element.querySelector<HTMLButtonElement>('[data-testid="session-destroy-confirm"]')!,
    );
    expect(destroySessionGuarded).toHaveBeenCalledTimes(1);
    expect(destroySessionGuarded).toHaveBeenCalledWith(SESSION.sessionId, ['run-2']);
    expect(element.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('keeps the dialog open when the guarded backend reports changed state', async () => {
    const { transport, destroySessionGuarded } = makeTransport([
      {
        sessionId: SESSION.sessionId,
        runId: 'run-1',
        commandText: 'build',
        executionKind: 'local',
      },
    ]);
    destroySessionGuarded.mockResolvedValueOnce({ ok: false, reason: 'state-changed' });
    const element = await renderSwitcher(transport);
    await clickAndFlush(
      element.querySelector<HTMLButtonElement>('[data-testid="session-destroy"]')!,
    );
    await clickAndFlush(
      element.querySelector<HTMLButtonElement>('[data-testid="session-destroy-confirm"]')!,
    );

    expect(destroySessionGuarded).toHaveBeenCalledWith(SESSION.sessionId, ['run-1']);
    expect(element.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'activity that could not be identified',
    );
  });
});
