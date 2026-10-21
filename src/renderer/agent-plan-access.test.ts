// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { inheritPlanAccess, movePlanAccess, readLastAccess, readPlanAccess, resetPlanAccessForTests, writeLastAccess, writePlanAccess } from './agent-plan-access';

describe('plan access memory', () => {
  beforeEach(() => { window.localStorage.clear(); resetPlanAccessForTests(); });
  afterEach(() => vi.restoreAllMocks());

  it('asks before running when nothing was chosen, never full access', () => {
    expect(readPlanAccess('session-a')).toBe('standard');
  });

  it('remembers the level per conversation across a reload', () => {
    writePlanAccess('session-a', 'full-access');
    writePlanAccess('session-b', 'standard');
    resetPlanAccessForTests();
    expect(readPlanAccess('session-a')).toBe('full-access');
    expect(readPlanAccess('session-b')).toBe('standard');
  });

  it('remembers the access level the person last chose, for new conversations', () => {
    expect(readLastAccess()).toBeUndefined();
    writeLastAccess('full-access');
    resetPlanAccessForTests();
    expect(readLastAccess()).toBe('full-access');
  });

  it('gives a continued or cleared conversation its source plan level, without replacing one already chosen', () => {
    writePlanAccess('source', 'full-access');
    inheritPlanAccess('source', 'continued');
    expect(readPlanAccess('continued')).toBe('full-access');
    writePlanAccess('chosen', 'standard');
    inheritPlanAccess('source', 'chosen');
    expect(readPlanAccess('chosen')).toBe('standard');
    inheritPlanAccess('missing', 'other');
    expect(readPlanAccess('other')).toBe('standard');
  });

  it('moves a draft choice to the session it became', () => {
    writePlanAccess('draft-1', 'full-access');
    movePlanAccess('draft-1', 'session-new');
    expect(readPlanAccess('session-new')).toBe('full-access');
    expect(readPlanAccess('draft-1')).toBe('standard');
    movePlanAccess('missing', 'session-other');
    expect(readPlanAccess('session-other')).toBe('standard');
  });

  it('keeps only the newest 200 conversations', () => {
    for (let index = 0; index < 205; index += 1) writePlanAccess(`session-${index}`, 'full-access');
    resetPlanAccessForTests();
    expect(readPlanAccess('session-0')).toBe('standard');
    expect(readPlanAccess('session-204')).toBe('full-access');
    expect(JSON.parse(window.localStorage.getItem('ezterminal.agent.plan-access.v1')!)).toHaveLength(200);
  });

  it('ignores a corrupt store and keeps working when storage refuses writes', () => {
    window.localStorage.setItem('ezterminal.agent.plan-access.v1', '{not json');
    expect(readPlanAccess('session-a')).toBe('standard');
    window.localStorage.setItem('ezterminal.agent.plan-access.v1', JSON.stringify([['session-a', 'plan'], ['session-b', 'full-access']]));
    resetPlanAccessForTests();
    expect(readPlanAccess('session-a')).toBe('standard');
    expect(readPlanAccess('session-b')).toBe('full-access');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    writePlanAccess('session-c', 'full-access');
    expect(readPlanAccess('session-c')).toBe('full-access');
  });
});
