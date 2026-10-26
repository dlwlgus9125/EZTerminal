import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { FEATURES, TEST_IDS, parseArguments } from '../scripts/profile-runtime.mjs';

const RENDERER = path.resolve(__dirname, '..', 'src', 'renderer');

function productSource(directory: string): string {
  return readdirSync(directory, { withFileTypes: true }).map((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return productSource(target);
    if (!/\.tsx?$/u.test(entry.name) || /\.(?:test|stories)\.tsx?$/u.test(entry.name)) return '';
    return readFileSync(target, 'utf8');
  }).join('\n');
}

describe('profile-runtime', () => {
  // The profiler broke silently when the 2.0 shell moved Monitor into the Tools menu.
  it('depends only on test ids that product components render', () => {
    const source = productSource(RENDERER);
    const rendered = (id: string) => [`data-testid="${id}"`, `testId: '${id}'`, `testId="${id}"`, `testId = '${id}'`, `data-testid={'${id}'}`]
      .some((form) => source.includes(form));
    expect(TEST_IDS.filter((id) => !rendered(id))).toEqual([]);
  });

  it('opens Monitor and Remote straight from the live list tool row', () => {
    expect(FEATURES.filter((feature) => 'menu' in feature)).toEqual([]);
    expect(FEATURES.map((feature) => feature.button)).toEqual(['shell-all-projects', 'btn-toggle-stats', 'rail-remote', 'btn-toggle-settings']);
    // 모든 프로젝트 is a dialog over the shell: it is closed before the next button.
    expect(FEATURES[0]).toMatchObject({ target: 'all-projects-dialog', close: 'Escape' });
  });

  it('keeps chat launches separate from interaction launches', () => {
    expect(() => parseArguments(['--chat', '--interactions'])).toThrow(/separate launches/u);
    expect(parseArguments(['--chat', '--samples', '1', '--skip-build'])).toMatchObject({ chat: true, interactions: false, samples: 1, skipBuild: true });
    expect(parseArguments(['--chat']).output).toMatch(/chat-profile\.json$/u);
  });
});
