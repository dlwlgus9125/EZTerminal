import path from 'node:path';

import { expect, test as base } from '@playwright/test';

/**
 * Screenshot contracts must render the same pixels on a developer's Windows 11
 * machine and on the Windows Server 2022 CI runner. The UI and terminal font
 * stacks start with Windows 11 faces (Segoe UI Variable, Cascadia) that the
 * runner does not have, and the two systems ship different Consolas builds. So
 * here, and only here: Segoe UI Variable resolves to Segoe UI (identical on
 * both), and the Cascadia names resolve to the bundled JetBrains Mono file. The
 * application's own font stacks are unchanged.
 */
const FONT_ROUTE = '/__ez-visual-fonts/';
const MONO_FILE = path.resolve(__dirname, '..', 'src', 'renderer', 'fonts', 'jetbrains-mono-latin.woff2');
const SEGOE_FACES = [
  ['Segoe UI Light', 300],
  ['Segoe UI', 400],
  ['Segoe UI Semibold', 600],
  ['Segoe UI Bold', 700],
] as const;

export const VISUAL_FONT_ALIASES = [
  ...['Segoe UI Variable Text', 'Segoe UI Variable', 'Segoe UI Variable Display', 'Segoe UI Variable Small'].flatMap((family) => SEGOE_FACES.map(([local, weight]) =>
    `@font-face { font-family: "${family}"; src: local("${local}"); font-weight: ${weight}; font-style: normal; }`)),
  ...['Cascadia Code', 'Cascadia Mono'].map((family) =>
    `@font-face { font-family: "${family}"; src: url("${FONT_ROUTE}mono.woff2") format("woff2"); font-weight: 100 900; font-style: normal; }`),
].join('\n');

export const test = base.extend<{ visualFonts: void }>({
  visualFonts: [async ({ page }, use) => {
    await page.route(`**${FONT_ROUTE}mono.woff2`, (route) => route.fulfill({ path: MONO_FILE, contentType: 'font/woff2' }));
    await page.addInitScript((css) => {
      // An element added before parsing does not survive it; install once the head exists.
      const install = (): void => {
        if (document.querySelector('style[data-ez-visual-fonts]')) return;
        const style = document.createElement('style');
        style.setAttribute('data-ez-visual-fonts', '');
        style.textContent = css;
        document.head.append(style);
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
      else install();
    }, VISUAL_FONT_ALIASES);
    await use();
  }, { auto: true }],
});

export { expect };
export type { Page } from '@playwright/test';
