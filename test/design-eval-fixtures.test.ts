import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

interface DesignEvalManifest {
  readonly version: number;
  readonly cases: readonly {
    readonly id: string;
    readonly platform: 'desktop' | 'mobile' | 'cross-platform';
    readonly prompt: string;
  }[];
}

const fixtureRoot = resolve(process.cwd(), 'test/fixtures/design-eval');
const readFixture = (path: string): string => readFileSync(resolve(fixtureRoot, path), 'utf8');
const manifest = JSON.parse(readFixture('cases.json')) as DesignEvalManifest;

describe('design-context agent evaluation fixtures', () => {
  it('defines three unique, readable implementation cases', () => {
    expect(manifest.version).toBe(1);
    expect(manifest.cases).toHaveLength(3);
    expect(new Set(manifest.cases.map(({ id }) => id)).size).toBe(manifest.cases.length);

    for (const fixture of manifest.cases) {
      const prompt = readFixture(fixture.prompt);
      expect(prompt).toContain('## Objective');
      expect(prompt).toContain('## Constraints');
      expect(prompt).toContain('## Completion evidence');
      expect(prompt).toContain('production-backed');
    }
  });

  it('keeps the comparison controlled and the scoring tied to live authorities', () => {
    const protocol = readFixture('README.md');
    const rubric = readFixture('rubric.md');

    for (const term of ['same SHA', 'same model', 'baseline', 'treatment', 'without knowing the condition', 'Do not merge']) {
      expect(protocol).toContain(term);
    }
    expect(rubric).toContain('current `DESIGN.md`');
    expect(rubric).toContain('`docs/ux/frontend-design.md`');
    expect(rubric).toContain('production tokens/components');
    expect(rubric).toContain('Maximum score: 16');
  });

  it('does not turn fixtures into another palette source', () => {
    const allFixtureText = [
      readFixture('README.md'),
      readFixture('rubric.md'),
      ...manifest.cases.map(({ prompt }) => readFixture(prompt)),
    ].join('\n');

    expect(allFixtureText).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
