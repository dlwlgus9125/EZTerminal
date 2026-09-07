import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { IpcRegistration, type FeatureIpc } from './ipc-registration';

function ipcFixture() {
  const handlers = new Map<string, Parameters<FeatureIpc['handle']>[1]>();
  const ipc = new EventEmitter() as unknown as FeatureIpc;
  ipc.handle = (channel, handler) => {
    if (handlers.has(channel)) throw new Error('duplicate handler');
    handlers.set(channel, handler);
  };
  ipc.removeHandler = (channel) => { handlers.delete(channel); };
  return { ipc, handlers };
}

describe('feature IPC ownership', () => {
  it('removes only its listeners and handlers and can be disposed repeatedly', () => {
    const { ipc, handlers } = ipcFixture();
    const first = new IpcRegistration(ipc);
    const second = new IpcRegistration(ipc);
    const owned = vi.fn();
    const other = vi.fn();
    first.on('changed', owned);
    second.on('changed', other);
    first.handle('first:read', () => 1);
    second.handle('second:read', () => 2);

    first.dispose();
    first.dispose();
    (ipc as unknown as EventEmitter).emit('changed');
    expect(owned).not.toHaveBeenCalled();
    expect(other).toHaveBeenCalledOnce();
    expect([...handlers.keys()]).toEqual(['second:read']);
    second.dispose();
    expect(handlers.size).toBe(0);
  });

  it('does not acquire or remove an already owned channel when registration fails', () => {
    const { ipc, handlers } = ipcFixture();
    const first = new IpcRegistration(ipc);
    const second = new IpcRegistration(ipc);
    first.handle('read', () => 'original');
    expect(() => second.handle('read', () => 'replacement')).toThrow('duplicate handler');
    second.dispose();
    expect(handlers.has('read')).toBe(true);
    first.dispose();
  });

  it('continues releasing independent registrations when one cleanup fails', () => {
    const { ipc, handlers } = ipcFixture();
    const originalRemove = ipc.removeHandler;
    ipc.removeHandler = (channel) => {
      if (channel === 'broken') throw new Error('cleanup failure');
      originalRemove(channel);
    };
    const registrations = new IpcRegistration(ipc);
    registrations.handle('healthy', () => undefined);
    registrations.handle('broken', () => undefined);
    expect(registrations.dispose).toThrow('cleanup failure');
    expect(handlers.has('healthy')).toBe(false);
    expect(registrations.dispose).not.toThrow();
  });
});
