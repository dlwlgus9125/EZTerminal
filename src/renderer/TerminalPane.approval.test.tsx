// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentApproval } from '../shared/agent';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let TerminalPane: typeof import('./TerminalPane').TerminalPane;

beforeAll(async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillStyle: '#000000',
  } as unknown as CanvasRenderingContext2D);
  ({ TerminalPane } = await import('./TerminalPane'));
});

afterAll(() => {
  vi.restoreAllMocks();
});

function approval(pending: boolean, expiresAt: number): AgentApproval {
  return {
    approvalId: 'approval-pane',
    toolName: 'Bash',
    command: 'pnpm test',
    risk: 'write',
    pending,
    requestedAt: Date.now() - 1_000,
    expiresAt,
  };
}

function renderApproval(pending: boolean, expiresAt: number): void {
  act(() => {
    root.render(
      <TerminalPane
        panelId="approval-pane"
        pendingApproval={{
          activityId: 'activity-pane',
          approval: approval(pending, expiresAt),
        }}
        onDecideApproval={vi.fn(async () => ({ ok: true as const }))}
      />,
    );
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('TerminalPane approval authority', () => {
  it('uses host pending truth instead of the renderer wall clock', () => {
    renderApproval(true, Date.now() - 60_000);
    expect(container.querySelector('[data-testid="pane-approval"]')).not.toBeNull();

    renderApproval(false, Date.now() + 60_000);
    expect(container.querySelector('[data-testid="pane-approval"]')).toBeNull();
  });
});
