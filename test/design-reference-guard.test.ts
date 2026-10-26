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

/** The visual spec only dispatches each literal case to the pinned checker. */
const VISUAL_CASE = '{ storyId: "shell-2-0--desktop-shell", screenshot: "shell-desktop.png", readySelector: "[data-testid=shell2]", locale: "ko", viewports: [{ width: 1440, height: 900 }, { width: 1024, height: 720 }] }';
const DISPATCH = [
  'for (const referenceCase of designReferenceCases) {',
  '  test(referenceCase.storyId, async ({ page }) => {',
  '    await checkReferenceSurface(page, referenceCase);',
  '  });',
  '}',
].join('\n');
const CHECKER_IMPORT = 'import { checkReferenceSurface } from "./design-reference-checks";';
const visualSpec = (cases = VISUAL_CASE, dispatch = DISPATCH, prelude = CHECKER_IMPORT) => `${prelude}\nconst designReferenceCases = [${cases}];\n${dispatch}`;
/** The pinned checker: every axis, for the case it is given. */
const CHECKER = [
  'export async function checkReferenceSurface(page: Page, item: ReferenceCase): Promise<void> {',
  '  const alternateLocale = item.locale === "ko" ? "en" : "ko";',
  '  await openStory(page, item.storyId, { locale: item.locale });',
  '  await expectNoAccessibilityViolations(page);',
  '  await expect(page).toHaveScreenshot(item.screenshot);',
  '  await page.keyboard.press("Tab");',
  '  await page.keyboard.press("Shift+Tab");',
  '  for (const size of item.viewports) {',
  '    await page.setViewportSize(size);',
  '    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);',
  '  }',
  '  await openStory(page, item.storyId, { locale: alternateLocale });',
  '  await expectNoAccessibilityViolations(page);',
  '}',
].join('\n');
const CHECKER_PIN = { file: 'visual/design-reference-checks.ts', sha256: 'c'.repeat(64) };
const APPROVAL = ['# ux2 기록', '', '## Gate 2 shell', '', '| 화면 | 결정 | 답 |', '|---|---|---|', '| shell-desktop | 셸 구성 | B안, 레일 5칸 |'].join('\n');

function approvedEvidence(overrides: Record<string, unknown> = {}) {
  return {
    storySource: 'export const DesktopShell: Story = {};',
    visualSource: visualSpec(),
    checker: CHECKER_PIN,
    checkerSource: CHECKER,
    checkerSha256: CHECKER_PIN.sha256,
    availableSnapshots: new Set(['shell-desktop.png']),
    captureBytes: PNG,
    captureSha256: SHA,
    approvalSource: APPROVAL,
    ...overrides,
  };
}

describe('2.0 design reference manifest', () => {
  it('accepts the checked-in manifest: the I1 shell, the I2 flow and the I3 terminal are approved and every 1.0 handoff surface is still guarded as legacy', () => {
    const { manifest, legacyManifest } = readReference();
    const result = validateDesignReferenceManifest(manifest, legacyManifest);
    expect(result.legacy).toHaveLength(14);
    expect(result.approved.map((entry: { id: string }) => entry.id)).toEqual(['shell-board', 'shell-work-mode', 'flow-run-view', 'desk-terminal']);
    expect(result.retired).toEqual([]);
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
    next.approvedChecker = CHECKER_PIN;
    expect(validateDesignReferenceManifest(next, legacyManifest).retired).toEqual(['workbench-agent-hub']);

    next.legacy.surfaces.push('workbench-agent-hub');
    expect(() => validateDesignReferenceManifest(next, legacyManifest)).toThrow('both legacy and replaced');
  });

  it('rejects an approved surface without a recorded user decision, pinned capture or pinned checker', () => {
    const { manifest, legacyManifest } = readReference();
    const next = structuredClone(manifest);
    next.approvedChecker = CHECKER_PIN;
    next.approved = [approved({ approval: { decidedAt: '2026-11-01' }, replaces: [] })];
    expect(() => validateDesignReferenceManifest(next, legacyManifest)).toThrow('approval.record');
    next.approved = [approved({ capture: { file: 'x.png', sha256: 'nope' }, replaces: [] })];
    expect(() => validateDesignReferenceManifest(next, legacyManifest)).toThrow('capture.sha256');
    next.approved = [approved({ replaces: [] })];
    delete next.approvedChecker;
    expect(() => validateDesignReferenceManifest(next, legacyManifest)).toThrow('approvedChecker.file');
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
    const loose = `const unrelated = ["shell-2-0--desktop-shell", "shell-desktop.png"];\n${DISPATCH}`;
    expect(() => validateApprovedSurface(entry, approvedEvidence({ visualSource: loose }))).toThrow('designReferenceCases');
    expect(() => validateApprovedSurface(approved({ approval: { record: 'docs/ux/overhaul/approvals.md#gate-2-shell', decidedAt: '2026-99-99' } }), approvedEvidence())).toThrow('real YYYY-MM-DD');
    expect(() => validateApprovedSurface(approved({ approval: { record: 'docs/ux/overhaul/approvals.md#gate-2-shell', decidedAt: '2026-02-30' } }), approvedEvidence())).toThrow('real YYYY-MM-DD');
    expect(() => validateApprovedSurface(entry, approvedEvidence({ approvalSource: ['# ux2 기록', '', '## Gate 2 shell', '', '결정 답변'].join('\n') }))).toThrow('no row for shell-desktop');
    expect(() => validateApprovedSurface(entry, approvedEvidence({ approvalSource: APPROVAL.replace('B안, 레일 5칸', ' ') }))).toThrow('no recorded answer');
    // A row under a sibling heading does not count for this record.
    expect(() => validateApprovedSurface(entry, approvedEvidence({ approvalSource: APPROVAL.replace('## Gate 2 shell', '## Gate 2 shell\n\n## Other') }))).toThrow('no row for shell-desktop');
  });

  it('finds the answer by the 답 column, and the row by the exact surface id', () => {
    const entry = approved();
    const noAnswerColumn = ['# ux2 기록', '', '## Gate 2 shell', '', '| 화면 | 제안 |', '|---|---|', '| shell-desktop | 제안 내용 |'].join('\n');
    expect(() => validateApprovedSurface(entry, approvedEvidence({ approvalSource: noAnswerColumn }))).toThrow('no 답 column');
    const shortRow = APPROVAL.replace('| shell-desktop | 셸 구성 | B안, 레일 5칸 |', '| shell-desktop | 셸 구성 |');
    expect(() => validateApprovedSurface(entry, approvedEvidence({ approvalSource: shortRow }))).toThrow('no recorded answer');
    expect(() => validateApprovedSurface(entry, approvedEvidence({ approvalSource: APPROVAL.replace('| shell-desktop |', '| shell-desktop-old |') }))).toThrow('no row for shell-desktop');
    expect(() => validateApprovedSurface(entry, approvedEvidence({ approvalSource: APPROVAL.replace('| shell-desktop |', '| `shell-desktop` |') }))).not.toThrow();
  });

  it.each([
    { loophole: 'a skipped test', dispatch: DISPATCH.replace('  test(referenceCase.storyId', '  test.skip(referenceCase.storyId'), message: 'must not skip' },
    { loophole: 'a skip anywhere in the spec, even before the loop', dispatch: `test.skip(true, "later");\n${DISPATCH}`, message: 'must not skip' },
    { loophole: 'a loop inside a describe', dispatch: `test.describe("reference", () => {\n${DISPATCH}\n});`, message: 'top-level statement' },
    { loophole: 'an early return in the test', dispatch: DISPATCH.replace('    await checkReferenceSurface(page, referenceCase);', '    return;\n    await checkReferenceSurface(page, referenceCase);'), message: 'exactly one statement' },
    { loophole: 'a second statement in the test', dispatch: DISPATCH.replace('    await checkReferenceSurface(page, referenceCase);', '    await page.goto("about:blank");\n    await checkReferenceSurface(page, referenceCase);'), message: 'exactly one statement' },
    { loophole: 'a test that never calls the checker', dispatch: DISPATCH.replace('await checkReferenceSurface(page, referenceCase);', 'await openStory(page, referenceCase.storyId);'), message: 'may only be imported and called once' },
    { loophole: 'a test named after another story', dispatch: DISPATCH.replace('test(referenceCase.storyId', 'test("other"'), message: 'exactly test(referenceCase.storyId' },
    { loophole: 'the checker called with another case', dispatch: DISPATCH.replace('checkReferenceSurface(page, referenceCase)', 'checkReferenceSurface(page, designReferenceCases[0])'), message: 'may only be declared and read by its dispatch loop' },
  ])('rejects $loophole in the visual spec', ({ dispatch, message }) => {
    expect(() => validateApprovedSurface(approved(), approvedEvidence({ visualSource: visualSpec(VISUAL_CASE, dispatch) }))).toThrow(message);
  });

  it.each([
    { bypass: 'a local look-alike checker', prelude: 'async function checkReferenceSurface() { return; }', message: 'must import { checkReferenceSurface }' },
    { bypass: 'a look-alike defined next to the import', prelude: `${CHECKER_IMPORT}\nconst shadow = () => { const checkReferenceSurface = async () => undefined; return checkReferenceSurface; };`, message: 'may only be imported and called once' },
    { bypass: 'the checker imported from another file', prelude: 'import { checkReferenceSurface } from "./other-checks";', message: 'must import { checkReferenceSurface }' },
    { bypass: 'another export renamed to the checker', prelude: 'import { quickCheck as checkReferenceSurface } from "./design-reference-checks";', message: 'must import { checkReferenceSurface }' },
    { bypass: 'emptying the case list before the loop', prelude: `${CHECKER_IMPORT}\ndesignReferenceCases.length = 0;`, message: 'may only be declared and read by its dispatch loop' },
  ])('rejects $bypass', ({ prelude, message }) => {
    const source = prelude.includes('designReferenceCases.length')
      ? `${CHECKER_IMPORT}\nconst designReferenceCases = [${VISUAL_CASE}];\ndesignReferenceCases.length = 0;\n${DISPATCH}`
      : visualSpec(VISUAL_CASE, DISPATCH, prelude);
    expect(() => validateApprovedSurface(approved(), approvedEvidence({ visualSource: source }))).toThrow(message);
  });

  it('rejects a case list that is not one top-level const', () => {
    const mutable = `${CHECKER_IMPORT}\nlet designReferenceCases = [${VISUAL_CASE}];\n${DISPATCH}`;
    expect(() => validateApprovedSurface(approved(), approvedEvidence({ visualSource: mutable }))).toThrow('top-level const');
  });

  it('rejects a checker that differs from its pin', () => {
    expect(() => validateApprovedSurface(approved(), approvedEvidence({ checkerSha256: 'd'.repeat(64) }))).toThrow('pinned SHA-256');
  });

  it.each([
    { axis: 'axe after each render', checker: CHECKER.replaceAll('  await expectNoAccessibilityViolations(page);\n', ''), message: 'axe after each render' },
    { axis: 'axe twice in the same locale', checker: CHECKER.replace('  await openStory(page, item.storyId, { locale: alternateLocale });\n  await expectNoAccessibilityViolations(page);', '  await expectNoAccessibilityViolations(page);\n  await openStory(page, item.storyId, { locale: alternateLocale });'), message: 'axe after each render' },
    { axis: 'the screenshot', checker: CHECKER.replace('  await expect(page).toHaveScreenshot(item.screenshot);\n', ''), message: 'case screenshot' },
    { axis: 'another screenshot', checker: CHECKER.replace('toHaveScreenshot(item.screenshot)', 'toHaveScreenshot("other.png")'), message: 'case screenshot' },
    { axis: 'keyboard focus back', checker: CHECKER.replace('  await page.keyboard.press("Shift+Tab");\n', ''), message: 'keyboard focus' },
    { axis: 'the viewports', checker: CHECKER.replace('    await page.setViewportSize(size);\n', ''), message: 'setViewportSize' },
    { axis: 'a fixed viewport', checker: CHECKER.replace('setViewportSize(size)', 'setViewportSize({ width: 1440, height: 900 })'), message: 'setViewportSize' },
    { axis: 'the overflow assertion', checker: CHECKER.replace('    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);', '    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);'), message: 'horizontal overflow' },
    { axis: 'the other locale', checker: CHECKER.replace('  await openStory(page, item.storyId, { locale: alternateLocale });\n  await expectNoAccessibilityViolations(page);\n', ''), message: 'both the case locale' },
    { axis: 'the same locale twice', checker: CHECKER.replace('{ locale: alternateLocale }', '{ locale: item.locale }'), message: 'both the case locale' },
    { axis: 'an alternate locale that maps ko to ko', checker: CHECKER.replace('item.locale === "ko" ? "en" : "ko"', 'item.locale === "ko" ? "ko" : "en"'), message: 'the other locale' },
    { axis: 'an alternate locale not derived from the case', checker: CHECKER.replace('item.locale === "ko" ? "en" : "ko"', '"ko"'), message: 'the other locale' },
    { axis: 'another story', checker: CHECKER.replace('openStory(page, item.storyId, { locale: item.locale })', 'openStory(page, "shell-2-0--other", { locale: item.locale })'), message: 'case story' },
  ])('rejects a pinned checker that drops $axis', ({ checker, message }) => {
    expect(() => validateApprovedSurface(approved(), approvedEvidence({ checkerSource: checker }))).toThrow(message);
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
