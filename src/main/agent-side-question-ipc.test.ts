import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import type { AgentSideQuestionResult } from '../shared/agent-side-question';
import { installAgentSideQuestionIpc } from './agent-side-question-ipc';
import type { AgentSideQuestionHost } from './agent-side-question-service';
import type { FeatureIpc } from './ipc-registration';
import { LocalMutationIngress } from './local-mutation-ingress';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function fakeIpc() {
  const handlers = new Map<string, Handler>();
  const listeners = new Map<string, Handler>();
  const ipc = {
    handle: (channel: string, handler: Handler) => { handlers.set(channel, handler); },
    removeHandler: (channel: string) => { handlers.delete(channel); },
    on: (channel: string, listener: Handler) => { listeners.set(channel, listener); return ipc; },
    removeListener: (channel: string) => { listeners.delete(channel); return ipc; },
  } as unknown as FeatureIpc;
  return { ipc, handlers, listeners };
}

function sender(id: number) {
  return Object.assign(new EventEmitter(), { id });
}

/** A host whose asks stay pending until aborted. */
function hangingHost(): AgentSideQuestionHost & { readonly signals: AbortSignal[] } {
  const signals: AbortSignal[] = [];
  return {
    signals,
    ask: (_request, signal) => new Promise<AgentSideQuestionResult>((resolve) => {
      signals.push(signal);
      signal.addEventListener('abort', () => resolve({ ok: false, code: 'cancelled' }), { once: true });
    }),
  };
}

const request = (requestId: string) => ({ requestId, sessionId: 's1', question: 'Which file?', history: [] });

describe('agent side question IPC', () => {
  it('requires a desktop principal and a request id', async () => {
    const { ipc, handlers } = fakeIpc();
    const host = { ask: vi.fn(async (): Promise<AgentSideQuestionResult> => ({ ok: true, answer: 'a', synthetic: false })) };
    installAgentSideQuestionIpc({ ipc, host, ingress: new LocalMutationIngress('test'), resolveDesktopPrincipal: (_event, clientId) => clientId === 'ok' });
    const ask = handlers.get('agent-side-question:ask')!;
    await expect(ask({ sender: sender(1) }, 'nope', request('r1'))).resolves.toEqual({ ok: false, code: 'unavailable' });
    await expect(ask({ sender: sender(1) }, 'ok', { ...request('r1'), requestId: '' })).resolves.toEqual({ ok: false, code: 'invalid' });
    await expect(ask({ sender: sender(1) }, 'ok', request('r1'))).resolves.toEqual({ ok: true, answer: 'a', synthetic: false });
    expect(host.ask).toHaveBeenCalledTimes(1);
  });

  it('cancels only the named ask of the same window, and refuses duplicates and too many asks', async () => {
    const { ipc, handlers, listeners } = fakeIpc();
    const host = hangingHost();
    installAgentSideQuestionIpc({ ipc, host, ingress: new LocalMutationIngress('test'), resolveDesktopPrincipal: () => true, maxPerSender: 2 });
    const ask = handlers.get('agent-side-question:ask')!;
    const cancel = listeners.get('agent-side-question:cancel')!;
    const one = sender(1);
    const two = sender(2);
    const first = ask({ sender: one }, 'ok', request('r1'));
    const second = ask({ sender: one }, 'ok', request('r2'));
    const other = ask({ sender: two }, 'ok', request('r1'));
    await expect(ask({ sender: one }, 'ok', request('r1'))).resolves.toEqual({ ok: false, code: 'busy' });
    await expect(ask({ sender: one }, 'ok', request('r3'))).resolves.toEqual({ ok: false, code: 'busy' });
    await vi.waitFor(() => expect(host.signals).toHaveLength(3));
    cancel({ sender: two }, 'r2');
    cancel({ sender: one }, 'r1');
    await expect(first).resolves.toEqual({ ok: false, code: 'cancelled' });
    expect(host.signals.map((signal) => signal.aborted)).toEqual([true, false, false]);
    one.emit('destroyed');
    await expect(second).resolves.toEqual({ ok: false, code: 'cancelled' });
    expect(host.signals[2]?.aborted).toBe(false);
    two.emit('render-process-gone');
    await expect(other).resolves.toEqual({ ok: false, code: 'cancelled' });
  });

  it('aborts pending asks when the ingress drains at quit and refuses new ones', async () => {
    const { ipc, handlers } = fakeIpc();
    const host = hangingHost();
    const ingress = new LocalMutationIngress('test');
    installAgentSideQuestionIpc({ ipc, host, ingress, resolveDesktopPrincipal: () => true });
    const ask = handlers.get('agent-side-question:ask')!;
    const pending = ask({ sender: sender(1) }, 'ok', request('r1'));
    await vi.waitFor(() => expect(host.signals).toHaveLength(1));
    await ingress.closeAndDrain();
    await expect(pending).resolves.toEqual({ ok: false, code: 'cancelled' });
    await expect(ask({ sender: sender(1) }, 'ok', request('r2'))).resolves.toEqual({ ok: false, code: 'unavailable' });
  });
});
