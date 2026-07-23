import { readFile } from 'node:fs/promises';
import process from 'node:process';

const DEFAULT_MAX_REGRESSION_PERCENT = 5;
const DEFAULT_MIN_TARGET_IMPROVEMENT_PERCENT = 15;
const SCHEMA_VERSION = 2;
const WARMUP_RUNS = 5;
const MEASUREMENT_RUNS = 25;
const METRIC_ORDER = [
  'cancellationLatencyMs',
  'rows100kCompletionMs',
  'plainOutput1_1MiBCompletionMs',
  'plainOutput12MiBRetentionPressureMs',
];
const FIXTURES = [
  {
    id: 'largePlainOutput',
    path: 'e2e/fixtures/large-plain-output.js',
    stdoutBytes: 1_101_119,
    stdoutSha256: 'bbab0e75bbec8e2b80d281ab814a67d841e03167099d787a407d69a038ed717a',
    completionMarker: 'LARGE-OUTPUT-DONE',
  },
  {
    id: 'retentionPressureOutput',
    path: 'e2e/fixtures/retention-pressure-output.js',
    stdoutBytes: 12_012_025,
    stdoutSha256: '8f4d6337d2637244a47991f82383f798e78b36a145b579c01c027b6a3bdeced7',
    completionMarker: 'RETENTION-PRESSURE-DONE',
  },
];
const REQUIRED_BUILD_ARTIFACTS = [
  'build/interpreter-process.js',
  'build/main.js',
  'build/packet-capture-host.js',
  'build/preload.js',
  'build/script-host.js',
];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ALLOWED_FLAGS = new Set([
  '--baseline',
  '--candidate',
  '--expected-baseline-build-sha',
  '--expected-candidate-build-sha',
  '--max-regression-percent',
  '--min-target-improvement-percent',
  '--target-metrics',
]);

function fail(message) {
  throw new Error(message);
}

function parseNumberFlag(value, label, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) fail(`${label} must be a non-negative number`);
  return parsed;
}

function parseExpectedSha(value, label) {
  if (value === undefined || !GIT_SHA_PATTERN.test(value)) {
    fail(`${label} must be a full 40-character Git SHA`);
  }
  return value.toLowerCase();
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--')) fail(`unexpected argument: ${flag}`);
    if (!ALLOWED_FLAGS.has(flag)) fail(`unknown option: ${flag}`);
    if (values.has(flag)) fail(`duplicate option: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`${flag} requires a value`);
    values.set(flag, value);
    index += 1;
  }
  const baseline = values.get('--baseline');
  const candidate = values.get('--candidate');
  if (!baseline || !candidate) {
    fail(
      'usage: verify-performance-report.mjs --baseline <json> --candidate <json> '
      + '--expected-baseline-build-sha <sha> --expected-candidate-build-sha <sha> [options]',
    );
  }
  const targetMetrics = new Set(
    (values.get('--target-metrics') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  for (const target of targetMetrics) {
    if (!METRIC_ORDER.includes(target)) fail(`unknown targeted metric: ${target}`);
  }
  return {
    baseline,
    candidate,
    expectedBaselineBuildSha: parseExpectedSha(
      values.get('--expected-baseline-build-sha'),
      '--expected-baseline-build-sha',
    ),
    expectedCandidateBuildSha: parseExpectedSha(
      values.get('--expected-candidate-build-sha'),
      '--expected-candidate-build-sha',
    ),
    maxRegressionPercent: parseNumberFlag(
      values.get('--max-regression-percent'),
      '--max-regression-percent',
      DEFAULT_MAX_REGRESSION_PERCENT,
    ),
    minTargetImprovementPercent: parseNumberFlag(
      values.get('--min-target-improvement-percent'),
      '--min-target-improvement-percent',
      DEFAULT_MIN_TARGET_IMPROVEMENT_PERCENT,
    ),
    targetMetrics,
  };
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index];
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function validateFileEvidence(raw, label, expectedPath) {
  if (
    raw === null
    || typeof raw !== 'object'
    || !nonEmptyString(raw.path)
    || raw.path.startsWith('/')
    || raw.path.includes('\\')
    || raw.path.split('/').includes('..')
    || !Number.isSafeInteger(raw.bytes)
    || raw.bytes < 1
    || typeof raw.sha256 !== 'string'
    || !SHA256_PATTERN.test(raw.sha256)
  ) {
    fail(`${label} is not valid SHA-256 file evidence`);
  }
  if (expectedPath !== undefined && raw.path !== expectedPath) {
    fail(`${label} path differs: expected ${expectedPath}, got ${raw.path}`);
  }
  return raw;
}

function validateSource(raw, label, expectedBuildSha) {
  if (
    raw === null
    || typeof raw !== 'object'
    || typeof raw.gitHeadSha !== 'string'
    || !GIT_SHA_PATTERN.test(raw.gitHeadSha)
    || typeof raw.workingTreeDirty !== 'boolean'
  ) {
    fail(`${label} is missing Git source provenance`);
  }
  if (raw.gitHeadSha !== expectedBuildSha) {
    fail(`${label} Git SHA differs from the launched build SHA`);
  }
  if (raw.workingTreeDirty) fail(`${label} was collected from a dirty working tree`);
  return raw;
}

function validateLaunchArtifacts(raw, label) {
  if (
    raw === null
    || typeof raw !== 'object'
    || raw.entry !== 'build/main.js'
    || !Array.isArray(raw.files)
  ) {
    fail(`${label} is missing launch artifact evidence`);
  }
  const files = raw.files.map((file, index) =>
    validateFileEvidence(file, `${label}.files[${index}]`));
  const paths = files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) fail(`${label} contains duplicate artifact paths`);
  const sortedPaths = [...paths].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(paths) !== JSON.stringify(sortedPaths)) {
    fail(`${label} artifact paths are not in canonical order`);
  }
  for (const requiredPath of REQUIRED_BUILD_ARTIFACTS) {
    if (!paths.includes(requiredPath)) fail(`${label} is missing ${requiredPath}`);
  }
  if (!paths.includes('renderer/main_window/index.html')) {
    fail(`${label} is missing renderer/main_window/index.html`);
  }
  if (!paths.some((artifactPath) => /^renderer\/main_window\/.+\.js$/.test(artifactPath))) {
    fail(`${label} is missing its renderer JavaScript artifact`);
  }
  if (!paths.some((artifactPath) => /^renderer\/main_window\/.+\.css$/.test(artifactPath))) {
    fail(`${label} is missing its renderer CSS artifact`);
  }
  return raw;
}

function validateProduct(raw, label, reportBuildSha) {
  if (
    raw === null
    || typeof raw !== 'object'
    || raw.name !== 'EZTerminal'
    || !nonEmptyString(raw.version)
    || !Number.isSafeInteger(raw.protocolVersion)
    || raw.protocolVersion < 1
    || typeof raw.buildSha !== 'string'
    || !GIT_SHA_PATTERN.test(raw.buildSha)
    || raw.buildSha !== reportBuildSha
  ) {
    fail(`${label} is missing launched product provenance`);
  }
  validateSource(raw.source, `${label}.source`, raw.buildSha);
  validateFileEvidence(raw.lock, `${label}.lock`, 'pnpm-lock.yaml');
  if (
    raw.runtime === null
    || typeof raw.runtime !== 'object'
    || !nonEmptyString(raw.runtime.electron)
    || !nonEmptyString(raw.runtime.chrome)
    || !nonEmptyString(raw.runtime.node)
    || [raw.runtime.electron, raw.runtime.chrome, raw.runtime.node].includes('unknown')
  ) {
    fail(`${label} is missing actual Electron/Chrome/Node runtime versions`);
  }
  validateLaunchArtifacts(raw.launchArtifacts, `${label}.launchArtifacts`);
  return raw;
}

function validateHarness(raw, label) {
  if (raw === null || typeof raw !== 'object') {
    fail(`${label} is missing benchmark harness provenance`);
  }
  if (
    raw.source === null
    || typeof raw.source !== 'object'
    || typeof raw.source.gitHeadSha !== 'string'
    || !GIT_SHA_PATTERN.test(raw.source.gitHeadSha)
    || typeof raw.source.workingTreeDirty !== 'boolean'
  ) {
    fail(`${label}.source is missing Git source provenance`);
  }
  if (raw.source.workingTreeDirty) fail(`${label}.source was collected from a dirty working tree`);
  validateFileEvidence(raw.lock, `${label}.lock`, 'pnpm-lock.yaml');
  if (
    raw.runner === null
    || typeof raw.runner !== 'object'
    || !nonEmptyString(raw.runner.node)
    || !nonEmptyString(raw.runner.playwright)
  ) {
    fail(`${label} is missing actual Node/Playwright runner versions`);
  }
  validateFileEvidence(raw.spec, `${label}.spec`, 'e2e/release-performance.spec.ts');
  if (!Array.isArray(raw.fixtures) || raw.fixtures.length !== FIXTURES.length) {
    fail(`${label} must contain the exact benchmark fixture set`);
  }
  for (let index = 0; index < FIXTURES.length; index += 1) {
    const expected = FIXTURES[index];
    const fixture = raw.fixtures[index];
    validateFileEvidence(fixture, `${label}.fixtures[${index}]`, expected.path);
    if (
      fixture.id !== expected.id
      || fixture.stdoutBytes !== expected.stdoutBytes
      || fixture.stdoutSha256 !== expected.stdoutSha256
      || fixture.completionMarker !== expected.completionMarker
    ) {
      fail(`${label}.fixtures[${index}] output metadata differs from the approved workload`);
    }
  }
  return raw;
}

function validateProvenance(raw, label, reportBuildSha) {
  if (raw === null || typeof raw !== 'object') {
    fail(`${label} is missing provenance`);
  }
  return {
    product: validateProduct(raw.product, `${label}.product`, reportBuildSha),
    harness: validateHarness(raw.harness, `${label}.harness`),
  };
}

function validateEnvironment(environment, label) {
  if (
    environment === null
    || typeof environment !== 'object'
    || !nonEmptyString(environment.platform)
    || !nonEmptyString(environment.arch)
    || !nonEmptyString(environment.osRelease)
    || !nonEmptyString(environment.cpuModel)
    || !Number.isSafeInteger(environment.logicalCpuCount)
    || environment.logicalCpuCount < 1
    || !Number.isSafeInteger(environment.totalMemoryGiB)
    || environment.totalMemoryGiB < 1
    || environment.hostFingerprint === null
    || typeof environment.hostFingerprint !== 'object'
    || environment.hostFingerprint.algorithm !== 'windows-machine-guid-sha256-v1'
    || typeof environment.hostFingerprint.sha256 !== 'string'
    || !SHA256_PATTERN.test(environment.hostFingerprint.sha256)
    || environment.powerPlan === null
    || typeof environment.powerPlan !== 'object'
    || typeof environment.powerPlan.schemeGuid !== 'string'
    || !GUID_PATTERN.test(environment.powerPlan.schemeGuid)
    || (environment.powerPlan.powerSource !== 'ac'
      && environment.powerPlan.powerSource !== 'dc')
    || ![
      'battery-saver',
      'better-battery',
      'balanced',
      'high-performance',
      'max-performance',
    ].includes(environment.powerPlan.effectivePowerMode)
    || typeof environment.powerPlan.baseSettingsSha256 !== 'string'
    || !SHA256_PATTERN.test(environment.powerPlan.baseSettingsSha256)
    || typeof environment.powerPlan.effectiveSettingsSha256 !== 'string'
    || !SHA256_PATTERN.test(environment.powerPlan.effectiveSettingsSha256)
  ) {
    fail(`${label} is missing its privacy-preserving same-host or power-plan evidence`);
  }
  return {
    platform: environment.platform,
    arch: environment.arch,
    osRelease: environment.osRelease,
    cpuModel: environment.cpuModel,
    logicalCpuCount: environment.logicalCpuCount,
    totalMemoryGiB: environment.totalMemoryGiB,
    hostFingerprint: {
      algorithm: environment.hostFingerprint.algorithm,
      sha256: environment.hostFingerprint.sha256,
    },
    powerPlan: {
      schemeGuid: environment.powerPlan.schemeGuid,
      powerSource: environment.powerPlan.powerSource,
      effectivePowerMode: environment.powerPlan.effectivePowerMode,
      baseSettingsSha256: environment.powerPlan.baseSettingsSha256,
      effectiveSettingsSha256: environment.powerPlan.effectiveSettingsSha256,
    },
  };
}

function validateMetric(raw, name, label) {
  if (
    raw === null
    || typeof raw !== 'object'
    || raw.unit !== 'ms'
    || raw.direction !== 'lower'
    || raw.warmupRuns !== WARMUP_RUNS
    || !Array.isArray(raw.samples)
    || raw.samples.length !== MEASUREMENT_RUNS
    || raw.samples.some((sample) => !Number.isFinite(sample) || sample < 0)
  ) {
    fail(
      `${label} metric ${name} must contain exactly ${MEASUREMENT_RUNS} finite millisecond `
      + `samples after ${WARMUP_RUNS} warmups`,
    );
  }
  const p95 = percentile(raw.samples, 0.95);
  const max = Math.max(...raw.samples);
  if (raw.p95Ms !== p95 || raw.maxMs !== max) {
    fail(`${label} metric ${name} summary differs from its samples`);
  }

  const expectedBudget = name === 'cancellationLatencyMs'
    ? { p95Ms: 3_000, maxMs: 5_000 }
    : undefined;
  if (expectedBudget === undefined) {
    if (raw.absoluteBudget !== undefined) {
      fail(`${label} metric ${name} has an unapproved absolute budget`);
    }
  } else if (
    raw.absoluteBudget === null
    || typeof raw.absoluteBudget !== 'object'
    || raw.absoluteBudget.p95Ms !== expectedBudget.p95Ms
    || raw.absoluteBudget.maxMs !== expectedBudget.maxMs
  ) {
    fail(`${label} metric ${name} does not use the approved absolute budget`);
  }

  return {
    p95,
    max,
    p95BudgetMs: expectedBudget?.p95Ms,
    maxBudgetMs: expectedBudget?.maxMs,
    samples: raw.samples.length,
  };
}

function validateReport(raw, label) {
  if (
    raw?.schemaVersion !== SCHEMA_VERSION
    || raw?.evidenceMode !== 'release'
    || typeof raw?.metrics !== 'object'
    || raw.metrics === null
    || typeof raw.buildSha !== 'string'
    || !GIT_SHA_PATTERN.test(raw.buildSha)
  ) {
    fail(
      `${label} is not EZTerminal release performance evidence `
      + `(schemaVersion ${SCHEMA_VERSION}, evidenceMode release)`,
    );
  }
  if (
    raw.warmupRuns !== WARMUP_RUNS
    || raw.measurementRuns !== MEASUREMENT_RUNS
    || JSON.stringify(raw.metricOrder) !== JSON.stringify(METRIC_ORDER)
    || JSON.stringify(Object.keys(raw.metrics)) !== JSON.stringify(METRIC_ORDER)
  ) {
    fail(`${label} does not use the exact approved metric order and 5-warmup/25-measurement protocol`);
  }

  const metrics = new Map();
  for (const name of METRIC_ORDER) {
    metrics.set(name, validateMetric(raw.metrics[name], name, label));
  }
  return {
    metrics,
    environment: validateEnvironment(raw.environment, label),
    buildSha: raw.buildSha,
    provenance: validateProvenance(raw.provenance, label, raw.buildSha),
  };
}

async function readReport(path, label) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    fail(`could not read ${label} report ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateReport(parsed, label);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [baselineReport, candidateReport] = await Promise.all([
    readReport(options.baseline, 'baseline'),
    readReport(options.candidate, 'candidate'),
  ]);
  const baseline = baselineReport.metrics;
  const candidate = candidateReport.metrics;
  const failures = [];
  const results = [];

  if (baselineReport.buildSha !== options.expectedBaselineBuildSha) {
    failures.push(
      `baseline build SHA differs: expected ${options.expectedBaselineBuildSha}, `
      + `got ${baselineReport.buildSha}`,
    );
  }
  if (candidateReport.buildSha !== options.expectedCandidateBuildSha) {
    failures.push(
      `candidate build SHA differs: expected ${options.expectedCandidateBuildSha}, `
      + `got ${candidateReport.buildSha}`,
    );
  }

  if (!sameJson(baselineReport.environment, candidateReport.environment)) {
    failures.push(
      'benchmark host, hardware, operating system, or power plan differs between baseline and candidate',
    );
  }
  if (!sameJson(baselineReport.provenance.harness, candidateReport.provenance.harness)) {
    failures.push('benchmark harness, fixtures, lock, or runner provenance differs');
  }
  if (!sameJson(
    baselineReport.provenance.product.runtime,
    candidateReport.provenance.product.runtime,
  )) {
    failures.push('launched Electron/Chrome/Node runtime versions differ');
  }
  if (
    baselineReport.provenance.product.name !== candidateReport.provenance.product.name
    || baselineReport.provenance.product.protocolVersion
      !== candidateReport.provenance.product.protocolVersion
  ) {
    failures.push('product name or protocol version differs between baseline and candidate');
  }

  for (const [name, base] of baseline) {
    const next = candidate.get(name);
    const deltaPercent = base.p95 === 0
      ? (next.p95 === 0 ? 0 : Number.POSITIVE_INFINITY)
      : ((next.p95 - base.p95) / base.p95) * 100;
    const improvementPercent = -deltaPercent;
    const targeted = options.targetMetrics.has(name);

    if (deltaPercent > options.maxRegressionPercent) {
      failures.push(
        `${name}: p95 regressed ${deltaPercent.toFixed(2)}% `
        + `(baseline ${base.p95.toFixed(2)}ms, candidate ${next.p95.toFixed(2)}ms)`,
      );
    }
    if (targeted && improvementPercent < options.minTargetImprovementPercent) {
      failures.push(
        `${name}: targeted p95 improvement was ${improvementPercent.toFixed(2)}%, `
        + `below ${options.minTargetImprovementPercent.toFixed(2)}%`,
      );
    }
    if (next.p95BudgetMs !== undefined && next.p95 > next.p95BudgetMs) {
      failures.push(`${name}: p95 ${next.p95.toFixed(2)}ms exceeds ${next.p95BudgetMs}ms`);
    }
    if (next.maxBudgetMs !== undefined && next.max >= next.maxBudgetMs) {
      failures.push(`${name}: max ${next.max.toFixed(2)}ms must remain below ${next.maxBudgetMs}ms`);
    }

    results.push({
      name,
      samples: next.samples,
      baselineP95Ms: base.p95,
      candidateP95Ms: next.p95,
      deltaPercent,
      targeted,
    });
  }

  process.stdout.write(`${JSON.stringify({
    ok: failures.length === 0,
    schemaVersion: SCHEMA_VERSION,
    baselineBuildSha: baselineReport.buildSha,
    candidateBuildSha: candidateReport.buildSha,
    maxRegressionPercent: options.maxRegressionPercent,
    minTargetImprovementPercent: options.minTargetImprovementPercent,
    results,
    failures,
  }, null, 2)}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

await main();
