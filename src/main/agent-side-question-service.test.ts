import { describe, expect, it, vi } from 'vitest';

import { ProviderSideQuestionError } from './agent-provider-adapter';
import { createAgentSideQuestionHost, type AgentSideQuestionHostOptions } from './agent-side-question-service';

const request = { requestId: 'r1', sessionId: 's1', question: 'Which file?', history: [] };
const host = (overrides: Partial<AgentSideQuestionHostOptions> = {}) => createAgentSideQuestionHost({
  ready: async () => undefined,
  available: () => true,
  ask: async () => ({ text: 'src/config.ts', synthetic: false }),
  ...overrides,
});

describe('AgentSideQuestionHost', () => {
  it('answers a valid request and passes only the validated fields', async () => {
    const ask = vi.fn(async () => ({ text: 'src/config.ts', synthetic: false, fallbackNotice: 'n' }));
    await expect(host({ ask }).ask(request, new AbortController().signal)).resolves.toEqual({ ok: true, answer: 'src/config.ts', synthetic: false, fallbackNotice: 'n' });
    expect(ask).toHaveBeenCalledWith({ sessionId: 's1', question: 'Which file?', history: [] }, expect.any(AbortSignal));
  });

  it('refuses invalid, unavailable and over-limit requests', async () => {
    const signal = new AbortController().signal;
    await expect(host().ask({ ...request, extra: true }, signal)).resolves.toEqual({ ok: false, code: 'invalid' });
    await expect(host({ available: () => false }).ask(request, signal)).resolves.toEqual({ ok: false, code: 'unavailable' });
    let release!: () => void;
    const slow = host({ maxInFlight: 1, ask: () => new Promise((resolve) => { release = () => resolve({ text: 'a', synthetic: false }); }) });
    const first = slow.ask(request, signal);
    await expect(slow.ask({ ...request, requestId: 'r2' }, signal)).resolves.toEqual({ ok: false, code: 'busy' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    await expect(first).resolves.toMatchObject({ ok: true });
  });

  it('maps a timeout, a cancel and provider failures to codes', async () => {
    const hang: AgentSideQuestionHostOptions['ask'] = (_input, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new ProviderSideQuestionError('cancelled')), { once: true });
    });
    let runtimeSignal: AbortSignal | undefined;
    await expect(host({ timeoutMs: 20, ask: (input, signal) => { runtimeSignal = signal; return hang(input, signal); } }).ask(request, new AbortController().signal))
      .resolves.toEqual({ ok: false, code: 'timeout' });
    expect(runtimeSignal?.aborted).toBe(true);
    const controller = new AbortController();
    const cancelled = host({ ask: hang }).ask(request, controller.signal);
    controller.abort();
    await expect(cancelled).resolves.toEqual({ ok: false, code: 'cancelled' });
    await expect(host({ ask: async () => { throw new ProviderSideQuestionError('session-restarted'); } }).ask(request, new AbortController().signal))
      .resolves.toEqual({ ok: false, code: 'session-restarted' });
    await expect(host({ ask: async () => { throw new Error('Which file? exploded'); } }).ask(request, new AbortController().signal))
      .resolves.toEqual({ ok: false, code: 'failed' });
  });

  it('never logs', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    try {
      await host({ ask: async () => { throw new Error('boom'); } }).ask(request, new AbortController().signal);
      await host().ask(request, new AbortController().signal);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
