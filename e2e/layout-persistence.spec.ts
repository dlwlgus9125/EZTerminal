import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { launchApp } from './launch-app';

// Track A ③ (A-M3/M5): layout persistence. The load-bearing property under test
// (Codex B1/B5): a restored panel NEVER resurrects a persisted sessionId — every
// pane gets a brand-new session after restart, while the layout GEOMETRY comes
// back. Corrupt files must quarantine to .corrupt and fall back to the default
// single pane. Design: docs/design/layout-persistence-design.md §8.

function tempUserData(): string {
  return mkdtempSync(path.join(tmpdir(), 'ezterm-layout-e2e-'));
}

const panes = (w: Page) => w.getByTestId('pane');

/** Wait for a pane's session to be adopted and return its session id. */
async function sessionIdOf(w: Page, index: number): Promise<string> {
  await expect(panes(w).nth(index)).toHaveAttribute('data-session-id', /.+/, {
    timeout: 15_000,
  });
  return (await panes(w).nth(index).getAttribute('data-session-id')) as string;
}

/** Deterministically persist the current layout (cancels the save debounce). */
async function flushLayout(w: Page): Promise<void> {
  await w.evaluate(() => {
    const seam = globalThis as unknown as { __ezLayoutFlush?: () => Promise<void> };
    if (!seam.__ezLayoutFlush) throw new Error('__ezLayoutFlush seam missing');
    return seam.__ezLayoutFlush();
  });
}

test('restart-restore: 3-pane layout comes back with ALL-NEW sessions (B1/B5)', async () => {
  const dir = tempUserData();

  // ── first run: build a 3-pane layout (two splits) ─────────────────────────
  const app1 = await launchApp(dir);
  const w1 = await app1.firstWindow();
  await expect(panes(w1)).toHaveCount(1);
  await w1.getByTestId('btn-split-right').click();
  await expect(panes(w1)).toHaveCount(2);
  await w1.getByTestId('btn-split-down').click();
  await expect(panes(w1)).toHaveCount(3);

  const before = [
    await sessionIdOf(w1, 0),
    await sessionIdOf(w1, 1),
    await sessionIdOf(w1, 2),
  ];
  expect(new Set(before).size).toBe(3);

  // Give pane 0 session state (cd) — after restart the NEW session must NOT have it.
  const initialPrompt = (await w1.getByTestId('prompt-cwd').first().textContent()) ?? '';
  await panes(w1).nth(0).getByTestId('cmd-input').fill(`cd ${tmpdir()}`);
  await panes(w1).nth(0).getByTestId('btn-run').click();
  await expect(panes(w1).nth(0).getByTestId('prompt-cwd')).not.toHaveText(initialPrompt, {
    timeout: 15_000,
  });

  await flushLayout(w1);
  await app1.close();
  expect(existsSync(path.join(dir, 'layout.json'))).toBe(true);

  // ── second run: same userData → geometry restored, sessions all fresh ─────
  const app2 = await launchApp(dir);
  const w2 = await app2.firstWindow();
  await expect(panes(w2)).toHaveCount(3, { timeout: 15_000 });

  const after = [
    await sessionIdOf(w2, 0),
    await sessionIdOf(w2, 1),
    await sessionIdOf(w2, 2),
  ];
  expect(new Set(after).size).toBe(3);
  for (const id of after) expect(before).not.toContain(id); // never resurrected

  // Session STATE did not persist: the restored pane starts at the default cwd.
  await expect(panes(w2).nth(0).getByTestId('prompt-cwd')).toHaveText(initialPrompt);

  // No leaked sessions: exactly one live session per restored pane (gate B6).
  await expect
    .poll(() =>
      w2.evaluate(() => {
        const seam = globalThis as unknown as { __ezSessions?: () => number };
        return seam.__ezSessions ? seam.__ezSessions() : -1;
      }),
    )
    .toBe(3);

  // Counter reseed (F6): the next tab must mint tab-4, not collide with tab-1.
  await w2.getByTestId('btn-new-tab').click();
  const ids = await w2.evaluate(() => {
    const seam = globalThis as unknown as { __ezDock?: { panels: Array<{ id: string }> } };
    if (!seam.__ezDock) throw new Error('__ezDock seam missing');
    return seam.__ezDock.panels.map((p) => p.id);
  });
  expect(ids).toContain('tab-4');

  // A restored pane is functional end-to-end (fresh session runs commands).
  await panes(w2).nth(1).getByTestId('cmd-input').fill('gen-rows 3');
  await panes(w2).nth(1).getByTestId('btn-run').click();
  await expect(panes(w2).nth(1).getByTestId('result-table')).toBeVisible({ timeout: 15_000 });

  await app2.close();
});

test('corrupt layout.json (garbage) quarantines and falls back to the default pane', async () => {
  const dir = tempUserData();
  writeFileSync(path.join(dir, 'layout.json'), '{ definitely not json', 'utf8');

  const app = await launchApp(dir);
  const w = await app.firstWindow();
  await expect(panes(w)).toHaveCount(1, { timeout: 15_000 });
  await expect
    .poll(() => existsSync(path.join(dir, 'layout.json.corrupt')), { timeout: 10_000 })
    .toBe(true);

  // Still functional after the fallback.
  await panes(w).nth(0).getByTestId('cmd-input').fill('gen-rows 2');
  await panes(w).nth(0).getByTestId('btn-run').click();
  await expect(panes(w).nth(0).getByTestId('result-table')).toBeVisible({ timeout: 15_000 });
  await app.close();
});

test('a persisted sessionId in panel params is REJECTED (quarantine + default pane)', async () => {
  const dir = tempUserData();
  writeFileSync(
    path.join(dir, 'layout.json'),
    JSON.stringify({
      schemaVersion: 1,
      savedAt: '2026-07-02T00:00:00.000Z',
      layout: {
        grid: { root: { type: 'branch', data: [] }, width: 800, height: 600, orientation: 'HORIZONTAL' },
        panels: {
          'tab-1': {
            id: 'tab-1',
            contentComponent: 'terminal',
            renderer: 'always',
            params: { sessionId: 'stale-session-must-not-resurrect' },
          },
        },
      },
    }),
    'utf8',
  );

  const app = await launchApp(dir);
  const w = await app.firstWindow();
  await expect(panes(w)).toHaveCount(1, { timeout: 15_000 });
  await expect
    .poll(() => existsSync(path.join(dir, 'layout.json.corrupt')), { timeout: 10_000 })
    .toBe(true);
  // The surviving pane runs on a FRESH session, not the persisted id.
  const id = await sessionIdOf(w, 0);
  expect(id).not.toBe('stale-session-must-not-resurrect');
  await app.close();
});

test('presets: save/apply (fresh sessions, no leaks) and startup preset wins over last layout', async () => {
  const dir = tempUserData();
  const app = await launchApp(dir);
  const w = await app.firstWindow();
  await expect(panes(w)).toHaveCount(1);

  // Build a 2-pane layout and save it as the preset "duo".
  await w.getByTestId('btn-split-right').click();
  await expect(panes(w)).toHaveCount(2);
  await w.getByTestId('btn-presets').click();
  await w.getByTestId('btn-save-preset').click();
  await w.getByTestId('preset-name-input').fill('duo');
  await w.getByTestId('preset-save-confirm').click();
  await expect(w.getByTestId('preset-apply-duo')).toBeVisible();
  await w.getByTestId('btn-presets').click(); // close the menu

  // Mutate the layout past the preset (3 panes) and record live session ids.
  await w.getByTestId('btn-new-tab').click();
  await expect(panes(w)).toHaveCount(3);
  const before = [await sessionIdOf(w, 0), await sessionIdOf(w, 1), await sessionIdOf(w, 2)];

  // Apply the preset: confirm dialog accepted → back to 2 panes, ALL sessions new.
  await w.getByTestId('btn-presets').click();
  await w.getByTestId('preset-apply-duo').click();
  await w.getByTestId('risky-close-confirm').click();
  await expect(panes(w)).toHaveCount(2, { timeout: 15_000 });
  const after = [await sessionIdOf(w, 0), await sessionIdOf(w, 1)];
  for (const id of after) expect(before).not.toContain(id);
  await expect
    .poll(() =>
      w.evaluate(() => {
        const seam = globalThis as unknown as { __ezSessions?: () => number };
        return seam.__ezSessions ? seam.__ezSessions() : -1;
      }),
    )
    .toBe(2); // no leaked sessions from the torn-down 3-pane layout (gate B6)

  // Startup preset: star "duo", then make the LAST layout 3 panes again —
  // on relaunch the preset must win (gate Q5 startup pref).
  await w.getByTestId('btn-presets').click();
  await w.getByTestId('preset-star-duo').click();
  await expect(w.getByTestId('preset-star-duo')).toHaveText('★');
  await w.getByTestId('btn-new-tab').click();
  await expect(panes(w)).toHaveCount(3);
  await flushLayout(w);
  await app.close();

  const app2 = await launchApp(dir);
  const w2 = await app2.firstWindow();
  await expect(panes(w2)).toHaveCount(2, { timeout: 15_000 }); // preset beat last-layout
  await app2.close();
});

test('unsupported feature buckets (edgeGroups) are stripped, restore still succeeds', async () => {
  const dir = tempUserData();

  const app1 = await launchApp(dir);
  const w1 = await app1.firstWindow();
  await expect(panes(w1)).toHaveCount(1);
  await w1.getByTestId('btn-split-right').click();
  await expect(panes(w1)).toHaveCount(2);
  await flushLayout(w1);
  await app1.close();

  // Inject an unsupported bucket into the persisted layout (gate B4).
  const file = path.join(dir, 'layout.json');
  const env = JSON.parse(readFileSync(file, 'utf8')) as { layout: Record<string, unknown> };
  env.layout.edgeGroups = [{ anything: true }];
  writeFileSync(file, JSON.stringify(env), 'utf8');

  const app2 = await launchApp(dir);
  const w2 = await app2.firstWindow();
  await expect(panes(w2)).toHaveCount(2, { timeout: 15_000 }); // stripped, NOT quarantined
  expect(existsSync(path.join(dir, 'layout.json.corrupt'))).toBe(false);
  await app2.close();
});
