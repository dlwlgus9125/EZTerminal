import { describe, expect, it } from 'vitest';

import { rememberBlockEnd, rememberBlockStart, rememberedBlockTiming } from './block-timing';

describe('block timing', () => {
  it('remembers the first start and end of a run and nothing for an unknown one', () => {
    rememberBlockStart('run-a', 100);
    rememberBlockStart('run-a', 999);
    expect(rememberedBlockTiming('run-a')).toEqual({ startedAtMs: 100 });
    rememberBlockEnd('run-a', 400);
    rememberBlockEnd('run-a', 900);
    expect(rememberedBlockTiming('run-a')).toEqual({ startedAtMs: 100, endedAtMs: 400 });
    rememberBlockEnd('run-unknown', 5);
    expect(rememberedBlockTiming('run-unknown')).toEqual({});
  });

  it('keeps a bounded number of runs, oldest out first', () => {
    for (let index = 0; index < 1_005; index += 1) rememberBlockStart(`bulk-${index}`, index);
    expect(rememberedBlockTiming('bulk-0')).toEqual({});
    expect(rememberedBlockTiming('bulk-1004')).toEqual({ startedAtMs: 1_004 });
  });
});
