import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { createServer } from 'vite';

const RUNS = 30;
const CACHED_OPEN_P95_MS = 250;
const PRODUCTION_P95_MS = 2_000;
const DIRECTORY = '.ezterminal/project-map';

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function rawHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function summary(values) {
  return {
    runs: values.length,
    p50Ms: Number(percentile(values, 0.5).toFixed(3)),
    p95Ms: Number(percentile(values, 0.95).toFixed(3)),
    maxMs: Number(Math.max(...values).toFixed(3)),
  };
}

const root = process.cwd();
const manifestPath = path.join(root, DIRECTORY, 'manifest.json');
const counters = { fileReads: 0, gitCalls: 0, layouts: 0, cacheGets: 0 };
let vite;
let temporary;

async function readBytes(file) {
  counters.fileReads += 1;
  return fs.readFile(file);
}

function git(args) {
  counters.gitCalls += 1;
  return execFileSync('git', ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
}

try {
  vite = await createServer({
    root,
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  });
  const contract = await vite.ssrLoadModule('/src/shared/project-map.ts');
  const geometry = await vite.ssrLoadModule('/src/shared/project-map-layout.ts');
  const cacheModule = await vite.ssrLoadModule('/src/main/project-map-cache-store.ts');

  async function validateProduction() {
    const manifestBytes = await readBytes(manifestPath);
    const manifestResult = contract.validateProjectMapManifestText(manifestBytes.toString('utf8'));
    if (!manifestResult.value) throw new Error(JSON.stringify(manifestResult.diagnostics));
    const manifest = manifestResult.value;
    const entry = manifest.maps.find((map) => map.id === manifest.overviewMapId);
    if (!entry) throw new Error('Overview map is missing.');
    const mapPath = path.join(root, DIRECTORY, ...entry.path.split('/'));
    const mapBytes = await readBytes(mapPath);
    const parsed = contract.validateProjectMapSpecText(mapBytes.toString('utf8'));
    if (!parsed.value) throw new Error(JSON.stringify(parsed.diagnostics));
    const spec = parsed.value;
    const inputs = [];
    for (const input of entry.authoritativeInputs) {
      const bytes = await readBytes(path.join(root, ...input.relativePath.split('/')));
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      inputs.push({
        ...input,
        version: rawHash(contract.normalizeProjectMapInputText(content)),
      });
    }
    const inputHash = sha256(contract.serializeProjectMapInputVersions(inputs));
    if (inputHash !== entry.review.inputDigest) throw new Error('Overview input review digest is stale.');
    const evidenceFiles = new Map();
    for (const anchor of contract.projectMapEvidence(spec)) {
      let content = evidenceFiles.get(anchor.relativePath);
      if (!content) {
        content = (await readBytes(path.join(root, ...anchor.relativePath.split('/')))).toString('utf8');
        evidenceFiles.set(anchor.relativePath, content);
      }
      const lines = content.replace(/\r\n?/gu, '\n').split('\n');
      const digest = sha256(lines.slice(anchor.startLine - 1, anchor.endLine).join('\n'));
      if (digest !== anchor.lineDigest) throw new Error(`Evidence digest is stale: ${anchor.relativePath}:${anchor.startLine}`);
    }
    counters.layouts += 1;
    const laidOut = geometry.layoutProjectMap(spec);
    if (laidOut.diagnostics.length > 0) throw new Error(JSON.stringify(laidOut.diagnostics));
    const head = git(['rev-parse', 'HEAD']).trim();
    const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', `${DIRECTORY}/manifest.json`, `${DIRECTORY}/${entry.path}`,
      ...entry.authoritativeInputs.map((input) => input.relativePath)]);
    git(['rev-parse', '--show-toplevel']);
    const fingerprint = sha256(JSON.stringify({
      qualityGateVersion: contract.PROJECT_MAP_QUALITY_GATE_VERSION,
      collectionId: manifest.collectionId,
      map: entry,
      specHash: rawHash(mapBytes),
      inputHash,
      layoutHash: sha256(JSON.stringify(laidOut.layout)),
      head,
      dirty: status.length > 0,
    }));
    return { manifest, entry, spec, layout: laidOut.layout, inputHash, fingerprint, head, status };
  }

  const warm = await validateProduction();
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ezterminal-project-map-profile-'));
  const cache = new cacheModule.ProjectMapCacheStore(temporary);
  await cache.init();
  const checks = ['schema', 'semantics', 'evidence', 'inputs', 'layout', 'routes', 'labels', 'containment', 'accessibility', 'provenance']
    .map((name) => ({ name, status: 'passed' }));
  const document = {
    collectionId: warm.manifest.collectionId,
    mapId: warm.spec.id,
    mapPath: `${DIRECTORY}/${warm.entry.path}`,
    state: 'valid',
    spec: warm.spec,
    layout: warm.layout,
    provenance: {
      kind: warm.status.length > 0 ? 'worktree-snapshot' : 'commit-pinned',
      roots: [{
        rootAlias: warm.manifest.ownerRootAlias,
        head: warm.head,
        dirty: warm.status.length > 0,
        ...(warm.status.length > 0 ? { snapshotHash: sha256(warm.status) } : {}),
      }],
    },
    verification: {
      quality: 'production',
      fingerprint: warm.fingerprint,
      verifiedAt: new Date().toISOString(),
      manifestHash: sha256(await fs.readFile(manifestPath)),
      specHash: sha256(JSON.stringify(warm.spec)),
      inputHash: warm.inputHash,
      layoutHash: sha256(JSON.stringify(warm.layout)),
      checks,
      diagnostics: [],
    },
    fromLastGood: false,
  };
  await cache.put('approved-overview', document);
  await cache.get('approved-overview');

  const cachedTimes = [];
  for (let index = 0; index < RUNS; index += 1) {
    const started = performance.now();
    const cached = await cache.get('approved-overview');
    cachedTimes.push(performance.now() - started);
    counters.cacheGets += 1;
    if (!cached) throw new Error('Approved cache entry disappeared.');
  }
  await cache.flush();

  await validateProduction();
  const productionTimes = [];
  for (let index = 0; index < RUNS; index += 1) {
    const started = performance.now();
    await validateProduction();
    productionTimes.push(performance.now() - started);
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sample: { mapId: warm.spec.id, warmups: 1, measuredRuns: RUNS },
    thresholds: { cachedOpenP95Ms: CACHED_OPEN_P95_MS, productionValidationP95Ms: PRODUCTION_P95_MS },
    cachedOpen: summary(cachedTimes),
    productionValidation: summary(productionTimes),
    calls: counters,
  };
  await fs.mkdir(path.join(root, 'out'), { recursive: true });
  await fs.writeFile(path.join(root, 'out', 'project-map-profile.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  if (report.cachedOpen.p95Ms > CACHED_OPEN_P95_MS || report.productionValidation.p95Ms > PRODUCTION_P95_MS) {
    process.exitCode = 1;
  }
} finally {
  await vite?.close();
  if (temporary) await fs.rm(temporary, { recursive: true, force: true });
}
