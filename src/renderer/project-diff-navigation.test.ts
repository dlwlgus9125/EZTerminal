import { describe, expect, it, vi } from 'vitest';

import {
  findRegisteredProjectFileTarget,
  projectRelativeReviewHint,
  requestProjectDiffReveal,
  subscribeProjectDiffReveal,
} from './project-diff-navigation';

describe('project diff navigation', () => {
  it('normalizes only paths contained by the selected project root', () => {
    expect(projectRelativeReviewHint('src\\app.ts', 'C:\\Work\\Demo')).toBe('src/app.ts');
    expect(projectRelativeReviewHint('c:\\work\\demo\\src\\app.ts', 'C:\\Work\\Demo'))
      .toBe('src/app.ts');
    expect(projectRelativeReviewHint('/work/demo/src/app.ts', '/work/demo')).toBe('src/app.ts');
    expect(projectRelativeReviewHint('..\\outside.ts', 'C:\\Work\\Demo')).toBeNull();
    expect(projectRelativeReviewHint('C:\\Work\\Other\\app.ts', 'C:\\Work\\Demo')).toBeNull();
    expect(projectRelativeReviewHint('\\\\server\\share\\demo\\src\\app.ts', '\\\\SERVER\\share\\demo'))
      .toBe('src/app.ts');
  });

  it('maps an absolute file to the deepest registered project root', async () => {
    const describeProject = vi.fn(async (projectId: string) => ({
      ok: true as const,
      project: {
        projectId,
        name: projectId,
        roots: [{
          rootId: projectId === 'nested' ? 'nested-root' : 'outer-root',
          name: projectId,
          displayPath: projectId === 'nested' ? 'C:\\Work\\Demo\\packages\\app' : 'C:\\Work\\Demo',
          primary: true,
        }],
      },
    }));
    const target = await findRegisteredProjectFileTarget(
      'c:\\work\\demo\\packages\\app\\src\\index.ts',
      {
        listProjects: async () => ({
          items: [
            { projectId: 'outer', name: 'Outer', primaryRoot: 'C:\\Work\\Demo', additionalRoots: [], pinned: true, saved: true, sessionCount: 1, providers: ['codex'], lastActiveAt: 1 },
            { projectId: 'nested', name: 'Nested', primaryRoot: 'C:\\Work\\Demo\\packages\\app', additionalRoots: [], pinned: true, saved: true, sessionCount: 1, providers: ['codex'], lastActiveAt: 1 },
          ],
          nextCursor: null,
        }),
        describeProject,
      },
    );
    expect(target).toEqual({ projectId: 'nested', rootId: 'nested-root', relativePath: 'src/index.ts' });
    expect(describeProject).toHaveBeenCalledTimes(1);
    expect(describeProject).toHaveBeenCalledWith('nested');
  });

  it('delivers a bounded reveal queued before mount and later reveals immediately', () => {
    const target = {
      projectId: 'project-navigation-test',
      rootId: 'root-navigation-test',
      scope: 'last-turn' as const,
      historyId: 'history-navigation-test',
      reviewTurnId: 'turn-navigation-test',
    };
    const listener = vi.fn();
    requestProjectDiffReveal(target, 'src/first.ts');
    const unsubscribe = subscribeProjectDiffReveal(target, listener);
    expect(listener).toHaveBeenCalledWith('src/first.ts');

    requestProjectDiffReveal(target, 'src/second.ts');
    expect(listener).toHaveBeenLastCalledWith('src/second.ts');
    unsubscribe();
  });

  it('keeps selected-turn reveal intents isolated inside the same history', () => {
    const base = {
      projectId: 'project-navigation-test',
      rootId: 'root-navigation-test',
      scope: 'last-turn' as const,
      historyId: 'history-navigation-test',
    };
    const selectedTurn = { ...base, reviewTurnId: 'turn-1' };
    requestProjectDiffReveal(selectedTurn, 'src/selected.ts');

    const latestListener = vi.fn();
    const selectedListener = vi.fn();
    const unsubscribeLatest = subscribeProjectDiffReveal(base, latestListener);
    const unsubscribeSelected = subscribeProjectDiffReveal(selectedTurn, selectedListener);
    expect(latestListener).not.toHaveBeenCalled();
    expect(selectedListener).toHaveBeenCalledWith('src/selected.ts');
    unsubscribeLatest();
    unsubscribeSelected();
  });

  it('keeps nested-repository reveal intents isolated from the outer repository panel', () => {
    const base = {
      projectId: 'project-navigation-test',
      rootId: 'root-navigation-test',
      scope: 'working-tree' as const,
    };
    const nested = { ...base, repositoryRelativePath: 'out/manual-test-project' };
    requestProjectDiffReveal(nested, 'src/app.ts');

    const outerListener = vi.fn();
    const nestedListener = vi.fn();
    const unsubscribeOuter = subscribeProjectDiffReveal(base, outerListener);
    const unsubscribeNested = subscribeProjectDiffReveal(nested, nestedListener);
    expect(outerListener).not.toHaveBeenCalled();
    expect(nestedListener).toHaveBeenCalledWith('src/app.ts');
    unsubscribeOuter();
    unsubscribeNested();
  });
});
