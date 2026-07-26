import { describe, expect, it } from 'vitest';

import { SETTINGS_CATEGORIES } from './SettingsPanel';

describe('SettingsPanel categories', () => {
  it('exposes the approved categories in navigation order', () => {
    expect(SETTINGS_CATEGORIES.map(({ id }) => id)).toEqual([
      'general',
      'appearance',
      'terminal',
      'agents',
      'integrations',
      'about',
    ]);
  });
});
