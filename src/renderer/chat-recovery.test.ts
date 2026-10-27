import { describe, expect, it, vi } from 'vitest';
import { createDaemonCommand } from '../shared/daemon-protocol';
import type { ChatSessionState, ChatStateSnapshot, ChatStateResult, ChatStateScope, ChatStateWrite } from '../shared/chat-state';
import { ChatRecoveryController, type ChatStateAccess } from './chat-recovery';

const scope = { projectId: 'project-1', sessionId: 'session-1' };
const NOW = '2026-10-13T08:00:00.000Z';
function command() {
  return createDaemonCommand({ type: 'agent.submit', commandId: 'command-1', idempotencyKey: 'same-1',
    principal: { kind: 'desktop', id: 'desktop-user' }, expectedRevision: 7, issuedAt: NOW,
    payload: { sessionId: scope.sessionId, prompt: 'Send original', context: { replyTo: { messageId: 'message-1', text: 'Quote' } } } });
}
function fixture(initial: ChatSessionState = { draft: { text: '' } }) {
  let stored: ChatStateSnapshot = { version: 1, scope, revision: 1, state: initial, updatedAt: NOW };
  const access: ChatStateAccess = {
    chatStateRead: vi.fn(async (): Promise<ChatStateResult> => ({ ok: true, snapshot: structuredClone(stored) })),
    chatStateWrite: vi.fn(async (_scope: ChatStateScope, request: ChatStateWrite): Promise<ChatStateResult> => {
      if (request.expectedRevision !== stored.revision) return { ok: false, error: 'stale', revision: stored.revision, message: 'conflict' };
      stored = structuredClone({ ...stored, revision: stored.revision + 1, state: request.state });
      return { ok: true, snapshot: stored };
    }),
  };
  return { access, stored: () => stored, controller: new ChatRecoveryController(scope, access) };
}

describe('desktop chat recovery ordering', () => {
  it('does not replace a stored draft with the empty caret event emitted during mount', async () => {
    const draft = { text: 'Saved before restart', selectionStart: 4, selectionEnd: 8, replyTo: { messageId: 'old', text: 'quote' } };
    const { controller, access, stored } = fixture({ draft });
    const loading = controller.load();
    controller.updateDraft({ text: '', selectionStart: 0, selectionEnd: 0 });
    await loading;
    expect(controller.getSnapshot().draft).toEqual(draft);
    expect(stored().state.draft).toEqual(draft);
    expect(access.chatStateWrite).not.toHaveBeenCalled();
  });
  it('restores the exact pending envelope after restart without invoking a daemon', async () => {
    const pending = { command: command(), mode: 'send' as const, recordedAt: NOW };
    const { controller, access } = fixture({ draft: { text: 'Send original', replyTo: command().payload.context!.replyTo }, pendingSubmit: pending });
    await controller.load();
    expect(controller.getSnapshot()).toMatchObject({ status: 'ready', pendingSubmit: pending });
    expect(access.chatStateWrite).not.toHaveBeenCalled();
  });

  it('preserves text entered while encrypted state is still loading', async () => {
    const { controller, access, stored } = fixture({ draft: { text: 'Older saved draft' } });
    let release!: () => void;
    vi.mocked(access.chatStateRead).mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ ok: true, snapshot: stored() }); }));
    const loading = controller.load();
    await Promise.resolve();
    controller.updateDraft({ text: 'New input during load', selectionStart: 4, selectionEnd: 4 });
    release();
    await loading;
    expect(controller.getSnapshot().draft.text).toBe('New input during load');
    expect(stored().state.draft.text).toBe('New input during load');
  });

  it('persists pending before send admission and preserves newly edited text on receipt', async () => {
    const { controller, stored } = fixture({ draft: { text: 'Send original', replyTo: command().payload.context!.replyTo } });
    await controller.load();
    expect(await controller.prepare(command())).toEqual({ ok: true });
    expect(stored().state.pendingSubmit?.command).toEqual(command());
    controller.updateDraft({ text: 'New draft during response', selectionStart: 3, selectionEnd: 3 });
    expect(await controller.complete(command().commandId, true)).toEqual({ ok: true });
    expect(stored().state).toEqual({ draft: { text: 'New draft during response', selectionStart: 3, selectionEnd: 3 } });
  });

  it('clears only the unchanged submitted composition after a confirmed receipt', async () => {
    const draft = { text: '  Send original  ', replyTo: command().payload.context!.replyTo };
    const { controller, stored } = fixture({ draft });
    await controller.load();
    await controller.prepare(command());
    await controller.complete(command().commandId, true);
    expect(stored().state).toEqual({ draft: { text: '', selectionStart: 0, selectionEnd: 0 } });
  });

  it('keeps an edit made while the message is delivered even when it only adds spaces, but not a caret move', async () => {
    const draft = { text: 'Send original', replyTo: command().payload.context!.replyTo };
    const edited = fixture({ draft });
    await edited.controller.load();
    await edited.controller.prepare(command());
    edited.controller.updateDraft({ ...draft, text: 'Send original\n\n', selectionStart: 15, selectionEnd: 15 });
    await edited.controller.complete(command().commandId, true);
    expect(edited.stored().state.draft.text).toBe('Send original\n\n');

    const moved = fixture({ draft });
    await moved.controller.load();
    await moved.controller.prepare(command());
    moved.controller.updateDraft({ ...draft, selectionStart: 2, selectionEnd: 2 });
    await moved.controller.complete(command().commandId, true);
    expect(moved.stored().state.draft.text).toBe('');
  });

  it('says the shown draft is unsaved until its autosave is stored', async () => {
    const { controller, access } = fixture({ draft: { text: '' } });
    await controller.load();
    expect(controller.getSnapshot().unsaved).toBeFalsy();
    let release!: () => void;
    const write = vi.mocked(access.chatStateWrite).getMockImplementation()!;
    vi.mocked(access.chatStateWrite).mockImplementationOnce((target, request) => new Promise((resolve) => { release = () => resolve(write(target, request)); }));
    controller.updateDraft({ text: 'typing' });
    expect(controller.getSnapshot().unsaved).toBe(true);
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(controller.getSnapshot().unsaved).toBe(true);
    release();
    await controller.flush();
    expect(controller.getSnapshot().unsaved).toBe(false);
  });

  it('reads as unsaved while a chosen draft is written after a conflict, and saved once an edit is undone', async () => {
    const { controller, access, stored } = fixture({ draft: { text: 'Stored' } });
    await controller.load();
    controller.updateDraft({ text: 'Local' });
    // Another window writes first: this draft's autosave conflicts.
    vi.mocked(access.chatStateWrite).mockResolvedValueOnce({ ok: false, error: 'stale', revision: 9, message: 'conflict' });
    await controller.flush();
    expect(controller.getSnapshot().status).toBe('conflict');
    let release!: () => void;
    const write = vi.mocked(access.chatStateWrite).getMockImplementation()!;
    vi.mocked(access.chatStateWrite).mockImplementationOnce((target, request) => new Promise((resolve) => { release = () => resolve(write(target, request)); }));
    const resolving = controller.resolveConflict('local');
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(controller.getSnapshot()).toMatchObject({ status: 'ready', unsaved: true });
    release();
    await resolving;
    expect(controller.getSnapshot().unsaved).toBe(false);
    expect(stored().state.draft.text).toBe('Local');

    controller.updateDraft({ text: 'Local!' });
    controller.updateDraft({ text: 'Local' });
    await controller.flush();
    expect(controller.getSnapshot().unsaved).toBe(false);
  });

  it('retains a rejected message as a draft but clears its resolved pending envelope', async () => {
    const { controller, stored } = fixture({ draft: { text: 'Send original' } });
    await controller.load();
    await controller.prepare(command());
    await controller.complete(command().commandId, false);
    expect(stored().state).toEqual({ draft: { text: 'Send original' } });
  });

  it('denies send admission when secure escrow fails and preserves local draft', async () => {
    const { controller, access } = fixture({ draft: { text: 'Send original' } });
    await controller.load();
    vi.mocked(access.chatStateWrite).mockResolvedValueOnce({ ok: false, error: 'unavailable', message: 'encryption unavailable' });
    expect(await controller.prepare(command())).toMatchObject({ ok: false });
    expect(controller.getSnapshot()).toMatchObject({ status: 'error', draft: { text: 'Send original' } });
    expect(controller.getSnapshot().pendingSubmit).toBeUndefined();
    expect(await controller.prepare(command())).toMatchObject({ ok: false });
    expect(access.chatStateWrite).toHaveBeenCalledTimes(1);
  });

  it('keeps an uncertain pending envelope when post-receipt persistence fails', async () => {
    const { controller, access, stored } = fixture({ draft: { text: 'Send original', replyTo: command().payload.context!.replyTo } });
    await controller.load();
    await controller.prepare(command());
    vi.mocked(access.chatStateWrite).mockResolvedValueOnce({ ok: false, error: 'unavailable', message: 'save failed' });
    expect(await controller.complete(command().commandId, true)).toMatchObject({ ok: false, deliveryUncertain: true });
    expect(controller.getSnapshot().pendingSubmit?.command).toEqual(command());
    expect(stored().state.pendingSubmit?.command).toEqual(command());
  });

  it('never overwrites another panel and requires explicit draft choice while retaining its pending request', async () => {
    const { controller: first, access, stored } = fixture();
    const second = new ChatRecoveryController(scope, access);
    await Promise.all([first.load(), second.load()]);
    first.updateDraft({ text: 'First panel saved' });
    await first.flush();
    await first.prepare(command());
    second.updateDraft({ text: 'Second panel local' });
    await second.flush();
    expect(second.getSnapshot()).toMatchObject({ status: 'conflict', draft: { text: 'Second panel local' }, conflict: { state: { draft: { text: 'First panel saved' } } } });
    expect(stored().state.draft.text).toBe('First panel saved');
    expect(await second.prepare(command())).toMatchObject({ ok: false });
    expect(await second.resolveConflict('local')).toEqual({ ok: true });
    expect(stored().state.draft.text).toBe('Second panel local');
    expect(stored().state.pendingSubmit?.command).toEqual(command());
  });

  it('loads the chosen stored draft and rejects another concurrent revision during conflict resolution', async () => {
    const { controller: first, access, stored } = fixture();
    const second = new ChatRecoveryController(scope, access);
    await Promise.all([first.load(), second.load()]);
    first.updateDraft({ text: 'Stored first' });
    await first.flush();
    second.updateDraft({ text: 'Local second' });
    await second.flush();
    first.updateDraft({ text: 'Stored newer' });
    await first.flush();
    expect(await second.resolveConflict('local')).toMatchObject({ ok: false });
    expect(stored().state.draft.text).toBe('Stored newer');
    expect(await second.resolveConflict('stored')).toEqual({ ok: true });
    expect(second.getSnapshot().draft.text).toBe('Stored newer');
  });
});
