// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LongRunDecisionsProvider, RECOMMENDED_LONG_RUN_DECISIONS } from './chat/long-run/long-run-decisions';
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

function box(props: Partial<StructuredAgentComposerProps> = {}, enter: 'steer' | 'queue' = 'steer'): { readonly send: Sent; readonly interrupt: Sent } {
  const send = sender();
  const interrupt = sender();
  act(() => root.render(
    <AppI18nProvider locale="ko" languages={['ko']}>
      <LongRunDecisionsProvider value={{ ...RECOMMENDED_LONG_RUN_DECISIONS, enter }}>
        <StructuredAgentComposer busy onSend={send} onInterruptAndSend={interrupt} {...props} />
      </LongRunDecisionsProvider>
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
    expect(input().getAttribute('placeholder')).toBe('이 턴에 끼워넣을 지시를 입력하세요 (Esc로 중단)');
    type('그 파일만');
    expect(byId('structured-agent-send')?.getAttribute('aria-label')).toBe('이 턴에 끼워넣기');
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
    expect(input().getAttribute('placeholder')).toBe('이 턴에 끼워넣을 지시를 입력하세요');
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

  it('with the other D1 option, Enter queues and a button puts it in', async () => {
    const running = steer();
    const { send } = box({ steer: running }, 'queue');
    type('다음에');
    await press({ key: 'Enter' });
    expect(send).toHaveBeenCalledWith('다음에');
    expect(running.onSteer).not.toHaveBeenCalled();
    type('지금');
    await click(byId('structured-agent-steer')!);
    expect(running.onSteer).toHaveBeenCalledWith('지금');
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

  it('promises Codex drops text only when it is writing: a tool holds a message on either AI', () => {
    const on = (behind: 'tool' | 'text'): void => {
      box({ providerId: 'codex', steer: steer({ messages: [{ id: 'm', text: '그 파일만', state: 'on-its-way', sentAt: '2026-11-01T05:50:00.000Z', behind }] }) });
    };
    on('tool');
    expect(byId('chat-steer-tray')?.textContent).toContain('지금 도구가 끝나면');
    expect(byId('chat-steer-tray')?.textContent).not.toContain('버리고');
    on('text');
    expect(byId('chat-steer-tray')?.textContent).toContain('쓰던 글은 버리고 다시 씁니다');
  });

  it('never says a held message arrived', () => {
    box({ steer: steer({ messages: [{ id: 'm', text: '그 파일만', state: 'behind-approval', sentAt: '2026-11-01T05:50:00.000Z' }] }) });
    const tray = byId('chat-steer-tray');
    expect(tray?.textContent).toContain('승인 뒤에 전달됩니다');
    expect(tray?.textContent).not.toContain('들어갔습니다');
  });
});
