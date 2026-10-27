import type { Meta, StoryObj } from '@storybook/react-vite';
import { useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { CONVERSATION_VIEWS_KEY } from '../conversation-views';
import { TerminalPane } from '../TerminalPane';
import { AppI18nProvider } from '../i18n';
import { DEFAULT_TERMINAL_RUNTIME_OPTIONS } from '../xterm-runtime';
import { createTerminalAiHost, TerminalAiContext } from './terminal-ai-host';
import { CWD, START, scriptedClock, snapshotWithProvider, storyDesktop, storyHost } from './terminal-story-host';
import '../index.css';
import '../structured-agent.css';
import '../session-start.css';

/**
 * The desktop terminal (I3): instrument blocks, the prompt dock, and the AI
 * input of the last conversation with a block attached. A real TerminalPane on
 * a fake host: commands "run" by sending interpreter frames over a real
 * MessagePort, and drafts live in memory.
 */

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
    // The sign and the Shell | AI switch sit on the command row's middle.
    const middle = (element: Element): number => { const box = element.getBoundingClientRect(); return box.top + box.height / 2; };
    const row = middle(canvas.getByTestId('cmd-input'));
    const sign = canvasElement.querySelector('.term-dock__sig')!;
    const modes = canvasElement.querySelector('.term-mode')!;
    await expect(Math.abs(middle(sign) - row)).toBeLessThanOrEqual(2);
    await expect(Math.abs(middle(modes) - row)).toBeLessThanOrEqual(2);
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
