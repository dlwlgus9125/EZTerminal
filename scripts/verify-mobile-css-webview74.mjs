import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  analyzeMobileCss,
  compareBaseline,
  formatBaseline,
  parseBaseline,
  updateBaseline,
} from './mobile-css-webview74-core.mjs';

// Usage: node scripts/verify-mobile-css-webview74.mjs <mobile dist dir> [--update-baseline]
const args = process.argv.slice(2);
const shouldUpdate = args.includes('--update-baseline');
const distRoot = path.resolve(args.find((arg) => !arg.startsWith('--')) ?? 'mobile/dist');
const repoRoot = path.resolve(import.meta.dirname, '..');
const baselinePath = path.join(repoRoot, 'scripts', 'mobile-css-webview74-baseline.json');
const updateCommand = 'node scripts/verify-mobile-css-webview74.mjs mobile/dist --update-baseline';

function fail(lines) {
  console.error(`Android 10 WebView 74 flex-gap check failed:\n${lines.map((line) => `- ${line}`).join('\n')}`);
  process.exit(1);
}

function toRepoPath(file) {
  return path.relative(repoRoot, file).replaceAll('\\', '/');
}

async function listTsxFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listTsxFiles(resolved));
    else if (entry.isFile() && /(?<!\.(?:test|spec|stories))\.tsx$/u.test(entry.name)) files.push(resolved);
  }
  return files.sort();
}

async function readAll(files) {
  return Promise.all(files.map(async (file) => ({ path: toRepoPath(file), source: await readFile(file, 'utf8') })));
}

const assetsRoot = path.join(distRoot, 'assets');
const assetNames = await readdir(assetsRoot).catch(() => fail([`build assets are missing: ${assetsRoot}`]));
const cssFiles = await readAll(assetNames.filter((name) => name.endsWith('.css')).sort().map((name) => path.join(assetsRoot, name)));
const jsFiles = await readAll(assetNames.filter((name) => name.endsWith('.js')).sort().map((name) => path.join(assetsRoot, name)));
if (cssFiles.length === 0 || jsFiles.length === 0) fail([`no CSS or JavaScript bundles in ${assetsRoot}`]);
const tsxFiles = await readAll(await listTsxFiles(path.join(repoRoot, 'mobile', 'src')));

const result = analyzeMobileCss({ cssFiles, jsSources: jsFiles.map((file) => file.source), tsxFiles });
const violationKeys = result.violations.map((violation) => violation.key);
const baselineSource = await readFile(baselinePath, 'utf8').catch(() => (shouldUpdate ? '[]' : null));
if (baselineSource === null) fail([`baseline is missing: ${toRepoPath(baselinePath)} (run ${updateCommand})`]);
const baseline = parseBaseline(baselineSource);

const inline = result.violations.filter((violation) => violation.kind === 'inline');
const ambiguous = result.violations.filter((violation) => violation.kind === 'ambiguous');
const summary = `${result.flexGapSelectors} flex-gap selectors in ${cssFiles.length} stylesheets: `
  + `${result.unreachable} not used by the phone bundles, ${result.withFallback} with a fallback, `
  + `${result.violations.length - inline.length} pending (${ambiguous.length} also grid somewhere); `
  + `${inline.length} source files with inline flex gaps.`;

if (shouldUpdate) {
  const entries = updateBaseline(violationKeys, baseline);
  await writeFile(baselinePath, formatBaseline(entries), 'utf8');
  console.log(`WebView 74 flex-gap baseline rewritten with ${entries.length} entries: ${summary}`);
  process.exit(0);
}

const { added, stale } = compareBaseline(violationKeys, baseline);
if (added.length > 0 || stale.length > 0) {
  const byKey = new Map(result.violations.map((violation) => [violation.key, violation]));
  fail([
    ...added.map((key) => {
      const violation = byKey.get(key);
      const where = violation.kind === 'inline' ? `lines ${violation.lines.join(', ')}` : violation.files.join(', ');
      return `new ${violation.kind} gap without a [data-ui-flex-gap=unsupported] fallback: ${key} (${where})`;
    }),
    ...stale.map((key) => `baseline entry no longer violates, remove it: ${key}`),
    `fix the CSS (src/renderer/mobile-shared.css shows the pattern) or, for a deliberate change, run ${updateCommand}`,
  ]);
}

for (const warning of result.warnings) console.warn(`warning: ${warning}`);
console.log(`WebView 74 flex-gap check passed: ${summary}`);
