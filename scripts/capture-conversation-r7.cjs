/* Production Storybook captures; never updates the frozen handoff or snapshots. */
const { chromium } = require('@playwright/test');
const { AxeBuilder } = require('@axe-core/playwright');
const fs = require('node:fs/promises');
const path = require('node:path');

(async () => {
  const stage = process.argv[2] || 'after';
  if (!['before', 'after'].includes(stage)) throw new Error('Use before or after');
  const output = path.resolve('artifacts/conversation-r7', stage);
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const report = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    for (const theme of ['dark', 'light', 'high-contrast', 'matrix']) {
      for (const skin of ['bubble', 'cli']) {
        const story = `agents-structured-session--${skin}-conversation`;
        const globals = `theme:${theme};locale:ko;density:compact;uiScale:100`;
        await page.goto(`http://127.0.0.1:6006/iframe.html?id=${story}&viewMode=story&globals=${encodeURIComponent(globals)}`);
        await page.locator(`html[data-story-ready="${story}|${theme}|ko|compact|100"]`).waitFor({ timeout: 120000 });
        await page.locator('[data-testid="structured-agent-session"]').waitFor();
        await page.screenshot({ path: path.join(output, `${theme}-${skin}.png`), animations: 'disabled' });
        const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
        report.push({ theme, skin, violations: accessibility.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) })) });
      }
    }
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ stage, errors, cases: report }, null, 2));
    process.stdout.write(JSON.stringify({ stage, output, errors, cases: report.length, violations: report.reduce((count, item) => count + item.violations.length, 0) }) + '\n');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
