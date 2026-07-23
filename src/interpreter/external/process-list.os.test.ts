import { describe, expect, it } from 'vitest';

import { createProcessLister } from './process-list';

describe.runIf(process.platform === 'win32')('Windows process-list integration', () => {
  it('returns at least one real tasklist row', async () => {
    const rows = await createProcessLister()();
    expect(rows.length).toBeGreaterThan(0);
    expect(typeof rows[0].pid).toBe('number');
    expect(typeof rows[0].name).toBe('string');
  });
});
