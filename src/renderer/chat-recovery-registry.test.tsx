// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { createDaemonCommand } from '../shared/daemon-protocol';
import type { ChatSessionState, ChatStateResult, ChatStateScope, ChatStateSnapshot, ChatStateWrite } from '../shared/chat-state';
import type { ChatStateAccess } from './chat-recovery';
import { retainChatRecovery, sharedChatRecovery } from './chat-recovery-registry';
import { useChatRecovery } from './use-chat-recovery';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scope = { projectId: 'project-1', sessionId: 'session-1' };
const NOW = '2026-10-27T08:00:00.000Z';

function store(initial: ChatSessionState = { draft: { text: '' } }) {
  let stored: ChatStateSnapshot = { version: 1, scope, revision: 1, state: initial, updatedAt: NOW };
  const access: ChatStateAccess = {
    chatStateRead: vi.fn(async (): Promise<ChatStateResult> => ({ ok: true, snapshot: structuredClone(stored) })),
    chatStateWrite: vi.fn(async (_scope: ChatStateScope, request: ChatStateWrite): Promise<ChatStateResult> => {
      if (request.expectedRevision !== stored.revision) return { ok: false, error: 'stale', revision: stored.revision, message: 'conflict' };
      stored = structuredClone({ ...stored, revision: stored.revision + 1, state: request.state });
      return { ok: true, snapshot: stored };
    }),
  };
  return { access, stored: () => stored };
}

function submit(id: string) {
  return createDaemonCommand({ type: 'agent.submit', commandId: id, idempotencyKey: id,
    principal: { kind: 'desktop', id: 'desktop-user' }, expectedRevision: 1, issuedAt: NOW,
    payload: { sessionId: scope.sessionId, prompt: 'hello' } });
}

describe('shared chat recovery', () => {
  it('gives every view of one conversation the same controller, per storage', () => {
    const one = store();
    const other = store();
    const first = sharedChatRecovery(scope, one.access);
    expect(sharedChatRecovery({ ...scope }, one.access)).toBe(first);
    expect(sharedChatRecovery(scope, other.access)).not.toBe(first);
    expect(sharedChatRecovery({ ...scope, kind: 'draft' }, one.access)).not.toBe(first);
  });

  it('lets two views edit one draft with no stale conflict', async () => {
    const { access, stored } = store();
    const seen: string[][] = [];
    function View({ label }: { readonly label: string }) {
      const { controller, view } = useChatRecovery(scope.projectId, scope.sessionId, access);
      seen.push([label, view.status, view.draft.text]);
      return <button data-testid={label} onClick={() => controller?.updateDraft({ text: `${label} typed` })} />;
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => { root.render(<><View label="tab" /><View label="terminal" /></>); });
    const button = (label: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${label}"]`)!;
    await act(async () => { button('tab').click(); });
    await act(async () => { button('terminal').click(); });
    await act(async () => { await sharedChatRecovery(scope, access).flush(); });
    expect(stored().state.draft.text).toBe('terminal typed');
    expect(sharedChatRecovery(scope, access).getSnapshot().status).toBe('ready');
    expect(seen.filter(([label]) => label === 'tab').at(-1)).toEqual(['tab', 'ready', 'terminal typed']);
    expect(access.chatStateRead).toHaveBeenCalledTimes(1);
    expect(access.chatStateWrite).toHaveBeenCalledTimes(2);
    await act(async () => { root.unmount(); });
    host.remove();
  });

  it('refuses a second send from another view while the first is pending', async () => {
    const { access } = store({ draft: { text: 'hello' } });
    const controller = sharedChatRecovery(scope, access);
    const release = retainChatRecovery(controller)!;
    await controller.load();
    const [first, second] = await Promise.all([
      sharedChatRecovery(scope, access).prepare(submit('c-1')),
      sharedChatRecovery(scope, access).prepare(submit('c-2')),
    ]);
    expect(first).toEqual({ ok: true });
    expect(second).toMatchObject({ ok: false, deliveryUncertain: true });
    await controller.complete('c-1', true);
    expect(controller.getSnapshot().draft.text).toBe('');
    release();
  });

  it('forgets a controller only after its writes finish and no view holds it again', async () => {
    const { access } = store();
    const controller = sharedChatRecovery(scope, access);
    const release = retainChatRecovery(controller)!;
    await controller.load();
    controller.updateDraft({ text: 'unsaved' });
    release();
    // Held again before the pending write finished: the live draft stays.
    const again = retainChatRecovery(controller)!;
    await controller.flush();
    await Promise.resolve();
    expect(sharedChatRecovery(scope, access)).toBe(controller);
    again();
    await controller.flush();
    await Promise.resolve();
    const fresh = sharedChatRecovery(scope, access);
    expect(fresh).not.toBe(controller);
    await fresh.load();
    expect(fresh.getSnapshot().draft.text).toBe('unsaved');
  });

  it('puts back a controller looked up while rendering but forgotten before its view committed', async () => {
    const { access } = store();
    const looked = sharedChatRecovery(scope, access);
    const early = retainChatRecovery(looked)!;
    early();
    await looked.flush();
    await Promise.resolve();
    const release = retainChatRecovery(looked)!;
    expect(sharedChatRecovery(scope, access)).toBe(looked);
    release();
  });

  it('an older release never forgets an entry that was held and edited again meanwhile', async () => {
    const { access, stored } = store();
    const controller = sharedChatRecovery(scope, access);
    const first = retainChatRecovery(controller)!;
    await controller.load();
    // The first release's flush settles only when the test says so.
    let settleFirst!: () => void;
    vi.spyOn(controller, 'flush').mockImplementationOnce(() => new Promise<void>((resolve) => { settleFirst = resolve; }));
    // The newer edit's write stays in flight.
    let finishWrite!: () => void;
    const write = vi.mocked(access.chatStateWrite).getMockImplementation()!;
    vi.mocked(access.chatStateWrite).mockImplementationOnce((target, request) => new Promise((resolve) => {
      finishWrite = () => resolve(write(target, request));
    }));
    first();
    const second = retainChatRecovery(controller)!;
    controller.updateDraft({ text: 'newer text' });
    second();
    settleFirst();
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    // The first release saw no holders, but it is not the latest release: the live controller stays.
    expect(sharedChatRecovery(scope, access)).toBe(controller);
    finishWrite();
    await controller.flush();
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    expect((await stored()).state.draft.text).toBe('newer text');
    expect(sharedChatRecovery(scope, access)).not.toBe(controller);
  });

  it('says a controller was replaced instead of holding a second live copy', async () => {
    const { access } = store();
    const stale = sharedChatRecovery(scope, access);
    const held = retainChatRecovery(stale)!;
    held();
    await stale.flush();
    await Promise.resolve();
    const replacement = sharedChatRecovery(scope, access);
    expect(replacement).not.toBe(stale);
    expect(retainChatRecovery(stale)).toBeNull();
    const release = retainChatRecovery(replacement)!;
    expect(sharedChatRecovery(scope, access)).toBe(replacement);
    release();
  });

});
