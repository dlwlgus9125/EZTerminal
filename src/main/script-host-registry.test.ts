import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class FakeUtilityProcess {
    readonly posted: Array<{ message: unknown; ports: unknown[] }> = [];
    readonly kill = vi.fn(() => {
      queueMicrotask(() => this.emit('exit', null));
      return true;
    });
    private readonly listeners = new Map<string, Set<Listener>>();

    constructor(readonly pid: number | undefined) {}

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? new Set<Listener>();
      listeners.add(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    once(event: string, listener: Listener): this {
      const wrapped: Listener = (...args) => {
        this.off(event, wrapped);
        listener(...args);
      };
      return this.on(event, wrapped);
    }

    off(event: string, listener: Listener): this {
      this.listeners.get(event)?.delete(listener);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
    }

    postMessage(message: unknown, ports: unknown[] = []): void {
      this.posted.push({ message, ports });
    }
  }

  const fork = vi.fn<() => FakeUtilityProcess>();
  const channels: Array<{ port1: object; port2: object }> = [];
  class FakeMessageChannelMain {
    readonly port1 = { side: 'main' };
    readonly port2 = { side: 'host' };

    constructor() {
      channels.push(this);
    }
  }

  return { channels, FakeMessageChannelMain, FakeUtilityProcess, fork };
});

vi.mock('electron', () => ({
  MessageChannelMain: electronMocks.FakeMessageChannelMain,
  utilityProcess: { fork: electronMocks.fork },
}));

import { ScriptHostRegistry, type ScriptHostGuardian } from './script-host-registry';

beforeEach(() => {
  electronMocks.channels.length = 0;
  electronMocks.fork.mockReset();
});

describe('ScriptHostRegistry process ownership', () => {
  it('registers the host group before transferring its initialization port', async () => {
    const host = new electronMocks.FakeUtilityProcess(451);
    electronMocks.fork.mockReturnValue(host);
    let releaseOwnership!: () => void;
    const createGroup = vi.fn(() => new Promise<void>((resolve) => {
      releaseOwnership = resolve;
    }));
    const guardian: ScriptHostGuardian = {
      createGroup,
      terminateGroup: vi.fn(async () => undefined),
    };
    const registry = new ScriptHostRegistry('script-host.js', guardian, () => 'interpreter:1');

    const spawning = registry.spawn('host-1', 'fixture.ez', ['a'], 'C:\\work', vi.fn());
    await Promise.resolve();
    await Promise.resolve();

    expect(createGroup).toHaveBeenCalledWith('script-host:host-1', 451, 'interpreter:1');
    expect(host.posted).toEqual([]);

    releaseOwnership();
    await expect(spawning).resolves.toEqual({ interpreterPort: { side: 'main' } });
    expect(host.posted).toEqual([{
      message: {
        type: 'init',
        hostId: 'host-1',
        scriptPath: 'fixture.ez',
        args: ['a'],
        cwd: 'C:\\work',
      },
      ports: [{ side: 'host' }],
    }]);
  });

  it('kills the direct host when ownership registration fails', async () => {
    const host = new electronMocks.FakeUtilityProcess(452);
    electronMocks.fork.mockReturnValue(host);
    const guardian: ScriptHostGuardian = {
      createGroup: vi.fn(async () => {
        throw new Error('outside root job');
      }),
      terminateGroup: vi.fn(async () => undefined),
    };
    const registry = new ScriptHostRegistry('script-host.js', guardian, () => 'interpreter:1');

    await expect(registry.spawn('host-2', 'fixture.ez', [], 'C:\\work', vi.fn()))
      .resolves.toEqual({ error: 'outside root job' });

    expect(host.kill).toHaveBeenCalledOnce();
    expect(guardian.terminateGroup).not.toHaveBeenCalled();
  });

  it('terminates the registered group and waits for host exit', async () => {
    const host = new electronMocks.FakeUtilityProcess(453);
    electronMocks.fork.mockReturnValue(host);
    const terminateGroup = vi.fn(async () => {
      host.emit('exit', 0);
    });
    const guardian: ScriptHostGuardian = {
      createGroup: vi.fn(async () => undefined),
      terminateGroup,
    };
    const registry = new ScriptHostRegistry('script-host.js', guardian, () => 'interpreter:1');
    await registry.spawn('host-3', 'fixture.ez', [], 'C:\\work', vi.fn());

    await registry.kill('host-3');

    expect(terminateGroup).toHaveBeenCalledWith('script-host:host-3');
    expect(host.kill).not.toHaveBeenCalled();
  });
});
