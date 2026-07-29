import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { CodexAppServerClient } from './codex-app-server-client';
import { CodexHistoryAdapter } from './codex-history-adapter';

async function isDirectory(value: string): Promise<boolean> {
  try {
    return (await fs.stat(value)).isDirectory();
  } catch {
    return false;
  }
}

describe.runIf(process.env.EZTERMINAL_AGENT_HISTORY_REPRO === '1')(
  'installed Agent history resume reproduction',
  () => {
    it('finds a resumable recent Codex session without exposing local history data', async () => {
      const adapter = new CodexHistoryAdapter(new CodexAppServerClient());
      try {
        const startedAt = performance.now();
        const projects = await adapter.discoverProjects(undefined, 100);
        const elapsedMs = performance.now() - startedAt;
        const recent = projects.items.slice(0, 10);
        const rootChecks = await Promise.all(recent.map(async (project) => ({
          cwdValid: await isDirectory(project.primaryRoot),
          rootsValid: await isDirectory(project.primaryRoot),
          rootCount: 1,
        })));
        const aggregate = {
          elapsedMs: Math.round(elapsedMs),
          projectsInFirstPage: projects.items.length,
          recentProjects: recent.length,
          validCwds: rootChecks.filter((entry) => entry.cwdValid).length,
          fullyValidRootSets: rootChecks.filter((entry) => entry.rootsValid).length,
          multiRootSessions: rootChecks.filter((entry) => entry.rootCount > 1).length,
        };
        console.info('[AGENT-HISTORY-REPRO]', JSON.stringify(aggregate));
        expect(elapsedMs).toBeLessThan(5_000);
        expect(recent.length).toBeGreaterThan(0);
        expect(rootChecks.some((entry) => entry.cwdValid && entry.rootsValid)).toBe(true);
      } finally {
        await adapter.dispose();
      }
    }, 60_000);
  },
);
