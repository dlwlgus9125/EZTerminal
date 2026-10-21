// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonApproval, DaemonTranscriptItem, DaemonTurn, PermissionPreset } from '../shared/daemon-protocol';
import { readLastAccess, readPlanAccess, resetPlanAccessForTests } from './agent-plan-access';
import { AppI18nProvider } from './i18n';
import { clearSessionViewStates } from './session-view-state';
import { StructuredAgentSessionPanel, type StructuredAgentSessionPanelProps } from './StructuredAgentSession';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = '2026-10-19T09:30:00.000Z';
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  clearSessionViewStates();
  localStorage.clear();
  resetPlanAccessForTests();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function render(node: ReactNode, locale: 'en' | 'ko' = 'en'): void {
  act(() => root.render(<AppI18nProvider locale={locale} languages={[locale]}>{node}</AppI18nProvider>));
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function panel(overrides: Partial<StructuredAgentSessionPanelProps> = {}): JSX.Element {
  return (
    <StructuredAgentSessionPanel
      sessionId="session-plan"
      title="Plan"
      providerId="claude"
      providerLabel="Claude"
      workspace={{ id: 'workspace-1', label: 'App', kind: 'local' }}
      model="opus"
      modelOptions={[{ id: 'opus', label: 'Opus' }]}
      permissionPreset="standard"
      state="idle"
      items={[]}
      onSend={async () => ({ ok: true })}
      onChangeSettings={async () => ({ ok: true })}
      {...overrides}
    />
  );
}

const planToggle = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-live-plan"]')!;
const accessPill = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-live-permission"]')!;
const input = (): HTMLTextAreaElement => container.querySelector<HTMLTextAreaElement>('[data-testid="structured-agent-composer-input"]')!;
const menuOptions = (): string[] => [...document.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent ?? '');

function chooseAccess(label: string): void {
  act(() => accessPill().click());
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find((item) => item.textContent?.includes(label))!;
  act(() => option.click());
}

function shiftTab(target: HTMLElement, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
}

describe('plan mode is a switch, not a permission', () => {
  it('offers only access levels in the permission pill, in the UI language', () => {
    render(panel(), 'ko');
    expect(planToggle().getAttribute('aria-pressed')).toBe('false');
    expect(planToggle().textContent).toBe('계획');
    act(() => accessPill().click());
    expect(menuOptions()).toHaveLength(2);
    expect(menuOptions().join(' ')).toContain('승인 후 실행');
    expect(menuOptions().join(' ')).toContain('전체 권한');
    expect(menuOptions().join(' ')).not.toMatch(/Plan|Standard|Full access|계획/u);
  });

  it('turns plan mode on and off, keeping the chosen access level for the plan', async () => {
    const onChangeSettings = vi.fn(async () => ({ ok: true as const }));
    render(panel({ permissionPreset: 'full-access', onChangeSettings }));
    act(() => planToggle().click());
    await flush();
    expect(onChangeSettings).toHaveBeenLastCalledWith({ permissionPreset: 'plan' });
    expect(readPlanAccess('session-plan')).toBe('full-access');

    render(panel({ permissionPreset: 'plan', onChangeSettings }));
    expect(planToggle().getAttribute('aria-pressed')).toBe('true');
    expect(accessPill().getAttribute('aria-label')).toContain('Full access');
    act(() => planToggle().click());
    await flush();
    expect(onChangeSettings).toHaveBeenLastCalledWith({ permissionPreset: 'full-access' });
  });

  it('changes the plan access level on this device only while plan mode is on', async () => {
    const onChangeSettings = vi.fn(async () => ({ ok: true as const }));
    render(panel({ permissionPreset: 'plan', onChangeSettings }));
    expect(accessPill().getAttribute('aria-label')).toContain('Ask before running');
    chooseAccess('Full access');
    await flush();
    expect(onChangeSettings).not.toHaveBeenCalled();
    expect(readPlanAccess('session-plan')).toBe('full-access');
    expect(accessPill().getAttribute('aria-label')).toContain('Full access');
    // The level the person chose is what new conversations start with.
    expect(readLastAccess()).toBe('full-access');
  });

  it('switches with Shift+Tab in the message box, but not while composing or during a turn', async () => {
    const onChangeSettings = vi.fn(async () => ({ ok: true as const }));
    render(panel({ onChangeSettings }));
    const pressed = shiftTab(input());
    await flush();
    expect(pressed.defaultPrevented).toBe(true);
    expect(onChangeSettings).toHaveBeenLastCalledWith({ permissionPreset: 'plan' });

    onChangeSettings.mockClear();
    shiftTab(input(), { isComposing: true });
    await flush();
    expect(onChangeSettings).not.toHaveBeenCalled();

    render(panel({ state: 'working', onChangeSettings }));
    shiftTab(input());
    await flush();
    expect(onChangeSettings).not.toHaveBeenCalled();
    expect(planToggle().disabled).toBe(true);
    expect(container.querySelector('[data-testid="structured-agent-plan-announcement"]')?.textContent).toContain('after the current turn');
  });

  it('lets effort change during a turn and sends only the effort', async () => {
    const onChangeSettings = vi.fn(async () => ({ ok: true as const }));
    render(panel({ state: 'working', effortSupported: true, reasoningEffort: 'medium', onChangeSettings }));
    expect(container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-live-model"]')!.disabled).toBe(true);
    expect(accessPill().disabled).toBe(true);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-live-effort"]')!.click());
    const high = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find((item) => item.textContent === 'High')!;
    act(() => high.click());
    await flush();
    expect(onChangeSettings).toHaveBeenCalledWith({ reasoningEffort: 'high' });
  });
});

const planApproval: DaemonApproval = {
  id: 'approval-plan', sessionId: 'session-plan', providerRequestId: 'request-plan', risk: 'write', title: 'Approve plan',
  state: 'pending', request: { v: 1, kind: 'plan', callId: 'call-plan', markdown: '- Add farewell()' },
  revision: 1, createdAt: NOW, updatedAt: NOW,
};

describe('plan approval runs with the chosen access level', () => {
  it('approves a Claude plan with the level picked in the dock', async () => {
    const onResolveApproval = vi.fn(async () => ({ ok: true as const }));
    render(panel({ permissionPreset: 'plan', state: 'blocked', approvals: [planApproval], approvalResponses: true, onResolveApproval }));
    const dockAccess = container.querySelector<HTMLButtonElement>('[data-testid="chat-dock-plan-access"]')!;
    act(() => dockAccess.click());
    const full = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find((item) => item.textContent?.includes('Full access'))!;
    act(() => full.click());
    expect(accessPill().getAttribute('aria-label')).toContain('Full access');
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="chat-dock-approve-plan"]')!.click());
    await flush();
    expect(onResolveApproval).toHaveBeenCalledWith('approval-plan', 'allow', { kind: 'plan', mode: 'full-access' });
  });

  it('lets an older host keep planning, and says how the plan will run', async () => {
    const onResolveApproval = vi.fn(async () => ({ ok: true as const }));
    render(panel({ permissionPreset: 'plan', state: 'blocked', approvals: [planApproval], approvalResponses: false, onResolveApproval }));
    expect(container.querySelector('[data-testid="chat-dock-plan-access"]')).toBeNull();
    expect(container.textContent).toContain('This host runs the plan asking before running.');
    const keep = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Keep planning')!;
    act(() => keep.click());
    await flush();
    expect(onResolveApproval).toHaveBeenCalledWith('approval-plan', 'deny');
  });
});

describe('a plan Codex proposed', () => {
  const user = (sequence: number, turnId: string): DaemonTranscriptItem => ({
    id: `user-${sequence}`, sessionId: 'session-plan', turnId, sequence, kind: 'user-message', text: 'Plan farewell', isDelta: false, isSensitive: false, createdAt: NOW,
  });
  const plan: DaemonTranscriptItem = {
    id: 'plan-1', sessionId: 'session-plan', turnId: 'turn-1', sequence: 2, kind: 'reasoning', text: '- Add farewell()', isDelta: false, isSensitive: false,
    payload: { v: 1, type: 'plan', markdown: '- Add farewell()' }, createdAt: NOW,
  };
  const turn = (state: DaemonTurn['state']): DaemonTurn => ({ id: 'turn-1', sessionId: 'session-plan', commandId: 'command-1', state, revision: 2, createdAt: NOW, updatedAt: NOW });
  const codex = (overrides: Partial<StructuredAgentSessionPanelProps> = {}): JSX.Element => panel({
    providerId: 'codex', providerLabel: 'Codex', permissionPreset: 'plan' as PermissionPreset, items: [user(1, 'turn-1'), plan], turns: [turn('completed')], ...overrides,
  });

  it('asks to run it, then leaves plan mode and asks Codex to implement it', async () => {
    const calls: string[] = [];
    const onChangeSettings = vi.fn(async (settings: { readonly permissionPreset?: PermissionPreset }) => { calls.push(`settings:${settings.permissionPreset}`); return { ok: true as const }; });
    const onSend = vi.fn(async (prompt: string) => { calls.push(`send:${prompt}`); return { ok: true as const }; });
    render(codex({ onChangeSettings, onSend }));
    expect(container.querySelector('[data-testid="chat-dock-proposed-plan"]')).not.toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="chat-dock-approve-plan"]')!.click());
    await flush();
    await flush();
    expect(calls).toEqual(['settings:standard', 'send:Implement the plan above.']);
  });

  it('does not ask while the turn runs, after the person replied, or outside plan mode', () => {
    render(codex({ state: 'working', turns: [turn('working')] }));
    expect(container.querySelector('[data-testid="chat-dock-proposed-plan"]')).toBeNull();
    render(codex({ items: [user(1, 'turn-1'), plan, user(3, 'turn-2')] }));
    expect(container.querySelector('[data-testid="chat-dock-proposed-plan"]')).toBeNull();
    render(codex({ permissionPreset: 'standard' }));
    expect(container.querySelector('[data-testid="chat-dock-proposed-plan"]')).toBeNull();
  });

  it('keeps plan mode when the person asks for changes', async () => {
    const onChangeSettings = vi.fn(async () => ({ ok: true as const }));
    const onSend = vi.fn(async () => ({ ok: true as const }));
    render(codex({ onChangeSettings, onSend }));
    const keep = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Keep planning…')!;
    act(() => keep.click());
    const feedback = container.querySelector<HTMLTextAreaElement>('.chat-dock__feedback textarea')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(feedback, 'Also add a test');
      feedback.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => container.querySelector<HTMLFormElement>('.chat-dock__feedback')!.requestSubmit());
    await flush();
    expect(onSend).toHaveBeenCalledWith('Also add a test');
    expect(onChangeSettings).not.toHaveBeenCalled();
  });
});
