// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonTurn } from '../shared/daemon-protocol';
import { resetPlanAccessForTests } from './agent-plan-access';
import type { ChatTaskDefaults, ChatWrapUpAction } from './chat/ChatContext';
import { cartStory, inSession } from './chat/wrap-up/wrap-up-fixtures';
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

describe('the cards’ actions', () => {
  const cart = (onAction: (action: ChatWrapUpAction, defaults: ChatTaskDefaults) => Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> | void): JSX.Element => {
    const fixture = inSession(cartStory('en', 'claude'), 'session-wrap');
    return panel({
      items: fixture.items, turns: fixture.turns, model: 'claude-opus-5-5', modelOptions: [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }], effortSupported: true, reasoningEffort: 'high',
      permissionPreset: 'full-access', wrapUp: { onAction },
    });
  };
  const press = async (kind: string): Promise<void> => { await act(async () => { container.querySelector<HTMLButtonElement>(`[data-action="${kind}"]`)!.click(); await Promise.resolve(); }); };

  it('hands over what the card’s line says one press starts: 승인 후 실행 whatever this conversation runs at', async () => {
    const onAction = vi.fn<(action: ChatWrapUpAction, defaults: ChatTaskDefaults) => void>();
    render(cart(onAction));
    expect(container.querySelector('[data-testid="chat-task-defaults"]')?.textContent).toContain('Claude · Opus 5.5 · High · Ask before running');
    await press('task-start');
    expect(onAction).toHaveBeenCalledWith(
      { kind: 'task-start', turnId: 'turn-cart', taskId: 'task-claude-1' },
      { agent: { providerId: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'high', permissionPreset: 'standard' }, settings: 'Claude · Opus 5.5 · High · Ask before running' },
    );
  });

  it('reads a refused action above the chat, and clears it with the next one', async () => {
    const onAction = vi.fn(async (): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> => ({ ok: false, message: 'This conversation is archived.' }));
    render(cart(onAction));
    await press('task-here');
    expect(container.querySelector('[data-testid="structured-agent-wrap-up-error"]')?.textContent).toContain('This conversation is archived.');
    onAction.mockResolvedValueOnce({ ok: true });
    await press('task-here');
    expect(container.querySelector('[data-testid="structured-agent-wrap-up-error"]')).toBeNull();
  });
});

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

  describe('on the phone, seconds after the turn', () => {
    const chip = (): HTMLElement | null => container.querySelector<HTMLElement>('[data-testid="structured-agent-suggestion-chip"]');
    const room = (): Element | null => container.querySelector('.chat-viewport__room');

    it('floats over the foot of the transcript, no part of the composer’s layout', () => {
      render(panel({ variant: 'mobile' }));
      expect(chip()?.closest('.chat-composer')).toBeNull();
      expect(chip()?.closest('.chat-viewport__scroll')).toBeNull();
      expect(chip()?.closest('.chat-viewport')).not.toBeNull();
    });

    it('still fills the box from there and sends nothing', () => {
      const onSend = vi.fn(async () => ({ ok: true as const }));
      render(panel({ variant: 'mobile', onSend }));
      act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-suggestion-fill"]')!.click());
      expect(input().value).toBe(SUGGESTION);
      expect(document.activeElement).toBe(input());
      expect(onSend).not.toHaveBeenCalled();
    });

    it('opens scroll room with the suggestion and keeps it past ×: closing it then could pull the transcript down', () => {
      render(panel({ variant: 'mobile' }));
      expect(room()).not.toBeNull();
      act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-suggestion-dismiss"]')!.click());
      expect(chip()).toBeNull();
      expect(room(), 'the × takes the chip, not the room').not.toBeNull();
      render(panel({ variant: 'mobile', state: 'working', turns: [turn('turn-1', 'completed', AT), turn('turn-2', 'working', LATER)] }));
      expect(room(), 'the next turn moves the transcript anyway').toBeNull();
    });

    it('opens nothing when no suggestion came: about half of Codex turns have none', () => {
      render(panel({ variant: 'mobile', wrapUp: {} }));
      expect(room()).toBeNull();
      expect(container.querySelector('.chat-viewport')?.hasAttribute('data-tail-room')).toBe(false);
    });

    it('leaves the desktop as it was', () => {
      render(panel());
      expect(room()).toBeNull();
      expect(container.querySelector('.chat-viewport__dock')).toBeNull();
    });
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
