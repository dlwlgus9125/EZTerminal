import { describe, expect, it, vi } from 'vitest';

import { BROWSER_CHECK_PRINCIPAL, BROWSER_CHECK_PROMPT, type BrowserViewState } from '../shared/browser';
import { encodeFileChanges } from '../shared/conversation-changes';
import type { DaemonCommand, DaemonCommandReceipt, DaemonSnapshot, DaemonTranscriptItem, DaemonTurn } from '../shared/daemon-protocol';
import { BrowserCheckCoordinator, type BrowserCheckDeps } from './browser-check-coordinator';

const ORIGIN = 'http://localhost:5173';
const CHANGE = encodeFileChanges([{ path: 'src/cart.tsx', patch: '@@ -1 +1 @@\n-a\n+b\n', coverage: 'patch' }])!;

function turn(patch: Partial<DaemonTurn> = {}): DaemonTurn {
  return { id: 'turn-1', sessionId: 'chat', commandId: 'command-1', state: 'completed', revision: 1, startedAt: '2026-11-02T05:00:00.000Z', finishedAt: '2026-11-02T05:01:00.000Z', createdAt: '2026-11-02T05:00:00.000Z', updatedAt: '2026-11-02T05:01:00.000Z', ...patch } as DaemonTurn;
}

interface Options {
  readonly autoCheck?: boolean;
  readonly listed?: boolean;
  readonly pane?: Partial<BrowserViewState> | null;
  readonly principal?: DaemonCommand['principal'];
  readonly command?: DaemonCommand | null;
  readonly items?: readonly DaemonTranscriptItem[];
  readonly snapshot?: Partial<DaemonSnapshot>;
  readonly turns?: readonly DaemonTurn[];
  readonly receipts?: readonly DaemonCommandReceipt[];
}

function harness(options: Options = {}) {
  const snapshot = {
    revision: 7,
    sessions: [{ id: 'chat', kind: 'agent', source: 'structured', projectId: 'project', workspaceId: 'workspace' }],
    agents: [{ sessionId: 'chat', providerId: 'codex', state: 'idle' }],
    agentRelations: [],
    turns: options.turns ?? [turn()],
    approvals: [],
    ...options.snapshot,
  } as unknown as DaemonSnapshot;
  const receipts = [...(options.receipts ?? [])];
  const execute = vi.fn<(command: DaemonCommand) => Promise<DaemonCommandReceipt>>(async () => receipts.shift() ?? ({ ok: true } as DaemonCommandReceipt));
  const items = options.items ?? [{ id: 'change', sessionId: 'chat', turnId: 'turn-1', sequence: 3, kind: 'tool-result', text: CHANGE, isDelta: false, isSensitive: false, createdAt: '2026-11-02T05:00:30.000Z' } as DaemonTranscriptItem];
  const person = { commandId: 'command-1', principal: options.principal ?? { kind: 'desktop', id: 'window' }, type: 'agent.submit', payload: { sessionId: 'chat', prompt: 'Fix the total' } } as unknown as DaemonCommand;
  const deps: BrowserCheckDeps = {
    autoCheck: () => options.autoCheck ?? true,
    listed: () => options.listed ?? true,
    pane: () => (options.pane === null ? undefined : { conversationId: 'chat', url: `${ORIGIN}/cart`, site: 'local', loading: false, canBack: false, canForward: false, ai: 'none', ...options.pane }),
    getSnapshot: () => snapshot,
    prepared: () => false,
    turnCommand: () => (options.command === undefined ? person : options.command),
    readTranscript: (_sessionId, afterSequence) => (afterSequence === 0 ? items : []),
    execute,
    now: () => new Date('2026-11-02T05:01:00.000Z'),
  };
  return { coordinator: new BrowserCheckCoordinator(deps), execute, snapshot };
}

describe('BrowserCheckCoordinator: one check, after a turn a person sent', () => {
  it('sends one turn to the same conversation, from the host, in the app\'s words', async () => {
    const { coordinator, execute } = harness();
    await coordinator.turnFinished(turn());
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toMatchObject({
      type: 'agent.submit', principal: { kind: 'cli', id: BROWSER_CHECK_PRINCIPAL }, expectedRevision: 7,
      payload: { sessionId: 'chat', prompt: BROWSER_CHECK_PROMPT, browserCheck: { origin: ORIGIN, providerId: 'codex' } },
    });
  });

  it('checks a turn once, however often it is reported', async () => {
    const { coordinator, execute } = harness();
    await coordinator.turnFinished(turn());
    await coordinator.turnFinished(turn());
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Options]>([
    ['the setting is off', { autoCheck: false }],
    ['the AI was launched without the tools', { listed: false }],
    ['no pane is open', { pane: null }],
    ['the pane shows nothing', { pane: { url: '' } }],
    ['the pane is on an allowed site', { pane: { url: 'https://staging.example/', site: 'allowed' } }],
    ['the pane is on a site not allowed', { pane: { url: 'https://evil.example/', site: 'external' } }],
    ['the page failed', { pane: { fault: 'server-down' } }],
    ['the page waits to be reopened', { pane: { needsReopen: true } }],
    ['the turn changed no file', { items: [] }],
    ['the turn\'s command cannot be told', { command: null }],
    ['a phone-less host sent it: a heartbeat', { principal: { kind: 'cli', id: 'automation-runtime' } }],
    ['an AI\'s own shell sent it', { principal: { kind: 'cli', id: 'chat', sessionId: 'chat' } }],
    ['a parent AI sent it', { principal: { kind: 'mcp', id: 'parent', sessionId: 'parent' } }],
    ['a limit\'s "Continue." sent it', { principal: { kind: 'cli', id: 'long-run-runtime' } }],
    ['a newer turn finished since', { turns: [turn(), turn({ id: 'turn-2', finishedAt: '2026-11-02T05:02:00.000Z' })] }],
    ['a message waits behind it', { turns: [turn(), turn({ id: 'turn-2', state: 'queued', finishedAt: undefined })] }],
    ['an approval is open', { snapshot: { approvals: [{ id: 'a', sessionId: 'chat', state: 'pending' }] as never } }],
    ['a limit stopped the conversation', { snapshot: { usageLimits: { chat: {} } as never } }],
    ['this AI is near its limit', { snapshot: { providerUsage: { codex: { fiveHour: { usedPercent: 95 } } } as never } }],
  ])('sends nothing when %s', async (_name, options) => {
    const { coordinator, execute } = harness(options);
    await coordinator.turnFinished(turn());
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['failed', 'interrupted'] as const)('sends nothing after a turn that %s', async (state) => {
    const finished = turn({ state });
    const { coordinator, execute } = harness({ turns: [finished] });
    await coordinator.turnFinished(finished);
    expect(execute).not.toHaveBeenCalled();
  });

  it('never chains: the check\'s own turn is the host\'s, and asks for no check', async () => {
    const { coordinator, execute } = harness({ principal: { kind: 'cli', id: BROWSER_CHECK_PRINCIPAL } });
    await coordinator.turnFinished(turn());
    expect(execute).not.toHaveBeenCalled();
  });

  it('checks on a file page in the conversation\'s folders, and after a phone\'s turn', async () => {
    const onFile = harness({ pane: { url: 'file:///C:/work/index.html', site: 'file' } });
    await onFile.coordinator.turnFinished(turn());
    expect(onFile.execute.mock.calls[0]![0]).toMatchObject({ payload: { browserCheck: { origin: 'file:///C:/work/index.html' } } });
    const fromPhone = harness({ principal: { kind: 'android', id: 'phone' } });
    await fromPhone.coordinator.turnFinished(turn());
    expect(fromPhone.execute).toHaveBeenCalledTimes(1);
  });

  it('looks at a turn\'s own changes, not an earlier turn\'s', async () => {
    const earlier = { id: 'old', sessionId: 'chat', turnId: 'turn-0', sequence: 1, kind: 'tool-result', text: CHANGE, isDelta: false, isSensitive: false, createdAt: '2026-11-02T04:00:00.000Z' } as DaemonTranscriptItem;
    const { coordinator, execute } = harness({ items: [earlier] });
    await coordinator.turnFinished(turn());
    expect(execute).not.toHaveBeenCalled();
  });

  it('tries again on a revision conflict, with a new revision, and gives up on anything else', async () => {
    const conflict = { ok: false, error: { code: 'revision-conflict', message: 'x' } } as DaemonCommandReceipt;
    const retried = harness({ receipts: [conflict] });
    await retried.coordinator.turnFinished(turn());
    expect(retried.execute).toHaveBeenCalledTimes(2);
    const refused = harness({ receipts: [{ ok: false, error: { code: 'invalid-state', message: 'x' } } as DaemonCommandReceipt] });
    await refused.coordinator.turnFinished(turn());
    expect(refused.execute).toHaveBeenCalledTimes(1);
  });

  it('survives a router that throws: the conversation goes on', async () => {
    const { coordinator, execute } = harness();
    execute.mockRejectedValue(new Error('gone'));
    await expect(coordinator.turnFinished(turn())).resolves.toBeUndefined();
  });
});
