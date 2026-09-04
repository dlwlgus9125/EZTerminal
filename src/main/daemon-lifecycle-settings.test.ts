import { describe, expect, it, vi } from 'vitest';

import {
  AutomationEnableCoordinator,
  DaemonLifecycleSettingsController,
  type DaemonLifecycleSettings,
} from './daemon-lifecycle-settings';

function harness(initial: DaemonLifecycleSettings = { keepRunning: false, startAtLogin: false }) {
  let persisted = { ...initial };
  let loginEnabled = initial.startAtLogin;
  const writes: DaemonLifecycleSettings[] = [];
  const loginWrites: boolean[] = [];
  const store = {
    read: vi.fn(async () => ({ ...persisted })),
    write: vi.fn(async (settings: DaemonLifecycleSettings) => {
      persisted = { ...settings };
      writes.push({ ...settings });
    }),
  };
  const loginItem = {
    readEnabled: vi.fn(async () => loginEnabled),
    writeEnabled: vi.fn(async (enabled: boolean) => {
      loginEnabled = enabled;
      loginWrites.push(enabled);
    }),
  };
  const controller = new DaemonLifecycleSettingsController({ store, loginItem });
  return {
    controller,
    store,
    loginItem,
    writes,
    loginWrites,
    persisted: () => persisted,
    loginEnabled: () => loginEnabled,
    setLoginEnabled: (enabled: boolean) => { loginEnabled = enabled; },
  };
}

describe('DaemonLifecycleSettingsController', () => {
  it('commits keep-running and a verified OS login item as one setting mutation', async () => {
    const h = harness();

    await expect(h.controller.update({ startAtLogin: true })).resolves.toEqual({
      keepRunning: true,
      startAtLogin: true,
    });

    expect(h.loginWrites).toEqual([true]);
    expect(h.writes).toEqual([{ keepRunning: true, startAtLogin: true }]);
  });

  it('rolls the OS login item back and preserves persisted settings when verification fails', async () => {
    const h = harness();
    h.loginItem.readEnabled
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);

    await expect(h.controller.update({ startAtLogin: true })).rejects.toThrow(
      /did not apply the requested login item state/,
    );

    expect(h.loginWrites).toEqual([true, false]);
    expect(h.writes).toEqual([]);
    expect(h.persisted()).toEqual({ keepRunning: false, startAtLogin: false });
    expect(h.controller.snapshot()).toEqual({ keepRunning: false, startAtLogin: false });
  });

  it('rolls the OS login item back when persistence fails after native success', async () => {
    const h = harness();
    h.store.write.mockRejectedValueOnce(new Error('disk unavailable'));

    await expect(h.controller.update({ startAtLogin: true })).rejects.toThrow(/disk unavailable/);

    expect(h.loginWrites).toEqual([true, false]);
    expect(h.loginEnabled()).toBe(false);
    expect(h.controller.snapshot()).toEqual({ keepRunning: false, startAtLogin: false });
  });
});

describe('AutomationEnableCoordinator', () => {
  it('leaves automation and lifecycle settings disabled when first-use consent is cancelled', async () => {
    const h = harness();
    const activate = vi.fn();
    const coordinator = new AutomationEnableCoordinator(h.controller);

    await expect(coordinator.enable(() => false, activate)).resolves.toEqual({
      ok: false,
      reason: 'cancelled',
      settings: { keepRunning: false, startAtLogin: false },
    });
    expect(activate).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
    expect(h.loginWrites).toEqual([]);
  });

  it('activates only after consent and both daemon lifecycle settings commit', async () => {
    const h = harness();
    const order: string[] = [];
    h.store.write.mockImplementation(async (settings: DaemonLifecycleSettings) => {
      order.push('settings');
      h.writes.push({ ...settings });
    });
    h.loginItem.writeEnabled.mockImplementation(async (enabled: boolean) => {
      order.push('login');
      h.setLoginEnabled(enabled);
      h.loginWrites.push(enabled);
    });
    const coordinator = new AutomationEnableCoordinator(h.controller);

    const result = await coordinator.enable(
      async () => {
        order.push('consent');
        return true;
      },
      async () => { order.push('activate'); },
    );

    expect(result).toEqual({
      ok: true,
      settings: { keepRunning: true, startAtLogin: true },
    });
    expect(order).toEqual(['consent', 'login', 'settings', 'activate']);
  });

  it('does not invoke activation when the login item cannot be enabled', async () => {
    const h = harness();
    h.loginItem.writeEnabled.mockRejectedValueOnce(new Error('registry denied'));
    const activate = vi.fn();
    const coordinator = new AutomationEnableCoordinator(h.controller);

    await expect(coordinator.enable(() => true, activate)).resolves.toMatchObject({
      ok: false,
      reason: 'lifecycle-settings-failed',
    });
    expect(activate).not.toHaveBeenCalled();
    expect(h.controller.snapshot()).toEqual({ keepRunning: false, startAtLogin: false });
  });
});
