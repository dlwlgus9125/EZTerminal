// One-off README screenshot capture — launches the real Electron app via
// Playwright's _electron seam (same pattern as e2e/launch-app.ts), drives it
// into a few showcase states, and writes PNGs to docs/screenshots/.
import { _electron as electron } from '@playwright/test';
import path from 'node:path';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAIN = path.join(ROOT, '.vite', 'build', 'main.js');
const OUT = path.join(ROOT, 'docs', 'screenshots');
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const userData = mkdtempSync(path.join(tmpdir(), 'ezterm-shots-'));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.EZTERMINAL_USER_DATA_DIR = userData;

  const app = await electron.launch({ args: [MAIN], env });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  // Resize to a comfortable README size and center.
  const bw = await app.browserWindow(win);
  await bw.evaluate((w, size) => { w.setContentSize(size.w, size.h); w.center(); }, { w: 1440, h: 900 });
  await sleep(700);

  const pane = win.getByTestId('pane').first();
  async function run(cmd, wait = 1300) {
    await pane.getByTestId('cmd-input').fill(cmd);
    await pane.getByTestId('btn-run').click();
    await sleep(wait);
  }

  // ── 01 hero: structured shell blocks ─────────────────────────────────────
  // Builtins only (echo is NOT a builtin here; ',' / em-dash are parse-special).
  await run('cd src');
  await run('ls');
  await run('gen-rows 5 | where n > 2 | sort-by n'); // structured-data pipeline demo
  await run('!node --version', 2000);
  await sleep(800);
  await win.screenshot({ path: path.join(OUT, '01-hero.png') });
  console.log('[shots] 01-hero done');

  // ── 02 Matrix CRT theme ──────────────────────────────────────────────────
  const themeBtn = win.getByTestId('btn-theme');
  let matched = false;
  for (let i = 0; i < 10; i++) {
    const label = (await themeBtn.textContent()) ?? '';
    if (label.toLowerCase().includes('matrix')) { matched = true; break; }
    await themeBtn.click();
    await sleep(500);
  }
  console.log('[shots] theme after cycle:', await themeBtn.textContent(), 'matched=', matched);
  await sleep(1400); // let the CRT scanline/rollbar effect render
  await win.screenshot({ path: path.join(OUT, '02-matrix-crt.png') });
  console.log('[shots] 02-matrix done');

  // ── 03 system status panel ───────────────────────────────────────────────
  await win.getByTestId('btn-toggle-stats').click();
  await sleep(2200); // let CPU/MEM/NET populate a couple of ticks
  await win.screenshot({ path: path.join(OUT, '03-status.png') });
  await win.getByTestId('btn-toggle-stats').click();
  await sleep(400);
  console.log('[shots] 03-status done');

  // ── 04 settings (themes / effects / font / scrollback / remote) ──────────
  await win.getByTestId('btn-toggle-settings').click();
  await sleep(700);
  await win.screenshot({ path: path.join(OUT, '04-settings.png') });
  await win.getByTestId('btn-toggle-settings').click();
  await sleep(400);
  console.log('[shots] 04-settings done');

  // ── 05 split panes ───────────────────────────────────────────────────────
  await win.getByTestId('btn-split-right').click();
  await sleep(1000);
  const panes = win.getByTestId('pane');
  const count = await panes.count();
  if (count > 1) {
    const p2 = panes.nth(count - 1);
    await p2.getByTestId('cmd-input').fill('gen-rows 6 | where n > 3 | sort-by n');
    await p2.getByTestId('btn-run').click();
    await sleep(1200);
  }
  await win.screenshot({ path: path.join(OUT, '05-splits.png') });
  console.log('[shots] 05-splits done, panes=', count);

  await app.close();
  console.log('[shots] ALL DONE ->', OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
