import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonEvent, DaemonSnapshot } from '../shared/daemon-protocol';
import { BrowserApprovals, type BrowserApprovalsDeps } from './browser-approvals';
import type { BrowserApprovalRequest } from './browser-tools';

const HOLD_MS = 240_000;

const ask = (patch: Partial<BrowserApprovalRequest> = {}): BrowserApprovalRequest => ({
  sessionId: 'chat', turnId: 'turn-1', origin: 'https://staging.cart-kit.example', tool: 'browser_type', action: 'type',
  run: { kind: 'type', value: 'SPRING' }, pageElement: 'textbox "Coupon"', ...patch,
});

function harness(patch: Partial<BrowserApprovalsDeps> = {}) {
  const listeners: ((event: DaemonEvent) => void)[] = [];
  const approvals: { id: string; state: string }[] = [];
  const raise = vi.fn<BrowserApprovalsDeps['raise']>(async () => {
    approvals.push({ id: 'approval-1', state: 'pending' });
    return 'approval-1';
  });
  const expire = vi.fn<BrowserApprovalsDeps['expire']>(async () => undefined);
  const coordinator = new BrowserApprovals({
    raise, expire,
    getSnapshot: () => ({ approvals }) as unknown as Pick<DaemonSnapshot, 'approvals'>,
    onEvent: (listener) => { listeners.push(listener); return () => { listeners.length = 0; }; },
    createId: () => 'call-1',
    ...patch,
  });
  const expireFromHost = (): void => {
    approvals[0]!.state = 'expired';
    for (const listener of listeners) listener({ kind: 'approval.changed', payload: { approvalId: 'approval-1', sessionId: 'chat' } } as unknown as DaemonEvent);
  };
  return { coordinator, raise, expire, expireFromHost };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('what the pane says while a person is asked', () => {
  it('says so while one waits, and stops when none does', async () => {
    const onHeld = vi.fn();
    const approvals = new BrowserApprovals({
      raise: vi.fn(async () => 'approval-1'), expire: vi.fn(async () => undefined), getSnapshot: () => ({ approvals: [] }), onEvent: () => () => undefined, onHeld, createId: () => 'call-1',
      setTimer: () => 0 as never, clearTimer: () => undefined,
    });
    const first = approvals.request({ sessionId: 'chat', turnId: 't', origin: 'https://staging.example', tool: 'browser_click', action: 'click', run: { kind: 'click' } });
    expect(onHeld).toHaveBeenLastCalledWith('chat', true);
    approvals.resolved('browser-action:call-1', 'allow');
    await first;
    expect(onHeld).toHaveBeenLastCalledWith('chat', false);
  });
});

describe('BrowserApprovals', () => {
  it('raises the host\'s own arguments, the page\'s words in a field of their own', async () => {
    const { coordinator, raise } = harness();
    void coordinator.request(ask());
    await vi.advanceTimersByTimeAsync(0);
    expect(raise).toHaveBeenCalledWith({
      sessionId: 'chat', turnId: 'turn-1', providerRequestId: 'browser-action:call-1', risk: 'write', title: 'browser_type on https://staging.cart-kit.example',
      request: { v: 1, kind: 'tool', toolName: 'browser_type', target: 'https://staging.cart-kit.example', input: JSON.stringify({ value: 'SPRING', element: 'textbox "Coupon"' }) },
    });
  });

  it.each([
    [{ kind: 'navigate', url: 'https://staging.cart-kit.example/a?b=1' }, { url: 'https://staging.cart-kit.example/a?b=1' }],
    [{ kind: 'press', keys: 'Control+Enter' }, { keys: 'Control+Enter' }],
    [{ kind: 'click' }, {}],
  ] as const)('shows what will run: %j', async (run, input) => {
    const { coordinator, raise } = harness();
    void coordinator.request(ask({ run, pageElement: undefined }));
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse((raise.mock.calls[0]![0].request as { input: string }).input)).toEqual(input);
  });

  it('answers allow and decline, once', async () => {
    const { coordinator } = harness();
    const allowed = coordinator.request(ask());
    await vi.advanceTimersByTimeAsync(0);
    coordinator.resolved('browser-action:call-1', 'allow');
    coordinator.resolved('browser-action:call-1', 'deny');
    await expect(allowed).resolves.toBe('allow');
    const declined = coordinator.request(ask());
    await vi.advanceTimersByTimeAsync(0);
    coordinator.resolved('browser-action:call-1', 'deny');
    await expect(declined).resolves.toBe('approval-declined');
  });

  it('expires at 240 s, voids the approval, and no earlier', async () => {
    const { coordinator, expire } = harness();
    const answer = coordinator.request(ask());
    await vi.advanceTimersByTimeAsync(HOLD_MS - 1);
    expect(expire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(answer).resolves.toBe('approval-timeout');
    expect(expire).toHaveBeenCalledWith('approval-1');
  });

  it('a late answer after expiry changes nothing', async () => {
    const { coordinator } = harness();
    const answer = coordinator.request(ask());
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    coordinator.resolved('browser-action:call-1', 'allow', { kind: 'session' });
    await expect(answer).resolves.toBe('approval-timeout');
    expect(coordinator.siteTrusted('chat', 'https://staging.cart-kit.example')).toBe(false);
  });

  it('settles when the host expired it: a Stop, or the turn ending', async () => {
    const { coordinator, expireFromHost, expire } = harness();
    const answer = coordinator.request(ask());
    await vi.advanceTimersByTimeAsync(0);
    expireFromHost();
    await expect(answer).resolves.toBe('approval-timeout');
    expect(expire).toHaveBeenCalledTimes(1);
  });

  it('ends when the caller goes away', async () => {
    const { coordinator, expire } = harness();
    const abort = new AbortController();
    const answer = coordinator.request(ask({ signal: abort.signal }));
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await expect(answer).resolves.toBe('approval-timeout');
    expect(expire).toHaveBeenCalledWith('approval-1');
  });

  it('never raises for a caller already gone', async () => {
    const { coordinator, raise } = harness();
    const abort = new AbortController();
    abort.abort();
    await expect(coordinator.request(ask({ signal: abort.signal }))).resolves.toBe('approval-timeout');
    expect(raise).not.toHaveBeenCalled();
  });

  it('ends when the turn moved on before it could be raised', async () => {
    const { coordinator } = harness({ raise: vi.fn(async () => undefined) });
    await expect(coordinator.request(ask())).resolves.toBe('approval-timeout');
  });

  it('ends if raising fails', async () => {
    const { coordinator } = harness({ raise: vi.fn(async () => { throw new Error('store'); }) });
    await expect(coordinator.request(ask())).resolves.toBe('approval-timeout');
  });

  it('브라우저만 중지 ends what waits on that conversation alone', async () => {
    const { coordinator, expire } = harness();
    const answer = coordinator.request(ask());
    await vi.advanceTimersByTimeAsync(0);
    coordinator.stopped('another');
    expect(expire).not.toHaveBeenCalled();
    coordinator.stopped('chat');
    await expect(answer).resolves.toBe('stopped');
    expect(expire).toHaveBeenCalledWith('approval-1');
  });

  describe('do not ask again', () => {
    const origin = 'https://staging.cart-kit.example';

    it('holds for this site in this conversation, and nowhere else', async () => {
      const { coordinator } = harness();
      void coordinator.request(ask());
      await vi.advanceTimersByTimeAsync(0);
      coordinator.resolved('browser-action:call-1', 'allow', { kind: 'session' });
      expect(coordinator.siteTrusted('chat', origin)).toBe(true);
      expect(coordinator.siteTrusted('chat', 'https://other.example')).toBe(false);
      expect(coordinator.siteTrusted('another-chat', origin)).toBe(false);
    });

    it('takes nothing from a plain allow or from a decline', async () => {
      const { coordinator } = harness();
      void coordinator.request(ask());
      await vi.advanceTimersByTimeAsync(0);
      coordinator.resolved('browser-action:call-1', 'allow');
      expect(coordinator.siteTrusted('chat', origin)).toBe(false);
      void coordinator.request(ask());
      await vi.advanceTimersByTimeAsync(0);
      coordinator.resolved('browser-action:call-1', 'deny', { kind: 'session' });
      expect(coordinator.siteTrusted('chat', origin)).toBe(false);
    });

    it('ends when the site is revoked', async () => {
      const { coordinator } = harness();
      void coordinator.request(ask());
      await vi.advanceTimersByTimeAsync(0);
      coordinator.resolved('browser-action:call-1', 'allow', { kind: 'session' });
      coordinator.forgetSite(origin);
      expect(coordinator.siteTrusted('chat', origin)).toBe(false);
    });
  });
});
