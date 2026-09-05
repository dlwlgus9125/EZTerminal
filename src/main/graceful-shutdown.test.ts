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

  it('starts dependent cleanup only after its named prerequisite settles', async () => {
    let finishIngressDrain!: () => void;
    const ingressDrain = new Promise<void>((resolve) => { finishIngressDrain = resolve; });
    const stopIngress = vi.fn(() => ingressDrain);
    const disposeDependency = vi.fn();
    const independentCleanup = vi.fn();
    const continueQuit = vi.fn();
    const coordinator = new GracefulShutdownCoordinator({
      tasks: [
        { name: 'agent control', run: stopIngress },
        { name: 'managed merge', after: ['agent control'], run: disposeDependency },
        { name: 'independent', run: independentCleanup },
      ],
      continueQuit,
    });

    coordinator.handleBeforeQuit(quitEvent());

    expect(stopIngress).toHaveBeenCalledOnce();
    expect(independentCleanup).toHaveBeenCalledOnce();
    expect(disposeDependency).not.toHaveBeenCalled();
    expect(continueQuit).not.toHaveBeenCalled();

    finishIngressDrain();
    await vi.waitFor(() => expect(continueQuit).toHaveBeenCalledOnce());
    expect(disposeDependency).toHaveBeenCalledOnce();
  });

  it.each([
    ['synchronous', () => { throw new Error('sync prerequisite failed'); }],
    ['asynchronous', async () => { throw new Error('async prerequisite failed'); }],
  ] as const)('runs dependent cleanup after a %s prerequisite failure is reported', async (_kind, fail) => {
    const disposeDependency = vi.fn();
    const continueQuit = vi.fn();
    const reportError = vi.fn();
    const coordinator = new GracefulShutdownCoordinator({
      tasks: [
        { name: 'ingress', run: fail },
        { name: 'dependent', after: ['ingress'], run: disposeDependency },
      ],
      continueQuit,
      reportError,
    });

    coordinator.handleBeforeQuit(quitEvent());
    await vi.waitFor(() => expect(continueQuit).toHaveBeenCalledOnce());

    expect(disposeDependency).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(
      'shutdown task "ingress" failed',
      expect.objectContaining({ message: expect.stringContaining('prerequisite failed') }),
    );
  });

  it.each([
    ['unknown dependency', [
      { name: 'first', after: ['missing'], run: vi.fn() },
      { name: 'second', run: vi.fn() },
    ]],
    ['dependency cycle', [
      { name: 'first', after: ['second'], run: vi.fn() },
      { name: 'second', after: ['first'], run: vi.fn() },
    ]],
  ] as const)('reports an invalid %s and falls back to declared sequential cleanup', async (_kind, tasks) => {
    const order: string[] = [];
    const normalizedTasks = tasks.map((task) => ({
      ...task,
      run: vi.fn(async () => {
        order.push(`${task.name}:start`);
        await Promise.resolve();
        order.push(`${task.name}:end`);
      }),
    }));
    const continueQuit = vi.fn();
    const reportError = vi.fn();
    const coordinator = new GracefulShutdownCoordinator({
      tasks: normalizedTasks,
      continueQuit,
      reportError,
    });

    coordinator.handleBeforeQuit(quitEvent());
    await vi.waitFor(() => expect(continueQuit).toHaveBeenCalledOnce());

    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    expect(reportError).toHaveBeenCalledWith(
      'shutdown task dependency graph invalid',
      expect.any(Error),
    );
  });
});
