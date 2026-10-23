import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  assertCanonicalPng,
  validateApprovedSurface,
  validateDesignReferenceManifest,
  validateDesktopHandoffContract,
} from './design-reference-guard-core.mjs';

const root = resolve(import.meta.dirname, '..');
const referenceRoot = resolve(root, 'docs/ux/reference/desktop-handoff');
const snapshotRoot = resolve(
  root,
  'visual/__snapshots__/storybook.visual.spec.ts',
);
const manifest = JSON.parse(
  await readFile(resolve(referenceRoot, 'manifest.json'), 'utf8'),
);
const reference = JSON.parse(
  await readFile(resolve(root, 'docs/ux/reference/2.0/manifest.json'), 'utf8'),
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

// The archived 1.0 handoff stays byte-identical: its pins are the proof.
for (const surface of manifest.surfaces ?? []) {
  assert(
    Object.hasOwn(manifest.extractedFiles, surface.reference),
    `Desktop handoff surface ${surface.id} references an unpinned asset.`,
  );
}

for (const [name, expected] of Object.entries(manifest.extractedFiles ?? {})) {
  const actual = await sha256(resolve(referenceRoot, name));
  assert(
    actual === expected,
    `Desktop handoff source hash differs for ${name}: expected ${expected}, got ${actual}.`,
  );
}

const [designContract, referenceIndex, e2eSource, storySource, visualSource] = await Promise.all([
  readFile(resolve(root, 'docs/ux/frontend-design.md'), 'utf8'),
  readFile(resolve(root, 'docs/ux/reference/README.md'), 'utf8'),
  readFile(resolve(root, 'e2e/workbench-shell.spec.ts'), 'utf8'),
  readFile(resolve(root, 'src/renderer/workbench/DesktopHandoff.stories.tsx'), 'utf8'),
  readFile(resolve(root, 'visual/storybook.visual.spec.ts'), 'utf8'),
]);
const snapshotEntries = await readdir(snapshotRoot, { withFileTypes: true });
const availableSnapshots = new Set(
  snapshotEntries.filter((entry) => entry.isFile()).map((entry) => entry.name),
);
assert(
  designContract.includes('docs/ux/reference/2.0/manifest.json'),
  'Frontend design contract does not name the 2.0 design reference manifest.',
);
assert(
  referenceIndex.includes('desktop-handoff/manifest.json'),
  'docs/ux/reference/README.md does not name the archived desktop handoff manifest.',
);

// 2.0 reference: approved surfaces plus the 1.0 surfaces still guarded as legacy.
const { approved, legacy, retired } = validateDesignReferenceManifest(reference, manifest);
for (const entry of approved) {
  const capturePath = resolve(root, entry.capture.file);
  validateApprovedSurface(entry, {
    storySource: await readFile(resolve(root, entry.story.file), 'utf8'),
    visualSource,
    availableSnapshots,
    captureBytes: await readFile(capturePath),
    captureSha256: await sha256(capturePath),
    approvalSource: await readFile(resolve(root, entry.approval.record.split('#')[0]), 'utf8'),
  });
}

// Legacy 1.0 surfaces keep their story, visual, accessibility and Electron contracts.
const { canonicalSnapshots } = validateDesktopHandoffContract({
  availableSnapshots,
  e2eSource,
  manifest,
  retiredSurfaceIds: retired,
  storySource,
  visualSource,
});
for (const snapshot of canonicalSnapshots) {
  const snapshotPath = resolve(snapshotRoot, snapshot);
  const [metadata, bytes] = await Promise.all([
    stat(snapshotPath),
    readFile(snapshotPath),
  ]);
  assert(metadata.isFile(), `Canonical snapshot is not a regular file: ${snapshot}.`);
  assertCanonicalPng(bytes, snapshot);
}

console.log(
  `guard:design-reference OK: ${approved.length} approved 2.0 surfaces; ${legacy.length} legacy 1.0 surfaces / `
  + `${Object.keys(manifest.extractedFiles ?? {}).length} pinned source files still map to real stories and executable visual/accessibility contracts.`,
);
