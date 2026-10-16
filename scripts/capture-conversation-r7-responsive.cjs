/* Actual production components with deterministic provider records. No snapshot updates. */
const { chromium } = require('@playwright/test');
const { AxeBuilder } = require('@axe-core/playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
  const output = path.resolve('artifacts/conversation-r7/responsive');
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const report = [];
  try {
    for (const theme of ['dark', 'light', 'high-contrast', 'matrix']) {
      for (const [width, height, story] of [[320, 640, 'mobile-change-review'], [390, 844, 'mobile-change-review'], [600, 400, 'change-review'], [1440, 1000, 'change-review']]) {
        const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
        const page = await context.newPage(); const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        const id = `agents-structured-session--${story}`;
        await page.goto(`http://127.0.0.1:6006/iframe.html?id=${id}&viewMode=story&globals=${encodeURIComponent(`theme:${theme};locale:ko;density:compact;uiScale:100`)}`);
        await page.locator(`html[data-story-ready="${id}|${theme}|ko|compact|100"]`).waitFor();
        const prefix = `${theme}-${width}x${height}`;
        const geometry = await page.evaluate(() => {
          const input = document.querySelector('textarea').getBoundingClientRect();
          return { overflow: document.documentElement.scrollWidth > innerWidth, input: { top: input.top, bottom: input.bottom }, viewport: innerHeight };
        });
        await page.screenshot({ path: path.join(output, `${prefix}-chat.png`) });
        await page.locator('.conversation-review__trigger').click();
        await page.locator('[data-testid="conversation-change-review"]').waitFor();
        await page.screenshot({ path: path.join(output, `${prefix}-review.png`) });
        const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
        await page.locator('.conversation-review__line[data-kind="add"]').click();
        await page.getByRole('button', { name: '선택한 줄 인용', exact: true }).click();
        const quoted = (await page.locator('textarea').inputValue()).includes('+  border-color: var(--ui-focus);');
        report.push({ theme, width, height, geometry, quoted, errors, violations: accessibility.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) })) });
        await context.close();
      }
    }
  } finally { await browser.close(); }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (report.some(result => result.errors.length || result.violations.length || !result.quoted || result.geometry.overflow || result.geometry.input.bottom > result.geometry.viewport)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
