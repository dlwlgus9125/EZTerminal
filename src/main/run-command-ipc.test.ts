import { describe, expect, it, vi } from 'vitest';

import type { InterpreterBroker } from './interpreter-broker';
import {
  installRunCommandIpc,
  type RunCommandEvent,
  type RunCommandIpc,
  type RunCommandListener,
} from './run-command-ipc';

class FakeRunCommandIpc implements RunCommandIpc {
  readonly listeners = new Set<RunCommandListener>();
  readonly on = vi.fn((_channel: 'run-command', listener: RunCommandListener) => {
    this.listeners.add(listener);
  });
  readonly removeListener = vi.fn((_channel: 'run-command', listener: RunCommandListener) => {
    this.listeners.delete(listener);
  });

  emit(event: RunCommandEvent, payload: unknown): void {
    for (const listener of this.listeners) listener(event, payload);
  }
}

function brokerWith(port: object | null) {
  return {
    runCommand: vi.fn(() => port),
  } as unknown as Pick<InterpreterBroker, 'runCommand'>;
}

describe('run-command app-lifetime IPC', () => {
  it('registers once, routes each request once, and removes the exact listener once', () => {
    const ipc = new FakeRunCommandIpc();
    const port = {};
    const broker = brokerWith(port);
    const firstSender = { postMessage: vi.fn() };
    const secondSender = { postMessage: vi.fn() };
    const reportInfo = vi.fn();
    const uninstall = installRunCommandIpc({
      ipc,
      getBroker: () => broker,
      reportInfo,
    });

    expect(ipc.on).toHaveBeenCalledOnce();
    expect(ipc.listeners.size).toBe(1);
    ipc.emit(
      { sender: firstSender },
      { commandText: 'pwd', runId: 'run-1', sessionId: 'session-1' },
    );
    ipc.emit(
      { sender: secondSender },
      { commandText: 'ls', runId: 'run-2', sessionId: 'session-2' },
    );

    expect(broker.runCommand).toHaveBeenNthCalledWith(1, 'session-1', 'run-1', 'pwd');
    expect(broker.runCommand).toHaveBeenNthCalledWith(2, 'session-2', 'run-2', 'ls');
    expect(firstSender.postMessage).toHaveBeenCalledWith('cmd-port', { runId: 'run-1' }, [port]);
    expect(secondSender.postMessage).toHaveBeenCalledWith('cmd-port', { runId: 'run-2' }, [port]);
    expect(reportInfo).toHaveBeenCalledTimes(2);

    uninstall();
    uninstall();
    expect(ipc.removeListener).toHaveBeenCalledOnce();
    expect(ipc.listeners.size).toBe(0);
    ipc.emit(
      { sender: firstSender },
      { commandText: 'echo late', runId: 'run-3', sessionId: 'session-1' },
    );
    expect(broker.runCommand).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed envelopes and unavailable brokers without transferring a port', () => {
    const ipc = new FakeRunCommandIpc();
    const broker = brokerWith(null);
    const sender = { postMessage: vi.fn() };
    const reportError = vi.fn();
    const uninstall = installRunCommandIpc({
      ipc,
      getBroker: () => broker,
      reportError,
    });

    ipc.emit({ sender }, undefined);
    ipc.emit(
      { sender },
      { commandText: 'pwd', runId: '', sessionId: 'session-1' },
    );
    ipc.emit(
      { sender },
      { commandText: 'pwd', runId: 'run-1', sessionId: 'session-1' },
    );

    expect(broker.runCommand).toHaveBeenCalledOnce();
    expect(sender.postMessage).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(3);
    uninstall();
  });
});
