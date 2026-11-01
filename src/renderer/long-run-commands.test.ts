import { describe, expect, it, vi } from 'vitest';

import type { DaemonCommand, DaemonCommandReceipt, DaemonSnapshot } from '../shared/daemon-protocol';
import { LONG_RUN_CAPABILITY, type OpenUsageLimit, type SteeredMessage } from '../shared/long-run';
import { formatClock } from './chat/copy';
import { longRunHost, type LongRunHostInput } from './long-run-commands';

const SESSION = 'session-1';
const STOP = 'stop-1';
const RESUME = '2026-11-01T06:12:00.000Z';
const LIMIT: OpenUsageLimit = { stopId: STOP, turnId: 'turn-1', providerId: 'claude', phase: 'waiting', window: 'five-hour', stoppedAt: '2026-11-01T05:58:00.000Z', resetsAt: '2026-11-01T06:10:00.000Z', resumeAt: RESUME };
const FAILED: SteeredMessage = { id: 'steer-1', text: 'That file only.', state: 'failed', failure: 'refused', sentAt: '2026-11-01T05:50:00.000Z' };

const applied = (command: DaemonCommand): DaemonCommandReceipt => ({ ok: true, status: 'applied', commandId: command.commandId, revision: 8, eventSequence: 1 });
const refused = (command: DaemonCommand, code: 'revision-conflict' | 'invalid-state', message: string = code): DaemonCommandReceipt => ({ ok: false, status: 'rejected', commandId: command.commandId, revision: 8, error: { code, message, retryable: false } });

function snapshotWith(patch: Record<string, unknown> = {}, agent: Record<string, unknown> = {}): DaemonSnapshot {
  return {
    revision: 7, capabilities: [LONG_RUN_CAPABILITY], longRunSupport: { claude: true },
    agents: [{ sessionId: SESSION, providerId: 'claude', state: 'idle', ...agent }], ...patch,
  } as unknown as DaemonSnapshot;
}

function host(snapshot: DaemonSnapshot | null, answers: readonly ((command: DaemonCommand) => DaemonCommandReceipt | null)[] = []) {
  const sent: DaemonCommand[] = [];
  const onSteer = vi.fn<LongRunHostInput['onSteer']>(async () => ({ ok: true }));
  const onQueue = vi.fn<LongRunHostInput['onQueue']>(async () => ({ ok: true }));
  const props = longRunHost({
    snapshot, sessionId: SESSION, locale: 'en', onSteer, onQueue,
    access: {
      latestSnapshot: async () => snapshot,
      sendCommand: async (command) => { sent.push(command); return (answers[sent.length - 1] ?? applied)(command); },
    },
  });
  return { props, sent, onSteer, onQueue };
}

describe('long-run on a conversation screen', () => {
  it('offers nothing on a host without long-run-v1', () => {
    expect(host(snapshotWith({ capabilities: ['review-loop-v1'] })).props).toBeUndefined();
    expect(host(null).props).toBeUndefined();
  });

  it('lets a person press a limit card on an AI below its floor, but leaves the box as it is', () => {
    const { props } = host(snapshotWith({ longRunSupport: { claude: false } }));
    expect(props?.longRun.onAction).toBeDefined();
    expect(props?.longRun.steer).toBeUndefined();
  });

  it('writes into the turn the host says is running', async () => {
    const { props, onSteer } = host(snapshotWith({}, { state: 'working', currentTurnId: 'turn-9' }));
    expect(props?.longRun.steer?.noTurn).toBeUndefined();
    await props?.longRun.steer?.onSteer('That file only.');
    expect(onSteer).toHaveBeenCalledExactlyOnceWith('turn-9', 'That file only.');
  });

  it('has no turn to write into while the conversation only waits in the queue', () => {
    expect(host(snapshotWith({}, { state: 'queued' })).props?.longRun.steer?.noTurn).toBe(true);
  });

  it('sends what cannot go in through the queue', async () => {
    const { props, onQueue } = host(snapshotWith({}, { state: 'working', currentTurnId: 'turn-9' }));
    const context = { replyTo: { messageId: 'm-1', text: 'That part.' } };
    await props?.longRun.steer?.onQueue?.('Look again.', context);
    expect(onQueue).toHaveBeenCalledExactlyOnceWith('Look again.', context);
  });

  it('shows the snapshot\'s messages on their way', () => {
    const { props } = host(snapshotWith({ steers: { [SESSION]: [FAILED] } }));
    expect(props?.longRun.steer?.messages).toEqual([FAILED]);
  });
});

describe('a message that did not land', () => {
  it('goes to the queue or back to the box by the person\'s word', async () => {
    const { props, sent } = host(snapshotWith({ steers: { [SESSION]: [FAILED] } }));
    await expect(props?.longRun.steer?.onToQueue?.(FAILED)).resolves.toEqual({ ok: true });
    await expect(props?.longRun.steer?.onToBox?.(FAILED)).resolves.toEqual({ ok: true });
    expect(sent.map((command) => [command.type, command.payload])).toEqual([
      ['agent.steer-settle', { sessionId: SESSION, steerId: FAILED.id, action: 'queue' }],
      ['agent.steer-settle', { sessionId: SESSION, steerId: FAILED.id, action: 'box' }],
    ]);
  });

  it('says what the host refused', async () => {
    const { props } = host(snapshotWith({ steers: { [SESSION]: [FAILED] } }), [(command) => refused(command, 'invalid-state', 'This message is still on its way.')]);
    await expect(props?.longRun.steer?.onToBox?.(FAILED)).resolves.toEqual({ ok: false, message: 'This message is still on its way.' });
  });
});

describe('a limit card\'s buttons', () => {
  const CASES = [
    ['limit-try-now', 'try-now'], ['limit-resume', 'resume'], ['limit-auto-off', 'auto-off'], ['limit-auto-on', 'auto-on'],
    ['limit-schedule', 'schedule'], ['limit-unschedule', 'unschedule'], ['limit-leave', 'leave'],
  ] as const;

  it('each sends its action for that stop', async () => {
    for (const [kind, action] of CASES) {
      const { props, sent } = host(snapshotWith({ usageLimits: { [SESSION]: LIMIT } }));
      await props?.longRun.onAction?.({ kind, stopId: STOP });
      expect(sent[0]).toMatchObject({ type: 'long-run.limit-action', payload: { sessionId: SESSION, stopId: STOP, action } });
    }
  });

  it('works on a card the snapshot no longer holds open: a stop left as it is still takes 이어서 하기', async () => {
    const { props, sent } = host(snapshotWith());
    await props?.longRun.onAction?.({ kind: 'limit-resume', stopId: STOP });
    expect(sent[0]).toMatchObject({ payload: { stopId: STOP, action: 'resume' } });
  });

  it('survives the revision moving under it, under a fresh command each time', async () => {
    const conflict = (command: DaemonCommand): DaemonCommandReceipt => refused(command, 'revision-conflict');
    const { props, sent } = host(snapshotWith({ usageLimits: { [SESSION]: LIMIT } }), [conflict, conflict]);
    await expect(props?.longRun.onAction?.({ kind: 'limit-try-now', stopId: STOP })).resolves.toEqual({ ok: true });
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((command) => command.commandId)).size).toBe(3);
  });

  it('reports no answer as that, and sends nothing again', async () => {
    const { props, sent } = host(snapshotWith({ usageLimits: { [SESSION]: LIMIT } }), [() => null]);
    await expect(props?.longRun.onAction?.({ kind: 'limit-try-now', stopId: STOP })).resolves.toMatchObject({ ok: false });
    expect(sent).toHaveLength(1);
  });
});

describe('the header and the box', () => {
  it('say a clock runs, without asking anything', () => {
    const { props } = host(snapshotWith({ usageLimits: { [SESSION]: LIMIT } }));
    expect(props?.statusLabel).toBe(`Limit wait · ${formatClock(RESUME, 'en')}`);
    expect(props?.longRun.asks).toBeUndefined();
    expect(props?.longRun.limitHint).toBe(true);
    expect(props?.longRun.openLimit).toEqual(LIMIT);
  });

  it('wait on the person only where the person is needed', () => {
    const { props } = host(snapshotWith({ usageLimits: { [SESSION]: { ...LIMIT, phase: 'ask-reset' } } }));
    expect(props?.longRun.asks).toBe(true);
    expect(props?.longRun.limitHint).toBeUndefined();
  });

  it('say nothing once the conversation has moved on, or for a stop the host has closed', () => {
    expect(host(snapshotWith()).props?.statusLabel).toBeUndefined();
    // A person's message went past the hold: the turn is theirs, whatever the card last said.
    const moved = host(snapshotWith({ usageLimits: { [SESSION]: LIMIT } }, { state: 'working', currentTurnId: 'turn-person' }));
    expect(moved.props?.statusLabel).toBeUndefined();
    expect(moved.props?.longRun.limitHint).toBeUndefined();
  });

  it('say the send is going while its turn runs', () => {
    const { props } = host(snapshotWith({ usageLimits: { [SESSION]: { ...LIMIT, phase: 'resuming' } } }, { state: 'working', currentTurnId: 'turn-resume' }));
    expect(props?.statusLabel).toBe('Continuing');
  });

  it('leave an open decision the header it already has', () => {
    const { props } = host(snapshotWith({ usageLimits: { [SESSION]: { ...LIMIT, phase: 'skipped' } } }, { state: 'blocked' }));
    expect(props?.statusLabel).toBeUndefined();
  });
});
