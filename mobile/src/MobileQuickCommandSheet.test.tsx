import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MobileQuickCommandSheet,
  type MobileQuickCommandSource,
} from './MobileQuickCommandSheet';
import type { QuickCommand } from '../../src/shared/quick-command';
import type { RemoteQuickCommandsResult } from './transport/ws-ezterminal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const command: QuickCommand = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Check status',
  command: 'git status --short',
  description: 'Repository state',
  createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  window.history.replaceState({}, '');
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.history.replaceState({}, '');
});

function renderSheet({
  source,
  supported = true,
  connected = true,
  onInsert = vi.fn(),
  onRun = vi.fn(),
  runDisabledReason,
}: {
  source: MobileQuickCommandSource;
  supported?: boolean;
  connected?: boolean;
  onInsert?: (text: string) => void;
  onRun?: (text: string) => void;
  runDisabledReason?: string;
}): void {
  act(() => root.render(
    <MobileQuickCommandSheet
      source={source}
      supported={supported}
      connected={connected}
      onInsert={onInsert}
      onRun={onRun}
      runDisabledReason={runDisabledReason}
    />,
  ));
}

async function openAndLoad(): Promise<void> {
  act(() => container.querySelector<HTMLButtonElement>('[data-testid="mobile-quick-command-trigger"]')!.click());
  await act(async () => Promise.resolve());
}

describe('MobileQuickCommandSheet', () => {
  it('is absent when the paired desktop did not advertise support', () => {
    const source = { listRemoteQuickCommands: vi.fn() } as MobileQuickCommandSource;
    renderSheet({ source, supported: false });
    expect(container.querySelector('[data-testid="mobile-quick-command-trigger"]')).toBeNull();
    expect(source.listRemoteQuickCommands).not.toHaveBeenCalled();
  });

  it('fetches only on open and explicitly inserts without running', async () => {
    const source: MobileQuickCommandSource = {
      listRemoteQuickCommands: vi.fn(async (): Promise<RemoteQuickCommandsResult> => ({ ok: true, commands: [command] })),
    };
    const onInsert = vi.fn();
    const onRun = vi.fn();
    renderSheet({ source, onInsert, onRun });
    expect(source.listRemoteQuickCommands).not.toHaveBeenCalled();

    await openAndLoad();
    act(() => container.querySelector<HTMLButtonElement>(`[data-testid="mobile-quick-command-insert-${command.id}"]`)!.click());

    expect(onInsert).toHaveBeenCalledWith(command.command);
    expect(onRun).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="mobile-quick-command-sheet"]')).toBeNull();
    expect(container.textContent).not.toContain(command.command);
  });

  it('requires a preview confirmation before Run', async () => {
    const source: MobileQuickCommandSource = {
      listRemoteQuickCommands: vi.fn(async (): Promise<RemoteQuickCommandsResult> => ({ ok: true, commands: [command] })),
    };
    const onRun = vi.fn();
    renderSheet({ source, onRun });
    await openAndLoad();

    act(() => container.querySelector<HTMLButtonElement>(`[data-testid="mobile-quick-command-run-${command.id}"]`)!.click());
    expect(onRun).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Run this command in the current session?');

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="mobile-quick-command-confirm-run"]')!.click());
    expect(onRun).toHaveBeenCalledWith(command.command);
  });

  it('keeps a loaded row insertable after disconnect while disabling Run', async () => {
    const source: MobileQuickCommandSource = {
      listRemoteQuickCommands: vi.fn(async (): Promise<RemoteQuickCommandsResult> => ({ ok: true, commands: [command] })),
    };
    const onInsert = vi.fn();
    renderSheet({ source, connected: true, onInsert });
    await openAndLoad();

    renderSheet({ source, connected: false, onInsert });
    expect(container.textContent).toContain('Offline');
    expect(container.querySelector<HTMLButtonElement>(`[data-testid="mobile-quick-command-run-${command.id}"]`)?.disabled).toBe(true);
    act(() => container.querySelector<HTMLButtonElement>(`[data-testid="mobile-quick-command-insert-${command.id}"]`)!.click());
    expect(onInsert).toHaveBeenCalledWith(command.command);
  });

  it('renders retryable error and desktop-authored empty states', async () => {
    const source: MobileQuickCommandSource = {
      listRemoteQuickCommands: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, error: 'unavailable' })
        .mockResolvedValueOnce({ ok: true, commands: [] }),
    };
    renderSheet({ source });
    await openAndLoad();
    expect(container.textContent).toContain('Could not load Quick Commands.');
    act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!.click());
    await act(async () => Promise.resolve());
    expect(container.textContent).toContain('Add them on desktop.');
  });
});
