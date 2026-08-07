import { describe, expect, it } from 'vitest';

import { projectRelativeReviewHint } from './project-diff-navigation';

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

});
