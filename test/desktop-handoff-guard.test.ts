import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertCanonicalPng,
  validateDesktopHandoffContract,
} from '../scripts/desktop-handoff-guard-core.mjs';

const root = resolve(import.meta.dirname, '..');
const snapshotRoot = resolve(
  root,
  'visual/__snapshots__/storybook.visual.spec.ts',
);

function readFixture() {
  return {
    availableSnapshots: new Set(readdirSync(snapshotRoot)),
    e2eSource: readFileSync(resolve(root, 'e2e/workbench-shell.spec.ts'), 'utf8'),
    manifest: JSON.parse(
      readFileSync(
        resolve(root, 'docs/ux/reference/desktop-handoff/manifest.json'),
        'utf8',
      ),
    ),
    storySource: readFileSync(
      resolve(root, 'src/renderer/workbench/DesktopHandoff.stories.tsx'),
      'utf8',
    ),
    visualSource: readFileSync(
      resolve(root, 'visual/storybook.visual.spec.ts'),
      'utf8',
    ),
  };
}

function replaceLast(source: string, search: string, replacement: string): string {
  const index = source.lastIndexOf(search);
  return index < 0
    ? source
    : `${source.slice(0, index)}${replacement}${source.slice(index + search.length)}`;
}

describe('desktop handoff structural guard', () => {
  it('rejects a canonical snapshot with a corrupted PNG signature', () => {
    expect(() => assertCanonicalPng(
      new Uint8Array([0x00, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
      'desktop-handoff-01-boot.png',
    )).toThrow('Canonical snapshot does not have a valid PNG signature');
  });

  it('accepts the checked-in manifest, stories, visual matrix, and Electron path', () => {
    expect(() => validateDesktopHandoffContract(readFixture())).not.toThrow();
  });

  it.each([
    {
      name: 'a manifest-bound Storybook export',
      mutate: (fixture: ReturnType<typeof readFixture>) => ({
        ...fixture,
        storySource: fixture.storySource.replace(
          'export const CommandCenter: Story',
          'const CommandCenter: Story',
        ),
      }),
      message: 'Story export CommandCenter',
    },
    {
      name: 'a canonical PNG snapshot',
      mutate: (fixture: ReturnType<typeof readFixture>) => {
        const availableSnapshots = new Set(fixture.availableSnapshots);
        availableSnapshots.delete('desktop-handoff-01-boot.png');
        return { ...fixture, availableSnapshots };
      },
      message: 'Canonical snapshot file is missing',
    },
    {
      name: 'the supporting import closure role',
      mutate: (fixture: ReturnType<typeof readFixture>) => {
        const manifest = structuredClone(fixture.manifest);
        manifest.sourceRoles.supportingImportClosure = [];
        return { ...fixture, manifest };
      },
      message: 'sourceRoles.supportingImportClosure',
    },
    {
      name: 'a pinned source SHA-256',
      mutate: (fixture: ReturnType<typeof readFixture>) => {
        const manifest = structuredClone(fixture.manifest);
        manifest.extractedFiles['support.js'] = 'not-a-sha256';
        return { ...fixture, manifest };
      },
      message: 'support.js needs a lowercase SHA-256',
    },
    {
      name: 'a canonical surface case',
      mutate: (fixture: ReturnType<typeof readFixture>) => ({
        ...fixture,
        visualSource: fixture.visualSource.replace(
          'storyId: "compositions-desktop-handoff--monitor"',
          'storyId: "compositions-desktop-handoff--missing-monitor"',
        ),
      }),
      message: 'compositions-desktop-handoff--monitor',
    },
    {
      name: 'a responsive viewport',
      mutate: (fixture: ReturnType<typeof readFixture>) => ({
        ...fixture,
        visualSource: replaceLast(
          fixture.visualSource,
          'viewport: { width: 800, height: 600 }',
          'viewport: { width: 801, height: 600 }',
        ),
      }),
      message: '800x600',
    },
    {
      name: 'dual-locale axe coverage',
      mutate: (fixture: ReturnType<typeof readFixture>) => {
        const lastAudit = fixture.visualSource.lastIndexOf(
          'await expectNoAccessibilityViolations(page);',
          fixture.visualSource.indexOf(
            'test.describe("desktop handoff responsive and interaction axes"',
          ),
        );
        return {
          ...fixture,
          visualSource: `${fixture.visualSource.slice(0, lastAudit)}`
            + `${fixture.visualSource.slice(lastAudit).replace(
              'await expectNoAccessibilityViolations(page);',
              'await Promise.resolve();',
            )}`,
        };
      },
      message: 'both locales',
    },
    {
      name: 'keyboard focus restoration',
      mutate: (fixture: ReturnType<typeof readFixture>) => ({
        ...fixture,
        visualSource: fixture.visualSource.replace(
          'await page.keyboard.press("Shift+Tab");',
          'await page.keyboard.press("ArrowDown");',
        ),
      }),
      message: 'Shift+Tab',
    },
    {
      name: 'unfrozen reduced-motion behavior',
      mutate: (fixture: ReturnType<typeof readFixture>) => ({
        ...fixture,
        visualSource: fixture.visualSource.replace(
          'freezeAnimations: false',
          'freezeAnimations: true',
        ),
      }),
      message: 'animation freezer',
    },
  ])('rejects removal of $name', ({ mutate, message }) => {
    expect(() => validateDesktopHandoffContract(mutate(readFixture()))).toThrow(
      message,
    );
  });
});
