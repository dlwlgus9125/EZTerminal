import { test, expect } from '@playwright/test';

import { launchApp } from './launch-app';

// WT-parity M1: confirms main.ts actually WIRES the terminal-safe menu
// (app-menu.ts's buildMenuTemplate) via Menu.setApplicationMenu — the unit
// test in src/main/app-menu.test.ts covers the template shape itself.

test('app menu: a terminal-safe menu is installed with no reload item', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  const menuInfo = await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    const hasRole = (role: string): boolean => {
      const walk = (items: Electron.MenuItem[]): boolean =>
        items.some((item) => item.role === role || (item.submenu ? walk(item.submenu.items) : false));
      return menu ? walk(menu.items) : false;
    };
    return {
      installed: menu !== null,
      hasReload: hasRole('reload') || hasRole('forceReload') || hasRole('close'),
      hasCopy: hasRole('copy'),
    };
  });

  expect(menuInfo.installed).toBe(true);
  expect(menuInfo.hasReload).toBe(false);
  expect(menuInfo.hasCopy).toBe(true);

  await app.close();
});
