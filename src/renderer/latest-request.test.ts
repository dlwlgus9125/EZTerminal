import { describe, expect, it } from 'vitest';

import { createLatestRequestGate } from './latest-request';

describe('latest request gate', () => {
  it('allows only the latest generation to commit', () => {
    const gate = createLatestRequestGate();
    const first = gate.begin();
    const second = gate.begin();

    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
  });

  it('invalidates an in-flight generation on demand', () => {
    const gate = createLatestRequestGate();
    const request = gate.begin();
    gate.invalidate();
    expect(gate.isCurrent(request)).toBe(false);
  });
});
