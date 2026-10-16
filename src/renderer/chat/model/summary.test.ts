import { describe, expect, it } from 'vitest';

import { workspacePath } from './summary';

describe('workspacePath', () => {
  it('shows paths inside the workspace relative to it, whatever the case of the root', () => {
    expect(workspacePath('C:\\Work\\App\\src\\app.ts', 'c:\\work\\app')).toBe('src\\app.ts');
    expect(workspacePath('<WORKSPACE>\\notes.md')).toBe('notes.md');
  });

  it('keeps paths outside the workspace, including a sibling sharing its prefix', () => {
    expect(workspacePath('C:\\Work\\App2\\x.ts', 'C:\\Work\\App')).toBe('C:\\Work\\App2\\x.ts');
    expect(workspacePath('D:\\other\\y.ts', 'C:\\Work\\App')).toBe('D:\\other\\y.ts');
  });
});
