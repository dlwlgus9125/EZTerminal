import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  assertCanonicalPng,
  validateDesktopHandoffContract,
} from './desktop-handoff-guard-core.mjs';

const root = resolve(import.meta.dirname, '..');
const referenceRoot = resolve(root, 'docs/ux/reference/desktop-handoff');
const snapshotRoot = resolve(
  root,
  'visual/__snapshots__/storybook.visual.spec.ts',
);
const manifest = JSON.parse(
  await readFile(resolve(referenceRoot, 'manifest.json'), 'utf8'),
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

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

const [designContract, e2eSource, storySource, visualSource] = await Promise.all([
  readFile(resolve(root, 'docs/ux/frontend-design.md'), 'utf8'),
  readFile(resolve(root, 'e2e/workbench-shell.spec.ts'), 'utf8'),
  readFile(resolve(root, 'src/renderer/workbench/DesktopHandoff.stories.tsx'), 'utf8'),
  readFile(resolve(root, 'visual/storybook.visual.spec.ts'), 'utf8'),
]);
const snapshotEntries = await readdir(snapshotRoot, { withFileTypes: true });
const availableSnapshots = new Set(
  snapshotEntries.filter((entry) => entry.isFile()).map((entry) => entry.name),
);
assert(
  designContract.includes('docs/ux/reference/desktop-handoff/manifest.json'),
  'Frontend design contract does not name the desktop handoff manifest.',
);
const { canonicalSnapshots } = validateDesktopHandoffContract({
  availableSnapshots,
  e2eSource,
  manifest,
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
  'guard:desktop-handoff OK: 14 surfaces / 19 pinned source files map to real stories and executable visual/accessibility contracts.',
);
