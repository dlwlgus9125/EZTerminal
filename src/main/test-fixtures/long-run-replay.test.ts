import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import type { AgentProviderEvent } from '../agent-provider-adapter';
import {
  PROVIDER_CAPTURE_DIRECTORY, readProviderCaptureFixture, replayProviderFixture, type ProviderCaptureFixture,
} from './provider-replay';

/**
 * The real CLIs against a loopback stub (scripts/capture-provider-fixtures.mjs, `limit-*`): no real limit was ever
 * seen, so every shape here is what the CLI does with a refusal the probes built. The first real limit updates them.
 */
const CLAUDE_RECORDINGS = ['claude-limit-first', 'claude-limit-weekly', 'claude-limit-no-reset', 'claude-limit-child'] as const;
const CODEX_RECORDINGS = ['codex-limit-usage', 'codex-limit-no-reset', 'codex-limit-not-included'] as const;

type RawMessage = Record<string, unknown>;

function sdkMessages(fixture: ProviderCaptureFixture): readonly RawMessage[] {
  return fixture.lines.flatMap((line) => (line.dir === 'sdk' ? [line.msg as SDKMessage as unknown as RawMessage] : []));
}

/** The Codex notifications in order: method and params. */
function notifications(fixture: ProviderCaptureFixture): readonly { readonly method: string; readonly params: RawMessage }[] {
  return fixture.lines.flatMap((line) => (
    line.dir === 'in' && line.frame.method ? [{ method: line.frame.method, params: (line.frame.params ?? {}) as RawMessage }] : []
  ));
}

describe('limit recordings', () => {
  it.each([...CLAUDE_RECORDINGS, ...CODEX_RECORDINGS])('%s is marked as a stub run and holds nothing of the account or this PC', (name) => {
    expect(readProviderCaptureFixture(name).meta.server).toBe('stub');
    const text = readFileSync(path.join(PROVIDER_CAPTURE_DIRECTORY, `${name}.ndjson`), 'utf8');
    expect(text).not.toMatch(/[A-Za-z]:[\\/]+(?:Users|Working)\b/u);
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u);
    expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/-]{12,}/u);
    expect(text).not.toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(text).not.toContain('sk-ant-oat01');
    expect(text).not.toContain('sk-long-run-probe');
  });

  it.each(CLAUDE_RECORDINGS)('%s replays through the Claude adapter past authentication', async (name) => {
    const golden = await replayProviderFixture(readProviderCaptureFixture(name));
    expect(golden.items.some((item) => item.kind === 'user-message')).toBe(true);
  });

  it.each(CODEX_RECORDINGS)('%s replays through the Codex adapter', async (name) => {
    const golden = await replayProviderFixture(readProviderCaptureFixture(name));
    expect(golden.items.some((item) => item.kind === 'user-message')).toBe(true);
  });
});

describe('what a Claude limit looks like', () => {
  it('the rejected event comes first, then a synthetic message, then an error result that names the limit', () => {
    const messages = sdkMessages(readProviderCaptureFixture('claude-limit-first'));
    const rejected = messages.findIndex((message) => message.type === 'rate_limit_event' && (message.rate_limit_info as RawMessage).status === 'rejected');
    const assistant = messages.findIndex((message) => message.type === 'assistant');
    const result = messages.findIndex((message) => message.type === 'result');
    expect(rejected).toBeGreaterThanOrEqual(0);
    expect(assistant).toBeGreaterThan(rejected);
    expect(result).toBeGreaterThan(assistant);
    expect(messages[assistant]).toMatchObject({ error: 'rate_limit', api_error: 'usage_limit_reached', api_error_status: 429 });
    expect((messages[assistant]!.message as RawMessage).model).toBe('<synthetic>');
    expect(messages[result]).toMatchObject({ subtype: 'success', is_error: true, api_error: 'usage_limit_reached', api_error_status: 429, terminal_reason: 'api_error' });
  });

  it('the message carries the window and the reset, in seconds', () => {
    const info = (name: string): RawMessage => {
      const message = sdkMessages(readProviderCaptureFixture(name)).find((entry) => entry.type === 'assistant' && entry.api_error === 'usage_limit_reached');
      return (message!.api_error_params as RawMessage).rate_limit_info as RawMessage;
    };
    expect(info('claude-limit-first')).toMatchObject({ rateLimitType: 'five_hour', status: 'rejected', resetsAt: expect.any(Number) });
    expect(info('claude-limit-weekly')).toMatchObject({ rateLimitType: 'seven_day', status: 'rejected', resetsAt: expect.any(Number) });
    const noReset = info('claude-limit-no-reset');
    expect(noReset).toMatchObject({ rateLimitType: 'five_hour', status: 'rejected' });
    expect(noReset.resetsAt).toBeUndefined();
  });

  it('a subagent refused: the parent is refused too, in one result', () => {
    const messages = sdkMessages(readProviderCaptureFixture('claude-limit-child'));
    const results = messages.filter((message) => message.type === 'result');
    expect(results[0]).toMatchObject({ is_error: true, api_error: 'usage_limit_reached' });
  });
});

async function replayed(name: string, longRun = true) {
  const events: AgentProviderEvent[] = [];
  const golden = await replayProviderFixture(readProviderCaptureFixture(name), { ...(longRun ? { session: { longRun: true as const } } : {}), onEvent: (event) => events.push(event) });
  const finished = events.filter((event) => event.kind === 'turn-finished');
  return { events, golden, finished, errors: events.filter((event) => event.kind === 'provider-error'), states: events.flatMap((event) => (event.kind === 'session-state' ? [event.state] : [])) };
}

describe('a Claude limit through the adapter', () => {
  it.each([
    ['claude-limit-first', 'five-hour', true],
    ['claude-limit-weekly', 'weekly', true],
    ['claude-limit-no-reset', 'five-hour', false],
    ['claude-limit-child', 'five-hour', true],
  ] as const)('%s ends the turn with the limit: no error, no row of its words, the session usable', async (name, window, reset) => {
    const { finished, errors, states, golden } = await replayed(name);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toEqual({
      kind: 'turn-finished', sessionId: 'replay-session', turnId: 'replay-turn-1', outcome: 'failed', errorCode: 'usage-limit',
      limit: { kind: 'resettable', window, ...(reset ? { resetsAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u) } : {}) },
    });
    expect(errors).toEqual([]);
    expect(states).not.toContain('failed');
    expect(states.at(-1)).toBe('idle');
    expect(golden.items.filter((item) => item.sessionId === 'replay-session' && item.kind === 'assistant-message' && /hit your/u.test(item.text))).toEqual([]);
  });

  it('keeps reading the usage the refusal carried', async () => {
    const { events } = await replayed('claude-limit-first');
    expect(events).toContainEqual(expect.objectContaining({ kind: 'usage', limits: expect.objectContaining({ fiveHour: expect.objectContaining({ usedPercent: 100 }) }) }));
  });

  it('a subagent refused after its parent stopped raises no error against the conversation', async () => {
    const { errors, golden } = await replayed('claude-limit-child');
    expect(errors).toEqual([]);
    expect(golden.items.filter((item) => item.kind === 'error')).toEqual([]);
    // Its own transcript keeps its words: a subagent the AI runs has no card (D7).
    expect(golden.items.filter((item) => item.sessionId !== 'replay-session' && /hit your/u.test(item.text))).toHaveLength(1);
  });

  it('below the measured version it classifies as it always did', async () => {
    const { finished, errors, states } = await replayed('claude-limit-first', false);
    expect(finished[0]).toMatchObject({ outcome: 'failed', errorCode: 'CLAUDE_PROVIDER_ERROR' });
    expect(finished[0]).not.toHaveProperty('limit');
    expect(errors.length).toBeGreaterThan(0);
    expect(states).toContain('failed');
  });
});

describe('a Codex limit through the adapter', () => {
  const resetsAt = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u);

  it.each([
    ['codex-limit-usage', { kind: 'resettable', window: 'five-hour', resetsAt }],
    ['codex-limit-no-reset', { kind: 'resettable', window: 'five-hour', resetsAt }],
    ['codex-limit-not-included', { kind: 'not-included', window: 'unknown' }],
  ] as const)('%s ends the turn with the limit: no error, and the session usable', async (name, limit) => {
    const { finished, errors, states, golden } = await replayed(name);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toEqual({ kind: 'turn-finished', sessionId: 'replay-session', turnId: 'replay-turn-1', outcome: 'failed', errorCode: 'usage-limit', limit });
    expect(errors).toEqual([]);
    expect(states).not.toContain('failed');
    expect(states.at(-1)).toBe('idle');
    expect(golden.items.filter((item) => item.kind === 'error')).toEqual([]);
  });

  it('below the measured version it classifies as it always did', async () => {
    const { finished, states } = await replayed('codex-limit-usage', false);
    expect(states).toContain('failed');
    for (const event of finished) expect(event).not.toHaveProperty('limit');
  });
});

describe('what a Codex limit looks like', () => {
  const order = (name: string): readonly string[] => notifications(readProviderCaptureFixture(name)).map(({ method, params }) => (
    method === 'thread/status/changed' ? `status:${String((params.status as RawMessage).type)}` : method
  ));

  it.each(CODEX_RECORDINGS)('%s: the system error status comes before the error, and the turn ends last', (name) => {
    const frames = order(name);
    const status = frames.indexOf('status:systemError');
    const error = frames.indexOf('error');
    const completed = frames.indexOf('turn/completed');
    expect(status).toBeGreaterThanOrEqual(0);
    expect(error).toBeGreaterThan(status);
    expect(completed).toBeGreaterThan(error);
  });

  it('every limit says usageLimitExceeded and does not retry', () => {
    for (const name of CODEX_RECORDINGS) {
      const error = notifications(readProviderCaptureFixture(name)).find(({ method }) => method === 'error');
      expect(error?.params, name).toMatchObject({ willRetry: false, error: { codexErrorInfo: 'usageLimitExceeded' } });
    }
  });

  it('a plan without Codex differs from a limit without a reset only in its words', () => {
    const message = (name: string): string => {
      const error = notifications(readProviderCaptureFixture(name)).find(({ method }) => method === 'error');
      return (error!.params.error as RawMessage).message as string;
    };
    expect(message('codex-limit-no-reset')).toMatch(/try again later/u);
    expect(message('codex-limit-not-included')).not.toMatch(/try again/u);
    expect(message('codex-limit-usage')).toMatch(/try again at/u);
  });

  it('the windows arrive before the status, by their length, and a plan without Codex sends none', () => {
    const limits = (name: string) => notifications(readProviderCaptureFixture(name)).filter(({ method }) => method === 'account/rateLimits/updated');
    const [reading] = limits('codex-limit-usage');
    expect(reading?.params.rateLimits).toMatchObject({ primary: { usedPercent: 100, windowDurationMins: 300 }, secondary: { windowDurationMins: 10_080 } });
    expect(limits('codex-limit-not-included')).toEqual([]);
  });
});
