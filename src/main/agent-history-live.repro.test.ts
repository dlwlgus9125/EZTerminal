import { describe, expect, it } from 'vitest';

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
  },
);
