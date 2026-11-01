import { describe, expect, it } from 'vitest';

import { agentUsageLevel } from './agent-usage';
import { AUTOMATIC_CALL_PAUSE_LEVEL, AUTOMATIC_CALLS } from './automatic-calls';
import { DEFAULT_LONG_RUN_SETTINGS } from './long-run';

describe('automatic call policy', () => {
  it('lists reviews as never automatic', () => {
    expect(AUTOMATIC_CALLS.review).toEqual({ automatic: false, pausesNearLimit: false });
  });

  it('ties each automatic call to its setting and stops it near the limit', () => {
    expect(AUTOMATIC_CALLS['next-prompt-suggestion']).toEqual({ automatic: true, setting: 'suggestions', pausesNearLimit: true });
    expect(AUTOMATIC_CALLS['turn-recap']).toEqual({ automatic: true, setting: 'recaps', pausesNearLimit: true });
  });

  it('ties auto-resume to its own switch and does not pause it near the limit', () => {
    const autoResume = AUTOMATIC_CALLS['auto-resume'];
    expect(autoResume).toEqual({ automatic: true, setting: 'autoResume', pausesNearLimit: false });
    expect(DEFAULT_LONG_RUN_SETTINGS).toHaveProperty(autoResume.setting);
  });

  it('pauses at the usage display’s danger level, 90% or more', () => {
    expect(agentUsageLevel(90)).toBe(AUTOMATIC_CALL_PAUSE_LEVEL);
    expect(agentUsageLevel(89)).not.toBe(AUTOMATIC_CALL_PAUSE_LEVEL);
  });
});
