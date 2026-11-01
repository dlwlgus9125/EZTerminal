// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppI18nProvider } from './i18n';
import { clearSessionViewStates } from './session-view-state';
import { StructuredAgentComposer, type ComposerSteer, type StructuredAgentComposerProps } from './StructuredAgentSession';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 시안 (bundle 3): what Enter does while a turn runs. Without the long-run prop the box must stay exactly today's. */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  clearSessionViewStates();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const ok = async (): Promise<{ readonly ok: true }> => ({ ok: true });
type Sent = StructuredAgentComposerProps['onSend'] & ReturnType<typeof vi.fn>;
const sender = (): Sent => vi.fn(ok) as unknown as Sent;

function box(props: Partial<StructuredAgentComposerProps> = {}): { readonly send: Sent; readonly interrupt: Sent } {
  const send = sender();
  const interrupt = sender();
  act(() => root.render(
    <AppI18nProvider locale="ko" languages={['ko']}>
      <StructuredAgentComposer busy onSend={send} onInterruptAndSend={interrupt} {...props} />
    </AppI18nProvider>,
  ));
  return { send, interrupt };
}

const byId = <T extends HTMLElement = HTMLElement>(id: string): T | null => container.querySelector<T>(`[data-testid="${id}"]`);
const input = (): HTMLTextAreaElement => byId<HTMLTextAreaElement>('structured-agent-composer-input')!;

function type(text: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), text);
    input().setSelectionRange(text.length, text.length);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function press(init: KeyboardEventInit): Promise<void> {
  await act(async () => {
    input().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    await Promise.resolve();
  });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => { element.click(); await Promise.resolve(); });
}

const steer = (extra: Partial<Omit<ComposerSteer, 'onSteer'>> = {}): ComposerSteer & { readonly onSteer: Sent } => ({ running: true, ...extra, onSteer: sender() });

describe('the busy message box', () => {
  it('without the long-run prop stays as it is: Enter queues', async () => {
    const { send } = box();
    expect(input().getAttribute('placeholder')).toBe('다음에 보낼 메시지를 입력하세요 (Esc로 중단)');
    type('다음에');
    expect(byId('structured-agent-send')?.getAttribute('data-kind')).toBe('queue');
    expect(byId('structured-agent-interrupt-send')?.textContent).toContain('중단 후 보내기');
    expect(byId('structured-agent-interrupt-send')?.classList.contains('chat-composer__interrupt')).toBe(false);
    expect(input().closest('form')?.hasAttribute('data-long-run')).toBe(false);
    await press({ key: 'Enter' });
    expect(send).toHaveBeenCalledWith('다음에');
  });

  it('with it, Enter puts the message into the running turn and nothing else', async () => {
    const running = steer();
    const { send, interrupt } = box({ steer: running });
    expect(input().getAttribute('placeholder')).toBe('실행 중에 보낼 지시를 입력하세요 (Esc로 중단)');
    type('그 파일만');
    expect(byId('structured-agent-send')?.getAttribute('aria-label')).toBe('실행 중에 끼워넣기');
    await press({ key: 'Enter' });
    expect(running.onSteer).toHaveBeenCalledWith('그 파일만');
    expect(send).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
    expect(input().value).toBe('');
  });

  it('never sends in the middle of a Korean composition', async () => {
    const running = steer();
    box({ steer: running });
    type('그 파일');
    await press({ key: 'Enter', isComposing: true, keyCode: 229 });
    expect(running.onSteer).not.toHaveBeenCalled();
    expect(input().value).toBe('그 파일');
  });

  it('keeps 끊고 보내기 as the one way to stop the turn', async () => {
    const running = steer();
    const { interrupt } = box({ steer: running });
    type('멈춰');
    const button = byId('structured-agent-interrupt-send')!;
    expect(button.textContent).toContain('끊고 보내기');
    await click(button);
    expect(interrupt).toHaveBeenCalledWith('멈춰');
    expect(running.onSteer).not.toHaveBeenCalled();
  });

  it('on the phone the send button does what Enter does, and Enter stays a new line', async () => {
    const running = steer();
    box({ steer: running, variant: 'mobile' });
    expect(input().getAttribute('placeholder')).toBe('실행 중에 보낼 지시를 입력하세요');
    type('그 파일만');
    await press({ key: 'Enter' });
    expect(running.onSteer).not.toHaveBeenCalled();
    await click(byId('structured-agent-send')!);
    expect(running.onSteer).toHaveBeenCalledWith('그 파일만');
  });

  it('once no turn runs, Enter is plain sending again', async () => {
    const running = steer({ running: false });
    const { send } = box({ steer: running, busy: false });
    type('이제');
    await press({ key: 'Enter' });
    expect(send).toHaveBeenCalledWith('이제');
    expect(running.onSteer).not.toHaveBeenCalled();
  });

  it('brings a failed message back after what is typed, without sending it', async () => {
    const onToBox = vi.fn();
    const message = { id: 'm', text: '그 파일만', state: 'failed' as const, sentAt: '2026-11-01T05:50:00.000Z', failure: 'disconnected' as const };
    const running = steer({ messages: [message], onToBox });
    box({ steer: running });
    type('먼저 쓴 글');
    expect(byId('chat-steer-to-queue')).toBeNull();
    await click(byId('chat-steer-to-box')!);
    expect(input().value).toBe('먼저 쓴 글\n\n그 파일만');
    expect(onToBox).toHaveBeenCalledWith(message);
    expect(running.onSteer).not.toHaveBeenCalled();
  });

  it('promises Claude only what it does: into this turn after a tool, a new turn after text', () => {
    const on = (behind: 'tool' | 'text'): void => {
      box({ providerId: 'claude', steer: steer({ messages: [{ id: 'm', text: '그 파일만', state: 'on-its-way', sentAt: '2026-11-01T05:50:00.000Z', behind }] }) });
    };
    on('tool');
    expect(byId('chat-steer-tray')?.textContent).toContain('지금 도구가 끝나면 이 턴에');
    on('text');
    expect(byId('chat-steer-tray')?.textContent).toContain('지금 글이 끝나면 새 턴으로 전달');
    expect(byId('chat-steer-tray')?.textContent).not.toContain('버리고');
  });

  it('promises Codex drops text only when it is writing: a tool holds a message on either AI', () => {
    const on = (behind: 'tool' | 'text'): void => {
      box({ providerId: 'codex', steer: steer({ messages: [{ id: 'm', text: '그 파일만', state: 'on-its-way', sentAt: '2026-11-01T05:50:00.000Z', behind }] }) });
    };
    on('tool');
    expect(byId('chat-steer-tray')?.textContent).toContain('지금 도구가 끝나면');
    expect(byId('chat-steer-tray')?.textContent).not.toContain('버리고');
    on('text');
    expect(byId('chat-steer-tray')?.textContent).toContain('쓰던 글은 버리고 이 턴에서 다시 씁니다');
  });

  describe('only plain text goes into a running turn', () => {
    const attachment = { id: 'a', name: 'notes.txt', mimeType: 'text/plain', kind: 'text' as const, data: 'x' };
    const cases = [
      ['an attachment', { draftState: { text: '이것도 봐 줘', attachments: [attachment] }, supportsMessageContext: true }],
      ['a reply', { draftState: { text: '이 부분 말이야', replyTo: { messageId: 'm', text: '앞 글' } }, supportsMessageContext: true }],
      ['a skill', { draftState: { text: '/deploy 해 줘', skills: [{ providerId: 'claude' as const, id: 's', invocation: '/deploy', name: 'deploy' }] } }],
      ['a / command', { draftState: { text: '/compact' } }],
    ] as const;

    for (const [name, props] of cases) {
      it(`${name} goes to the queue as it does today, and the box says so first`, async () => {
        const running = steer();
        const { send } = box({ steer: running, statusHint: 'Enter 끼워넣기', ...props });
        expect(byId('structured-agent-send')?.getAttribute('data-kind')).toBe('queue');
        expect(byId('structured-agent-send')?.getAttribute('aria-label')).toBe('메시지 대기열 추가');
        expect(byId('structured-agent-composer-hint')?.textContent).toBe('첨부·답장·/ 명령은 아직 끼워넣을 수 없어 대기열에 넣습니다.');
        // A / draft has the completion list open, and that list takes Enter: the send button is the same path.
        if (props.draftState.text.startsWith('/compact')) await click(byId('structured-agent-send')!);
        else await press({ key: 'Enter' });
        expect(running.onSteer).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledTimes(1);
      });
    }

    it('goes back to the running turn as soon as the draft is plain text', () => {
      box({ steer: steer(), statusHint: 'Enter 끼워넣기' });
      type('/compact');
      expect(byId('structured-agent-send')?.getAttribute('data-kind')).toBe('queue');
      type('그 파일만');
      expect(byId('structured-agent-send')?.getAttribute('data-kind')).toBe('steer');
      expect(byId('structured-agent-composer-hint')?.textContent).toBe('Enter 끼워넣기');
    });

    it('on the phone the send button takes the same way', async () => {
      const running = steer();
      const { send } = box({ steer: running, variant: 'mobile', draftState: { text: '/compact' } });
      await click(byId('structured-agent-send')!);
      expect(running.onSteer).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  it('describes the box by what Enter does and what sending costs, the sentence shown under it', () => {
    box({ steer: steer(), statusHint: 'Enter 끼워넣기 · 쓰던 글은 버리고 다시 씁니다' });
    const ids = input().getAttribute('aria-describedby')?.split(' ') ?? [];
    expect(ids.length).toBe(1);
    const described = container.querySelector(`[id="${ids[0]!}"]`);
    expect(described?.textContent).toBe('Enter 끼워넣기 · 쓰던 글은 버리고 다시 씁니다');
    expect(described).toBe(byId('structured-agent-composer-hint'));
  });

  it('adds no description to a box without the long-run prop', () => {
    box({ statusHint: '지금 바꾼 설정은 다음 요청부터 적용됩니다.' });
    expect(input().hasAttribute('aria-describedby')).toBe(false);
    expect(byId('structured-agent-composer-hint')?.hasAttribute('id')).toBe(false);
  });

  it('announces a move to the queue once, with its reason', () => {
    const running = steer();
    box({ steer: running });
    expect(byId('chat-steer-announce')?.textContent).toBe('');
    const queued = [{ turnId: 'turn-a', revision: 1, text: '그 파일만', fellBack: 'review-turn' as const }];
    box({ steer: running, queueItems: queued });
    expect(byId('chat-steer-announce')?.textContent).toBe('검토 턴에는 끼워넣을 수 없어 대기열에 넣었습니다.');
    const once = byId('chat-steer-announce')?.textContent;
    box({ steer: running, queueItems: queued });
    expect(byId('chat-steer-announce')?.textContent).toBe(once);
  });

  it('says a message was delivered only when its row shows, never because it left the list', () => {
    const held = { id: 'm', text: '그 파일만', state: 'on-its-way' as const, sentAt: '2026-11-01T05:50:00.000Z', behind: 'tool' as const };
    const running = steer({ messages: [held] });
    box({ steer: running });
    box({ steer: { ...running, messages: [] } });
    expect(byId('chat-steer-tray')).toBeNull();
    expect(byId('chat-steer-announce')?.textContent).toBe('');
    box({ steer: { ...running, messages: [held] } });
    box({ steer: { ...running, messages: [], landedRow: 'row-1' } });
    expect(byId('chat-steer-announce')?.textContent).toBe('메시지가 전달됐습니다.');
    // A landed one is a transcript row by now, not a line above the box.
    expect(byId('chat-steer-tray')).toBeNull();
  });

  it('says nothing of old landed rows a transcript brings in as it loads', () => {
    const running = steer();
    box({ steer: running });
    box({ steer: { ...running, landedRow: 'row-old' } });
    expect(byId('chat-steer-announce')?.textContent).toBe('');
  });

  it('says what a stop or a limit left unknown, and offers no resend', () => {
    const at = '2026-11-01T05:50:00.000Z';
    box({ steer: steer({ messages: [{ id: 's', text: '그 파일만', state: 'unconfirmed', sentAt: at, caught: 'stop' }, { id: 'l', text: '다른 파일도', state: 'unconfirmed', sentAt: at, caught: 'limit' }] }) });
    const tray = byId('chat-steer-tray')?.textContent;
    expect(tray).toContain('턴이 멈춰 전달됐는지 확인하지 못했습니다');
    expect(tray).toContain('한도로 턴이 멈춰 전달됐는지 확인하지 못했습니다');
    expect(tray).toContain('이어서 할 때 AI가 읽을 수 있습니다');
    expect(byId('chat-steer-to-queue')).toBeNull();
  });

  it('never says a held message arrived', () => {
    box({ steer: steer({ messages: [{ id: 'm', text: '그 파일만', state: 'behind-approval', sentAt: '2026-11-01T05:50:00.000Z' }] }) });
    const tray = byId('chat-steer-tray');
    expect(tray?.textContent).toContain('승인 뒤에 전달됩니다');
    expect(tray?.textContent).not.toContain('들어갔습니다');
  });
});
