// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TerminalCompletionRequest, TerminalCompletionResult } from '../shared/terminal-completion';
import { clearSessionViewStates } from './session-view-state';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let TerminalPane: typeof import('./TerminalPane').TerminalPane;
let complete: ReturnType<typeof vi.fn<(request: TerminalCompletionRequest) => Promise<TerminalCompletionResult>>>;
let runCommand: ReturnType<typeof vi.fn>;
const answers: Array<(result: TerminalCompletionResult) => void> = [];

beforeAll(async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillStyle: '#000000' } as unknown as CanvasRenderingContext2D);
  ({ TerminalPane } = await import('./TerminalPane'));
});
afterAll(() => { vi.restoreAllMocks(); });

beforeEach(() => {
  clearSessionViewStates();
  answers.length = 0;
  complete = vi.fn<(request: TerminalCompletionRequest) => Promise<TerminalCompletionResult>>(
    () => new Promise<TerminalCompletionResult>((resolve) => { answers.push(resolve); }),
  );
  runCommand = vi.fn(async () => undefined);
  Object.defineProperty(window, 'ezterminal', {
    configurable: true,
    value: {
      openSessionSurface: async (surfaceId: string) => ({
        ok: true, binding: { surfaceId, bindingId: `binding:${surfaceId}`, role: 'owner', session: { sessionId: 'session-1', cwd: 'C:\\Work', createdAt: 0 } },
      }),
      releaseSessionSurface: async () => ({ ok: true }),
      listSessions: async () => [],
      listRuns: async () => [],
      onRunStarted: () => () => undefined,
      onSessionDead: () => () => undefined,
      onSessionRecovered: () => () => undefined,
      runCommand,
    },
  });
  Object.defineProperty(window, 'ezterminalDesktop', { configurable: true, value: { completeTerminalLine: complete } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(window, 'ezterminal');
  Reflect.deleteProperty(window, 'ezterminalDesktop');
});

async function renderPane(): Promise<HTMLInputElement> {
  await act(async () => {
    root.render(
      <TerminalPane
        panelId="pane-complete"
        mountSessionPane={(panelId, _token, initialCwd) => ({
          surfaceId: `test:${panelId}`, intent: { kind: 'create', cwd: initialCwd }, bind: () => true, dispose: () => undefined,
        })}
      />,
    );
  });
  await act(async () => { await Promise.resolve(); });
  const input = container.querySelector<HTMLInputElement>('[data-testid="cmd-input"]')!;
  expect(input.disabled).toBe(false);
  input.focus();
  return input;
}

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.setSelectionRange(value.length, value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function press(input: HTMLInputElement, key: string, init: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => { input.dispatchEvent(event); });
  return event.defaultPrevented;
}

async function answer(result: TerminalCompletionResult): Promise<void> {
  await act(async () => { answers.shift()!(result); await Promise.resolve(); });
}

const list = (): HTMLElement | null => container.querySelector('[role="listbox"]');
const options = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[data-testid="terminal-completion-option"]')];

describe('TerminalPane Tab completion', () => {
  it('fills the only match in, asking the session\'s interpreter with the line and caret', async () => {
    const input = await renderPane();
    type(input, 'cd sr');
    expect(press(input, 'Tab')).toBe(true);
    expect(complete).toHaveBeenCalledWith({ sessionId: 'session-1', line: 'cd sr', caret: 5 });
    await answer({ ok: true, replaceStart: 3, replaceEnd: 5, commonText: 'src\\', truncated: false, candidates: [{ label: 'src\\', kind: 'directory', insertText: 'src\\' }] });
    expect(input.value).toBe('cd src\\');
    expect(input.selectionStart).toBe(7);
    expect(list()).toBeNull();
  });

  it('fills the shared part of several, lists them, and takes the one the arrows pick', async () => {
    const input = await renderPane();
    type(input, 'cat s');
    press(input, 'Tab');
    await answer({ ok: true, replaceStart: 4, replaceEnd: 5, commonText: 'sc', truncated: false, candidates: [
      { label: 'scripts\\', kind: 'directory', insertText: 'scripts\\' },
      { label: 'scratch.txt', kind: 'file', insertText: 'scratch.txt ' },
    ] });
    expect(input.value).toBe('cat sc');
    expect(list()).not.toBeNull();
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBe(list()!.id);
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[0]!.id);
    expect(press(input, 'ArrowDown')).toBe(true);
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[1]!.id);
    expect(options()[1]!.getAttribute('aria-selected')).toBe('true');
    // Enter takes the candidate; it does not run the line.
    expect(press(input, 'Enter')).toBe(true);
    expect(input.value).toBe('cat scratch.txt ');
    expect(list()).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('Esc closes the list and typing closes it too', async () => {
    const input = await renderPane();
    const several: TerminalCompletionResult = { ok: true, replaceStart: 0, replaceEnd: 1, commonText: 'g', truncated: true, candidates: [
      { label: 'gh', kind: 'executable', insertText: 'gh ' }, { label: 'git', kind: 'executable', insertText: 'git ' },
    ] };
    type(input, 'g');
    press(input, 'Tab');
    await answer(several);
    expect(container.querySelector('.term-completion__more')).not.toBeNull();
    expect(press(input, 'Escape')).toBe(true);
    expect(list()).toBeNull();
    expect(input.value).toBe('g');

    press(input, 'Tab');
    await answer(several);
    expect(list()).not.toBeNull();
    type(input, 'gi');
    expect(list()).toBeNull();
  });

  it('leaves Tab alone with nothing to complete, and never takes Shift+Tab or Ctrl+Tab', async () => {
    const input = await renderPane();
    expect(press(input, 'Tab')).toBe(false);
    type(input, 'cd ');
    expect(press(input, 'Tab')).toBe(false);
    type(input, 'cd sr');
    expect(press(input, 'Tab', { shiftKey: true })).toBe(false);
    expect(press(input, 'Tab', { ctrlKey: true })).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it('Esc drops an answer still on its way', async () => {
    const input = await renderPane();
    type(input, 'cd sr');
    press(input, 'Tab');
    press(input, 'Escape');
    await answer({ ok: true, replaceStart: 3, replaceEnd: 5, commonText: 's', truncated: false, candidates: [
      { label: 'src\\', kind: 'directory', insertText: 'src\\' }, { label: 'srv\\', kind: 'directory', insertText: 'srv\\' },
    ] });
    expect(input.value).toBe('cd sr');
    expect(list()).toBeNull();
  });

  it('clicking in the line closes the list, so Tab asks again instead of taking an old candidate', async () => {
    const input = await renderPane();
    type(input, 'cat s');
    press(input, 'Tab');
    await answer({ ok: true, replaceStart: 4, replaceEnd: 5, commonText: 's', truncated: false, candidates: [
      { label: 'scripts\\', kind: 'directory', insertText: 'scripts\\' }, { label: 'src\\', kind: 'directory', insertText: 'src\\' },
    ] });
    expect(list()).not.toBeNull();
    act(() => { input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(list()).toBeNull();
    press(input, 'Tab');
    expect(complete).toHaveBeenCalledTimes(2);
    expect(input.value).toBe('cat s');
  });

  it('drops an answer for a line that changed while it was on its way', async () => {
    const input = await renderPane();
    type(input, 'cd sr');
    press(input, 'Tab');
    type(input, 'cd s');
    await answer({ ok: true, replaceStart: 3, replaceEnd: 5, commonText: 'src\\', truncated: false, candidates: [{ label: 'src\\', kind: 'directory', insertText: 'src\\' }] });
    expect(input.value).toBe('cd s');
  });

  it('without the desktop completion, Tab keeps its usual meaning and no hint shows', async () => {
    Reflect.deleteProperty(window, 'ezterminalDesktop');
    const input = await renderPane();
    type(input, 'cd sr');
    expect(press(input, 'Tab')).toBe(false);
    expect(container.querySelector('.term-dock__ctx')?.textContent).not.toContain('Tab');
  });
});
