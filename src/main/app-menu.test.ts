import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it } from 'vitest';

import { buildMenuTemplate } from './app-menu';

// Accelerators the default Electron menu binds that we must NOT reintroduce
// (case-insensitive — Electron accepts either case for the modifier keys).
const DANGEROUS_ACCELERATORS = [
  /^ctrl\+r$/i,
  /^cmdorctrl\+r$/i,
  /^commandorcontrol\+r$/i,
  /^ctrl\+shift\+r$/i,
  /^cmdorctrl\+shift\+r$/i,
  /^ctrl\+w$/i,
  /^cmdorctrl\+w$/i,
  /^f5$/i,
];

const DANGEROUS_ROLES = new Set(['reload', 'forceReload', 'close']);

/** Recursively walk a menu template, visiting every item (including submenu items). */
function walk(
  items: MenuItemConstructorOptions[],
  visit: (item: MenuItemConstructorOptions) => void,
): void {
  for (const item of items) {
    visit(item);
    if (Array.isArray(item.submenu)) walk(item.submenu, visit);
  }
}

function collect(locale: 'ko' | 'en' = 'en'): MenuItemConstructorOptions[] {
  const all: MenuItemConstructorOptions[] = [];
  walk(buildMenuTemplate(locale), (item) => all.push(item));
  return all;
}

describe('buildMenuTemplate — terminal-safe application menu (WT-parity M1)', () => {
  it('never includes the reload/forceReload/close roles', () => {
    for (const item of collect()) {
      if (typeof item.role === 'string') {
        expect(DANGEROUS_ROLES.has(item.role)).toBe(false);
      }
    }
  });

  it('never binds Ctrl+R, Ctrl+Shift+R, Ctrl+W, or F5', () => {
    for (const item of collect()) {
      if (typeof item.accelerator === 'string') {
        for (const pattern of DANGEROUS_ACCELERATORS) {
          expect(item.accelerator).not.toMatch(pattern);
        }
      }
    }
  });

  it('keeps the Edit clipboard roles (copy/paste/cut/selectAll) for text-field editing', () => {
    const roles = collect().map((item) => item.role);
    expect(roles).toContain('copy');
    expect(roles).toContain('paste');
    expect(roles).toContain('cut');
    expect(roles).toContain('selectAll');
  });

  it('keeps toggleDevTools as a dev affordance', () => {
    const roles = collect().map((item) => item.role);
    expect(roles).toContain('toggleDevTools');
  });

  it('localizes every visible native menu label without changing safe roles', () => {
    expect(buildMenuTemplate('en').map((item) => item.label)).toEqual([
      'File',
      'Edit',
      'View',
      'Window',
    ]);
    expect(buildMenuTemplate('ko').map((item) => item.label)).toEqual([
      '파일',
      '편집',
      '보기',
      '창',
    ]);
    expect(collect('ko').map((item) => item.role)).toEqual(
      collect('en').map((item) => item.role),
    );
  });
});
