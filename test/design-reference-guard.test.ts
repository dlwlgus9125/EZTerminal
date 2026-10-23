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
    visual: { storyId: 'shell-2-0--desktop-shell', snapshot: 'shell-desktop.png' },
    capture: { file: 'docs/ux/reference/2.0/captures/shell-desktop.png', sha256: SHA },
    approval: { record: 'docs/ux/overhaul/approvals.md#gate-2-shell', decidedAt: '2026-11-01' },
    replaces: ['workbench-agent-hub'],
    ...overrides,
  };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

/** A visual spec that executes the approved case on every promised axis. */
const VISUAL_CASE = '{ storyId: "shell-2-0--desktop-shell", screenshot: "shell-desktop.png", readySelector: "[data-testid=shell2]", locale: "ko", viewports: [{ width: 1440, height: 900 }, { width: 1024, height: 720 }] }';
const VISUAL_LOOP = [
  'for (const referenceCase of designReferenceCases) {',
  '  test(referenceCase.storyId, async ({ page }) => {',
  '    const alternateLocale = referenceCase.locale === "ko" ? "en" : "ko";',
  '    await openStory(page, referenceCase.storyId, { locale: referenceCase.locale });',
  '    await expectNoAccessibilityViolations(page);',
  '    await expect(page).toHaveScreenshot(referenceCase.screenshot);',
  '    await page.keyboard.press("Tab");',
  '    await page.keyboard.press("Shift+Tab");',
  '    for (const size of referenceCase.viewports) {',
  '      await page.setViewportSize(size);',
  '      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);',
  '    }',
  '    await openStory(page, referenceCase.storyId, { locale: alternateLocale });',
  '    await expectNoAccessibilityViolations(page);',
  '  });',
  '}',
].join('\n');
const visualSpec = (cases = VISUAL_CASE, loop = VISUAL_LOOP) => `const designReferenceCases = [${cases}];\n${loop}`;
const APPROVAL = ['# ux2 기록', '', '## Gate 2 shell', '', '| 화면 | 결정 | 답 |', '|---|---|---|', '| shell-desktop | 셸 구성 | B안, 레일 5칸 |'].join('\n');

function approvedEvidence(overrides: Record<string, unknown> = {}) {
  return {
    storySource: 'export const DesktopShell: Story = {};',
    visualSource: visualSpec(),
    availableSnapshots: new Set(['shell-desktop.png']),
    captureBytes: PNG,
    captureSha256: SHA,
    approvalSource: APPROVAL,
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

  it('checks an approved surface against a real story export, visual case, capture and recorded decision', () => {
    const entry = approved();
    expect(() => validateApprovedSurface(entry, approvedEvidence())).not.toThrow();
    expect(() => validateApprovedSurface(entry, approvedEvidence({ storySource: ['// export const DesktopShell = 1;', 'const DesktopShell = {};'].join('\n') }))).toThrow('DesktopShell');
    expect(() => validateApprovedSurface(entry, approvedEvidence({ visualSource: visualSpec('{ storyId: "other", screenshot: "other.png", readySelector: "x", locale: "ko", viewports: [{ width: 1, height: 1 }, { width: 2, height: 2 }] }') }))).toThrow('exactly one case');
    expect(() => validateApprovedSurface(entry, approvedEvidence({ availableSnapshots: new Set() }))).toThrow('shell-desktop.png');
    expect(() => validateApprovedSurface(entry, approvedEvidence({ captureSha256: 'b'.repeat(64) }))).toThrow('capture');
    expect(() => validateApprovedSurface(entry, approvedEvidence({ captureBytes: new Uint8Array([1, 2, 3]) }))).toThrow('PNG');
    expect(() => validateApprovedSurface(entry, approvedEvidence({ approvalSource: ['# ux2 기록', '', '## Gate 1'].join('\n') }))).toThrow('gate-2-shell');
    expect(() => validateApprovedSurface(approved({ approval: { record: 'docs/ux/overhaul/approvals.md#gate-2-shell', decidedAt: 'soon' } }), approvedEvidence())).toThrow('decidedAt');
  });

  it('rejects the loopholes of a string-only check: loose strings, impossible dates, a heading without an answer', () => {
    const entry = approved();
    // The story id and snapshot appear, but in an array no test runs.
    const loose = `const unrelated = ["shell-2-0--desktop-shell", "shell-desktop.png"];\n${VISUAL_LOOP}`;
    expect(() => validateApprovedSurface(entry, approvedEvidence({ visualSource: loose }))).toThrow('designReferenceCases');
    expect(() => validateApprovedSurface(approved({ approval: { record: 'docs/ux/overhaul/approvals.md#gate-2-shell', decidedAt: '2026-99-99' } }), approvedEvidence())).toThrow('real YYYY-MM-DD');
    expect(() => validateApprovedSurface(approved({ approval: { record: 'docs/ux/overhaul/approvals.md#gate-2-shell', decidedAt: '2026-02-30' } }), approvedEvidence())).toThrow('real YYYY-MM-DD');
    expect(() => validateApprovedSurface(entry, approvedEvidence({ approvalSource: ['# ux2 기록', '', '## Gate 2 shell', '', '결정 답변'].join('\n') }))).toThrow('no row for shell-desktop');
    expect(() => validateApprovedSurface(entry, approvedEvidence({ approvalSource: APPROVAL.replace('B안, 레일 5칸', ' ') }))).toThrow('no recorded answer');
    // A row under a sibling heading does not count for this record.
    expect(() => validateApprovedSurface(entry, approvedEvidence({ approvalSource: APPROVAL.replace('## Gate 2 shell', '## Gate 2 shell\n\n## Other') }))).toThrow('no row for shell-desktop');
  });

  it.each([
    { axis: 'axe in both locales', loop: VISUAL_LOOP.replaceAll('await expectNoAccessibilityViolations(page);', ''), message: 'axe' },
    { axis: 'the screenshot', loop: VISUAL_LOOP.replace('await expect(page).toHaveScreenshot(referenceCase.screenshot);', ''), message: 'screenshot' },
    { axis: 'keyboard focus', loop: VISUAL_LOOP.replace('await page.keyboard.press("Shift+Tab");', ''), message: 'keyboard focus' },
    { axis: 'the viewports', loop: VISUAL_LOOP.replace('await page.setViewportSize(size);', ''), message: 'viewports' },
    { axis: 'horizontal overflow', loop: VISUAL_LOOP.replace('document.documentElement.scrollWidth <= window.innerWidth', 'true'), message: 'overflow' },
    { axis: 'the other locale', loop: VISUAL_LOOP.replace('await openStory(page, referenceCase.storyId, { locale: alternateLocale });', ''), message: 'both its locale' },
  ])('rejects an approved case whose test loop drops $axis', ({ loop, message }) => {
    expect(() => validateApprovedSurface(approved(), approvedEvidence({ visualSource: visualSpec(VISUAL_CASE, loop) }))).toThrow(message);
  });

  it.each([
    { loophole: 'a skipped test', loop: VISUAL_LOOP.replace('  test(referenceCase.storyId', '  test.skip(referenceCase.storyId'), message: 'must not be skipped' },
    { loophole: 'a skip inside the test', loop: VISUAL_LOOP.replace('const alternateLocale', 'test.skip(true, "later");\n    const alternateLocale'), message: 'must not be skipped' },
    { loophole: 'a skipped describe around the loop', loop: `test.describe.skip("reference", () => {\n${VISUAL_LOOP}\n});`, message: 'must not be skipped' },
    { loophole: 'another story', loop: VISUAL_LOOP.replace('openStory(page, referenceCase.storyId, { locale: referenceCase.locale })', 'openStory(page, "shell-2-0--other", { locale: referenceCase.locale })'), message: 'its own story' },
    { loophole: 'another screenshot', loop: VISUAL_LOOP.replace('toHaveScreenshot(referenceCase.screenshot)', 'toHaveScreenshot("other.png")'), message: 'referenceCase.screenshot' },
    { loophole: 'the same locale twice', loop: VISUAL_LOOP.replace('{ locale: alternateLocale }', '{ locale: referenceCase.locale }'), message: 'both its locale' },
    { loophole: 'an alternate locale that is not derived from the case', loop: VISUAL_LOOP.replace('referenceCase.locale === "ko" ? "en" : "ko"', '"ko"'), message: 'alternateLocale' },
    { loophole: 'an overflow check outside the viewport loop', loop: VISUAL_LOOP.replace('      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);\n', '').replace('    await openStory(page, referenceCase.storyId, { locale: alternateLocale });', '    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);\n    await openStory(page, referenceCase.storyId, { locale: alternateLocale });'), message: 'at each viewport' },
  ])('rejects $loophole', ({ loop, message }) => {
    expect(() => validateApprovedSurface(approved(), approvedEvidence({ visualSource: visualSpec(VISUAL_CASE, loop) }))).toThrow(message);
  });

  it('matches the approval row by the exact surface id', () => {
    const near = APPROVAL.replace('| shell-desktop |', '| shell-desktop-old |');
    expect(() => validateApprovedSurface(approved(), approvedEvidence({ approvalSource: near }))).toThrow('no row for shell-desktop');
    expect(() => validateApprovedSurface(approved(), approvedEvidence({ approvalSource: APPROVAL.replace('| shell-desktop |', '| `shell-desktop` |') }))).not.toThrow();
  });

  it('rejects an approved case with fewer than two viewports', () => {
    const single = VISUAL_CASE.replace(', { width: 1024, height: 720 }', '');
    expect(() => validateApprovedSurface(approved(), approvedEvidence({ visualSource: visualSpec(single) }))).toThrow('two literal viewports');
  });

  it('retires the story and visual checks of a replaced 1.0 surface but keeps the rest', () => {
    const fixture = readFixture();
    const withoutMonitor = {
      ...fixture,
      storySource: fixture.storySource.replace('export const Monitor: Story', 'const Monitor: Story'),
    };
    expect(() => validateDesktopHandoffContract(withoutMonitor)).toThrow('Monitor');
    expect(() => validateDesktopHandoffContract({ ...withoutMonitor, retiredSurfaceIds: ['monitor'] })).not.toThrow();
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
