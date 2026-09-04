// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DaemonCommand,
  DaemonCommandReceipt,
  DaemonSchedule,
  DaemonSnapshot,
} from '../shared/daemon-protocol';
import { rendererCapabilities, type CapabilityAccess } from './capability-access';
import { AppI18nProvider } from './i18n';
import { isExactFiveFieldCron, isIanaTimeZone, ScheduleSettings } from './ScheduleSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = '2026-09-04T09:30:00.000Z';

const SCHEDULE: DaemonSchedule = {
  id: 'schedule-1',
  name: 'Daily review',
  workspaceId: 'workspace-1',
  providerId: 'codex',
  permissionPreset: 'standard',
  prompt: 'Review the worktree.',
  cron: '0 9 * * 1-5',
  timezone: 'Asia/Seoul',
  enabled: false,
  maxRuns: 12,
  runCount: 3,
  nextRunAt: '2026-09-05T00:00:00.000Z',
  revision: 3,
  createdAt: NOW,
  updatedAt: NOW,
};

function snapshot(options: {
  readonly revision?: number;
  readonly ready?: boolean;
  readonly schedules?: readonly DaemonSchedule[];
} = {}): DaemonSnapshot {
  const ready = options.ready ?? true;
  return {
    protocolVersion: 12,
    revision: options.revision ?? 4,
    eventSequence: options.revision ?? 4,
    generatedAt: NOW,
    runtime: {
      keepRunning: ready,
      startAtLogin: ready,
      orchestrationToolsEnabled: false,
      browserEnabled: false,
    },
    projects: [],
    workspaces: [{
      id: 'workspace-1',
      projectId: 'project-1',
      name: 'Main workspace',
      kind: 'local',
      rootPath: 'C:\\Work\\project',
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    }],
    sessions: [],
    agents: [],
    agentRelations: [],
    turns: [],
    transcriptHeads: [],
    approvals: [],
    providers: [{
      id: 'codex',
      displayName: 'Codex',
      protocol: 'codex-app-server',
      executablePath: 'C:\\Tools\\codex.exe',
      executableVersion: '1.2.3',
      argv: ['app-server'],
      environmentVariableNames: ['PATH'],
      capabilities: ['create'],
      enabled: true,
      health: 'ready',
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    }],
    schedules: options.schedules ?? [],
    heartbeats: [],
  };
}

interface CapabilityOverrides {
  readonly getSnapshot?: CapabilityAccess['daemon']['getSnapshot'];
  readonly sendCommand?: CapabilityAccess['daemon']['sendCommand'];
  readonly observeEvents?: CapabilityAccess['daemon']['observeEvents'];
  readonly setLifecycleSettings?: CapabilityAccess['daemon']['setLifecycleSettings'];
  readonly listModels?: CapabilityAccess['structuredProviders']['listModels'];
}

function capabilities(overrides: CapabilityOverrides = {}): CapabilityAccess {
  return {
    ...rendererCapabilities,
    structuredProviders: {
      ...rendererCapabilities.structuredProviders,
      listModels: overrides.listModels ?? (async () => ({
        ok: true,
        value: [{
          id: 'gpt-5.6-codex',
          displayName: 'GPT-5.6 Codex',
          supportsReasoning: true,
          isDefault: true,
        }],
      })),
    },
    daemon: {
      ...rendererCapabilities.daemon,
      getSnapshot: overrides.getSnapshot ?? (async () => snapshot()),
      sendCommand: overrides.sendCommand ?? (async (command) => ({
        ok: true,
        status: 'applied',
        commandId: command.commandId,
        revision: 5,
        eventSequence: 5,
      })),
      observeEvents: overrides.observeEvents ?? (() => () => undefined),
      setLifecycleSettings: overrides.setLifecycleSettings
        ?? (async () => ({ keepRunning: true, startAtLogin: true })),
    },
  };
}

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderSettings(access: CapabilityAccess, locale: 'en' | 'ko' = 'en'): void {
  act(() => root.render(
    <AppI18nProvider locale={locale} languages={[locale]}>
      <ScheduleSettings capabilities={access} />
    </AppI18nProvider>,
  ));
}

function setControlValue(selector: string, value: string): void {
  const control = container.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector)!;
  const prototype = control instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : control instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  act(() => {
    setter?.call(control, value);
    control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

function openAndFillDraft(): void {
  act(() => container.querySelector<HTMLButtonElement>('[data-testid="schedule-create-open"]')!.click());
  setControlValue('[data-testid="schedule-name"]', 'Morning review');
  setControlValue('[data-testid="schedule-prompt"]', 'Review the current worktree.');
  setControlValue('[data-testid="schedule-timezone"]', 'UTC');
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('ScheduleSettings validation', () => {
  it('requires exactly five cron fields and a real IANA timezone', () => {
    expect(isExactFiveFieldCron('0 9 * * 1-5')).toBe(true);
    expect(isExactFiveFieldCron('0 0 9 * * 1-5')).toBe(false);
    expect(isIanaTimeZone('Asia/Seoul')).toBe(true);
    expect(isIanaTimeZone('UTC')).toBe(true);
    expect(isIanaTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('ScheduleSettings', () => {
  it('keeps activation fail-closed while allowing a disabled schedule to be saved', async () => {
    const authority = snapshot({ revision: 11, ready: false, schedules: [SCHEDULE] });
    const sendCommand = vi.fn(async (command: DaemonCommand): Promise<DaemonCommandReceipt> => ({
      ok: true,
      status: 'applied',
      commandId: command.commandId,
      revision: 12,
      eventSequence: 12,
    }));
    renderSettings(capabilities({ getSnapshot: async () => authority, sendCommand }));
    await flush();

    expect(container.querySelector('[data-testid="schedule-runtime-warning"]')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-testid="schedule-toggle-schedule-1"]')!.disabled).toBe(false);

    openAndFillDraft();
    const enabled = container.querySelector<HTMLInputElement>('[data-testid="schedule-enabled"]')!;
    expect(enabled.checked).toBe(false);
    expect(enabled.disabled).toBe(false);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="schedule-create-submit"]')!.click());
    await flush();

    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand.mock.calls[0]![0]).toMatchObject({
      type: 'schedule.create',
      expectedRevision: 11,
      payload: {
        name: 'Morning review',
        enabled: false,
        cron: '0 9 * * 1-5',
        timezone: 'UTC',
      },
    });
  });

  it('asks once before enabling the background host and does not mutate the schedule on failure', async () => {
    const stopped = snapshot({ revision: 11, ready: false, schedules: [SCHEDULE] });
    const ready = snapshot({ revision: 12, ready: true, schedules: [SCHEDULE] });
    const getSnapshot = vi.fn()
      .mockResolvedValueOnce(stopped)
      .mockResolvedValue(ready);
    const sendCommand = vi.fn(async (command: DaemonCommand): Promise<DaemonCommandReceipt> => ({
      ok: true,
      status: 'applied',
      commandId: command.commandId,
      revision: 13,
      eventSequence: 13,
    }));
    const setLifecycleSettings = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ keepRunning: true, startAtLogin: true });
    renderSettings(capabilities({ getSnapshot, sendCommand, setLifecycleSettings }));
    await flush();

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="schedule-toggle-schedule-1"]')!.click());
    expect(container.querySelector('[data-testid="schedule-host-confirm"]')).not.toBeNull();
    expect(sendCommand).not.toHaveBeenCalled();

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="schedule-host-enable"]')!.click());
    await flush();
    expect(setLifecycleSettings).toHaveBeenNthCalledWith(1, {
      keepRunning: true,
      startAtLogin: true,
    });
    expect(sendCommand).not.toHaveBeenCalled();
    expect(container.textContent).toContain('schedule remains disabled');

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="schedule-host-enable"]')!.click());
    await flush();
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: 'schedule.update',
      expectedRevision: 12,
      payload: { scheduleId: 'schedule-1', enabled: true },
    }));
  });

  it('renders the schedule and host-recovery flow in Korean', async () => {
    renderSettings(capabilities({ getSnapshot: async () => snapshot({ ready: false }) }), 'ko');
    await flush();

    expect(container.textContent).toContain('예약 실행');
    expect(container.textContent).toContain('호스트 런타임 확인');
    expect(container.textContent).toContain('비활성 일정은 지금도 저장');
  });

  it('reads a fresh revision immediately before create and guards duplicate submits', async () => {
    const initial = snapshot({ revision: 3 });
    const fresh = snapshot({ revision: 9 });
    const getSnapshot = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValue(fresh);
    let settle!: (receipt: DaemonCommandReceipt) => void;
    const pending = new Promise<DaemonCommandReceipt>((resolve) => { settle = resolve; });
    const sendCommand = vi.fn((command: DaemonCommand) => {
      void command;
      return pending;
    });
    renderSettings(capabilities({ getSnapshot, sendCommand }));
    await flush();

    openAndFillDraft();
    const submit = container.querySelector<HTMLButtonElement>('[data-testid="schedule-create-submit"]')!;
    act(() => {
      submit.click();
      submit.click();
    });
    await flush();

    expect(sendCommand).toHaveBeenCalledTimes(1);
    const sent = sendCommand.mock.calls[0]![0] as DaemonCommand;
    expect(sent).toMatchObject({ type: 'schedule.create', expectedRevision: 9 });

    settle({
      ok: true,
      status: 'applied',
      commandId: sent.commandId,
      revision: 10,
      eventSequence: 10,
    });
    await flush();
  });

  it('shows field errors without sending malformed cron, timezone, or maxRuns', async () => {
    const sendCommand = vi.fn();
    renderSettings(capabilities({ getSnapshot: async () => snapshot(), sendCommand }));
    await flush();

    openAndFillDraft();
    setControlValue('[data-testid="schedule-cron"]', '0 0 9 * * 1-5');
    setControlValue('[data-testid="schedule-timezone"]', 'Mars/Olympus');
    setControlValue('[data-testid="schedule-max-runs"]', '0');
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="schedule-create-submit"]')!.click());
    await flush();

    expect(sendCommand).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Use exactly five cron fields');
    expect(container.textContent).toContain('valid IANA timezone');
    expect(container.textContent).toContain('positive whole number');
  });

  it('supports disable, run now, and explicit two-step delete commands', async () => {
    const enabledSchedule = { ...SCHEDULE, enabled: true };
    const authority = snapshot({ revision: 7, schedules: [enabledSchedule] });
    const sendCommand = vi.fn(async (command: DaemonCommand): Promise<DaemonCommandReceipt> => ({
      ok: true,
      status: 'applied',
      commandId: command.commandId,
      revision: 8,
      eventSequence: 8,
    }));
    renderSettings(capabilities({ getSnapshot: async () => authority, sendCommand }));
    await flush();

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="schedule-toggle-schedule-1"]')!.click());
    await flush();
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="schedule-run-schedule-1"]')!.click());
    await flush();
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="schedule-delete-schedule-1"]')!.click());
    expect(sendCommand).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="schedule-delete-confirm-schedule-1"]')).not.toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="schedule-delete-commit-schedule-1"]')!.click());
    await flush();

    expect(sendCommand.mock.calls.map(([command]) => command.type)).toEqual([
      'schedule.update',
      'schedule.run-now',
      'schedule.delete',
    ]);
    expect(sendCommand.mock.calls[0]![0]).toMatchObject({
      expectedRevision: 7,
      payload: { scheduleId: 'schedule-1', enabled: false },
    });
  });

  it('reloads and explains a revision conflict', async () => {
    const authority = snapshot({ revision: 14, schedules: [{ ...SCHEDULE, enabled: true }] });
    const getSnapshot = vi.fn(async () => authority);
    const sendCommand = vi.fn(async (command: DaemonCommand): Promise<DaemonCommandReceipt> => ({
      ok: false,
      status: 'rejected',
      commandId: command.commandId,
      revision: 15,
      error: {
        code: 'revision-conflict',
        message: 'stale',
        retryable: true,
        currentRevision: 15,
      },
    }));
    renderSettings(capabilities({ getSnapshot, sendCommand }));
    await flush();

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="schedule-toggle-schedule-1"]')!.click());
    await flush();

    expect(container.textContent).toContain('Schedules changed elsewhere');
    expect(getSnapshot.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('maps automation-requires-daemon to a recoverable runtime state', async () => {
    const ready = snapshot({ revision: 4, schedules: [SCHEDULE] });
    const stopped = snapshot({ revision: 5, ready: false, schedules: [SCHEDULE] });
    const getSnapshot = vi.fn()
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(ready)
      .mockResolvedValue(stopped);
    const sendCommand = vi.fn(async (command: DaemonCommand): Promise<DaemonCommandReceipt> => ({
      ok: false,
      status: 'rejected',
      commandId: command.commandId,
      revision: 5,
      error: {
        code: 'automation-requires-daemon',
        message: 'background host required',
        retryable: true,
      },
    }));
    renderSettings(capabilities({ getSnapshot, sendCommand }));
    await flush();

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="schedule-toggle-schedule-1"]')!.click());
    await flush();

    expect(container.textContent).toContain('Enabled schedules require the background Agent host');
    expect(container.querySelector('[data-testid="schedule-runtime-warning"]')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-testid="schedule-toggle-schedule-1"]')!.disabled).toBe(false);
  });

  it('distinguishes initial loading from a retryable load error', async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<DaemonSnapshot | null>((_resolve, rejectPromise) => { reject = rejectPromise; });
    const getSnapshot = vi.fn()
      .mockImplementationOnce(() => pending)
      .mockResolvedValue(snapshot());
    renderSettings(capabilities({ getSnapshot }));

    expect(container.textContent).toContain('Loading schedules');
    reject(new Error('offline'));
    await flush();
    expect(container.textContent).toContain('Schedules could not be loaded');

    const retry = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Retry'))!;
    act(() => retry.click());
    await flush();
    expect(container.textContent).toContain('No schedules yet');
  });
});
