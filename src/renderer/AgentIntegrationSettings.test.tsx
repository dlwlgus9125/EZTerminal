// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonSnapshot } from '../shared/daemon-protocol';
import { LONG_RUN_CAPABILITY } from '../shared/long-run';
import { DEFAULT_TURN_WRAP_UP_SETTINGS, TURN_WRAP_UP_CAPABILITY } from '../shared/turn-wrap-up';
import { AgentIntegrationSettings } from './AgentIntegrationSettings';
import { rendererCapabilities, type CapabilityAccess } from './capability-access';
import { AppI18nProvider } from './i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const load = vi.fn(async () => ({ settings: DEFAULT_TURN_WRAP_UP_SETTINGS, paused: [] }));

async function show(getSnapshot: CapabilityAccess['daemon']['getSnapshot']): Promise<void> {
  const capabilities: CapabilityAccess = {
    ...rendererCapabilities,
    daemon: { ...rendererCapabilities.daemon, getSnapshot },
    agentIntegrations: { ...rendererCapabilities.agentIntegrations, load: async () => null },
    turnWrapUp: { load, save: async (settings) => settings },
    longRun: { load: async () => ({ autoResume: true }), save: async (settings) => settings },
  };
  await act(async () => {
    root.render(<AppI18nProvider locale="en" languages={['en']}><AgentIntegrationSettings capabilities={capabilities} /></AppI18nProvider>);
    await Promise.resolve();
    await Promise.resolve();
  });
}

const section = (): Element | null => container.querySelector('[data-testid="turn-wrap-up-settings"]');
const offering = (capabilities: readonly string[]) => async () => ({
  capabilities: [...capabilities], runtime: { keepRunning: true, startAtLogin: false, orchestrationToolsEnabled: true, browserEnabled: false }, projects: [], workspaces: [], sessions: [], agents: [], providers: [],
}) as unknown as DaemonSnapshot;

const longRunSection = (): Element | null => container.querySelector('[data-testid="long-run-settings"]');

describe('Settings › 에이전트 › 이어서 하기', () => {
  it('is there on a host that offers long-run continuity, and each section answers for itself', async () => {
    await show(offering([LONG_RUN_CAPABILITY]));
    expect(longRunSection()).not.toBeNull();
    expect(section()).toBeNull();
  });

  it('is not on an older host, nor before a host answers', async () => {
    await show(offering([TURN_WRAP_UP_CAPABILITY]));
    expect(longRunSection()).toBeNull();
    expect(section()).not.toBeNull();
    await show(async () => null);
    expect(longRunSection()).toBeNull();
  });
});

describe('Settings › 에이전트 › 턴 마무리', () => {
  it('is there on a host that offers turn wrap-up', async () => {
    await show(offering(['review-loop-v1', TURN_WRAP_UP_CAPABILITY]));
    expect(section()).not.toBeNull();
    expect(load).toHaveBeenCalled();
  });

  it('is not on an older host, nor before a host answers', async () => {
    await show(offering(['review-loop-v1']));
    expect(section()).toBeNull();
    await show(async () => null);
    expect(section()).toBeNull();
    await show(async () => { throw new Error('no daemon'); });
    expect(section()).toBeNull();
  });
});
