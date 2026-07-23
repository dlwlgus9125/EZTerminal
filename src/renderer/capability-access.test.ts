import { describe, expect, it, vi } from 'vitest';

import type {
  EzTerminalApi,
  EzTerminalDesktopApi,
  RemoteDesktopHostStatus,
  SystemStatsSnapshot,
} from '../shared/ipc';
import type { OpenClawVisibility } from '../shared/openclaw';
import {
  createCapabilityAccess,
  RequiredCapabilityUnavailableError,
  type CapabilitySource,
} from './capability-access';

interface MutableSource {
  core: EzTerminalApi | undefined;
  desktop: EzTerminalDesktopApi | undefined;
}

function accessFor(mutable: MutableSource) {
  const source: CapabilitySource = {
    readCore: () => mutable.core,
    readDesktop: () => mutable.desktop,
  };
  return createCapabilityAccess(source);
}

describe('CapabilityAccess Interface', () => {
  it('fails closed for an absent optional desktop bridge and names a missing required core operation', async () => {
    const access = accessFor({ core: undefined, desktop: undefined });

    expect(access.snapshot()).toEqual({ core: 'unavailable', desktop: 'unavailable' });
    await expect(access.agentIntegrations.load()).resolves.toBeNull();
    await expect(access.openClaw.getStatus()).resolves.toBeNull();
    await expect(access.remoteDesktop.disconnect()).resolves.toBeNull();
    await expect(access.sshForwards.list()).resolves.toBeNull();
    await expect(access.uiPreferences.refreshNativeMenuLocale()).resolves.toBe(false);
    expect(access.openClaw.openChat()).toBe(false);
    expect(() => access.files.list('')).toThrow(
      new RequiredCapabilityUnavailableError('listFiles'),
    );
  });

  it('discovers a late desktop bridge on a later call and then resolves that bridge once', async () => {
    const mutable: MutableSource = { core: undefined, desktop: undefined };
    const access = accessFor(mutable);

    await expect(access.openClaw.getMode()).resolves.toBeNull();

    const firstGetMode = vi.fn(async () => 'auto' as const);
    mutable.desktop = { getOpenClawMode: firstGetMode } as unknown as EzTerminalDesktopApi;
    await expect(access.openClaw.getMode()).resolves.toBe('auto');
    expect(access.snapshot().desktop).toBe('available');

    const replacementGetMode = vi.fn(async () => 'off' as const);
    mutable.desktop = { getOpenClawMode: replacementGetMode } as unknown as EzTerminalDesktopApi;
    await expect(access.openClaw.getMode()).resolves.toBe('auto');
    expect(firstGetMode).toHaveBeenCalledTimes(2);
    expect(replacementGetMode).not.toHaveBeenCalled();
  });

  it('preserves rejected desktop calls instead of converting them to an unavailable fallback', async () => {
    const failure = new Error('IPC rejected');
    const desktop = {
      runOpenClawLifecycle: vi.fn(async () => {
        throw failure;
      }),
    } as unknown as EzTerminalDesktopApi;
    const access = accessFor({ core: undefined, desktop });

    await expect(access.openClaw.runLifecycle('start')).rejects.toBe(failure);
  });

  it('owns drawer listener gates and performs every cleanup exactly once', async () => {
    const statusCleanup = vi.fn();
    const logCleanup = vi.fn();
    const setOpenClawDrawerOpen = vi.fn();
    const status = { state: 'running', port: 18789 } as const;
    const onStatus = vi.fn();
    const onLog = vi.fn();
    const desktop = {
      getOpenClawStatus: vi.fn(async () => status),
      setOpenClawDrawerOpen,
      onOpenClawStatus: vi.fn(() => statusCleanup),
      onOpenClawLog: vi.fn(() => logCleanup),
    } as unknown as EzTerminalDesktopApi;
    const access = accessFor({ core: undefined, desktop });

    const cleanup = access.openClaw.observeDrawer({ onStatus, onLog });
    await Promise.resolve();
    expect(onStatus).toHaveBeenCalledWith(status);
    expect(setOpenClawDrawerOpen).toHaveBeenCalledWith(true);

    cleanup();
    cleanup();
    expect(statusCleanup).toHaveBeenCalledTimes(1);
    expect(logCleanup).toHaveBeenCalledTimes(1);
    expect(setOpenClawDrawerOpen).toHaveBeenLastCalledWith(false);
  });

  it('removes remote desktop listeners after a seeded subscription', async () => {
    const status: RemoteDesktopHostStatus = {
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
    };
    const unsubscribe = vi.fn();
    const onStatus = vi.fn();
    const desktop = {
      getRemoteDesktopStatus: vi.fn(async () => status),
      onRemoteDesktopStatus: vi.fn(() => unsubscribe),
    } as unknown as EzTerminalDesktopApi;
    const access = accessFor({ core: undefined, desktop });

    const cleanup = access.remoteDesktop.observe(onStatus);
    await Promise.resolve();
    expect(onStatus).toHaveBeenCalledWith(status);
    cleanup();
    cleanup();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('does not deliver a late seed after its observer has been cleaned up', async () => {
    const status: RemoteDesktopHostStatus = {
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
    };
    let resolveStatus!: (value: RemoteDesktopHostStatus) => void;
    const pendingStatus = new Promise<RemoteDesktopHostStatus>((resolve) => {
      resolveStatus = resolve;
    });
    const onStatus = vi.fn();
    const desktop = {
      getRemoteDesktopStatus: vi.fn(() => pendingStatus),
      onRemoteDesktopStatus: vi.fn(() => vi.fn()),
    } as unknown as EzTerminalDesktopApi;
    const access = accessFor({ core: undefined, desktop });

    const cleanup = access.remoteDesktop.observe(onStatus);
    cleanup();
    resolveStatus(status);
    await pendingStatus;
    await Promise.resolve();

    expect(onStatus).not.toHaveBeenCalled();
  });

  it('does not let a late remote desktop seed revert a newer pushed status', async () => {
    const seededStatus = {
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
    } satisfies RemoteDesktopHostStatus;
    const pushedStatus = {
      ...seededStatus,
      state: 'active',
      controllerName: 'new-controller',
    } satisfies RemoteDesktopHostStatus;
    let resolveSeed!: (value: RemoteDesktopHostStatus) => void;
    const pendingSeed = new Promise<RemoteDesktopHostStatus>((resolve) => {
      resolveSeed = resolve;
    });
    let pushStatus!: (status: RemoteDesktopHostStatus) => void;
    const onStatus = vi.fn();
    const desktop = {
      getRemoteDesktopStatus: vi.fn(() => pendingSeed),
      onRemoteDesktopStatus: vi.fn((listener: (status: RemoteDesktopHostStatus) => void) => {
        pushStatus = listener;
        return vi.fn();
      }),
    } as unknown as EzTerminalDesktopApi;
    const access = accessFor({ core: undefined, desktop });

    access.remoteDesktop.observe(onStatus);
    pushStatus(pushedStatus);
    resolveSeed(seededStatus);
    await pendingSeed;
    await Promise.resolve();

    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenLastCalledWith(pushedStatus);
  });

  it('seeds and observes OpenClaw visibility through the capability Seam without stale rollback', async () => {
    const seededVisibility: OpenClawVisibility = { mode: 'auto', visible: false };
    const pushedVisibility: OpenClawVisibility = { mode: 'on', visible: true };
    let resolveSeed!: (value: OpenClawVisibility) => void;
    const pendingSeed = new Promise<OpenClawVisibility>((resolve) => {
      resolveSeed = resolve;
    });
    let pushVisibility!: (visibility: OpenClawVisibility) => void;
    const unsubscribe = vi.fn();
    const onVisibility = vi.fn();
    const desktop = {
      getOpenClawVisibility: vi.fn(() => pendingSeed),
      onOpenClawVisibilityChanged: vi.fn(
        (listener: (visibility: OpenClawVisibility) => void) => {
          pushVisibility = listener;
          return unsubscribe;
        },
      ),
    } as unknown as EzTerminalDesktopApi;
    const access = accessFor({ core: undefined, desktop });

    const cleanup = access.openClaw.observeVisibility(onVisibility);
    pushVisibility(pushedVisibility);
    resolveSeed(seededVisibility);
    await pendingSeed;
    await Promise.resolve();

    expect(onVisibility).toHaveBeenCalledTimes(1);
    expect(onVisibility).toHaveBeenLastCalledWith(pushedVisibility);

    cleanup();
    pushVisibility(seededVisibility);
    expect(onVisibility).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('drops late stats history after a newer snapshot push', async () => {
    const history = [{ at: 1 }] as unknown as readonly SystemStatsSnapshot[];
    const pushedSnapshot = { at: 2 } as unknown as SystemStatsSnapshot;
    let resolveSeed!: (value: readonly SystemStatsSnapshot[]) => void;
    const pendingSeed = new Promise<readonly SystemStatsSnapshot[]>((resolve) => {
      resolveSeed = resolve;
    });
    let pushSnapshot!: (snapshot: SystemStatsSnapshot) => void;
    const onSeed = vi.fn();
    const onSnapshot = vi.fn();
    const core = {
      getStatsHistory: vi.fn(() => pendingSeed),
      onStatsUpdate: vi.fn((listener: (snapshot: SystemStatsSnapshot) => void) => {
        pushSnapshot = listener;
        return vi.fn();
      }),
    } as unknown as EzTerminalApi;
    const access = accessFor({ core, desktop: undefined });

    access.systemStatus.observe({ onSeed, onSnapshot });
    pushSnapshot(pushedSnapshot);
    resolveSeed(history);
    await pendingSeed;
    await Promise.resolve();

    expect(onSnapshot).toHaveBeenCalledOnce();
    expect(onSnapshot).toHaveBeenCalledWith(pushedSnapshot);
    expect(onSeed).not.toHaveBeenCalled();
  });

  it('fails pairing closed when secure-token loading rejects and cleans runtime listeners once', async () => {
    const tokenFailure = new Error('secure token unavailable');
    const getRemoteToken = vi.fn(async () => {
      throw tokenFailure;
    });
    const unsubscribe = vi.fn();
    const onError = vi.fn();
    const core = {
      getRemoteConnectionInfo: vi.fn(async () => ({ urls: ['ws://127.0.0.1:7420'], port: 7420 })),
      getRemoteSecurityStatus: vi.fn(async () => ({ state: 'ready' as const, error: null })),
      getRemoteToken,
      getRemoteRuntimeStatus: vi.fn(async () => ({
        desiredEnabled: true,
        state: 'running' as const,
        port: 7420,
        errorCode: null,
        error: null,
      })),
      onRemoteRuntimeStatus: vi.fn(() => unsubscribe),
    } as unknown as EzTerminalApi;
    const access = accessFor({ core, desktop: undefined });

    const cleanup = access.remotePairing.observe({
      onConnectionInfo: vi.fn(),
      onSecurity: vi.fn(),
      onToken: vi.fn(),
      onRuntime: vi.fn(),
      onError,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(getRemoteToken).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith('token', tokenFailure);
    cleanup();
    cleanup();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('owns stats and packet capture gates with rejected-seed handling and idempotent cleanup', async () => {
    const seedFailure = new Error('stats unavailable');
    const statsCleanup = vi.fn();
    const subscribePackets = vi.fn();
    const unsubscribePackets = vi.fn();
    const onError = vi.fn();
    const core = {
      getStatsHistory: vi.fn(async () => {
        throw seedFailure;
      }),
      onStatsUpdate: vi.fn(() => statsCleanup),
      subscribePackets,
      unsubscribePackets,
    } as unknown as EzTerminalApi;
    const access = accessFor({ core, desktop: undefined });

    const stopStats = access.systemStatus.observe({
      onSeed: vi.fn(),
      onSnapshot: vi.fn(),
      onError,
    });
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(seedFailure);
    stopStats();
    stopStats();
    expect(statsCleanup).toHaveBeenCalledTimes(1);

    const stopPackets = access.systemStatus.capturePackets(onError);
    expect(subscribePackets).toHaveBeenCalledTimes(1);
    stopPackets();
    stopPackets();
    expect(unsubscribePackets).toHaveBeenCalledTimes(1);
  });
});
