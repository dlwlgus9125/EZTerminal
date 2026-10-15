/* Capture production Storybook stories for review gates.
 *
 *   node scripts/capture-storybook-stories.cjs <outDir> <storyId[@theme]>... [--width=1440 --height=900 --locale=ko]
 *
 * Requires `pnpm storybook` on 127.0.0.1:6006. Never updates committed snapshots. */
const { chromium } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');

(async () => {
  const args = process.argv.slice(2);
  const option = (name, fallback) => args.find(arg => arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
  const [outDir, ...stories] = args.filter(arg => !arg.startsWith('--'));
  if (!outDir || stories.length === 0) throw new Error('Usage: capture-storybook-stories.cjs <outDir> <storyId[@theme]>...');
  const output = path.resolve(outDir);
  await fs.mkdir(output, { recursive: true });
  const width = Number(option('width', '1440'));
  const height = Number(option('height', '900'));
  const locale = option('locale', 'ko');
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
    page.on('pageerror', error => errors.push(String(error)));
    for (const spec of stories) {
      const [story, theme = 'dark'] = spec.split('@');
      const globals = `theme:${theme};locale:${locale};density:adaptive;uiScale:100`;
      await page.goto(`http://127.0.0.1:6006/iframe.html?id=${story}&viewMode=story&globals=${encodeURIComponent(globals)}`);
      await page.locator(`html[data-story-ready^="${story}|"]`).waitFor({ timeout: 120000 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(output, `${story}${theme === 'dark' ? '' : `@${theme}`}.png`), animations: 'disabled' });
    }
  } finally {
    await browser.close();
  }
  process.stdout.write(`${JSON.stringify({ output, stories: stories.length, errors })}\n`);
})().catch(error => { console.error(error); process.exitCode = 1; });
