import { describe, expect, it, vi } from 'vitest';

import type {
  RemoteDesktopHostStatus,
  RemoteRuntimeStatus,
} from '../shared/ipc';
import {
  DESKTOP_RUNTIME_IPC_CHANNELS,
  ManagedDesktopRuntime,
  describeDesktopRuntimeError,
  type DesktopControlHost,
  type DesktopRuntimeIpcAdapter,
  type DesktopRuntimeIpcChannel,
  type DesktopRuntimeIpcHandler,
  type DesktopRuntimeOptions,
  type DesktopRuntimeTokenStore,
  type DesktopStatusPresentation,
} from './desktop-runtime';
import type { RemoteBridgeHandle } from './remote-bridge';

function desktopStatus(
  patch: Partial<RemoteDesktopHostStatus> = {},
): RemoteDesktopHostStatus {
  return {
    state: 'idle',
    service: 'ready',
    controllerName: null,
    connectedAt: null,
    localAddress: null,
    peerAddress: null,
    framesPerSecond: null,
    roundTripTimeMs: null,
    bitrateKbps: null,
    qualityTier: null,
    errorCode: null,
    ...patch,
  };
}

class FakeIpc implements DesktopRuntimeIpcAdapter {
  readonly handlers = new Map<DesktopRuntimeIpcChannel, DesktopRuntimeIpcHandler>();
  readonly registrations: DesktopRuntimeIpcChannel[] = [];
  readonly removals: DesktopRuntimeIpcChannel[] = [];

  handle(channel: DesktopRuntimeIpcChannel, handler: DesktopRuntimeIpcHandler): void {
    if (this.handlers.has(channel)) throw new Error(`duplicate IPC handler: ${channel}`);
    this.registrations.push(channel);
    this.handlers.set(channel, handler);
  }

  removeHandler(channel: DesktopRuntimeIpcChannel): void {
    this.removals.push(channel);
    this.handlers.delete(channel);
  }

  reserve(channel: DesktopRuntimeIpcChannel): void {
    this.handlers.set(channel, () => undefined);
  }

  release(channel: DesktopRuntimeIpcChannel): void {
    this.handlers.delete(channel);
  }

  invoke(channel: DesktopRuntimeIpcChannel, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) return Promise.reject(new Error(`missing IPC handler: ${channel}`));
    return Promise.resolve(handler({}, ...args));
  }
}

class FakeDesktopHost implements DesktopControlHost {
  status = desktopStatus();
  readonly shutdown = vi.fn(async () => undefined);
  readonly probeService = vi.fn(async () => this.status);
  private readonly listeners = new Set<(status: RemoteDesktopHostStatus) => void>();
  private readonly listenerHistory: Array<(status: RemoteDesktopHostStatus) => void> = [];

  getStatus(): RemoteDesktopHostStatus {
    return this.status;
  }

  onStatus(listener: (status: RemoteDesktopHostStatus) => void): () => void {
    this.listeners.add(listener);
    this.listenerHistory.push(listener);
    return () => this.listeners.delete(listener);
  }

  emit(status: RemoteDesktopHostStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }

  emitFromStaleSubscription(status: RemoteDesktopHostStatus): void {
    for (const listener of this.listenerHistory) listener(status);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

function tokenStore(): DesktopRuntimeTokenStore {
  return {
    init: vi.fn(async () => undefined),
    getToken: vi.fn(async () => 'a'.repeat(64)),
    rotateToken: vi.fn(async () => 'b'.repeat(64)),
  };
}

function presentation(): DesktopStatusPresentation & {
  update: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
} {
  return {
    update: vi.fn(),
    destroy: vi.fn(),
  };
}

function bridge(port = 7420): RemoteBridgeHandle & { stop: ReturnType<typeof vi.fn> } {
  return {
    port,
    stop: vi.fn(async () => undefined),
  };
}

interface Harness {
  readonly ipc: FakeIpc;
  readonly desktopHost: FakeDesktopHost;
  readonly token: DesktopRuntimeTokenStore;
  readonly desktopPresentation: ReturnType<typeof presentation>;
  readonly runningBridge: ReturnType<typeof bridge>;
  readonly startBridge: ReturnType<typeof vi.fn>;
  readonly stopAuxiliaryRuntime: ReturnType<typeof vi.fn>;
  readonly publishRuntimeStatus: ReturnType<typeof vi.fn>;
  readonly publishDesktopStatus: ReturnType<typeof vi.fn>;
  readonly reportError: ReturnType<typeof vi.fn>;
  readonly options: DesktopRuntimeOptions;
}

function harness(overrides: Partial<DesktopRuntimeOptions> = {}): Harness {
  const ipc = new FakeIpc();
  const desktopHost = new FakeDesktopHost();
  const token = tokenStore();
  const desktopPresentation = presentation();
  const runningBridge = bridge();
  const startBridge = vi.fn(async () => runningBridge);
  const stopAuxiliaryRuntime = vi.fn(async () => undefined);
  const publishRuntimeStatus = vi.fn<(status: RemoteRuntimeStatus) => void>();
  const publishDesktopStatus = vi.fn<(status: RemoteDesktopHostStatus) => void>();
  const reportError = vi.fn<(context: string, error: unknown) => void>();
  const options: DesktopRuntimeOptions = {
    port: 7420,
    ipc,
    tokenStore: token,
    desktopHost,
    desktopPresentation,
    readDesiredEnabled: async () => true,
    writeDesiredEnabled: async () => undefined,
    startBridge,
    getConnectionInfo: () => ({ urls: ['ws://100.64.0.1:7420'], port: 7420 }),
    stopAuxiliaryRuntime,
    publishRuntimeStatus,
    publishDesktopStatus,
    reportError,
    ...overrides,
  };
  return {
    ipc,
    desktopHost,
    token,
    desktopPresentation,
    runningBridge,
    startBridge,
    stopAuxiliaryRuntime,
    publishRuntimeStatus,
    publishDesktopStatus,
    reportError,
    options,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('ManagedDesktopRuntime Interface', () => {
  it('registers the exact IPC contract once and initializes the bridge once', async () => {
    const h = harness();
    const runtime = new ManagedDesktopRuntime(h.options);

    const first = runtime.initialize();
    const duplicate = runtime.initialize();

    expect(duplicate).toBe(first);
    await expect(first).resolves.toMatchObject({
      desiredEnabled: true,
      state: 'running',
      port: 7420,
    });
    expect(h.ipc.registrations).toEqual(DESKTOP_RUNTIME_IPC_CHANNELS);
    expect([...h.ipc.handlers.keys()]).toEqual(DESKTOP_RUNTIME_IPC_CHANNELS);
    expect(h.startBridge).toHaveBeenCalledOnce();
    expect(h.token.init).toHaveBeenCalledOnce();
    expect(h.token.getToken).toHaveBeenCalledOnce();
    expect(h.desktopHost.listenerCount).toBe(1);
    expect(h.desktopPresentation.update).toHaveBeenCalledWith(h.desktopHost.status);
    expect(runtime.isRunning()).toBe(true);

    await runtime.dispose();
  });

  it('removes handlers/listeners synchronously and disposes every resource exactly once', async () => {
    const h = harness();
    const runtime = new ManagedDesktopRuntime(h.options);
    await runtime.initialize();
    h.desktopHost.emit(desktopStatus({ state: 'active', controllerName: 'Phone A' }));
    expect(h.publishDesktopStatus).toHaveBeenCalledOnce();

    const firstDisposal = runtime.dispose();
    const duplicateDisposal = runtime.dispose();

    expect(duplicateDisposal).toBe(firstDisposal);
    expect(h.ipc.handlers.size).toBe(0);
    expect(h.desktopHost.listenerCount).toBe(0);
    expect(runtime.isRunning()).toBe(false);

    h.desktopHost.emitFromStaleSubscription(
      desktopStatus({ state: 'error', errorCode: 'LATE_CALLBACK' }),
    );
    expect(h.publishDesktopStatus).toHaveBeenCalledOnce();

    await firstDisposal;
    expect(h.runningBridge.stop).toHaveBeenCalledOnce();
    expect(h.desktopHost.shutdown).toHaveBeenCalledOnce();
    expect(h.desktopHost.shutdown).toHaveBeenCalledWith('app-quit');
    expect(h.stopAuxiliaryRuntime).toHaveBeenCalledOnce();
    expect(h.desktopPresentation.destroy).toHaveBeenCalledOnce();

    await runtime.dispose();
    expect(h.runningBridge.stop).toHaveBeenCalledOnce();
    expect(h.desktopPresentation.destroy).toHaveBeenCalledOnce();
  });

  it('stops a bridge that resolves after disposal and suppresses every late status', async () => {
    const pendingBridge = deferred<RemoteBridgeHandle>();
    const startBridge = vi.fn(() => pendingBridge.promise);
    const h = harness({ startBridge });
    const runtime = new ManagedDesktopRuntime(h.options);
    const initialization = runtime.initialize();
    await vi.waitFor(() => expect(startBridge).toHaveBeenCalledOnce());

    const publishedBeforeDisposal = h.publishRuntimeStatus.mock.calls.length;
    const disposal = runtime.dispose();
    expect(h.ipc.handlers.size).toBe(0);

    pendingBridge.resolve(h.runningBridge);
    await initialization;
    await disposal;

    expect(h.publishRuntimeStatus).toHaveBeenCalledTimes(publishedBeforeDisposal);
    expect(h.runningBridge.stop).toHaveBeenCalledOnce();
  });

  it('rolls back a partial IPC registration conflict and can initialize after the conflict is removed', async () => {
    const h = harness({ readDesiredEnabled: async () => false });
    h.ipc.reserve('remote:get-enabled');
    const runtime = new ManagedDesktopRuntime(h.options);

    await expect(runtime.initialize()).rejects.toThrow('duplicate IPC handler');
    expect([...h.ipc.handlers.keys()]).toEqual(['remote:get-enabled']);
    expect(h.desktopHost.listenerCount).toBe(0);
    expect(h.startBridge).not.toHaveBeenCalled();

    h.ipc.release('remote:get-enabled');
    await expect(runtime.initialize()).resolves.toMatchObject({ state: 'off' });
    expect([...h.ipc.handlers.keys()]).toEqual(DESKTOP_RUNTIME_IPC_CHANNELS);
    await runtime.dispose();
  });

  it('fails closed when secure token loading fails and exposes only the stable status payload', async () => {
    const secretFailure = new Error('token=do-not-log');
    const failingToken: DesktopRuntimeTokenStore = {
      init: vi.fn(async () => undefined),
      getToken: vi.fn(async () => Promise.reject(secretFailure)),
      rotateToken: vi.fn(async () => Promise.reject(secretFailure)),
    };
    const h = harness({ tokenStore: failingToken });
    const runtime = new ManagedDesktopRuntime(h.options);

    await expect(runtime.initialize()).resolves.toMatchObject({
      desiredEnabled: true,
      state: 'error',
      errorCode: 'REMOTE_TOKEN_UNAVAILABLE',
    });
    expect(h.startBridge).not.toHaveBeenCalled();
    await expect(h.ipc.invoke('remote:get-security-status')).resolves.toEqual({
      state: 'error',
      error: 'The remote access token could not be stored securely. Remote access remains off.',
    });
    await expect(h.ipc.invoke('remote:get-token')).rejects.toBe(secretFailure);
    expect(describeDesktopRuntimeError(secretFailure)).toBe('Error');
    expect(describeDesktopRuntimeError(secretFailure)).not.toContain('do-not-log');

    await runtime.dispose();
  });

  it('does not mutate settings for malformed IPC and propagates token rotation failure after fail-closed stop', async () => {
    const rotationFailure = Object.assign(new Error('bearer=do-not-log'), {
      code: 'TOKEN_WRITE_FAILED',
    });
    const token = tokenStore();
    token.rotateToken = vi.fn(async () => Promise.reject(rotationFailure));
    const writeDesiredEnabled = vi.fn(async () => undefined);
    const h = harness({
      tokenStore: token,
      readDesiredEnabled: async () => false,
      writeDesiredEnabled,
    });
    const runtime = new ManagedDesktopRuntime(h.options);
    await runtime.initialize();

    await expect(h.ipc.invoke('remote:set-enabled', 'yes')).resolves.toMatchObject({
      desiredEnabled: false,
      state: 'off',
    });
    expect(writeDesiredEnabled).not.toHaveBeenCalled();

    await expect(h.ipc.invoke('remote:rotate-token')).rejects.toBe(rotationFailure);
    await expect(h.ipc.invoke('remote:get-runtime-status')).resolves.toMatchObject({
      state: 'error',
      errorCode: 'REMOTE_TOKEN_UNAVAILABLE',
    });
    expect(h.stopAuxiliaryRuntime).toHaveBeenCalledOnce();
    expect(describeDesktopRuntimeError(rotationFailure)).toBe('Error');
    expect(describeDesktopRuntimeError(rotationFailure)).not.toContain('bearer');
    expect(describeDesktopRuntimeError(Object.assign(new Error('hidden'), { code: 'EADDRINUSE' })))
      .toBe('Error (EADDRINUSE)');

    await runtime.dispose();
  });

  it('contains cleanup failures while still attempting every owned resource', async () => {
    const h = harness();
    const bridgeFailure = new Error('bridge cleanup detail');
    const desktopFailure = new Error('desktop cleanup detail');
    const auxiliaryFailure = new Error('proxy cleanup detail');
    h.runningBridge.stop.mockRejectedValueOnce(bridgeFailure);
    h.desktopHost.shutdown.mockRejectedValueOnce(desktopFailure);
    h.stopAuxiliaryRuntime.mockRejectedValueOnce(auxiliaryFailure);
    h.desktopPresentation.destroy.mockImplementationOnce(() => {
      throw new Error('tray cleanup detail');
    });
    const runtime = new ManagedDesktopRuntime(h.options);
    await runtime.initialize();

    await expect(runtime.dispose()).resolves.toBeUndefined();

    expect(h.runningBridge.stop).toHaveBeenCalledOnce();
    expect(h.desktopHost.shutdown).toHaveBeenCalledOnce();
    expect(h.stopAuxiliaryRuntime).toHaveBeenCalledOnce();
    expect(h.desktopPresentation.destroy).toHaveBeenCalledOnce();
    expect(h.reportError.mock.calls.map(([context]) => context)).toEqual(expect.arrayContaining([
      'remote runtime shutdown failed',
      'remote desktop shutdown failed',
      'auxiliary remote runtime shutdown failed',
      'remote desktop presentation cleanup failed',
    ]));
  });
});
