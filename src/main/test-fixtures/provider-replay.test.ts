import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

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
// Goldens written ahead of the adapter work: each subagent's rows in its own
// session. They fail until the adapters route child traffic; then drop the entry.
const AWAITING_SUBAGENT_ROUTING = new Set(['claude-subagents', 'claude-subagent-approval', 'codex-subagents', 'codex-subagent-approval']);

describe('recorded provider sessions replayed through the current adapters', () => {
  const fixtures = listProviderCaptureFixtures();

  it('has recorded fixtures to replay', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const name of fixtures) {
    const test = AWAITING_SUBAGENT_ROUTING.has(name) && !updateGoldens ? it.fails : it;
    test(`${name} matches its golden transcript`, async () => {
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
