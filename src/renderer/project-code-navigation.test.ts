import { describe, expect, it, vi } from 'vitest';

import {
  flushProjectCodeFocus,
  flushProjectCodeReveal,
  requestProjectCodeFocus,
  requestProjectCodeReveal,
  subscribeProjectCodeFocus,
  subscribeProjectCodeReveal,
} from './project-code-navigation';

describe('project code navigation', () => {
  it('delivers a bounded location to the matching file and stops after unsubscribe', () => {
    const listener = vi.fn(() => true);
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

  it('keeps a reveal pending until the editor acknowledges it is ready', () => {
    const target = {
      projectId: 'project-navigation-pending',
      rootId: 'root-navigation-pending',
      workspaceId: 'workspace-navigation-pending',
      relativePath: 'src/ready-later.ts',
    };
    let ready = false;
    const listener = vi.fn(() => ready);
    requestProjectCodeReveal(target, { line: 42, column: 3 });
    const unsubscribe = subscribeProjectCodeReveal(target, listener);

    expect(listener).toHaveBeenCalledOnce();
    ready = true;
    flushProjectCodeReveal(target);
    flushProjectCodeReveal(target);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith({ line: 42, column: 3 });
    unsubscribe();
  });

  it('keeps focus pending until the canonical editor acknowledges it', () => {
    const target = {
      projectId: 'project-focus-pending',
      rootId: 'root-focus-pending',
      workspaceId: 'workspace-focus-pending',
      relativePath: 'src/focus-later.ts',
    };
    let ready = false;
    const listener = vi.fn(() => ready);
    requestProjectCodeFocus(target);
    const unsubscribe = subscribeProjectCodeFocus(target, listener);

    expect(listener).toHaveBeenCalledOnce();
    ready = true;
    flushProjectCodeFocus(target);
    flushProjectCodeFocus(target);

    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
