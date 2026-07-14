import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { AGENT_SETTINGS_SCHEMA_VERSION } from '../shared/agent';
import { AgentSettingsStore, defaultAgentSettings, validateAgentSettings } from './agent-settings-store';

const makeDir = (): string => mkdtempSync(path.join(os.tmpdir(), 'ez-agent-settings-'));

describe('AgentSettingsStore', () => {
  it('defaults notifications on and persists validated generic profiles', async () => {
    const dir = makeDir();
    const store = new AgentSettingsStore(dir);
    await store.init();
    expect(await store.get()).toEqual(defaultAgentSettings());

    const next = {
      schemaVersion: AGENT_SETTINGS_SCHEMA_VERSION,
      notifications: { waiting: false, blocked: true, error: false },
      genericProfiles: [{ id: 'aider', name: 'Aider', executable: 'aider.cmd', enabled: true }],
    } as const;
    await expect(store.set(next)).resolves.toEqual(next);

    const reloaded = new AgentSettingsStore(dir);
    await reloaded.init();
    await expect(reloaded.get()).resolves.toEqual(next);
  });

  it('rejects paths, duplicate executables, and malformed settings without changing the cache', async () => {
    const store = new AgentSettingsStore(makeDir());
    await store.init();
    expect(
      validateAgentSettings({
        schemaVersion: 1,
        notifications: { waiting: true, blocked: true, error: true },
        genericProfiles: [
          { id: 'a', name: 'A', executable: 'aider.cmd', enabled: true },
          { id: 'b', name: 'B', executable: 'AIDER.exe', enabled: true },
        ],
      }),
    ).toBeNull();
    await expect(
      store.set({
        schemaVersion: 1,
        notifications: { waiting: true, blocked: true, error: true },
        genericProfiles: [{ id: 'x', name: 'X', executable: 'C:\\bin\\agent.exe', enabled: true }],
      }),
    ).resolves.toBeNull();
    expect(store.current).toEqual(defaultAgentSettings());
  });
});
