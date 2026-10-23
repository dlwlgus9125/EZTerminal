import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertCanonicalPng,
  validateApprovedSurface,
  validateDesignReferenceManifest,
  validateDesktopHandoffContract,
} from '../scripts/design-reference-guard-core.mjs';

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

function readReference() {
  return {
    manifest: JSON.parse(readFileSync(resolve(root, 'docs/ux/reference/2.0/manifest.json'), 'utf8')),
    legacyManifest: JSON.parse(readFileSync(resolve(root, 'docs/ux/reference/desktop-handoff/manifest.json'), 'utf8')),
  };
}

const SHA = 'a'.repeat(64);

function approved(overrides: Record<string, unknown> = {}) {
  return {
    id: 'shell-desktop',
    title: 'Desktop shell',
    story: { file: 'src/renderer/shell/Shell2.stories.tsx', export: 'DesktopShell' },
    visual: { snapshot: 'shell-desktop.png' },
    capture: { file: 'docs/ux/reference/2.0/captures/shell-desktop.png', sha256: SHA },
    approval: { record: 'docs/ux/overhaul/approvals.md#gate-2', decidedAt: '2026-11-01' },
    replaces: ['workbench-agent-hub'],
    ...overrides,
  };
}

describe('2.0 design reference manifest', () => {
  it('accepts the checked-in manifest: every 1.0 handoff surface is still guarded as legacy', () => {
    const { manifest, legacyManifest } = readReference();
    const result = validateDesignReferenceManifest(manifest, legacyManifest);
    expect(result.legacy).toHaveLength(14);
    expect(result.approved).toHaveLength(0);
  });

  it('rejects a 1.0 surface that silently drops out of the guard', () => {
    const { manifest, legacyManifest } = readReference();
    const next = structuredClone(manifest);
    next.legacy.surfaces = next.legacy.surfaces.filter((id: string) => id !== 'monitor');
    expect(() => validateDesignReferenceManifest(next, legacyManifest)).toThrow('monitor');
  });

  it('lets an approved surface retire the legacy surfaces it replaces, once', () => {
    const { manifest, legacyManifest } = readReference();
    const next = structuredClone(manifest);
    next.legacy.surfaces = next.legacy.surfaces.filter((id: string) => id !== 'workbench-agent-hub');
    next.approved = [approved()];
    expect(validateDesignReferenceManifest(next, legacyManifest).retired).toEqual(['workbench-agent-hub']);

    next.legacy.surfaces.push('workbench-agent-hub');
    expect(() => validateDesignReferenceManifest(next, legacyManifest)).toThrow('both legacy and replaced');
  });

  it('rejects an approved surface without a recorded user decision or pinned capture', () => {
    const { manifest, legacyManifest } = readReference();
    const next = structuredClone(manifest);
    next.approved = [approved({ approval: { decidedAt: '2026-11-01' }, replaces: [] })];
    expect(() => validateDesignReferenceManifest(next, legacyManifest)).toThrow('approval.record');
    next.approved = [approved({ capture: { file: 'x.png', sha256: 'nope' }, replaces: [] })];
    expect(() => validateDesignReferenceManifest(next, legacyManifest)).toThrow('capture.sha256');
  });

  it('checks an approved surface against its story export, visual snapshot and capture bytes', () => {
    const entry = approved();
    const ok = {
      storySource: 'export const DesktopShell: Story = {};',
      availableSnapshots: new Set(['shell-desktop.png']),
      captureSha256: SHA,
    };
    expect(() => validateApprovedSurface(entry, ok)).not.toThrow();
    expect(() => validateApprovedSurface(entry, { ...ok, storySource: 'const DesktopShell = {};' })).toThrow('DesktopShell');
    expect(() => validateApprovedSurface(entry, { ...ok, availableSnapshots: new Set() })).toThrow('shell-desktop.png');
    expect(() => validateApprovedSurface(entry, { ...ok, captureSha256: 'b'.repeat(64) })).toThrow('capture');
  });
});

describe('desktop handoff structural guard (legacy 1.0 surfaces)', () => {
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
