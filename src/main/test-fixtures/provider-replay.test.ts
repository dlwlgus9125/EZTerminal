import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AgentProviderEvent } from '../agent-provider-adapter';
import { parseApprovalRequest } from '../../shared/approval-request';
import { parseTranscriptPayload } from '../../shared/transcript-payload';
import {
  PROVIDER_GOLDEN_DIRECTORY,
  listProviderCaptureFixtures,
  readProviderCaptureFixture,
  replayProviderFixture,
} from './provider-replay';

// UPDATE_PROVIDER_GOLDENS=1 rewrites src/renderer/chat/fixtures from the
// recorded provider traffic; otherwise the committed goldens are the contract.
const updateGoldens = process.env.UPDATE_PROVIDER_GOLDENS === '1';

describe('recorded provider sessions replayed through the current adapters', () => {
  const fixtures = listProviderCaptureFixtures();

  it('has recorded fixtures to replay', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const name of fixtures) {
    it(`${name} matches its golden transcript`, async () => {
      const golden = await replayProviderFixture(readProviderCaptureFixture(name));
      // The store drops a payload or request that fails its schema; an adapter
      // must never emit one, so the replay fails loudly instead.
      for (const item of golden.items) {
        if (item.payload !== undefined) expect(parseTranscriptPayload(item.payload), `${item.id} payload`).toBeDefined();
      }
      for (const approval of golden.approvals) {
        if (approval.request !== undefined) expect(parseApprovalRequest(approval.request), `${approval.id} request`).toBeDefined();
      }
      const target = path.join(PROVIDER_GOLDEN_DIRECTORY, `${name}.json`);
      const serialized = `${JSON.stringify(golden, null, 2)}\n`;
      if (updateGoldens) {
        mkdirSync(PROVIDER_GOLDEN_DIRECTORY, { recursive: true });
        writeFileSync(target, serialized);
      }
      expect(existsSync(target), `${target} is missing; run with UPDATE_PROVIDER_GOLDENS=1`).toBe(true);
      expect(JSON.parse(serialized)).toEqual(JSON.parse(readFileSync(target, 'utf8')));
    });
  }
});

describe('usage read from recorded provider sessions', () => {
  async function usageEvents(name: string) {
    const events: AgentProviderEvent[] = [];
    await replayProviderFixture(readProviderCaptureFixture(name), { onEvent: (event) => events.push(event) });
    const usage = events.filter((event) => event.kind === 'usage');
    const finished = events.findIndex((event) => event.kind === 'turn-finished');
    const reply = events.findIndex((event) => event.kind === 'usage' && event.sessionId !== undefined);
    return { usage, replyBeforeFinish: reply >= 0 && reply < finished };
  }

  it('Claude: plan windows from the rate-limit event and context from the main request', async () => {
    const { usage, replyBeforeFinish } = await usageEvents('claude-markdown');
    expect(usage).toEqual([
      {
        kind: 'usage',
        limits: {
          fiveHour: { usedPercent: 22, resetsAt: 1792045200000 },
          weekly: { usedPercent: 19, resetsAt: 1792220400000 },
        },
      },
      // (2 + 3925 + 16883) input tokens of claude-opus-5-5's 1,000,000 window
      { kind: 'usage', sessionId: 'replay-session', contextPercent: 2 },
    ]);
    expect(replyBeforeFinish).toBe(true);
  });

  it('Codex: the weekly window and the thread context before the turn finishes', async () => {
    const { usage, replyBeforeFinish } = await usageEvents('codex-markdown');
    expect(usage).toEqual([
      { kind: 'usage', limits: { fiveHour: null, weekly: { usedPercent: 72, resetsAt: 1792472286000 } } },
      { kind: 'usage', sessionId: 'replay-session', contextPercent: 3 },
    ]);
    expect(replyBeforeFinish).toBe(true);
  });
});
