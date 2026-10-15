import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const evidence = fileURLToPath(new URL('./evidence/', import.meta.url));
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const report = [];
try {
  for (const [name, story, width, height] of [
    ['current-desktop-chat', 'agents-structured-session--bubble-compose', 1440, 900],
    ['current-desktop-streaming', 'agents-structured-session--streaming', 1440, 900],
    ['current-desktop-approval', 'agents-structured-session--approval', 1440, 900],
    ['current-mobile-chat', 'agents-structured-session--mobile-bubble-compose', 390, 844],
    ['current-navigation', 'production-navigation-conversation-workbench--desktop-native-preview', 1440, 900],
  ]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://localhost:6006/iframe.html?id=${story}&viewMode=story&globals=theme:dark;locale:ko`, { waitUntil: 'networkidle' });
    await page.locator('[data-testid="structured-agent-session"], [data-testid="conversation-start"]').first().waitFor({timeout:60000});
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${evidence}/${name}.png`, fullPage: true });
    const metrics = await page.evaluate(() => ({
      viewport: [innerWidth, innerHeight], documentWidth: document.documentElement.scrollWidth,
      header: document.querySelector('.structured-agent-session-header')?.getBoundingClientRect().toJSON(),
      composer: document.querySelector('.structured-agent-composer')?.getBoundingClientRect().toJSON(),
      transcript: document.querySelector('.structured-agent-transcript')?.getBoundingClientRect().toJSON(),
      content: document.querySelector('#storybook-root')?.innerText,
    }));
    report.push({ name, story, errors, ...metrics });
    console.log(JSON.stringify({ name, errors, headerHeight: metrics.header?.height, composerHeight: metrics.composer?.height, transcriptHeight: metrics.transcript?.height, documentWidth: metrics.documentWidth }));
    await page.close();
  }
  await writeFile(`${evidence}/current-capture.json`, JSON.stringify(report, null, 2));
} finally { await browser.close(); }
