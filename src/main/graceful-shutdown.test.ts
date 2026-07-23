import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GracefulShutdownCoordinator,
  GracefulShutdownTimeoutError,
  type BeforeQuitEvent,
} from './graceful-shutdown';

function quitEvent() {
  return {
    preventDefault: vi.fn(),
  } satisfies BeforeQuitEvent;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('GracefulShutdownCoordinator', () => {
  it('starts cleanup exactly once and lets the re-entrant final quit proceed', async () => {
    let finishCleanup!: () => void;
    const pendingCleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const synchronousCleanup = vi.fn();
    const asynchronousCleanup = vi.fn(() => pendingCleanup);
    const firstEvent = quitEvent();
    const repeatedEvent = quitEvent();
    const finalEvent = quitEvent();
    const continueQuit = vi.fn();
    const coordinator = new GracefulShutdownCoordinator({
      tasks: [
        { name: 'synchronous', run: synchronousCleanup },
        { name: 'asynchronous', run: asynchronousCleanup },
      ],
      continueQuit,
    });
    continueQuit.mockImplementation(() => coordinator.handleBeforeQuit(finalEvent));

    coordinator.handleBeforeQuit(firstEvent);
    coordinator.handleBeforeQuit(repeatedEvent);

    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(repeatedEvent.preventDefault).toHaveBeenCalledOnce();
    expect(synchronousCleanup).toHaveBeenCalledOnce();
    expect(asynchronousCleanup).toHaveBeenCalledOnce();
    expect(continueQuit).not.toHaveBeenCalled();

    finishCleanup();
    await pendingCleanup;
    await vi.waitFor(() => expect(continueQuit).toHaveBeenCalledOnce());

    expect(finalEvent.preventDefault).not.toHaveBeenCalled();
    coordinator.handleBeforeQuit(quitEvent());
    expect(synchronousCleanup).toHaveBeenCalledOnce();
    expect(asynchronousCleanup).toHaveBeenCalledOnce();
  });

  it('continues quit after the bounded timeout without rerunning a hung task', async () => {
    vi.useFakeTimers();
    const hungCleanup = vi.fn(() => new Promise<void>(() => undefined));
    const continueQuit = vi.fn();
    const reportError = vi.fn();
    const event = quitEvent();
    const coordinator = new GracefulShutdownCoordinator({
      tasks: [{ name: 'hung', run: hungCleanup }],
      timeoutMs: 250,
      continueQuit,
      reportError,
    });

    coordinator.handleBeforeQuit(event);
    await vi.advanceTimersByTimeAsync(249);
    expect(continueQuit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(continueQuit).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(
      'graceful shutdown timed out',
      expect.any(GracefulShutdownTimeoutError),
    );

    const finalEvent = quitEvent();
    coordinator.handleBeforeQuit(finalEvent);
    expect(finalEvent.preventDefault).not.toHaveBeenCalled();
    expect(hungCleanup).toHaveBeenCalledOnce();
  });

  it('isolates synchronous and asynchronous task failures from later cleanup', async () => {
    const syncFailure = new Error('sync failed');
    const asyncFailure = new Error('async failed');
    const afterFailures = vi.fn();
    const continueQuit = vi.fn();
    const reportError = vi.fn();
    const coordinator = new GracefulShutdownCoordinator({
      tasks: [
        {
          name: 'sync',
          run: () => {
            throw syncFailure;
          },
        },
        {
          name: 'async',
          run: async () => {
            throw asyncFailure;
          },
        },
        { name: 'after', run: afterFailures },
      ],
      continueQuit,
      reportError,
    });

    coordinator.handleBeforeQuit(quitEvent());
    await vi.waitFor(() => expect(continueQuit).toHaveBeenCalledOnce());

    expect(afterFailures).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith('shutdown task "sync" failed', syncFailure);
    expect(reportError).toHaveBeenCalledWith('shutdown task "async" failed', asyncFailure);
  });
});
