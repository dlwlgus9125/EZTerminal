import { describe, expect, it } from 'vitest';

import { agentUsageLevel } from './agent-usage';
import { AUTOMATIC_CALL_PAUSE_LEVEL, AUTOMATIC_CALLS } from './automatic-calls';

describe('automatic call policy', () => {
  it('lists reviews as never automatic', () => {
    expect(AUTOMATIC_CALLS.review).toEqual({ automatic: false, pausesNearLimit: false });
  });

  it('ties each automatic call to its setting and stops it near the limit', () => {
    expect(AUTOMATIC_CALLS['next-prompt-suggestion']).toEqual({ automatic: true, setting: 'suggestions', pausesNearLimit: true });
    expect(AUTOMATIC_CALLS['turn-recap']).toEqual({ automatic: true, setting: 'recaps', pausesNearLimit: true });
  });

  it('pauses at the usage display’s danger level, 90% or more', () => {
    expect(agentUsageLevel(90)).toBe(AUTOMATIC_CALL_PAUSE_LEVEL);
    expect(agentUsageLevel(89)).not.toBe(AUTOMATIC_CALL_PAUSE_LEVEL);
  });
});
