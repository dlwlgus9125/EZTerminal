import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(process.argv[2] ?? 'mobile/dist');
const compatibilityMarker = '__EZTERMINAL_WEBVIEW74_COMPAT_V1__';
const bootstrapReadyMarker = '__EZTERMINAL_WEBVIEW74_BOOTSTRAP_READY__';
const bootstrapFailureMessage = 'WebView compatibility bootstrap did not complete';
const runtimePostconditionMessage = 'WebView compatibility postcondition failed:';
const requiredCompatibilityFeatures = [
  'Object.hasOwn',
  'Element.replaceChildren',
  'WeakRef',
  'AggregateError',
  'Blob.text',
  'Blob.arrayBuffer',
  'File.text',
  'File.arrayBuffer',
  'Array.prototype.at',
  'String.prototype.at',
  'crypto.randomUUID',
  'HTMLElement.inert',
];
const requiredCompatibilityFeatureList = JSON.stringify(requiredCompatibilityFeatures);
// These strings live inside distinct fallback implementations. Requiring them
// prevents an entry bundle from passing by advertising only the public
// contract/sentinels while tree-shaking (or otherwise omitting) the installer
// bodies. Runtime execution is covered separately by the API 29 device gate.
const requiredFallbackImplementationMarkers = [
  'WeakRef target must be an object',
  'FileReader returned an invalid',
  'Blob read failed',
  'Array.prototype.at called on null or undefined',
  'ezterminal-webview74-inert',
];

// These rules are diagnostic, not a regex-based ban. A member named `at` can
// belong to an arbitrary application object, and `.text()` can be Response
// rather than Blob. A match is safe when the entrypoint advertises the
// corresponding installed compatibility feature; this avoids both the old
// false positive and the old false pass.
const managedRuntimeApiRules = [
  { feature: 'Object.hasOwn', pattern: /\bObject\.hasOwn\s*\(/u },
  { feature: 'Element.replaceChildren', pattern: /\.replaceChildren\s*\(/u },
  { feature: 'WeakRef', pattern: /\bnew\s+WeakRef\s*\(/u },
  { feature: 'AggregateError', pattern: /\bnew\s+AggregateError\s*\(/u },
  { feature: 'Blob.text', pattern: /\.text\s*\(/u },
  { feature: 'Blob.arrayBuffer', pattern: /\.arrayBuffer\s*\(/u },
  { feature: 'Array.prototype.at', pattern: /\.at\s*\(/u },
  { feature: 'crypto.randomUUID', pattern: /(?:\.randomUUID|\[['"]randomUUID['"]\])\s*(?:\?\.)?\s*\(/u },
  { feature: 'HTMLElement.inert', pattern: /(?:\.inert\s*=|["']inert["'])/u },
];

async function listJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listJavaScriptFiles(resolved));
    else if (entry.isFile() && ['.js', '.mjs'].includes(path.extname(entry.name).toLowerCase())) files.push(resolved);
  }
  return files;
}

function fail(message) {
  throw new Error(`Android 10 WebView 74 compatibility check failed:\n- ${message}`);
}

function resolveOutputFile(relativePath) {
  const normalized = relativePath.replace(/^[/\\]+/u, '').split(/[?#]/u, 1)[0];
  const absolute = path.resolve(root, normalized);
  const relative = path.relative(root, absolute);
  if (!normalized || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`output reference escapes the build root: ${relativePath}`);
  }
  return absolute;
}

function moduleScriptSource(indexHtml) {
  for (const match of indexHtml.matchAll(/<script\b[^>]*>/giu)) {
    const tag = match[0];
    if (!/\btype\s*=\s*["']module["']/iu.test(tag)) continue;
    const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/iu)?.[1];
    if (src) return src;
  }
  fail('index.html does not contain a module entry script');
}

let rootStats;
try {
  rootStats = await stat(root);
} catch {
  fail(`output directory does not exist: ${root}`);
}
if (!rootStats.isDirectory()) fail(`output path is not a directory: ${root}`);

const indexPath = path.join(root, 'index.html');
const manifestPath = path.join(root, '.vite', 'manifest.json');
const [indexHtml, manifestSource, javascriptFiles] = await Promise.all([
  readFile(indexPath, 'utf8').catch(() => fail('index.html is missing')),
  readFile(manifestPath, 'utf8').catch(() => fail('.vite/manifest.json is missing')),
  listJavaScriptFiles(root),
]);

let manifest;
try {
  manifest = JSON.parse(manifestSource);
} catch {
  fail('.vite/manifest.json is not valid JSON');
}

const entryRecord = manifest['index.html'];
if (!entryRecord?.isEntry || typeof entryRecord.file !== 'string') {
  fail('Vite manifest does not identify index.html as the build entry');
}
if ((entryRecord.imports?.length ?? 0) !== 0) {
  fail('compatibility bootstrap gained a static dependency; application imports must remain dynamic');
}
if (!Array.isArray(entryRecord.dynamicImports) || entryRecord.dynamicImports.length !== 1) {
  fail('compatibility bootstrap must have exactly one dynamic application import');
}

const applicationRecord = manifest[entryRecord.dynamicImports[0]];
if (!applicationRecord?.isDynamicEntry || applicationRecord.name !== 'main') {
  fail('the bootstrap dynamic import no longer resolves to the main application entry');
}

const htmlEntryPath = resolveOutputFile(moduleScriptSource(indexHtml));
const manifestEntryPath = resolveOutputFile(entryRecord.file);
if (htmlEntryPath !== manifestEntryPath) {
  fail('index.html module script does not match the Vite manifest entry');
}

const entrySource = await readFile(manifestEntryPath, 'utf8').catch(() => fail(`entry bundle is missing: ${entryRecord.file}`));
const markerIndex = entrySource.indexOf(compatibilityMarker);
const runtimePostconditionIndex = entrySource.indexOf(runtimePostconditionMessage);
const failureGuardIndex = entrySource.indexOf(bootstrapFailureMessage);
const bootstrapReadyIndex = entrySource.indexOf(bootstrapReadyMarker);
const importIndex = entrySource.indexOf('import(');
if (markerIndex < 0) fail(`entry bundle is missing compatibility marker ${compatibilityMarker}`);
if (runtimePostconditionIndex < 0) {
  fail('entry bundle is missing the complete runtime fallback postcondition');
}
if (failureGuardIndex < 0) {
  fail('entry bundle is missing the executable compatibility completion guard');
}
if (bootstrapReadyIndex < 0) {
  fail('entry bundle is missing the post-install compatibility completion sentinel');
}
if (
  importIndex < 0
  || markerIndex > runtimePostconditionIndex
  || runtimePostconditionIndex > failureGuardIndex
  || failureGuardIndex > bootstrapReadyIndex
  || bootstrapReadyIndex > importIndex
) {
  fail('compatibility install, runtime postcondition, completion guard, and ready sentinel must execute before the dynamic application import');
}
if (/react(?:\.production)?(?:\.min)?\.js|Root element #root not found/iu.test(entrySource)) {
  fail('React/application code leaked into the pre-compatibility entry bundle');
}

if (!entrySource.includes(requiredCompatibilityFeatureList)) {
  fail('entry bundle does not emit the complete, ordered compatibility feature contract');
}
const advertisedFeatures = new Set(requiredCompatibilityFeatures);

const missingImplementationMarkers = requiredFallbackImplementationMarkers.filter(
  (marker) => !entrySource.includes(marker),
);
if (missingImplementationMarkers.length > 0) {
  fail(`entry bundle is missing emitted fallback implementations: ${missingImplementationMarkers.join(', ')}`);
}

const managedUsage = new Map();
for (const file of javascriptFiles) {
  const source = await readFile(file, 'utf8');
  for (const rule of managedRuntimeApiRules) {
    if (!rule.pattern.test(source)) continue;
    if (!advertisedFeatures.has(rule.feature)) {
      fail(`${path.relative(root, file)} uses ${rule.feature} without an entrypoint fallback`);
    }
    const files = managedUsage.get(rule.feature) ?? [];
    files.push(path.relative(root, file));
    managedUsage.set(rule.feature, files);
  }
}

console.log(
  `WebView 74 compatibility verified: bootstrap-before-app graph, ${requiredCompatibilityFeatures.length} fallback contracts emitted, `
  + `${managedUsage.size} managed API families across ${javascriptFiles.length} JavaScript bundles.`,
);
