// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonTranscriptItem } from '../../../shared/daemon-protocol';
import { SUGGEST_TASK_REFUSALS, SUGGEST_TASK_SERVER, SUGGEST_TASK_TOOL, type SuggestedTaskState } from '../../../shared/turn-wrap-up';
import { AppI18nProvider } from '../../i18n';
import { ChatProvider, type ChatContextValue, type ChatWrapUpAction } from '../ChatContext';
import { ChatRowView } from '../ChatRowView';
import { chatCopy } from '../copy';
import { buildChatModel } from '../model/build-chat-model';
import { TaskStartAllDialog } from '../wrap-up/TaskStartAllDialog';
import { cartStory, formatStory, refusedCallStory, waitingStory, WRAP_SESSION, type WrapUpFixture } from '../wrap-up/wrap-up-fixtures';

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

const TASK_START = { settings: 'Claude · Opus 5.5 · 높음 · 승인 후 실행', folder: 'cart-kit', phone: false, worktrees: true };

function render(fixture: WrapUpFixture, context: Partial<Omit<ChatContextValue, 'isExpanded' | 'setExpanded'>> = {}): void {
  const { rows } = buildChatModel({ items: fixture.items, turns: fixture.turns });
  act(() => root.render(
    <AppI18nProvider locale="ko" languages={['ko']}>
      <ChatProvider skin="bubble" locale="ko" taskStart={TASK_START} {...context}>
        {rows.map((row) => <ChatRowView key={row.id} row={row} providerLabel="Claude" />)}
      </ChatProvider>
    </AppI18nProvider>,
  ));
}

const byTestId = (id: string): HTMLElement | null => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const buttons = (): string[] => [...container.querySelectorAll('button')].map((button) => button.textContent?.trim() ?? '');

describe('a recap that could not be written', () => {
  const failed = formatStory('ko', 'claude', { recap: 'failed', failure: 'disconnected', suggestion: false });

  it('offers 다시 만들기 while the session is attached', () => {
    const onWrapUpAction = vi.fn();
    render(failed, { onWrapUpAction, recapRetry: true });
    expect(byTestId('chat-recap-line')?.textContent).toContain('요약을 만들지 못했습니다 · 연결 끊김');
    act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === '다시 만들기')!.click());
    expect(onWrapUpAction).toHaveBeenCalledWith({ kind: 'recap-retry', turnId: 'turn-plan' });
  });

  it('keeps its reason and offers no button that could only fail once the session is gone', () => {
    render(failed, { onWrapUpAction: vi.fn() });
    expect(byTestId('chat-recap-line')?.textContent).toContain('요약을 만들지 못했습니다 · 연결 끊김');
    expect(buttons()).not.toContain('다시 만들기');
  });
});

describe('a recap written while the AI waited, once the turn ran on', () => {
  it.each(['bubble', 'cli'] as const)('stays above what came after the answer and says it was answered (%s)', (skin) => {
    render(waitingStory('ko', { answered: true }), { skin, onFocusDecision: () => true });
    const page = container.textContent ?? '';
    expect(byTestId('chat-recap-card')?.textContent).toContain('답을 기다렸던 턴');
    expect(page.indexOf('답을 기다렸던 턴')).toBeLessThan(page.indexOf('음수는 괄호로 표시하기로 하고'));
    expect(byTestId('chat-recap-answer')).toBeNull();
  });
});

describe('a suggest_task call the host said no to', () => {
  const REASON = 'A turn can suggest 8 tasks. Stop suggesting; this one was not kept.';
  /** A cart turn with one more call. `tool`: as the AI names it; `answer`: the host's. */
  const withCall = (tool: string, server?: string, answer = `{"ok":false,"code":"cap","error":"${REASON}"}`): WrapUpFixture => {
    const fixture = cartStory('ko', 'codex');
    const row = (sequence: number, kind: 'tool-call' | 'tool-result', text: string, phase: 'call' | 'result', status: 'running' | 'failed'): DaemonTranscriptItem => ({
      id: `refused-${String(sequence)}`, sessionId: WRAP_SESSION, sequence, turnId: 'turn-cart', kind, text, isDelta: false, isSensitive: false, createdAt: fixture.turns[0]!.finishedAt!,
      payload: { v: 1, type: 'tool', callId: 'refused-call', name: tool, category: 'mcp', phase, status, ...(server ? { server } : {}) },
    });
    const head = `${server ?? 'x'}/${tool}`;
    const input = JSON.stringify({ title: '점검 9', rationale: '실검증용', prompt: '답해 줘.' });
    return { ...fixture, items: [...fixture.items, row(900, 'tool-call', `${head}: inProgress\n${input}`, 'call', 'running'), row(901, 'tool-result', `${head}: failed\n${answer}`, 'result', 'failed')] };
  };
  const openRun = (): void => {
    for (const header of [...container.querySelectorAll<HTMLButtonElement>('.chat-run__header')]) act(() => header.click());
  };

  it('reads calm in the bubble skin: no red, the reason on the row, a quiet count on the folded run', () => {
    render(withCall(SUGGEST_TASK_TOOL, SUGGEST_TASK_SERVER));
    expect(container.querySelector('.chat-run__note')?.textContent).toBe('제안 1개 받지 않음');
    expect(container.querySelector('.chat-run__problems')).toBeNull();
    openRun();
    const row = container.querySelector<HTMLElement>('.chat-tool[data-status="refused"]')!;
    expect(row.textContent).toContain('제안 받지 않음');
    expect(row.textContent).toContain('점검 9');
    expect(row.textContent).toContain('한 턴에 8개까지만 받습니다');
    expect(row.textContent).not.toContain(REASON);
    expect(row.textContent).not.toContain('도구 실패');
    expect(row.querySelector('[data-tone="danger"]')).toBeNull();
  });

  it('reads calm in the CLI skin', () => {
    render(withCall(SUGGEST_TASK_TOOL, SUGGEST_TASK_SERVER), { skin: 'cli' });
    const row = container.querySelector<HTMLElement>('.chat-cli-tool[data-status="refused"]')!;
    expect(row.textContent).toContain('제안 받지 않음 · 한 턴에 8개까지만 받습니다');
    expect(row.textContent).not.toContain(REASON);
    expect(row.querySelector('.chat-cli-glyph')?.getAttribute('data-tone')).toBe('muted');
    expect(row.querySelector('.chat-cli-result')?.getAttribute('data-tone')).toBe('muted');
  });

  it.each([
    ['no code', `{"ok":false,"error":"${REASON}"}`],
    ['a code this client does not know', `{"ok":false,"code":"something-new","error":"${REASON}"}`],
  ])('falls back to a generic line on %s, never to what the host told the AI', (_name, answer) => {
    render(withCall(SUGGEST_TASK_TOOL, SUGGEST_TASK_SERVER, answer));
    openRun();
    const row = container.querySelector<HTMLElement>('.chat-tool[data-status="refused"]')!;
    expect(row.textContent).toContain('앱이 받지 않았습니다');
    expect(row.textContent).not.toContain(REASON);
  });

  it('has a short line of its own for each of the host’s codes, in both languages', () => {
    const lines = (locale: 'ko' | 'en'): readonly string[] => [...SUGGEST_TASK_REFUSALS, 'unknown' as const].map((code) => chatCopy(locale).refusedReason(code));
    for (const locale of ['ko', 'en'] as const) {
      expect(new Set(lines(locale)).size).toBe(SUGGEST_TASK_REFUSALS.length + 1);
      for (const line of lines(locale)) {
        expect(line.length).toBeLessThan(45);
        expect(line).not.toMatch(/suggest_task|Stop suggesting|Do not/u);
      }
    }
    expect(lines('ko').join(' ')).toMatch(/^[^A-Za-z]*(AI[^A-Za-z]*)*$/u);
  });

  it.each([
    ['claude', 'bubble'], ['codex', 'bubble'], ['claude', 'cli'], ['codex', 'cli'],
  ] as const)('opened, the reason stays first and the raw answer reads as what the AI was told (%s, %s)', (provider, skin) => {
    render(refusedCallStory('ko', provider), { skin });
    if (skin === 'bubble') openRun();
    const row = container.querySelector<HTMLElement>(`${skin === 'bubble' ? '.chat-tool' : '.chat-cli-tool'}[data-status="refused"]`)!;
    act(() => row.querySelector<HTMLButtonElement>('.chat-tool__line, .chat-cli-tool__call')!.click());
    const caption = row.querySelector<HTMLElement>('.chat-output__caption');
    expect(caption?.textContent).toBe('AI에게 보낸 답');
    const answer = caption!.parentElement!.querySelector('pre')!;
    expect(answer.getAttribute('aria-label')).toBe('AI에게 보낸 답');
    // Word for word: the audit trail is neither translated nor rewritten.
    expect(answer.textContent).toContain('{"ok":false,"code":"cap","error":"A turn can suggest 8 tasks. Stop suggesting; this one was not kept."}');
    expect(answer.closest('.chat-output')?.getAttribute('data-tone')).toBeNull();
    const text = row.textContent ?? '';
    expect(text.indexOf('한 턴에 8개까지만 받습니다')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('한 턴에 8개까지만 받습니다')).toBeLessThan(text.indexOf('AI에게 보낸 답'));
    expect(text.indexOf('AI에게 보낸 답')).toBeLessThan(text.indexOf('Stop suggesting'));
  });

  it('says so in English too', () => {
    expect(chatCopy('en').refusedAnswer).toBe('What the AI was told');
  });

  it('leaves a foreign tool of that name an ordinary failed row', () => {
    render(withCall(SUGGEST_TASK_TOOL, 'someone_else'));
    expect(container.querySelector('.chat-run__problems')?.textContent).toBe('1개 실패');
    openRun();
    const row = container.querySelector<HTMLElement>('.chat-tool[data-status="failed"]')!;
    expect(row.textContent).toContain('도구 실패');
    expect(container.querySelector('.chat-tool[data-status="refused"]')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('.chat-tool[data-status="failed"] .chat-tool__line')!.click());
    expect(container.querySelector('.chat-output__caption'), 'an ordinary tool row keeps its plain output').toBeNull();
  });
});

describe('모두 시작', () => {
  const task = (id: string, title: string, worktree?: boolean): SuggestedTaskState => ({ id, title, rationale: 'Why.', prompt: 'Do it.', outcome: { kind: 'open' }, ...(worktree ? { worktree } : {}) });
  const onStart = vi.fn();
  let opened = 0;
  const sheet = (tasks: readonly SuggestedTaskState[], phone = false, worktrees = !phone, again = false, repository?: boolean): void => {
    onStart.mockClear();
    if (!again) opened += 1;
    act(() => root.render(
      <AppI18nProvider locale="ko" languages={['ko']}>
        <ChatProvider skin="bubble" locale="ko">
          <TaskStartAllDialog key={opened} open onOpenChange={() => undefined} tasks={tasks} settings="Claude" folder="cart-kit" phone={phone} worktrees={worktrees}
            {...(repository !== undefined ? { repository } : {})} onStart={onStart} />
        </ChatProvider>
      </AppI18nProvider>,
    ));
  };
  const radios = (id: string): HTMLInputElement[] => [...document.querySelectorAll<HTMLInputElement>(`[data-testid="${id}"]`)];
  const submit = (): void => act(() => document.querySelector<HTMLButtonElement>('[data-testid="task-start-all-submit"]')!.click());

  it('defaults every task to its own new worktree on the desktop when two or more start together', () => {
    sheet([task('one', 'Fix the cart'), task('two', 'Fix the tax', true)]);
    expect(radios('task-start-all-worktree').map((radio) => radio.checked)).toEqual([true, true]);
    expect(document.querySelector('[data-testid="task-start-all-phone"]')).toBeNull();
    submit();
    expect(onStart).toHaveBeenCalledWith([
      { taskId: 'one', where: { kind: 'new-worktree', branch: 'suggest/fix-the-cart' } },
      { taskId: 'two', where: { kind: 'new-worktree', branch: 'suggest/fix-the-tax' } },
    ]);
  });

  it('lets each task go back to this folder', () => {
    sheet([task('one', 'Fix the cart'), task('two', 'Fix the tax')]);
    act(() => radios('task-start-all-here')[0]!.click());
    submit();
    expect(onStart).toHaveBeenCalledWith([
      { taskId: 'one', where: { kind: 'this-folder' } },
      { taskId: 'two', where: { kind: 'new-worktree', branch: 'suggest/fix-the-tax' } },
    ]);
  });

  it('keeps a single task to its own rule: a worktree only if the AI recommended one', () => {
    sheet([task('one', 'Fix the cart')]);
    expect(radios('task-start-all-here')[0]!.checked).toBe(true);
    sheet([task('one', 'Fix the cart', true)]);
    expect(radios('task-start-all-worktree')[0]!.checked).toBe(true);
  });

  it('stays in this folder on the phone, and says starting together shares it', () => {
    sheet([task('one', 'Fix the cart'), task('two', 'Fix the tax', true)], true, false, false, true);
    expect(radios('task-start-all-worktree')).toHaveLength(0);
    expect(document.querySelector('[data-testid="task-start-all-phone"]')?.textContent).toBe('이 폴더 (cart-kit)에서 시작합니다. 함께 시작하면 같은 폴더를 씁니다. 새 워크트리는 데스크톱에서 고를 수 있습니다.');
    submit();
    expect(onStart).toHaveBeenCalledWith([{ taskId: 'one', where: { kind: 'this-folder' } }, { taskId: 'two', where: { kind: 'this-folder' } }]);
  });

  it.each([
    ['says the folder is no repository', false],
    ['cannot tell', undefined],
  ])('claims nothing about the desktop on the phone when the host %s', (_name, repository) => {
    sheet([task('one', 'Fix the cart'), task('two', 'Fix the tax', true)], true, false, false, repository);
    expect(document.querySelector('[data-testid="task-start-all-phone"]')?.textContent).toBe('이 폴더 (cart-kit)에서 시작합니다. 함께 시작하면 같은 폴더를 씁니다.');
  });

  it('stays in this folder on the desktop too where no worktree can be made, and says starting together shares it', () => {
    sheet([task('one', 'Fix the cart'), task('two', 'Fix the tax', true)], false, false, false, false);
    expect(radios('task-start-all-worktree')).toHaveLength(0);
    expect(radios('task-start-all-here')).toHaveLength(0);
    expect(document.querySelector('[data-testid="task-start-all-task"]')?.textContent).toContain('이 폴더 (cart-kit)');
    // The cause, beside what it means.
    expect(document.querySelector('[data-testid="task-start-all-shared"]')?.textContent).toBe('이 폴더 (cart-kit)에서 시작합니다. 함께 시작하면 같은 폴더를 씁니다. Git 저장소가 아니라 새 워크트리를 만들 수 없습니다.');
    // The phone's last sentence would be false here: this is the desktop.
    expect(document.querySelector('[data-testid="task-start-all-phone"]')).toBeNull();
    submit();
    expect(onStart).toHaveBeenCalledWith([{ taskId: 'one', where: { kind: 'this-folder' } }, { taskId: 'two', where: { kind: 'this-folder' } }]);
  });

  it('gives no cause on the desktop that Git has not said', () => {
    sheet([task('one', 'Fix the cart'), task('two', 'Fix the tax')], false, false);
    expect(document.querySelector('[data-testid="task-start-all-shared"]')?.textContent).toBe('이 폴더 (cart-kit)에서 시작합니다. 함께 시작하면 같은 폴더를 씁니다.');
  });

  it('says the cause in English too', () => {
    expect(chatCopy('en').taskSuggestions.confirm.notRepository).toBe('It is not a Git repository, so it cannot have a new worktree.');
  });

  it('follows the answer about the folder when it arrives with the sheet open', () => {
    const tasks = [task('one', 'Fix the cart'), task('two', 'Fix the tax')];
    sheet(tasks);
    expect(radios('task-start-all-worktree').map((radio) => radio.checked)).toEqual([true, true]);
    sheet(tasks, false, false, true);
    submit();
    expect(onStart).toHaveBeenCalledWith([{ taskId: 'one', where: { kind: 'this-folder' } }, { taskId: 'two', where: { kind: 'this-folder' } }]);
  });

  it('says nothing of sharing to a single task on the phone', () => {
    sheet([task('one', 'Fix the cart')], true, false, false, true);
    expect(document.querySelector('[data-testid="task-start-all-phone"]')?.textContent).toBe('이 폴더 (cart-kit)에서 시작합니다. 새 워크트리는 데스크톱에서 고를 수 있습니다.');
  });
});

describe('the suggested-task card', () => {
  it.each(['bubble', 'cli'] as const)('on the phone, says the desktop can pick a worktree only for a folder the host says is a repository (%s)', (skin) => {
    const note = (repository?: boolean): HTMLElement | null => {
      render(cartStory('ko', 'claude', 'mixed'), {
        skin, onWrapUpAction: vi.fn(), taskStart: { ...TASK_START, phone: true, worktrees: false, ...(repository !== undefined ? { repository } : {}) },
      });
      return byTestId('chat-task-worktree-desktop');
    };
    expect(note(true)?.textContent).toContain('새 워크트리는 데스크톱에서 고를 수 있습니다');
    expect(note(false)).toBeNull();
    expect(note()).toBeNull();
  });

  it('starts with one click a task the AI wanted in a worktree where none can be made: the form would have nothing to add', () => {
    const fixture = cartStory('ko', 'claude', 'mixed');
    const advised = (): HTMLElement => byTestId('chat-task-worktree')!.closest<HTMLElement>('[data-testid="chat-task"]')!;
    render(fixture, { onWrapUpAction: vi.fn() });
    expect(advised().querySelector('[data-action="task-start"]')).toBeNull();
    expect(advised().querySelector('[data-action="task-start-custom"]')).not.toBeNull();
    render(fixture, { onWrapUpAction: vi.fn(), taskStart: { ...TASK_START, worktrees: false } });
    expect(advised().querySelector('[data-action="task-start"]')).not.toBeNull();
  });

  it('reads as a record where nothing can be pressed: no line about what one click starts', () => {
    render(cartStory('ko', 'claude'));
    expect(byTestId('chat-task-card')).not.toBeNull();
    expect(byTestId('chat-task-defaults')).toBeNull();
    expect(byTestId('chat-task-start-all')).toBeNull();
    expect(container.querySelector('[data-action]')).toBeNull();
  });

  it('shows a command in flight on an open task and takes its button away', () => {
    const onWrapUpAction = vi.fn<(action: ChatWrapUpAction) => void>();
    render(cartStory('ko', 'claude'), { onWrapUpAction, wrapUpPending: new Map([['task-claude-1', 'starting'], ['task-claude-2', 'sending']]) });
    const [first, second] = [...container.querySelectorAll('[data-testid="chat-task"]')];
    expect(first?.getAttribute('data-outcome')).toBe('starting');
    expect(first?.querySelector('[data-action="task-start"]')).toBeNull();
    expect(second?.getAttribute('data-outcome')).toBe('sending');
    // Two of three are on their way: 모두 시작 counts what is left, and one left is no batch.
    expect(byTestId('chat-task-start-all')).toBeNull();
  });

  it('lets what the host confirmed win over a command still in flight', () => {
    render(cartStory('ko', 'claude', 'states'), { onWrapUpAction: vi.fn(), wrapUpPending: new Map([['task-claude-1', 'starting']]) });
    expect(container.querySelector('[data-testid="chat-task"]')?.getAttribute('data-outcome')).toBe('started');
  });

  it('shows the same in flight over a failed start being repeated', () => {
    render(cartStory('ko', 'claude', 'retry'), { onWrapUpAction: vi.fn(), wrapUpPending: new Map([['task-claude-1', 'starting']]) });
    expect(container.querySelector('[data-testid="chat-task"]')?.getAttribute('data-outcome')).toBe('starting');
  });
});
