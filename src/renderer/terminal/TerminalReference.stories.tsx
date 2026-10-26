import type { Meta, StoryObj } from '@storybook/react-vite';
import { useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import type { ChatStateResult, ChatStateScope, ChatStateWrite, ChatStateSnapshot } from '../../shared/chat-state';
import type { DaemonSnapshot } from '../../shared/daemon-protocol';
import type { InterpreterFrame } from '../../shared/ipc';
import type { TerminalCompletionRequest, TerminalCompletionResult } from '../../shared/terminal-completion';
import { CONVERSATION_VIEWS_KEY } from '../conversation-views';
import { shellSnapshot } from '../shell/shell-fixtures';
import { TerminalPane } from '../TerminalPane';
import { AppI18nProvider } from '../i18n';
import { DEFAULT_TERMINAL_RUNTIME_OPTIONS } from '../xterm-runtime';
import { createTerminalAiHost, TerminalAiContext } from './terminal-ai-host';
import '../index.css';
import '../structured-agent.css';
import '../session-start.css';

/**
 * The desktop terminal (I3): instrument blocks, the prompt dock, and the AI
 * input of the last conversation with a block attached. A real TerminalPane on
 * a fake host: commands "run" by sending interpreter frames over a real
 * MessagePort, and drafts live in memory.
 */

const CWD = 'C:\\Working\\EZTerminal';
const START = new Date(2026, 9, 27, 14, 20, 0).getTime();

/** Scripted output per command: text rows (each a line) and the exit code. */
const OUTPUTS: Record<string, { readonly lines: readonly string[]; readonly exitCode: number; readonly tookMs: number }> = {
  'git status --short': { lines: [' M src/renderer/TerminalPane.tsx', ' M src/renderer/index.css', '?? src/renderer/terminal/TerminalAiDock.tsx'], exitCode: 0, tookMs: 240 },
  'git log --oneline -3': { lines: ['9a8385b feat(terminal): Ctrl+. AI input', 'b566754 feat(terminal): instrument blocks', '556962c feat(terminal): Tab completion engine'], exitCode: 0, tookMs: 180 },
};

function snapshotWithProvider(): DaemonSnapshot {
  const base = shellSnapshot();
  const record = { revision: 1, createdAt: base.generatedAt, updatedAt: base.generatedAt };
  return {
    ...base,
    providers: [{ ...record, id: 'claude', displayName: 'Claude', protocol: 'claude-agent-sdk', executablePath: 'claude', executableVersion: '2', argv: [], environmentVariableNames: [], capabilities: [], reviewDigest: 'review', enabled: true, health: 'ready' }],
    // A conversation that finished its turn and waits for the next message.
    agents: base.agents.map((agent) => (agent.sessionId === 's-font' ? { ...agent, state: 'idle', model: 'claude-opus' } : agent)),
  } as DaemonSnapshot;
}

/** A clock that moves on by each command's own time, so start times and durations read the same every run. */
function scriptedClock(): { readonly now: () => number; readonly ran: (tookMs: number) => void } {
  let current = START;
  return { now: () => current, ran: (tookMs) => { current += tookMs; } };
}

function storyHost(clock: ReturnType<typeof scriptedClock>) {
  const drafts = new Map<string, ChatStateSnapshot>();
  const key = (scope: ChatStateScope) => `${scope.projectId}\0${scope.sessionId}\0${scope.kind ?? ''}`;
  return {
    openSessionSurface: async (surfaceId: string) => ({
      ok: true as const,
      binding: { surfaceId, bindingId: `binding:${surfaceId}`, role: 'owner' as const, session: { sessionId: 'story-terminal', cwd: CWD, createdAt: START } },
    }),
    prepareSessionSurfaceClose: async () => ({ ok: true as const, prepared: { closeToken: 'story-close', items: [] } }),
    commitSessionSurfaceClose: async () => ({ ok: true as const, keptSessionIds: [] }),
    releaseSessionSurface: async () => ({ ok: true as const }),
    listSessions: async () => [],
    listRuns: async () => [],
    onRunStarted: () => () => undefined,
    onSessionDead: () => () => undefined,
    onSessionRecovered: () => () => undefined,
    attachRun: async () => undefined,
    runCommand: async (text: string, runId: string) => {
      const output = OUTPUTS[text] ?? { lines: [`${text}: not in this story`], exitCode: 1, tookMs: 120 };
      const channel = new MessageChannel();
      const rows = output.lines.map((line, index) => ({ value: index < output.lines.length - 1 ? `${line}\n` : line }));
      const send = (frame: InterpreterFrame): void => channel.port1.postMessage(frame);
      channel.port1.onmessage = (event: MessageEvent<{ type: string; start?: number; count?: number }>) => {
        if (event.data.type !== 'requestRows' && event.data.type !== 'setViewport') return;
        const start = event.data.start ?? 0;
        send({ type: 'chunk', start, rows: rows.slice(start, start + (event.data.count ?? rows.length)) });
      };
      window.postMessage({ _ezPort: runId }, window.location.origin, [channel.port2]);
      setTimeout(() => {
        send({ type: 'start', commandText: text, cwd: CWD, executionKind: 'local' });
        send({ type: 'schema', shape: 'text', columns: [{ name: 'value', type: 'html' }] });
        send({ type: 'progress', count: rows.length, done: true });
        clock.ran(output.tookMs);
        send({ type: 'end', exitCode: output.exitCode, cwd: CWD });
      }, 30);
    },
    chatStateRead: async (scope: ChatStateScope): Promise<ChatStateResult> => ({
      ok: true, snapshot: drafts.get(key(scope)) ?? { version: 1, scope, revision: 0, state: { draft: { text: '' } }, updatedAt: null },
    }),
    chatStateWrite: async (scope: ChatStateScope, request: ChatStateWrite): Promise<ChatStateResult> => {
      const current = drafts.get(key(scope));
      const revision = (current?.revision ?? 0);
      if (request.expectedRevision !== revision) return { ok: false, error: 'stale', revision, message: 'conflict' };
      const next = { version: 1 as const, scope, revision: revision + 1, state: request.state, updatedAt: new Date(START).toISOString() };
      drafts.set(key(scope), next);
      return { ok: true, snapshot: next };
    },
  } as unknown as Window['ezterminal'];
}

/** Tab completion of `cd s…` in the story's folder. */
const storyDesktop = {
  completeTerminalLine: async (request: TerminalCompletionRequest): Promise<TerminalCompletionResult> => {
    const start = request.line.lastIndexOf(' ', request.caret - 1) + 1;
    const word = request.line.slice(start, request.caret).toLowerCase();
    const candidates = ['scripts\\', 'src\\', 'storybook-static\\']
      .filter((name) => name.startsWith(word))
      .map((name) => ({ label: name, kind: 'directory' as const, insertText: name }));
    if (candidates.length === 0) return { ok: false, reason: 'none' };
    return { ok: true, replaceStart: start, replaceEnd: request.caret, commonText: candidates.length === 1 ? candidates[0]!.insertText : request.line.slice(start, request.caret), candidates, truncated: false };
  },
} as unknown as Window['ezterminalDesktop'];

function TerminalReferenceFrame({ children }: { readonly children: (clock: () => number) => ReactNode }): JSX.Element {
  const clock = useMemo(scriptedClock, []);
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const previous = Object.getOwnPropertyDescriptor(window, 'ezterminal');
    const previousDesktop = Object.getOwnPropertyDescriptor(window, 'ezterminalDesktop');
    Object.defineProperty(window, 'ezterminal', { configurable: true, value: storyHost(clock) });
    Object.defineProperty(window, 'ezterminalDesktop', { configurable: true, value: storyDesktop });
    // The last conversation looked at: the terminal's AI input sends there.
    const viewed = localStorage.getItem(CONVERSATION_VIEWS_KEY);
    localStorage.setItem(CONVERSATION_VIEWS_KEY, JSON.stringify({ sessions: { 's-font': new Date(START).toISOString() }, last: 's-font' }));
    setReady(true);
    return () => {
      if (previous) Object.defineProperty(window, 'ezterminal', previous);
      else Reflect.deleteProperty(window, 'ezterminal');
      if (previousDesktop) Object.defineProperty(window, 'ezterminalDesktop', previousDesktop);
      else Reflect.deleteProperty(window, 'ezterminalDesktop');
      if (viewed === null) localStorage.removeItem(CONVERSATION_VIEWS_KEY);
      else localStorage.setItem(CONVERSATION_VIEWS_KEY, viewed);
    };
  }, [clock]);
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--term-bg)' }}>
      {ready && children(clock.now)}
    </div>
  );
}

function TerminalReferenceStory({ panelId, locale = 'ko' }: { readonly panelId: string; readonly locale?: 'ko' | 'en' }): JSX.Element {
  const host = useMemo(() => {
    const created = createTerminalAiHost({ openConversation: () => undefined, notifySent: () => undefined });
    created.set(snapshotWithProvider());
    return created;
  }, []);
  return (
    <AppI18nProvider locale={locale} languages={[locale]}>
      <TerminalReferenceFrame>
        {(now) => (
          <TerminalAiContext.Provider value={host}>
            <TerminalPane
              panelId={panelId}
              title="PowerShell · main"
              initialCwd={CWD}
              clock={now}
              mountSessionPane={(panelId, _token, initialCwd) => ({
                surfaceId: `story:${panelId}`,
                intent: { kind: 'create', cwd: initialCwd },
                bind: () => true,
                dispose: () => undefined,
              })}
              terminalRuntimeOptions={DEFAULT_TERMINAL_RUNTIME_OPTIONS}
            />
          </TerminalAiContext.Provider>
        )}
      </TerminalReferenceFrame>
    </AppI18nProvider>
  );
}

const meta = {
  title: 'Production/Terminal/Terminal pane',
  component: TerminalReferenceStory,
  parameters: { layout: 'fullscreen' },
  render: (args, context) => <TerminalReferenceStory panelId={args.panelId} locale={context.globals.locale === 'en' ? 'en' : 'ko'} />,
} satisfies Meta<typeof TerminalReferenceStory>;

export default meta;
type Story = StoryObj<typeof meta>;

async function run(canvas: ReturnType<typeof within>, command: string, count: number): Promise<void> {
  const input = await canvas.findByTestId('cmd-input');
  await waitFor(() => expect(input).not.toBeDisabled());
  await userEvent.click(input);
  await userEvent.type(input, `${command}{Enter}`);
  await waitFor(() => expect(canvas.getAllByTestId('block-status').filter((status: HTMLElement) => status.getAttribute('data-status') === 'done')).toHaveLength(count));
}

/** The approved 2.0 reference: two commands, then Ctrl+. with the last one attached. */
export const TerminalReference: Story = {
  args: { panelId: 'story-terminal-reference' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await run(canvas, 'git status --short', 1);
    await run(canvas, 'git log --oneline -3', 2);
    // By key code, as the app reads it (Period), whatever the keyboard layout.
    await userEvent.keyboard('{Control>}[Period]{/Control}');
    await waitFor(() => expect(canvas.getByTestId('term-dock')).toHaveAttribute('data-mode', 'ai'));
    await waitFor(() => expect(canvas.getByTestId('terminal-ai-chip')).toBeInTheDocument());
    await expect(canvas.getByTestId('terminal-ai-target')).toHaveTextContent('설정 화면 글꼴 미리보기');
  },
};

/** The shell line, before anything is attached. */
export const ShellMode: Story = {
  args: { panelId: 'story-terminal-shell' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await run(canvas, 'git status --short', 1);
    await expect(canvas.getByTestId('term-dock')).toHaveAttribute('data-mode', 'shell');
  },
};

/** Tab with several matches: the list over the prompt line, the first one active. */
export const CompletionList: Story = {
  args: { panelId: 'story-terminal-completion' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await run(canvas, 'git status --short', 1);
    const input = canvas.getByTestId('cmd-input');
    await userEvent.type(input, 'cd s');
    await userEvent.keyboard('{Tab}');
    await waitFor(() => expect(canvas.getAllByTestId('terminal-completion-option')).toHaveLength(3));
    await userEvent.keyboard('{ArrowDown}');
    await expect(input).toHaveAttribute('aria-activedescendant', canvas.getAllByTestId('terminal-completion-option')[1]!.id);
  },
};
