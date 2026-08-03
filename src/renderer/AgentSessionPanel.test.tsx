// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentResumeBootstrap } from '../shared/agent-history';
import { AgentSessionPanel } from './AgentSessionPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Object.defineProperty(window, 'ezterminal', {
    configurable: true,
    value: undefined,
  });
  vi.restoreAllMocks();
});

describe('AgentSessionPanel', () => {
  it('reads history without resuming, then converts the same panel after the first send', async () => {
    const readAgentHistory = vi.fn(async () => ({
      historyId: 'codex_opaque',
      provider: 'codex' as const,
      turns: [{
        id: 'turn_opaque',
        status: 'completed',
        entries: [
          { type: 'message' as const, id: 'item_opaque', role: 'user' as const, markdown: 'Earlier task' },
        ],
      }],
      nextCursor: null,
    }));
    const prepareAgentResume = vi.fn(async () => ({
      historyId: 'codex_opaque',
      provider: 'codex' as const,
      recordedRoots: ['C:\\project'],
      currentRoots: ['C:\\project'],
      rootsMatch: true,
      missingRecordedRoots: [],
      missingCurrentRoots: [],
      canResume: true,
      revision: 'revision-1',
    }));
    Object.defineProperty(window, 'ezterminal', {
      configurable: true,
      value: { readAgentHistory, prepareAgentResume },
    });

    let handoff: AgentResumeBootstrap | null = null;
    act(() => {
      root.render(
        <AgentSessionPanel
          historyId="codex_opaque"
          renderTerminal={(bootstrap: AgentResumeBootstrap) => {
            handoff = bootstrap;
            return <div data-testid="resumed-terminal">{bootstrap.initialPrompt}</div>;
          }}
        />,
      );
    });
    await flush();

    expect(container.textContent).toContain('Earlier task');
    expect(container.textContent).not.toContain('Read only');
    expect(container.textContent).not.toContain('Resume');
    expect(readAgentHistory).toHaveBeenCalledWith('codex_opaque', undefined, 20);
    expect(prepareAgentResume).not.toHaveBeenCalled();

    const input = container.querySelector<HTMLInputElement>('[data-testid="cmd-input"]')!;
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!;
    act(() => {
      setValue.call(input, 'Continue from here');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      container.querySelector('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    await flush();

    expect(prepareAgentResume).toHaveBeenCalledWith('codex_opaque');
    expect(container.querySelector('[data-testid="agent-session-panel"]')).toBeNull();
    expect(container.querySelector('[data-testid="resumed-terminal"]')?.textContent)
      .toBe('Continue from here');
    // The handoff carries the provider and the root the shell has to start in;
    // the terminal never branches on provider itself.
    expect(handoff).toMatchObject({
      historyId: 'codex_opaque',
      provider: 'codex',
      cwd: 'C:\\project',
      rootChoice: 'current',
      revision: 'revision-1',
      initialPrompt: 'Continue from here',
    });
  });

  it('labels replies with the session provider rather than a fixed agent name', async () => {
    const readAgentHistory = vi.fn(async () => ({
      historyId: 'claude_opaque',
      provider: 'claude' as const,
      turns: [{
        id: 'turn_opaque',
        status: 'completed',
        entries: [
          { type: 'message' as const, id: 'item_opaque', role: 'assistant' as const, markdown: 'Earlier reply' },
        ],
      }],
      nextCursor: null,
    }));
    Object.defineProperty(window, 'ezterminal', {
      configurable: true,
      value: { readAgentHistory, prepareAgentResume: vi.fn() },
    });

    act(() => {
      root.render(
        <AgentSessionPanel historyId="claude_opaque" renderTerminal={() => <div />} />,
      );
    });
    await flush();

    expect(container.querySelector('.agent-history-terminal__role')?.textContent).toBe('claude');
    expect(container.querySelector('[data-testid="agent-session-panel"]')?.getAttribute('data-provider'))
      .toBe('claude');
    expect(container.querySelector('.agent-provider-badge')?.textContent).toBe('Claude');
    expect(container.querySelector('.agent-history-terminal__message')?.getAttribute('data-provider'))
      .toBe('claude');
  });

  it('loads the previous twenty turns automatically near the top', async () => {
    const readAgentHistory = vi.fn(async (
      _historyId: string,
      cursor?: string,
    ) => cursor
      ? {
          historyId: 'codex_opaque',
          provider: 'codex' as const,
          turns: [{
            id: 'older',
            status: 'completed',
            entries: [{ type: 'message' as const, id: 'older-item', role: 'user' as const, markdown: 'Older' }],
          }],
          nextCursor: null,
        }
      : {
          historyId: 'codex_opaque',
          provider: 'codex' as const,
          turns: [{
            id: 'latest',
            status: 'completed',
            entries: [{ type: 'message' as const, id: 'latest-item', role: 'assistant' as const, markdown: 'Latest' }],
          }],
          nextCursor: 'older-cursor',
        });
    Object.defineProperty(window, 'ezterminal', {
      configurable: true,
      value: { readAgentHistory, prepareAgentResume: vi.fn() },
    });
    act(() => {
      root.render(
        <AgentSessionPanel
          historyId="codex_opaque"
          renderTerminal={() => <div />}
        />,
      );
    });
    await flush();
    const viewport = container.querySelector<HTMLDivElement>('[data-testid="agent-history-transcript"]')!;
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1_000 });
    viewport.scrollTop = 0;
    act(() => viewport.dispatchEvent(new Event('scroll', { bubbles: true })));
    await flush();

    expect(readAgentHistory).toHaveBeenLastCalledWith('codex_opaque', 'older-cursor', 20);
    expect(container.textContent).toContain('Older');
    expect(container.textContent).toContain('Latest');
  });
});
