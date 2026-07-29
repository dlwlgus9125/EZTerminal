import os from 'node:os';

import { describe, expect, it } from 'vitest';

import { ClaudeHistoryAdapter } from './claude-history-adapter';
import { CodexAppServerClient } from './codex-app-server-client';
import { CodexHistoryAdapter } from './codex-history-adapter';

describe.runIf(process.env.EZTERMINAL_AGENT_HISTORY_REPRO === '1')(
  'installed Agent history resume reproduction',
  () => {
    it('queries one terminal-owned project without discovering global Codex projects', async () => {
      const adapter = new CodexHistoryAdapter(new CodexAppServerClient());
      try {
        const startedAt = performance.now();
        const sessions = await adapter.listSessions({
          roots: [process.cwd()],
          limit: 10,
        });
        const elapsedMs = performance.now() - startedAt;
        const aggregate = {
          elapsedMs: Math.round(elapsedMs),
          sessionsInProject: sessions.items.length,
          hasNextPage: sessions.nextCursor !== null,
        };
        console.info('[AGENT-HISTORY-REPRO]', JSON.stringify(aggregate));
        expect(elapsedMs).toBeLessThan(5_000);
      } finally {
        await adapter.dispose();
      }
    }, 60_000);

    it('reads the installed Claude store for this project without loading whole transcripts', async () => {
      const adapter = new ClaudeHistoryAdapter({ homeDir: os.homedir() });
      try {
        const listStartedAt = performance.now();
        const sessions = await adapter.listSessions({ roots: [process.cwd()], limit: 10 });
        const listMs = performance.now() - listStartedAt;
        expect(sessions.items.length).toBeGreaterThan(0);
        for (const session of sessions.items) {
          expect(session.cwd.toLocaleLowerCase('en-US'))
            .toBe(process.cwd().toLocaleLowerCase('en-US'));
        }

        const newest = sessions.items[0]!;
        const readStartedAt = performance.now();
        const page = await adapter.readTranscript(newest.privateId, undefined, 20);
        const readMs = performance.now() - readStartedAt;
        const earlier = page.nextCursor
          ? await adapter.readTranscript(newest.privateId, page.nextCursor, 20)
          : null;

        console.info('[CLAUDE-HISTORY-REPRO]', JSON.stringify({
          listMs: Math.round(listMs),
          readMs: Math.round(readMs),
          sessionsInProject: sessions.items.length,
          hasNextPage: sessions.nextCursor !== null,
          titles: sessions.items.slice(0, 3).map((item) => item.title.slice(0, 60)),
          turnsInFirstPage: page.turns.length,
          entriesInFirstPage: page.turns.reduce((total, turn) => total + turn.entries.length, 0),
          turnsInEarlierPage: earlier?.turns.length ?? 0,
        }));
        expect(page.turns.length).toBeGreaterThan(0);
        expect(page.turns.length).toBeLessThanOrEqual(20);
        expect(listMs).toBeLessThan(5_000);
      } finally {
        await adapter.dispose();
      }
    }, 60_000);
  },
);
