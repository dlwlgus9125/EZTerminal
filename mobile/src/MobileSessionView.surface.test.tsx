import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunStartedInfo } from '../../src/shared/ipc';
import type { SessionSurfaceBinding } from '../../src/shared/session-surface';
import { MobileNavigationHistoryProvider } from './MobileNavigationHistory';
import { MobileSessionView } from './MobileSessionView';
import { MobileToastProvider } from './MobileToast';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION = { sessionId: 'session-1', cwd: '/work' } as const;

function binding(role: 'owner' | 'adopted'): SessionSurfaceBinding {
  return {
    surfaceId: 'surface-1',
    bindingId: 'binding-1',
    session: SESSION,
    role,
  };
}

function makeTransport(role: 'owner' | 'adopted', runs: readonly RunStartedInfo[]) {
  const listRuns = vi.fn(async () => runs);
  const prepareSessionSurfaceClose = vi.fn(async () => ({
    ok: true as const,
    prepared: {
      closeToken: 'close-token-1',
      items: [{
        bindingId: 'binding-1',
        surfaceId: 'surface-1',
        sessionId: SESSION.sessionId,
        role,
      }],
    },
  }));
  const commitSessionSurfaceClose = vi.fn(async () => ({
    ok: true as const,
    keptSessionIds: [] as readonly string[],
  }));
  const releaseSessionSurface = vi.fn(async () => ({ ok: true as const }));
  const transport = {
    listRuns,
    getAgentActivitySnapshot: vi.fn(async () => ({ revision: 0, items: [] })),
    prepareSessionSurfaceClose,
    commitSessionSurfaceClose,
    releaseSessionSurface,
  } as unknown as WsEzTerminalTransport;
  return {
    transport,
    listRuns,
    prepareSessionSurfaceClose,
    commitSessionSurfaceClose,
    releaseSessionSurface,
  };
}

function installWindowApi(): void {
  Object.defineProperty(window, 'ezterminal', {
    configurable: true,
    value: {
      onSessionDead: () => () => undefined,
      onRunStarted: () => () => undefined,
      listRuns: async () => [],
    } as unknown as Window['ezterminal'],
  });
}

async function renderSurface(
  surfaceBinding: SessionSurfaceBinding,
  transport: WsEzTerminalTransport,
  onCloseTab: () => void,
): Promise<{ readonly host: HTMLDivElement; readonly root: Root }> {
  installWindowApi();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <MobileNavigationHistoryProvider>
        <MobileToastProvider>
          <MobileSessionView
            sessionId={SESSION.sessionId}
            cwd={SESSION.cwd}
            connected
            transport={transport}
            surfaceBinding={surfaceBinding}
            onCloseTab={onCloseTab}
          />
        </MobileToastProvider>
      </MobileNavigationHistoryProvider>,
    );
    await Promise.resolve();
  });
  return { host, root };
}

async function click(host: HTMLElement, testId: string): Promise<void> {
  const button = host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!button) throw new Error(`missing ${testId}`);
  await act(async () => {
    button.click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

const mounted: Array<{ readonly host: HTMLDivElement; readonly root: Root }> = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.host.remove();
  }
  Reflect.deleteProperty(window, 'ezterminal');
  window.history.replaceState({}, '');
});

describe('MobileSessionView session-surface lifecycle', () => {
  it('detaches an adopted tab without a termination decision', async () => {
    const h = makeTransport('adopted', []);
    const onCloseTab = vi.fn();
    const view = await renderSurface(binding('adopted'), h.transport, onCloseTab);
    mounted.push(view);

    await click(view.host, 'terminal-close-tab');

    expect(h.prepareSessionSurfaceClose).toHaveBeenCalledWith([{
      bindingId: 'binding-1', expectedActiveRunIds: [],
    }]);
    expect(h.commitSessionSurfaceClose).toHaveBeenCalledWith('close-token-1', []);
    expect(onCloseTab).toHaveBeenCalledOnce();
  });

  it('terminates an idle owner atomically without prompting', async () => {
    const h = makeTransport('owner', []);
    const onCloseTab = vi.fn();
    const view = await renderSurface(binding('owner'), h.transport, onCloseTab);
    mounted.push(view);

    await click(view.host, 'terminal-close-tab');

    expect(view.host.querySelector('[data-testid="terminal-close-dialog"]')).toBeNull();
    expect(h.commitSessionSurfaceClose).toHaveBeenCalledWith('close-token-1', [{
      bindingId: 'binding-1', disposition: 'terminate',
    }]);
    expect(onCloseTab).toHaveBeenCalledOnce();
  });

  it('offers keep, terminate, and cancel for a risky owner', async () => {
    const run = {
      sessionId: SESSION.sessionId,
      runId: 'run-1',
      commandText: 'ssh prod',
      executionKind: 'ssh' as const,
    };
    const h = makeTransport('owner', [run]);
    const onCloseTab = vi.fn();
    const view = await renderSurface(binding('owner'), h.transport, onCloseTab);
    mounted.push(view);

    await click(view.host, 'terminal-close-tab');
    const dialog = view.host.querySelector('[data-testid="terminal-close-dialog"]');
    expect(dialog?.textContent).toContain('active SSH connection');
    expect(view.host.querySelector('[data-testid="terminal-close-cancel"]')).not.toBeNull();
    expect(view.host.querySelector('[data-testid="terminal-close-keep"]')).not.toBeNull();
    expect(view.host.querySelector('[data-testid="terminal-close-terminate"]')).not.toBeNull();
    expect(h.prepareSessionSurfaceClose).not.toHaveBeenCalled();

    await click(view.host, 'terminal-close-keep');
    expect(h.commitSessionSurfaceClose).toHaveBeenCalledWith('close-token-1', [{
      bindingId: 'binding-1', disposition: 'keep',
    }]);
    expect(onCloseTab).toHaveBeenCalledOnce();
  });

  it('fails closed and requires another decision when the run set changes', async () => {
    const first = {
      sessionId: SESSION.sessionId,
      runId: 'run-1',
      commandText: 'build',
      executionKind: 'local' as const,
    };
    const second = { ...first, runId: 'run-2', commandText: 'deploy' };
    const h = makeTransport('owner', [first]);
    h.listRuns.mockResolvedValueOnce([first]).mockResolvedValueOnce([second]);
    const onCloseTab = vi.fn();
    const view = await renderSurface(binding('owner'), h.transport, onCloseTab);
    mounted.push(view);

    await click(view.host, 'terminal-close-tab');
    await click(view.host, 'terminal-close-terminate');

    expect(h.commitSessionSurfaceClose).not.toHaveBeenCalled();
    expect(onCloseTab).not.toHaveBeenCalled();
    expect(view.host.querySelector('[data-testid="terminal-close-dialog"]')).not.toBeNull();
  });

  it('releases ownership without destroying work on unexpected unmount', async () => {
    const h = makeTransport('owner', []);
    const view = await renderSurface(binding('owner'), h.transport, vi.fn());

    act(() => view.root.unmount());
    view.host.remove();

    expect(h.releaseSessionSurface).toHaveBeenCalledWith('binding-1');
  });
});
