import { EventEmitter } from 'node:events';

import type { IpcMain, IpcMainEvent, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { CONVERSATION_VIEWING_TTL_MS } from '../shared/conversation-viewing';
import { ConversationViewers, installConversationViewingIpc } from './conversation-viewers';

function viewers(windows: readonly string[] = ['desktop:1']) {
  let now = 1_000;
  const list = [...windows];
  const instance = new ConversationViewers({ windows: () => list, now: () => now });
  return { instance, list, advance: (ms: number) => { now += ms; } };
}

describe('ConversationViewers', () => {
  it('counts a live claim from any client as viewed', () => {
    const { instance } = viewers();
    instance.report('desktop:1', []);
    instance.report('remote:phone', ['session-1']);
    expect(instance.status('session-1')).toBe('viewed');
    expect(instance.status('session-2')).toBe('unviewed');
  });

  it('lets a claim lapse without a resend, and a resend keep it', () => {
    const { instance, advance } = viewers();
    instance.report('desktop:1', ['session-1']);
    advance(CONVERSATION_VIEWING_TTL_MS - 1);
    expect(instance.status('session-1')).toBe('viewed');
    instance.report('desktop:1', ['session-1']);
    advance(CONVERSATION_VIEWING_TTL_MS - 1);
    expect(instance.status('session-1')).toBe('viewed');
    advance(1);
    expect(instance.status('session-1')).toBe('unviewed');
  });

  it('replaces what a client reported, and forgets a client that left', () => {
    const { instance } = viewers([]);
    instance.report('remote:phone', ['session-1']);
    instance.report('remote:phone', ['session-2']);
    expect(instance.status('session-1')).toBe('unviewed');
    expect(instance.status('session-2')).toBe('viewed');
    instance.drop('remote:phone');
    expect(instance.status('session-2')).toBe('unviewed');
  });

  it('does not know while a window has not reported this run: only unviewed makes a recap', () => {
    const { instance, list } = viewers(['desktop:1']);
    expect(instance.status('session-1')).toBe('unknown');
    // A phone says nothing about the window.
    instance.report('remote:phone', []);
    expect(instance.status('session-1')).toBe('unknown');
    instance.report('desktop:1', []);
    expect(instance.status('session-1')).toBe('unviewed');
    instance.drop('desktop:1');
    expect(instance.status('session-1')).toBe('unknown');
    list.length = 0;
    expect(instance.status('session-1')).toBe('unviewed');
  });

  it('still says viewed while another window has not reported', () => {
    const { instance } = viewers(['desktop:1', 'desktop:2']);
    instance.report('desktop:1', ['session-1']);
    expect(instance.status('session-1')).toBe('viewed');
    expect(instance.status('session-2')).toBe('unknown');
  });

  it('is unviewed with no window at all (the app keeps running in the tray)', () => {
    expect(viewers([]).instance.status('session-1')).toBe('unviewed');
  });
});

describe('conversation viewing IPC', () => {
  function install(principal: (event: unknown, clientId: unknown) => string | null = () => 'desktop:7:client') {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const ipc = {
      handle: vi.fn(), removeHandler: vi.fn(),
      on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => { listeners.set(channel, listener); }),
      removeListener: vi.fn((channel: string) => { listeners.delete(channel); }),
    } as unknown as Pick<IpcMain, 'handle' | 'removeHandler' | 'on' | 'removeListener'>;
    const target = { report: vi.fn(), drop: vi.fn() };
    const dispose = installConversationViewingIpc({ ipc, viewers: target, principal });
    const sender = Object.assign(new EventEmitter(), { id: 7 }) as unknown as WebContents & EventEmitter;
    const report = (ids: unknown, clientId: unknown = 'client') => listeners.get('conversation-viewing:report')?.({ sender } as IpcMainEvent, clientId, ids);
    return { target, report, sender, dispose, listeners };
  }

  it('records what an app window reports, by its web contents', () => {
    const { target, report } = install();
    report(['session-1', 'session-2']);
    expect(target.report).toHaveBeenCalledWith('desktop:7', ['session-1', 'session-2']);
  });

  it('refuses a sender that is no app window, and malformed lists', () => {
    const { target, report } = install(() => null);
    report(['session-1']);
    expect(target.report).not.toHaveBeenCalled();
    const open = install();
    open.report('session-1');
    open.report([1]);
    open.report(['']);
    open.report(Array.from({ length: 65 }, (_, index) => `session-${String(index)}`));
    expect(open.target.report).not.toHaveBeenCalled();
  });

  it.each(['destroyed', 'render-process-gone', 'did-navigate'])('forgets the window on %s, once', (event) => {
    const { target, report, sender } = install();
    report([]);
    report(['session-1']);
    sender.emit(event);
    expect(target.drop).toHaveBeenCalledTimes(1);
    expect(target.drop).toHaveBeenCalledWith('desktop:7');
  });

  it('removes its listener', () => {
    const { dispose, listeners } = install();
    dispose();
    expect(listeners.size).toBe(0);
  });
});
