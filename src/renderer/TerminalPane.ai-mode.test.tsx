// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonSnapshot } from '../shared/daemon-protocol';
import { CONVERSATION_VIEWS_KEY } from './conversation-views';
import { clearSessionViewStates, readSessionViewState, saveSessionViewState } from './session-view-state';
import { shellSnapshot } from './shell/shell-fixtures';
import { createTerminalAiHost, TerminalAiContext } from './terminal/terminal-ai-host';
import type { TerminalAiDockProps } from './terminal/TerminalAiDock';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The dock is replaced by a stand-in that shows what the pane hands it.
let lastDock: TerminalAiDockProps | null = null;
let lastPick: ((choice: string) => void) | null = null;
vi.mock('./terminal/TerminalAiDock', () => ({
  TerminalAiDock: (props: TerminalAiDockProps) => {
    lastDock = props;
    return <div data-testid="dock-stub" data-target={props.target.kind === 'conversation' ? props.target.sessionId : `new:${props.target.projectId ?? ''}`} />;
  },
  TerminalTargetPicker: (props: { readonly onPick: (choice: string) => void }) => {
    lastPick = props.onPick;
    return <span data-testid="picker-stub" />;
  },
}));

let container: HTMLDivElement;
let root: Root;
let TerminalPane: typeof import('./TerminalPane').TerminalPane;

beforeAll(async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillStyle: '#000000' } as unknown as CanvasRenderingContext2D);
  ({ TerminalPane } = await import('./TerminalPane'));
});
afterAll(() => { vi.restoreAllMocks(); });

function snapshot(): DaemonSnapshot {
  const base = shellSnapshot();
  return {
    ...base,
    projects: base.projects.map((project) => (project.id === 'p-ez' ? { ...project, rootPath: 'C:\\Work\\ez' } : project)),
    agents: base.agents.map((agent) => (agent.state === 'done' ? { ...agent, state: 'idle' } : agent)),
  };
}

beforeEach(() => {
  clearSessionViewStates();
  localStorage.setItem(CONVERSATION_VIEWS_KEY, JSON.stringify({ sessions: { 's-font': '2026-10-24T09:10:00.000Z' }, last: 's-font' }));
  lastDock = null;
  lastPick = null;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
});

function render(host: ReturnType<typeof createTerminalAiHost>, props: { initialCwd?: string; panelId?: string } = {}): void {
  act(() => {
    root.render(
      <TerminalAiContext.Provider value={host}>
        <TerminalPane panelId={props.panelId ?? 'pane-ai'} {...(props.initialCwd ? { initialCwd: props.initialCwd } : {})} />
      </TerminalAiContext.Provider>,
    );
  });
}

const pane = (): HTMLElement => container.querySelector('[data-testid="pane"]')!;
const dock = (): HTMLElement => container.querySelector('[data-testid="term-dock"]')!;
function ctrlPeriod(target: Element = pane()): void {
  act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: '.', code: 'Period', ctrlKey: true, bubbles: true, cancelable: true })); });
}
const stubTarget = (): string | null => container.querySelector('[data-testid="dock-stub"]')?.getAttribute('data-target') ?? null;

describe('TerminalPane AI input', () => {
  it('Ctrl+. switches to the last conversation looked at and back', () => {
    const host = createTerminalAiHost({ openConversation: vi.fn(), notifySent: vi.fn() });
    host.set(snapshot());
    render(host);
    ctrlPeriod();
    expect(dock().getAttribute('data-mode')).toBe('ai');
    expect(stubTarget()).toBe('s-font');
    ctrlPeriod();
    expect(dock().getAttribute('data-mode')).toBe('shell');
  });

  it('does nothing without the app host, and not while an IME composes', () => {
    act(() => { root.render(<TerminalPane panelId="pane-plain" />); });
    expect(container.querySelector('[data-testid="terminal-mode-ai"]')).toBeNull();
    ctrlPeriod();
    expect(dock().getAttribute('data-mode')).toBe('shell');

    const host = createTerminalAiHost({ openConversation: vi.fn(), notifySent: vi.fn() });
    host.set(snapshot());
    render(host);
    act(() => { pane().dispatchEvent(new KeyboardEvent('keydown', { key: '.', code: 'Period', ctrlKey: true, isComposing: true, bubbles: true })); });
    expect(dock().getAttribute('data-mode')).toBe('shell');
  });

  it('waits for the first snapshot instead of choosing a new conversation', () => {
    const host = createTerminalAiHost({ openConversation: vi.fn(), notifySent: vi.fn() });
    render(host);
    ctrlPeriod();
    expect(dock().getAttribute('data-mode')).toBe('ai');
    expect(stubTarget()).toBeNull();
    act(() => host.set(snapshot()));
    expect(stubTarget()).toBe('s-font');
  });

  it('sends to the conversation a start box created, even before the snapshot lists it', () => {
    const notifySent = vi.fn();
    const host = createTerminalAiHost({ openConversation: vi.fn(), notifySent });
    host.set(snapshot());
    render(host);
    ctrlPeriod();
    act(() => lastDock!.onNewConversation());
    expect(stubTarget()).toBe('new:');
    act(() => lastDock!.onStarted('s-brand-new'));
    expect(stubTarget()).toBe('s-brand-new');
    expect(notifySent).toHaveBeenCalledWith('s-brand-new', expect.anything());
    // Out and back in: the pick sticks to this terminal.
    ctrlPeriod();
    ctrlPeriod();
    expect(stubTarget()).toBe('s-brand-new');
  });

  it('a start box that finishes after the person chose elsewhere only reports the send', () => {
    const notifySent = vi.fn();
    const host = createTerminalAiHost({ openConversation: vi.fn(), notifySent });
    host.set(snapshot());
    render(host);
    ctrlPeriod();
    act(() => lastDock!.onNewConversation());
    expect(stubTarget()).toBe('new:');
    const lateStarted = lastDock!.onStarted;
    // While the new conversation is still being created, the person picks another one from the menu.
    act(() => lastPick!('s-pdf'));
    expect(stubTarget()).toBe('s-pdf');
    act(() => lateStarted('s-late'));
    expect(stubTarget()).toBe('s-pdf');
    expect(notifySent).toHaveBeenCalledWith('s-late', expect.anything());
  });

  it('switching to the shell and back while the start box sends still makes its conversation the destination', () => {
    const host = createTerminalAiHost({ openConversation: vi.fn(), notifySent: vi.fn() });
    host.set(snapshot());
    render(host);
    ctrlPeriod();
    act(() => lastDock!.onNewConversation());
    const started = lastDock!.onStarted;
    ctrlPeriod();
    ctrlPeriod();
    expect(stubTarget()).toBe('new:');
    act(() => started('s-made-here'));
    expect(stubTarget()).toBe('s-made-here');
  });

  it('drops a remembered pick the app no longer lists', () => {
    const host = createTerminalAiHost({ openConversation: vi.fn(), notifySent: vi.fn() });
    host.set(snapshot());
    saveSessionViewState('terminal-ai-target:pane-old-pick', 's-removed');
    render(host, { panelId: 'pane-old-pick' });
    ctrlPeriod();
    expect(stubTarget()).toBe('s-font');
    expect(readSessionViewState('terminal-ai-target:pane-old-pick')).toBeUndefined();
  });

  it('a remembered "new conversation" waits for the snapshot to know the terminal\'s project', () => {
    const host = createTerminalAiHost({ openConversation: vi.fn(), notifySent: vi.fn() });
    saveSessionViewState('terminal-ai-target:pane-new-pick', 'new');
    render(host, { initialCwd: 'C:\\Work\\ez\\src', panelId: 'pane-new-pick' });
    ctrlPeriod();
    expect(stubTarget()).toBeNull();
    act(() => host.set(snapshot()));
    expect(stubTarget()).toBe('new:p-ez');
  });

  it('reads the terminal\'s project from the folder it was opened in before its session binds', () => {
    const host = createTerminalAiHost({ openConversation: vi.fn(), notifySent: vi.fn() });
    host.set(snapshot());
    localStorage.setItem(CONVERSATION_VIEWS_KEY, JSON.stringify({ sessions: { 's-garnet': '2026-10-24T09:25:00.000Z' }, last: 's-garnet' }));
    render(host, { initialCwd: 'C:\\Work\\ez\\src', panelId: 'pane-project' });
    ctrlPeriod();
    // s-garnet is in another project: the EZTerminal terminal starts a new conversation in its own project.
    expect(stubTarget()).toBe('new:p-ez');
  });
});
