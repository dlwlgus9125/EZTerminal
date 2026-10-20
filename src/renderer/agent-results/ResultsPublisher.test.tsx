// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeFileChanges } from '../../shared/conversation-changes';
import type { DaemonTranscriptItem } from '../../shared/daemon-protocol';
import { AgentResultsContext, type AgentResultsHost } from './AgentResultsContext';
import { ResultsPublisher } from './ResultsPublisher';
import { readResultsSource, resetResultsSourcesForTests } from './results-source-store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function change(sequence: number, createdAt: string): DaemonTranscriptItem {
  return {
    id: `r${String(sequence)}`, sessionId: 's', turnId: 't', sequence, kind: 'tool-result', isDelta: false, isSensitive: false, createdAt,
    text: encodeFileChanges([{ path: 'a.ts', patch: '@@ -1,1 +1,1 @@\n-a\n+b', coverage: 'patch' }])!,
  };
}

describe('ResultsPublisher', () => {
  let root: Root;
  let container: HTMLDivElement;
  const host: AgentResultsHost = { open: vi.fn(() => true), requestAutoOpen: vi.fn() };
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(host.requestAutoOpen).mockClear();
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); resetResultsSourcesForTests(); });

  const render = (items: readonly DaemonTranscriptItem[], extra: { historyOnly?: boolean; loaded?: boolean } = {}): void => {
    act(() => root.render(
      <AgentResultsContext.Provider value={host}>
        <ResultsPublisher ownerPanelId="agent-session-1" sessionId="s" title="T" providerLabel="Codex" items={items} children={[]}
          transcriptFloor={0} loaded={extra.loaded ?? true} historyOnly={extra.historyOnly ?? false} turnActive={false} />
      </AgentResultsContext.Provider>,
    ));
  };

  it('publishes the conversation and asks once for its Results tab when a new change arrives', () => {
    render([]);
    expect(readResultsSource('agent-session-1')).toMatchObject({ sessionId: 's', title: 'T', loaded: true });
    expect(host.requestAutoOpen).not.toHaveBeenCalled();
    const now = new Date().toISOString();
    render([change(1, now)]);
    render([change(1, now), change(2, now)]);
    expect(host.requestAutoOpen).toHaveBeenCalledTimes(1);
    expect(host.requestAutoOpen).toHaveBeenCalledWith('agent-session-1', 's');
  });

  it('a change already in the first reply of a new conversation still opens it', () => {
    render([change(3, new Date(Date.now() - 2_000).toISOString())]);
    expect(host.requestAutoOpen).toHaveBeenCalledTimes(1);
  });

  it('reopening an older conversation, or a read-only one, never opens it', () => {
    render([change(1, '2026-01-01T00:00:00.000Z')]);
    expect(host.requestAutoOpen).not.toHaveBeenCalled();
    act(() => root.unmount());
    root = createRoot(container);
    render([change(1, new Date().toISOString())], { historyOnly: true });
    expect(host.requestAutoOpen).not.toHaveBeenCalled();
  });

  it('forgets what it published when the conversation goes', () => {
    render([]);
    act(() => root.unmount());
    root = createRoot(container);
    expect(readResultsSource('agent-session-1')).toBeUndefined();
  });
});
