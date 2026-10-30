// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonTurn } from '../shared/daemon-protocol';
import { resetPlanAccessForTests } from './agent-plan-access';
import { AppI18nProvider } from './i18n';
import { clearSessionViewStates } from './session-view-state';
import { StructuredAgentSessionPanel, type StructuredAgentSessionPanelProps } from './StructuredAgentSession';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Turn wrap-up (시안): the AI's guess of the next message in the message box. */

const AT = '2026-10-30T05:52:00.000Z';
const LATER = '2026-10-30T05:58:00.000Z';
const SUGGESTION = 'yes, add a unit test';
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

function turn(id: string, state: DaemonTurn['state'], at: string): DaemonTurn {
  return { id, sessionId: 'session-wrap', commandId: `command-${id}`, state, revision: 1, startedAt: at, createdAt: at, updatedAt: at };
}

function render(node: ReactNode): void {
  act(() => root.render(<AppI18nProvider locale="en" languages={['en']}>{node}</AppI18nProvider>));
}

function panel(overrides: Partial<StructuredAgentSessionPanelProps> = {}): JSX.Element {
  return (
    <StructuredAgentSessionPanel
      sessionId="session-wrap"
      title="Wrap-up"
      providerId="claude"
      providerLabel="Claude"
      workspace={{ id: 'workspace-1', label: 'App', kind: 'local' }}
      permissionPreset="standard"
      state="idle"
      items={[]}
      turns={[turn('turn-1', 'completed', AT)]}
      wrapUp={{ suggestion: { turnId: 'turn-1', text: SUGGESTION } }}
      onSend={async () => ({ ok: true })}
      onChangeSettings={async () => ({ ok: true })}
      {...overrides}
    />
  );
}

const input = (): HTMLTextAreaElement => container.querySelector<HTMLTextAreaElement>('[data-testid="structured-agent-composer-input"]')!;
const ghost = (): Element | null => container.querySelector('[data-testid="structured-agent-suggestion"]');

function key(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => { input().dispatchEvent(event); });
  return event;
}

function type(text: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), text);
    input().setSelectionRange(text.length, text.length);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('next-prompt suggestion', () => {
  it('fills the empty box on Tab, caret at the end, and sends nothing', () => {
    const onSend = vi.fn(async () => ({ ok: true as const }));
    render(panel({ onSend }));
    expect(ghost()?.textContent).toContain(SUGGESTION);
    expect(input().getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(input().getAttribute('aria-describedby')!)?.textContent).toBe(`Suggestion: ${SUGGESTION} · Press Tab to fill`);
    input().focus();
    const event = key({ key: 'Tab' });
    expect(event.defaultPrevented).toBe(true);
    expect(input().value).toBe(SUGGESTION);
    expect(input().selectionStart).toBe(SUGGESTION.length);
    expect(onSend).not.toHaveBeenCalled();
    expect(ghost()).toBeNull();
  });

  it('never fills while a word is being composed (IME)', () => {
    render(panel());
    input().focus();
    act(() => { input().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
    expect(ghost()).toBeNull();
    const event = key({ key: 'Tab', keyCode: 229 } as KeyboardEventInit);
    expect(event.defaultPrevented).toBe(false);
    expect(input().value).toBe('');
  });

  it('does not cover what the person typed, and stays away once they typed this turn', () => {
    render(panel({ wrapUp: {} }));
    type('Use parentheses');
    // The guess arrives seconds later, while the box holds text: nothing changes in it.
    render(panel());
    expect(input().value).toBe('Use parentheses');
    expect(ghost()).toBeNull();
    type('');
    expect(ghost()).toBeNull();
    // The next turn's guess shows again.
    render(panel({ turns: [turn('turn-1', 'completed', AT), turn('turn-2', 'completed', LATER)], wrapUp: { suggestion: { turnId: 'turn-2', text: 'Show negatives in parentheses' } } }));
    expect(ghost()?.textContent).toContain('Show negatives in parentheses');
  });

  it('stays away when the person typed and cleared before it arrived', () => {
    render(panel({ wrapUp: {} }));
    type('Use parentheses');
    type('');
    // Nothing was offered while they typed; the guess that arrives now is still set aside for this turn.
    render(panel());
    expect(ghost()).toBeNull();
    render(panel({ turns: [turn('turn-1', 'completed', AT), turn('turn-2', 'completed', LATER)], wrapUp: { suggestion: { turnId: 'turn-2', text: 'Show negatives in parentheses' } } }));
    expect(ghost()?.textContent).toContain('Show negatives in parentheses');
  });

  it('shows only the newest finished turn’s guess, not in plan mode, not while a turn runs', () => {
    // A newer turn without a guess (Codex said none): the older guess does not come back.
    render(panel({ turns: [turn('turn-1', 'completed', AT), turn('turn-2', 'completed', LATER)] }));
    expect(ghost()).toBeNull();
    render(panel({ permissionPreset: 'plan' }));
    expect(ghost()).toBeNull();
    render(panel({ state: 'working', turns: [turn('turn-1', 'working', AT)] }));
    expect(ghost()).toBeNull();
    expect(input().getAttribute('placeholder')).not.toBe('');
  });

  it('keeps Shift+Tab the plan switch and Esc a dismissal', async () => {
    const onChangeSettings = vi.fn(async () => ({ ok: true as const }));
    render(panel({ onChangeSettings }));
    input().focus();
    key({ key: 'Tab', shiftKey: true });
    await act(async () => { await Promise.resolve(); });
    expect(onChangeSettings).toHaveBeenCalledWith({ permissionPreset: 'plan' });
    expect(input().value).toBe('');
    expect(ghost()).toBeNull();
    key({ key: 'Tab', shiftKey: true });
    await act(async () => { await Promise.resolve(); });
    expect(onChangeSettings).toHaveBeenLastCalledWith({ permissionPreset: 'standard' });
    expect(ghost()).not.toBeNull();
    const escape = key({ key: 'Escape' });
    expect(escape.defaultPrevented).toBe(true);
    expect(ghost()).toBeNull();
    // Tab moves focus as usual once it is gone.
    expect(key({ key: 'Tab' }).defaultPrevented).toBe(false);
  });

  it('is a chip above the box on the phone: a tap fills the box, × puts it away', () => {
    const onSend = vi.fn(async () => ({ ok: true as const }));
    render(panel({ variant: 'mobile', onSend }));
    expect(ghost()).toBeNull();
    const fill = container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-suggestion-fill"]')!;
    expect(fill.getAttribute('aria-label')).toBe(`Put in the message box: ${SUGGESTION}`);
    act(() => fill.click());
    expect(input().value).toBe(SUGGESTION);
    expect(onSend).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="structured-agent-suggestion-chip"]')).toBeNull();
  });

  it('says how to send for the device: Enter on the desktop, the send button on the phone (Enter is a new line there)', () => {
    const announcement = (): string | null | undefined => container.querySelector('[data-testid="structured-agent-plan-announcement"]')?.textContent;
    render(panel());
    input().focus();
    key({ key: 'Tab' });
    expect(announcement()).toBe('Suggestion filled in. Edit it or press Enter to send.');
    act(() => root.unmount());
    root = createRoot(container);
    render(panel({ variant: 'mobile' }));
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-suggestion-fill"]')!.click());
    expect(announcement()).toBe('Suggestion filled in. Edit it, then press the send button.');
  });
});
