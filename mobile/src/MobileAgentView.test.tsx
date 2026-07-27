// Real React root + native DOM events, same harness as the other mobile
// component tests in this package (no @testing-library/react here).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentActivity, AgentActivitySnapshot, AgentStatus } from '../../src/shared/agent';
import { MobileAgentView } from './MobileAgentView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_800_000_000_000;

function activity(id: string, status: AgentStatus, overrides: Partial<AgentActivity> = {}): AgentActivity {
  return {
    id,
    sessionId: `session-${id}`,
    provider: 'claude',
    cwd: `C:/Workspace/${id}`,
    status,
    createdAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    ...overrides,
  };
}

function snapshotOf(...items: readonly AgentActivity[]): AgentActivitySnapshot {
  return { revision: 1, items };
}

let container: HTMLDivElement;
let root: Root;

function render(node: JSX.Element): void {
  act(() => root.render(node));
}

function testIds(id: string): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('MobileAgentView', () => {
  const noop = {
    onBack: () => undefined,
    onFocusSession: () => undefined,
    onSendFollowup: async () => ({ ok: true }) as const,
  };

  it('buckets every agent status into the four filters with counts', () => {
    render(
      <MobileAgentView
        snapshot={snapshotOf(
          activity('a', 'blocked'),
          activity('b', 'waiting'),
          activity('c', 'error'),
          activity('d', 'working'),
          activity('e', 'starting'),
          activity('f', 'done'),
        )}
        {...noop}
      />,
    );

    expect(testIds('agent-filter-all')[0]?.textContent).toContain('6');
    expect(testIds('agent-filter-attention')[0]?.textContent).toContain('3');
    expect(testIds('agent-filter-running')[0]?.textContent).toContain('2');
    expect(testIds('agent-filter-done')[0]?.textContent).toContain('1');
    expect(testIds('agent-card')).toHaveLength(6);
    expect(testIds('agent-attention-summary')[0]?.textContent).toContain('3');
  });

  it('narrows the list to the selected bucket and back', () => {
    render(
      <MobileAgentView
        snapshot={snapshotOf(activity('a', 'blocked'), activity('b', 'working'), activity('c', 'done'))}
        {...noop}
      />,
    );
    expect(testIds('agent-card')).toHaveLength(3);

    act(() => testIds('agent-filter-running')[0]!.click());
    const running = testIds('agent-card');
    expect(running).toHaveLength(1);
    expect(running[0]?.getAttribute('data-status')).toBe('working');

    act(() => testIds('agent-filter-all')[0]!.click());
    expect(testIds('agent-card')).toHaveLength(3);
  });

  it('orders attention ahead of running and done, blocked first within attention', () => {
    render(
      <MobileAgentView
        snapshot={snapshotOf(
          activity('done', 'done'),
          activity('waiting', 'waiting'),
          activity('working', 'working'),
          activity('blocked', 'blocked'),
        )}
        {...noop}
      />,
    );
    expect(testIds('agent-card').map((card) => card.getAttribute('data-status')))
      .toEqual(['blocked', 'waiting', 'working', 'done']);
  });

  it('offers the follow-up composer only for a waiting agent', () => {
    render(<MobileAgentView snapshot={snapshotOf(activity('a', 'blocked'))} {...noop} />);
    expect(testIds('agent-followup-input')).toHaveLength(0);

    render(<MobileAgentView snapshot={snapshotOf(activity('a', 'waiting'))} {...noop} />);
    expect(testIds('agent-followup-input')).toHaveLength(1);
  });

  it('sends a follow-up and clears the draft on success', async () => {
    const onSendFollowup = vi.fn(async () => ({ ok: true }) as const);
    render(
      <MobileAgentView
        snapshot={snapshotOf(activity('a', 'waiting'))}
        {...noop}
        onSendFollowup={onSendFollowup}
      />,
    );

    const input = testIds('agent-followup-input')[0] as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(input, 'continue please');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(onSendFollowup).toHaveBeenCalledWith('a', 'continue please');
    expect((testIds('agent-followup-input')[0] as HTMLInputElement).value).toBe('');
  });

  it('surfaces a delivery failure without clearing the draft', async () => {
    render(
      <MobileAgentView
        snapshot={snapshotOf(activity('a', 'waiting'))}
        {...noop}
        onSendFollowup={async () => ({ ok: false, error: 'not-waiting' }) as const}
      />,
    );

    const input = testIds('agent-followup-input')[0] as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(input, 'hello');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('The agent is no longer waiting.');
    expect((testIds('agent-followup-input')[0] as HTMLInputElement).value).toBe('hello');
  });

  it('focuses the terminal session behind an attention card', () => {
    const onFocusSession = vi.fn();
    render(
      <MobileAgentView
        snapshot={snapshotOf(activity('a', 'blocked'))}
        {...noop}
        onFocusSession={onFocusSession}
      />,
    );
    act(() => testIds('agent-focus')[0]!.click());
    expect(onFocusSession).toHaveBeenCalledWith('session-a');
  });

  it('distinguishes an empty snapshot from an empty filter', () => {
    render(<MobileAgentView snapshot={snapshotOf()} {...noop} />);
    expect(testIds('agent-empty')[0]?.textContent).toContain('No agent activity yet');

    render(<MobileAgentView snapshot={snapshotOf(activity('a', 'done'))} {...noop} />);
    act(() => testIds('agent-filter-attention')[0]!.click());
    expect(testIds('agent-empty')[0]?.textContent).toBe('No agents match this filter.');
  });

  it('blocks follow-up while disconnected and says so', () => {
    render(<MobileAgentView snapshot={snapshotOf(activity('a', 'waiting'))} {...noop} disconnected />);
    expect((testIds('agent-followup-input')[0] as HTMLInputElement).disabled).toBe(true);
    expect(container.textContent).toContain('Reconnecting to desktop…');
  });
});
