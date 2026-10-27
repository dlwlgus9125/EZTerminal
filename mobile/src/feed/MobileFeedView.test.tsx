import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostAttention } from '../../../src/shared/host-attention';
import { shellSnapshot, shellWorkflow } from '../../../src/renderer/shell/shell-fixtures';
import { AppI18nProvider } from '../../../src/renderer/i18n';
import { feedConversations, feedFlows, feedProjects, feedWaiting, type FeedScope } from './feed-model';
import { MobileFeedView, type MobileFeedViewProps } from './MobileFeedView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const attention: HostAttention = { version: 1, digest: 'd', items: [
  { id: 'flow-1', kind: 'flow-approval', projectId: 'p-ez', title: '승인', since: '2026-10-24T09:25:00.000Z', subprojectId: 'login', nodeId: 'login:approval', runId: 'run-4' },
] };

function props(overrides: Partial<MobileFeedViewProps> = {}, scope: FeedScope = null): MobileFeedViewProps {
  const daemon = { ...shellSnapshot(), attention };
  const projects = feedProjects(daemon);
  const waiting = feedWaiting(daemon, []);
  return {
    projects, scope, onScopeChange: vi.fn(), host: { tone: 'on', label: '작업 PC · 18ms' },
    waiting, flows: feedFlows(new Map([['p-ez', shellWorkflow()]]), scope, projects),
    conversations: feedConversations(daemon, scope, { waitingSessions: new Set(waiting.flatMap((item) => item.sessionId ? [item.sessionId] : [])), limit: 3 }),
    usage: { fiveHour: { usedPercent: 24 }, weekly: { usedPercent: 21 } },
    onDecide: vi.fn(async () => ({ ok: true as const })), onOpenWaiting: vi.fn(), onOpenConversation: vi.fn(), onOpenFlow: vi.fn(),
    onSeeAllConversations: vi.fn(), onNewConversation: vi.fn(),
    ...overrides,
  };
}

function render(next: MobileFeedViewProps, locale: 'ko' | 'en' = 'ko'): void {
  act(() => root.render(<AppI18nProvider locale={locale} languages={[locale]}><MobileFeedView {...next} /></AppI18nProvider>));
}

const ids = (id: string): HTMLElement[] => Array.from(container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));

describe('MobileFeedView', () => {
  it('answers a command approval from its card and opens the rest where they are decided', async () => {
    const next = props();
    render(next);
    const cards = ids('mobile-feed-waiting');
    expect(cards.map((card) => card.dataset.kind)).toEqual(['flow-approval', 'approval', 'question']);
    expect(cards[1]?.textContent).toContain('pnpm --dir mobile test -- notifications');
    // Allow sits left of deny, both full thumb buttons.
    const allow = ids('mobile-feed-allow')[0]!;
    expect(allow.nextElementSibling).toBe(ids('mobile-feed-deny')[0]);
    await act(async () => { allow.click(); await Promise.resolve(); });
    expect(next.onDecide).toHaveBeenCalledWith(expect.objectContaining({ approvalId: 'a-command' }), 'allow');
    act(() => cards[2]!.click());
    expect(next.onOpenWaiting).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'question', sessionId: 's-pdf' }));
    act(() => cards[0]!.click());
    expect(next.onOpenWaiting).toHaveBeenLastCalledWith(expect.objectContaining({ flow: { subprojectId: 'login', nodeId: 'login:approval', runId: 'run-4' } }));
  });

  it('shows why a decision did not go through and lets the person try again', async () => {
    render(props({ onDecide: vi.fn(async () => ({ ok: false as const, message: 'PC에 연결되어 있지 않습니다.' })) }));
    await act(async () => { ids('mobile-feed-allow')[0]!.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('PC에 연결되어 있지 않습니다.');
    expect((ids('mobile-feed-allow')[0] as HTMLButtonElement).disabled).toBe(false);
  });

  it('lists the scope\'s flows and conversations with the project named in 모든 프로젝트, and counts the rest', () => {
    const next = props();
    render(next);
    expect(ids('mobile-feed-flow')).toHaveLength(1);
    expect(ids('mobile-feed-flow')[0]?.textContent).toContain('EZTerminal');
    const conversations = ids('mobile-feed-conversation');
    expect(conversations.map((item) => item.dataset.session)).toEqual(['s-csv', 's-font', 's-garnet']);
    expect(container.querySelector('#mob-feed-conversations')?.textContent).toContain('4');
    expect(ids('mobile-feed-all-conversations')[0]?.textContent).toContain('대화 모두 보기 (4)');
    act(() => conversations[0]!.click());
    expect(next.onOpenConversation).toHaveBeenCalledWith('s-csv');
  });

  it('switches the scope from the header and names the project on the ask bar without a context figure', () => {
    const next = props({}, 'p-ez');
    render(next);
    expect(ids('mobile-feed-scope')[0]?.textContent).toContain('EZTerminal');
    expect(ids('mobile-feed-new')[0]?.textContent).toContain('EZTerminal에서 할 일 · 새 대화');
    expect(ids('mobile-feed-new')[0]?.textContent).toContain('5h 24% · 주간 21%');
    act(() => ids('mobile-feed-scope')[0]!.click());
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="mobile-feed-scope-all"]')!.click());
    expect(next.onScopeChange).toHaveBeenCalledWith(null);
    act(() => ids('mobile-feed-new')[0]!.click());
    expect(next.onNewConversation).toHaveBeenCalled();
  });

  it('leaves the flows out for a PC that cannot report them', () => {
    render(props({ flowsAvailable: false }));
    expect(ids('mobile-feed-flows')).toHaveLength(0);
    render(props({ waiting: [] }), 'en');
    expect(container.textContent).toContain('Nothing is waiting for you.');
  });
});
