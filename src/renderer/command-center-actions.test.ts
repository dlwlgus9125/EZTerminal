import { describe, expect, it } from 'vitest';

import { buildCommandCenterActionRows } from './command-center-actions';
import { createAppI18n } from './i18n';

describe('buildCommandCenterActionRows', () => {
  it('is the localized product source for every built-in destination', () => {
    const i18n = createAppI18n('ko', ['ko']);
    const rows = buildCommandCenterActionRows(i18n.t, true);

    expect(rows.map((row) => row.target.action)).toEqual([
      'new-tab',
      'split-right',
      'split-down',
      'cycle-theme',
      'save-preset',
      'open-explorer',
      'open-agents',
      'open-monitor',
      'open-remote',
      'open-openclaw',
      'open-settings',
      'toggle-locale',
    ]);
    expect(rows.find((row) => row.id === 'open-settings')?.title).toBe(i18n.t('rail.settings'));
    // 프로젝트 opens the 모든 프로젝트 dialog, not a sidebar.
    expect(rows.find((row) => row.id === 'open-agents')).toMatchObject({ title: '프로젝트', detail: '모든 프로젝트를 찾아 열고, 고정하고, 관리' });
  });

  it('omits OpenClaw when the product capability is not visible', () => {
    const i18n = createAppI18n('en', ['en']);
    const rows = buildCommandCenterActionRows(i18n.t, false);

    expect(rows.some((row) => row.target.action === 'open-openclaw')).toBe(false);
  });
});
