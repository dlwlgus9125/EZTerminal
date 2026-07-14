import { describe, expect, it, vi } from 'vitest';

import { RemoteRuntimeController } from './remote-runtime';
import type { RemoteBridgeHandle } from './remote-bridge';

function handle(port = 7420): RemoteBridgeHandle {
  return { port, stop: vi.fn(async () => undefined) };
}

describe('RemoteRuntimeController desired/runtime separation', () => {
  it('keeps desired enabled while surfacing EADDRINUSE as runtime error, then retries', async () => {
    let desired = true;
    const firstError = Object.assign(new Error('address in use'), { code: 'EADDRINUSE' });
    const recovered = handle();
    const start = vi.fn<() => Promise<RemoteBridgeHandle>>()
      .mockRejectedValueOnce(firstError)
      .mockResolvedValueOnce(recovered);
    const controller = new RemoteRuntimeController({
      port: 7420,
      readDesiredEnabled: async () => desired,
      writeDesiredEnabled: async (enabled) => { desired = enabled; },
      start,
    });

    await expect(controller.initialize()).resolves.toEqual({
      desiredEnabled: true,
      state: 'error',
      port: 7420,
      errorCode: 'EADDRINUSE',
      error: 'Port 7420 is already in use.',
    });
    expect(desired).toBe(true);

    await expect(controller.retry()).resolves.toEqual({
      desiredEnabled: true,
      state: 'running',
      port: 7420,
      errorCode: null,
      error: null,
    });
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('persists desired separately and does not report off until stop settles', async () => {
    let desired = false;
    let releaseStop!: () => void;
    const stop = vi.fn(() => new Promise<void>((resolve) => { releaseStop = resolve; }));
    const runningHandle: RemoteBridgeHandle = { port: 17420, stop };
    const writeDesiredEnabled = vi.fn(async (enabled: boolean) => { desired = enabled; });
    const statuses: string[] = [];
    const controller = new RemoteRuntimeController({
      port: 7420,
      readDesiredEnabled: async () => desired,
      writeDesiredEnabled,
      start: async () => runningHandle,
      onStatus: (status) => statuses.push(status.state),
    });

    expect((await controller.initialize()).state).toBe('off');
    expect(await controller.setDesiredEnabled(true)).toMatchObject({
      desiredEnabled: true,
      state: 'running',
      port: 17420,
    });

    const disabling = controller.setDesiredEnabled(false);
    await vi.waitFor(() => expect(controller.currentStatus.state).toBe('stopping'));
    expect(desired).toBe(false);
    releaseStop();

    await expect(disabling).resolves.toMatchObject({ desiredEnabled: false, state: 'off' });
    expect(writeDesiredEnabled).toHaveBeenNthCalledWith(1, true);
    expect(writeDesiredEnabled).toHaveBeenNthCalledWith(2, false);
    expect(statuses).toContain('starting');
    expect(statuses).toContain('stopping');
  });

  it('does not retry when the persisted desired state is off', async () => {
    const start = vi.fn(async () => handle());
    const controller = new RemoteRuntimeController({
      port: 7420,
      readDesiredEnabled: async () => false,
      writeDesiredEnabled: async () => undefined,
      start,
    });

    await controller.initialize();
    await expect(controller.retry()).resolves.toMatchObject({ desiredEnabled: false, state: 'off' });
    expect(start).not.toHaveBeenCalled();
  });

  it('retries a failed stop against the retained listener when desired is off', async () => {
    let desired = false;
    const stopError = Object.assign(new Error('stop failed'), { code: 'REMOTE_STOP_FAILED' });
    const stop = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(stopError)
      .mockResolvedValueOnce(undefined);
    const runningHandle: RemoteBridgeHandle = { port: 7420, stop };
    const start = vi.fn(async () => runningHandle);
    const controller = new RemoteRuntimeController({
      port: 7420,
      readDesiredEnabled: async () => desired,
      writeDesiredEnabled: async (enabled) => { desired = enabled; },
      start,
    });

    await controller.initialize();
    await controller.setDesiredEnabled(true);
    await expect(controller.setDesiredEnabled(false)).resolves.toMatchObject({
      desiredEnabled: false,
      state: 'error',
      errorCode: 'REMOTE_STOP_FAILED',
    });

    await expect(controller.retry()).resolves.toMatchObject({
      desiredEnabled: false,
      state: 'off',
    });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledOnce();
  });

  it('reuses the retained listener when re-enabled after a failed stop', async () => {
    let desired = false;
    const stop = vi.fn(async () => {
      throw Object.assign(new Error('stop failed'), { code: 'REMOTE_STOP_FAILED' });
    });
    const runningHandle: RemoteBridgeHandle = { port: 17420, stop };
    const start = vi.fn(async () => runningHandle);
    const controller = new RemoteRuntimeController({
      port: 7420,
      readDesiredEnabled: async () => desired,
      writeDesiredEnabled: async (enabled) => { desired = enabled; },
      start,
    });

    await controller.initialize();
    await controller.setDesiredEnabled(true);
    await expect(controller.setDesiredEnabled(false)).resolves.toMatchObject({
      desiredEnabled: false,
      state: 'error',
    });

    await expect(controller.setDesiredEnabled(true)).resolves.toMatchObject({
      desiredEnabled: true,
      state: 'running',
      port: 17420,
    });
    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('settles a forced error state when stop rejects and retains the handle for a later stop retry', async () => {
    let desired = true;
    const stopFailure = Object.assign(new Error('stop failed'), { code: 'REMOTE_STOP_FAILED' });
    const stop = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(stopFailure)
      .mockResolvedValueOnce(undefined);
    const runningHandle: RemoteBridgeHandle = { port: 17420, stop };
    const onError = vi.fn();
    const controller = new RemoteRuntimeController({
      port: 7420,
      readDesiredEnabled: async () => desired,
      writeDesiredEnabled: async (enabled) => { desired = enabled; },
      start: async () => runningHandle,
      onError,
    });

    await expect(controller.initialize()).resolves.toMatchObject({ state: 'running', port: 17420 });
    await expect(controller.stopWithError('REMOTE_TOKEN_UNAVAILABLE', 'Token storage failed.')).resolves.toEqual({
      desiredEnabled: true,
      state: 'error',
      port: 17420,
      errorCode: 'REMOTE_TOKEN_UNAVAILABLE',
      error: 'Token storage failed.',
    });
    expect(onError).toHaveBeenCalledWith(stopFailure);

    await expect(controller.setDesiredEnabled(false)).resolves.toMatchObject({
      desiredEnabled: false,
      state: 'off',
    });
    expect(stop).toHaveBeenCalledTimes(2);
  });
});
