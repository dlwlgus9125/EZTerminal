import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { expect, it, vi } from 'vitest';
import { LayoutStore } from './layout-store';
import type { FeatureIpc } from './ipc-registration';
import { installPreferencesIpc } from './settings-ipc';

it('waits for store initialization, persists validated preferences, and releases its channels', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ezterminal-settings-ipc-'));
  const handlers = new Map<string, Parameters<FeatureIpc['handle']>[1]>();
  const ipc = new EventEmitter() as unknown as FeatureIpc;
  ipc.handle = (name, handler) => { handlers.set(name, handler); };
  ipc.removeHandler = (name) => { handlers.delete(name); };
  const layoutStore = new LayoutStore(directory);
  let ready!: () => void;
  const storeReady = new Promise<void>((resolve) => { ready = resolve; });
  const applyNativeMenuLocale = vi.fn();
  const dispose = installPreferencesIpc({
    ipc, layoutStore, storeReady, applyNativeMenuLocale, systemStatsService: null,
  });
  const invoke = (channel: string, value?: unknown) =>
    handlers.get(channel)!({} as IpcMainInvokeEvent, value);
  try {
    let settled = false;
    const pending = Promise.resolve(invoke('settings:set-ui-preferences', { locale: 'en' }))
      .then((value) => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(applyNativeMenuLocale).not.toHaveBeenCalled();
    await layoutStore.init();
    ready();
    expect(await pending).toMatchObject({ locale: 'en' });
    expect(applyNativeMenuLocale).toHaveBeenCalledExactlyOnceWith('en');
    expect(await invoke('settings:set-ui-preferences', { locale: 'invalid' })).toMatchObject({ locale: 'en' });
    const reloaded = new LayoutStore(directory);
    await reloaded.init();
    expect(await reloaded.getUiPreferences()).toMatchObject({ locale: 'en' });
  } finally {
    dispose();
    expect(handlers.size).toBe(0);
    await layoutStore.flush();
    await rm(directory, { recursive: true, force: true });
  }
});
