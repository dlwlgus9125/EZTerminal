import { describe, expect, it, vi } from 'vitest';

import {
  requestProjectCodeReveal,
  subscribeProjectCodeReveal,
} from './project-code-navigation';

describe('project code navigation', () => {
  it('delivers a bounded location to the matching file and stops after unsubscribe', () => {
    const listener = vi.fn();
    const target = {
      projectId: 'project-navigation-test',
      rootId: 'root-navigation-test',
      relativePath: 'nested/src/app.ts',
    };
    const unsubscribe = subscribeProjectCodeReveal(target, listener);

    requestProjectCodeReveal(target, { line: 12, column: 4 });
    expect(listener).toHaveBeenCalledWith({ line: 12, column: 4 });

    unsubscribe();
    requestProjectCodeReveal(target, { line: 20 });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
