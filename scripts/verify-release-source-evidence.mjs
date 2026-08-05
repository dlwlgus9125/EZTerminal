import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const STRING_NON_FINITE_PATTERN = /^[+-]?(?:nan|infinity)$/i;
const PERFORMANCE_METRICS = [
  'cancellationLatencyMs',
  'rows100kCompletionMs',
  'plainOutput1_1MiBCompletionMs',
  'plainOutput12MiBRetentionPressureMs',
];
const SOAK_DURATION_MS = 30 * 60 * 1_000;
const SOAK_SESSION_COUNT = 8;
const SOAK_RECOVERY_CYCLES = 20;
const PSS_SLACK_KB = 16 * 1_024;
const RENDERER_HEAP_SLACK_BYTES = 4 * 1_024 * 1_024;
const MAX_EVIDENCE_BYTES = 16 * 1_024 * 1_024;
const PERFORMANCE_VERIFIER = fileURLToPath(
  new URL('./verify-performance-report.mjs', import.meta.url),
);
const RELEASE_CONTRACT = new URL('../release/version.json', import.meta.url);
const ALLOWED_FLAGS = new Set([
  '--report',
  '--mobile-soak',
  '--expected-version',
  '--expected-build-sha',
  '--expected-stage',
  '--performance-baseline',
  '--performance-candidate',
]);

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isIsoTimestamp(value) {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function assert(condition, message) {
  if (!condition) fail(message);
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

  for (const required of [
    '--report',
    '--mobile-soak',
    '--expected-version',
    '--expected-build-sha',
    '--expected-stage',
  ]) {
    if (!values.has(required)) fail(`${required} is required`);
  }

  const expectedVersion = values.get('--expected-version');
  const expectedBuildSha = values.get('--expected-build-sha')?.toLowerCase();
  const expectedStage = values.get('--expected-stage');
  assert(isNonEmptyString(expectedVersion), '--expected-version must be a non-empty version');
  assert(
    typeof expectedBuildSha === 'string' && GIT_SHA_PATTERN.test(expectedBuildSha),
    '--expected-build-sha must be a full 40-character Git SHA',
  );
  assert(
    expectedStage === 'candidate' || expectedStage === 'release',
    '--expected-stage must be candidate or release',
  );

  const performanceBaseline = values.get('--performance-baseline');
  const performanceCandidate = values.get('--performance-candidate');
  if (expectedStage === 'candidate') {
    assert(
      performanceBaseline === undefined && performanceCandidate === undefined,
      'candidate evidence must not include performance report arguments',
    );
  } else {
    assert(
      isNonEmptyString(performanceBaseline) && isNonEmptyString(performanceCandidate),
      'release evidence requires --performance-baseline and --performance-candidate',
    );
  }

  return {
    report: values.get('--report'),
    mobileSoak: values.get('--mobile-soak'),
    expectedVersion,
    expectedBuildSha,
    expectedStage,
    performanceBaseline,
    performanceCandidate,
  };
}

function assertNoNonFiniteValues(value, label, jsonPath = '$') {
  if (typeof value === 'number') {
    assert(Number.isFinite(value), `${label} contains a non-finite number at ${jsonPath}`);
    return;
  }
  if (typeof value === 'string') {
    assert(
      !STRING_NON_FINITE_PATTERN.test(value.trim()),
      `${label} contains a string-encoded non-finite number at ${jsonPath}`,
    );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoNonFiniteValues(entry, label, `${jsonPath}[${index}]`));
    return;
  }
  if (isObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      assertNoNonFiniteValues(entry, label, `${jsonPath}.${key}`);
    }
  }
}

function validatePerformancePolicy(contract, expectedVersion) {
  assert(isObject(contract), 'release performance policy contract must be an object');
  assert(
    contract.version === expectedVersion,
    'release performance policy contract version differs from the expected release version',
  );
  const policy = contract.performancePolicy;
  assert(isObject(policy), 'release performancePolicy is missing');
  assert(
    Number.isFinite(policy.maxP95RegressionPercent)
      && policy.maxP95RegressionPercent >= 0,
    'release maxP95RegressionPercent must be a non-negative number',
  );
  assert(
    Number.isFinite(policy.minTargetP95ImprovementPercent)
      && policy.minTargetP95ImprovementPercent >= 0,
    'release minTargetP95ImprovementPercent must be a non-negative number',
  );
  assert(Array.isArray(policy.targetMetrics), 'release targetMetrics must be an array');
  assert(
    policy.targetMetrics.every((metric) => PERFORMANCE_METRICS.includes(metric))
      && new Set(policy.targetMetrics).size === policy.targetMetrics.length,
    'release targetMetrics contains an unknown or duplicate metric',
  );
  return policy;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readEvidence(path, label) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    fail(
      `could not inspect ${label} ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  assert(
    metadata.isFile() && !metadata.isSymbolicLink(),
    `${label} must be a normal file`,
  );
  assert(
    metadata.size >= 1 && metadata.size <= MAX_EVIDENCE_BYTES,
    `${label} must be between 1 and ${MAX_EVIDENCE_BYTES} bytes`,
  );

  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    fail(
      `could not read ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assert(
    bytes.length === metadata.size
      && bytes.length >= 1
      && bytes.length <= MAX_EVIDENCE_BYTES,
    `${label} changed size or exceeds the evidence limit while being read`,
  );

  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    fail(
      `could not parse ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertNoNonFiniteValues(parsed, label);
  return { parsed, hash: sha256(bytes) };
}

function assertHash(value, expected, label) {
  assert(
    typeof value === 'string' && SHA256_PATTERN.test(value),
    `${label} must be a lowercase SHA-256`,
  );
  assert(value === expected, `${label} hash mismatch: expected ${expected}, got ${value}`);
}

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

function median(values) {
  assert(values.length > 0, 'cannot calculate a median without samples');
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function expectedGrowthCheck(metric, baselineValues, finalValues, slack) {
  const baselineMedian = median(baselineValues);
  const finalMedian = median(finalValues);
  const rawGrowth = finalMedian - baselineMedian;
  const growthAfterSlack = Math.max(0, rawGrowth - slack);
  const growthAfterSlackPercent = baselineMedian === 0
    ? (growthAfterSlack === 0 ? 0 : Number.POSITIVE_INFINITY)
    : (growthAfterSlack / baselineMedian) * 100;
  const threshold = baselineMedian * 1.2 + slack;
  return {
    metric,
    baselineMedian,
    finalMedian,
    rawGrowth,
    slack,
    growthAfterSlack,
    growthAfterSlackPercent,
    maxGrowthPercent: 20,
    threshold,
    passed: finalMedian <= threshold,
  };
}

function validateMemorySample(sample, index) {
  const label = `mobile soak memorySamples[${index}]`;
  assert(isObject(sample), `${label} must be an object`);
  assert(
    sample.phase === 'baseline' || sample.phase === 'soak' || sample.phase === 'final',
    `${label} has an invalid phase`,
  );
  if (sample.phase === 'soak') {
    assert(
      isPositiveInteger(sample.cycle) && sample.cycle <= SOAK_RECOVERY_CYCLES,
      `${label} has an invalid recovery cycle`,
    );
  } else {
    assert(sample.cycle === null, `${label} must not claim a recovery cycle`);
  }
  assert(isIsoTimestamp(sample.collectedAt), `${label} has an invalid collectedAt timestamp`);
  assert(isNonNegativeInteger(sample.elapsedMs), `${label} has an invalid elapsedMs`);
  assert(isNonNegativeInteger(sample.totalPssKb), `${label} has an invalid TOTAL PSS sample`);
  for (const field of ['nativeHeapKb', 'javaHeapKb']) {
    assert(
      sample[field] === null || isNonNegativeInteger(sample[field]),
      `${label}.${field} must be null or a non-negative integer`,
    );
  }
  assert(isObject(sample.renderer), `${label}.renderer must be an object`);
  assert(
    isNonNegativeInteger(sample.renderer.usedJsHeapBytes),
    `${label}.renderer.usedJsHeapBytes must be a non-negative integer`,
  );
  for (const field of ['totalJsHeapBytes', 'jsHeapLimitBytes']) {
    assert(
      sample.renderer[field] === null || isNonNegativeInteger(sample.renderer[field]),
      `${label}.renderer.${field} must be null or a non-negative integer`,
    );
  }
  assert(
    isNonNegativeInteger(sample.renderer.domNodeCount),
    `${label}.renderer.domNodeCount must be a non-negative integer`,
  );
  assert(
    isIsoTimestamp(sample.renderer.collectedAt),
    `${label}.renderer.collectedAt is invalid`,
  );
}

function validateSoak(soak, expectedVersion, expectedBuildSha) {
  assert(isObject(soak), 'mobile soak evidence must be an object');
  assert(soak.schemaVersion === 1, 'mobile soak schemaVersion must be 1');
  assert(soak.status === 'passed', 'mobile soak status must be passed');
  assert(!Object.hasOwn(soak, 'error'), 'passing mobile soak evidence must not contain an error');
  assert(isIsoTimestamp(soak.startedAt), 'mobile soak startedAt is invalid');
  assert(isIsoTimestamp(soak.finishedAt), 'mobile soak finishedAt is invalid');
  assert(
    soak.apkPath === 'mobile/android/app/build/outputs/apk/debug/app-debug.apk',
    'mobile soak apkPath must be the canonical repository-relative debug APK path',
  );
  assert(
    !Object.hasOwn(soak, 'reportPath'),
    'mobile soak evidence must not expose a machine-local reportPath',
  );
  assert(
    isNonEmptyString(soak.e2eApkMarker) && soak.e2eApkMarker.includes('[ez-e2e] theme:'),
    'mobile soak E2E APK marker is missing or invalid',
  );
  assert(
    isNonNegativeInteger(soak.initialConnectionGeneration),
    'mobile soak initial connection generation is invalid',
  );

  assert(isObject(soak.releaseIdentity), 'mobile soak release identity is missing');
  assert(
    soak.releaseIdentity.appVersion === expectedVersion,
    'mobile soak app version differs from the expected release version',
  );
  assert(
    soak.releaseIdentity.buildSha === expectedBuildSha,
    'mobile soak build SHA differs from the expected release SHA',
  );

  assert(isObject(soak.config), 'mobile soak config is missing');
  assert(
    isPositiveInteger(soak.config.durationMs) && soak.config.durationMs >= SOAK_DURATION_MS,
    'mobile soak duration must be at least 30 minutes',
  );
  assert(
    isNonNegativeInteger(soak.config.quiescenceMs),
    'mobile soak quiescence must be a non-negative integer',
  );
  assert(
    soak.config.sessionCount === SOAK_SESSION_COUNT,
    `mobile soak must use exactly ${SOAK_SESSION_COUNT} sessions`,
  );
  assert(
    soak.config.recoveryCycles === SOAK_RECOVERY_CYCLES,
    `mobile soak must configure exactly ${SOAK_RECOVERY_CYCLES} recovery cycles`,
  );
  assert(
    soak.config.networkFault === 'desktop-bridge-disabled-while-android-backgrounded',
    'mobile soak network-fault config differs from the approved gate',
  );
  assert(
    soak.config.memoryRule === 'final <= baseline * 1.20 + absolute measurement slack',
    'mobile soak memory rule differs from the approved gate',
  );
  assert(soak.config.pssSlackKb === PSS_SLACK_KB, 'mobile soak PSS slack differs');
  assert(
    soak.config.rendererHeapSlackBytes === RENDERER_HEAP_SLACK_BYTES,
    'mobile soak renderer heap slack differs',
  );
  assert(
    isNonNegativeInteger(soak.elapsedMs) && soak.elapsedMs >= soak.config.durationMs,
    'mobile soak elapsed time is shorter than its configured duration',
  );
  const timestampElapsedMs = Date.parse(soak.finishedAt) - Date.parse(soak.startedAt);
  assert(
    timestampElapsedMs >= soak.config.durationMs
      && Math.abs(timestampElapsedMs - soak.elapsedMs) <= 1_000,
    'mobile soak timestamps do not corroborate its elapsed duration',
  );

  assert(
    Array.isArray(soak.cycles) && soak.cycles.length === SOAK_RECOVERY_CYCLES,
    `mobile soak must contain exactly ${SOAK_RECOVERY_CYCLES} recovery cycles`,
  );
  for (let index = 0; index < soak.cycles.length; index += 1) {
    const cycle = soak.cycles[index];
    const label = `mobile soak cycles[${index}]`;
    assert(isObject(cycle), `${label} must be an object`);
    assert(cycle.index === index + 1, `${label} has a non-canonical cycle index`);
    assert(isIsoTimestamp(cycle.startedAt), `${label}.startedAt is invalid`);
    assert(isIsoTimestamp(cycle.finishedAt), `${label}.finishedAt is invalid`);
    assert(isNonNegativeInteger(cycle.elapsedMs), `${label}.elapsedMs is invalid`);
    assert(
      Math.abs(
        Date.parse(cycle.finishedAt) - Date.parse(cycle.startedAt) - cycle.elapsedMs,
      ) <= 1_000,
      `${label} timestamps do not corroborate elapsedMs`,
    );
    assert(isPositiveInteger(cycle.reconnectGeneration), `${label} has an invalid generation`);
    assert(isNonEmptyString(cycle.resumedRunId), `${label} has no resumed run ID`);
    assert(cycle.reconnectMarkerCount === 1, `${label} must contain one reconnect marker`);
    assert(cycle.resumeMarkerCount === 1, `${label} must contain one resume marker`);
    assert(
      cycle.sessionCount === SOAK_SESSION_COUNT,
      `${label} must retain exactly ${SOAK_SESSION_COUNT} sessions`,
    );
  }

  const reconnectGenerations = soak.cycles.map((cycle) => cycle.reconnectGeneration);
  const resumeKeys = soak.cycles.map(
    (cycle) => `${cycle.reconnectGeneration}:${cycle.resumedRunId}`,
  );
  const resumedRunIds = [...new Set(soak.cycles.map((cycle) => cycle.resumedRunId))];
  const expectedMarkerAudit = {
    reconnectGenerations,
    resumeKeys,
    resumedRunIds,
    duplicateReconnectGenerations: duplicates(reconnectGenerations),
    duplicateResumeKeys: duplicates(resumeKeys),
    passed: duplicates(reconnectGenerations).length === 0
      && duplicates(resumeKeys).length === 0
      && resumedRunIds.length === 1,
  };
  assert(
    isDeepStrictEqual(soak.markerAudit, expectedMarkerAudit),
    'mobile soak marker audit does not equal the cycle-derived marker audit',
  );
  assert(expectedMarkerAudit.passed, 'mobile soak marker audit did not pass');

  assert(
    Array.isArray(soak.memorySamples)
      && soak.memorySamples.length === SOAK_RECOVERY_CYCLES + 6,
    'mobile soak must contain 3 baseline, 20 cycle, and 3 final memory samples',
  );
  soak.memorySamples.forEach(validateMemorySample);
  const baselineSamples = soak.memorySamples.filter((sample) => sample.phase === 'baseline');
  const cycleSamples = soak.memorySamples.filter((sample) => sample.phase === 'soak');
  const finalSamples = soak.memorySamples.filter((sample) => sample.phase === 'final');
  assert(
    baselineSamples.length === 3 && cycleSamples.length === SOAK_RECOVERY_CYCLES
      && finalSamples.length === 3,
    'mobile soak memory sample phases are incomplete',
  );
  assert(
    isDeepStrictEqual(
      cycleSamples.map((sample) => sample.cycle),
      Array.from({ length: SOAK_RECOVERY_CYCLES }, (_, index) => index + 1),
    ),
    'mobile soak cycle memory samples are not in canonical 1..20 order',
  );

  const expectedGrowthChecks = [
    expectedGrowthCheck(
      'totalPssKb',
      baselineSamples.map((sample) => sample.totalPssKb),
      finalSamples.map((sample) => sample.totalPssKb),
      PSS_SLACK_KB,
    ),
    expectedGrowthCheck(
      'rendererUsedJsHeapBytes',
      baselineSamples.map((sample) => sample.renderer.usedJsHeapBytes),
      finalSamples.map((sample) => sample.renderer.usedJsHeapBytes),
      RENDERER_HEAP_SLACK_BYTES,
    ),
  ];
  assert(
    isDeepStrictEqual(soak.growthChecks, expectedGrowthChecks),
    'mobile soak growth checks do not equal the raw memory-sample calculation',
  );
  assert(
    expectedGrowthChecks.every((check) => check.passed),
    'mobile soak memory growth exceeded its approved bound',
  );
  assert(
    Array.isArray(soak.cleanupErrors) && soak.cleanupErrors.length === 0,
    'mobile soak cleanup must finish without errors',
  );

  return {
    status: soak.status,
    buildSha: soak.releaseIdentity.buildSha,
    appVersion: soak.releaseIdentity.appVersion,
    durationMs: soak.config.durationMs,
    sessionCount: soak.config.sessionCount,
    recoveryCycles: soak.cycles.length,
    memoryPassed: expectedGrowthChecks.every((check) => check.passed),
    markerAuditPassed: expectedMarkerAudit.passed,
    cleanupPassed: soak.cleanupErrors.length === 0,
  };
}

function validateReportIdentity(report, options) {
  assert(isObject(report), 'local RC report must be an object');
  assert(report.schemaVersion === 2, 'local RC report schemaVersion must be 2');
  assert(
    report.releaseStage === options.expectedStage,
    `local RC report stage must be ${options.expectedStage}`,
  );
  const expectedCompleteness = options.expectedStage === 'candidate'
    ? 'functional-complete-performance-pending'
    : 'complete';
  assert(
    report.evidenceCompleteness === expectedCompleteness,
    `local RC report evidenceCompleteness must be ${expectedCompleteness}`,
  );
  assert(
    report.appVersion === options.expectedVersion,
    'local RC report app version differs from the expected release version',
  );
  assert(
    report.buildSha === options.expectedBuildSha,
    'local RC report build SHA differs from the expected release SHA',
  );
}

function runPerformanceVerifier(options, performance, policy) {
  const verifierArguments = [
    PERFORMANCE_VERIFIER,
    '--baseline', options.performanceBaseline,
    '--candidate', options.performanceCandidate,
    '--expected-baseline-build-sha', performance.baselineBuildSha,
    '--expected-candidate-build-sha', options.expectedBuildSha,
    '--max-regression-percent', String(policy.maxP95RegressionPercent),
    '--min-target-improvement-percent', String(policy.minTargetP95ImprovementPercent),
  ];
  if (policy.targetMetrics.length > 0) {
    verifierArguments.push('--target-metrics', policy.targetMetrics.join(','));
  }
  const result = spawnSync(process.execPath, verifierArguments, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) fail(`could not run performance verifier: ${result.error.message}`);

  let comparison;
  try {
    comparison = JSON.parse(result.stdout);
  } catch {
    fail(`performance verifier returned invalid JSON: ${result.stderr.trim() || result.stdout}`);
  }
  assertNoNonFiniteValues(comparison, 'performance comparison');
  if (result.status !== 0 || comparison.ok !== true) {
    const details = Array.isArray(comparison.failures)
      ? comparison.failures.join('; ')
      : result.stderr.trim();
    fail(`performance comparison failed${details ? `: ${details}` : ''}`);
  }
  return comparison;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [reportEvidence, soakEvidence, releaseContract] = await Promise.all([
    readEvidence(options.report, 'local RC report'),
    readEvidence(options.mobileSoak, 'mobile soak report'),
    readFile(RELEASE_CONTRACT, 'utf8').then((contents) => JSON.parse(contents)),
  ]);
  const performancePolicy = validatePerformancePolicy(
    releaseContract,
    options.expectedVersion,
  );
  const report = reportEvidence.parsed;
  validateReportIdentity(report, options);

  const soakSummary = validateSoak(
    soakEvidence.parsed,
    options.expectedVersion,
    options.expectedBuildSha,
  );
  const expectedSoakSummary = {
    ...soakSummary,
    reportSha256: soakEvidence.hash,
  };
  assertHash(
    report.mobileSoak?.reportSha256,
    soakEvidence.hash,
    'mobile soak report',
  );
  assert(
    isDeepStrictEqual(report.mobileSoak, expectedSoakSummary),
    'local RC mobileSoak summary does not equal the raw soak evidence',
  );

  const output = {
    ok: true,
    reportSha256: reportEvidence.hash,
    mobileSoakSha256: soakEvidence.hash,
  };

  if (options.expectedStage === 'candidate') {
    assert(
      isDeepStrictEqual(report.desktopPerformance, {
        status: 'pending-final-release-measurement',
        reason: 'not-requested-for-this-local-rc',
      }),
      'candidate desktop performance must be the exact pending status',
    );
  } else {
    const [baselineEvidence, candidateEvidence] = await Promise.all([
      readEvidence(options.performanceBaseline, 'performance baseline report'),
      readEvidence(options.performanceCandidate, 'performance candidate report'),
    ]);
    const performance = report.desktopPerformance;
    assert(isObject(performance), 'release desktop performance evidence is missing');
    assert(performance.status === 'passed', 'release desktop performance status must be passed');
    assert(performance.schemaVersion === 2, 'release desktop performance schemaVersion must be 2');
    assert(
      typeof performance.baselineBuildSha === 'string'
        && GIT_SHA_PATTERN.test(performance.baselineBuildSha),
      'release performance baselineBuildSha must be a full lowercase Git SHA',
    );
    assert(
      performance.candidateBuildSha === options.expectedBuildSha,
      'release performance candidateBuildSha differs from the expected release SHA',
    );
    assert(
      performance.maxP95RegressionPercent === performancePolicy.maxP95RegressionPercent,
      'release performance regression budget differs from release/version.json',
    );
    assert(
      performance.minTargetP95ImprovementPercent
        === performancePolicy.minTargetP95ImprovementPercent,
      'release performance target improvement differs from release/version.json',
    );
    assert(
      isDeepStrictEqual(performance.targetMetrics, performancePolicy.targetMetrics),
      'release performance target metrics differ from release/version.json',
    );
    assertHash(
      performance.baselineReportSha256,
      baselineEvidence.hash,
      'performance baseline report',
    );
    assertHash(
      performance.candidateReportSha256,
      candidateEvidence.hash,
      'performance candidate report',
    );
    assert(
      baselineEvidence.parsed.buildSha === performance.baselineBuildSha,
      'raw performance baseline SHA differs from the local RC report',
    );
    assert(
      candidateEvidence.parsed.buildSha === options.expectedBuildSha,
      'raw performance candidate SHA differs from the expected release SHA',
    );
    assert(
      candidateEvidence.parsed?.provenance?.product?.version === options.expectedVersion,
      'raw performance candidate version differs from the expected release version',
    );
    assert(
      candidateEvidence.parsed?.provenance?.harness?.source?.gitHeadSha
        === options.expectedBuildSha,
      'raw performance harness SHA differs from the expected release SHA',
    );

    const comparison = runPerformanceVerifier(options, performance, performancePolicy);
    assert(
      isDeepStrictEqual(performance.results, comparison.results),
      'embedded performance comparison results differ from raw report verification',
    );
    assert(
      isDeepStrictEqual(performance.candidate, candidateEvidence.parsed),
      'embedded performance candidate differs from the raw candidate report',
    );
    output.performanceBaselineSha256 = baselineEvidence.hash;
    output.performanceCandidateSha256 = candidateEvidence.hash;
  }

  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `verify-release-source-evidence: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
