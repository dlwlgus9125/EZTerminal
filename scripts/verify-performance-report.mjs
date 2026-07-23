import { readFile } from 'node:fs/promises';
import process from 'node:process';

const DEFAULT_MAX_REGRESSION_PERCENT = 5;
const DEFAULT_MIN_TARGET_IMPROVEMENT_PERCENT = 15;
const MIN_MEASUREMENT_SAMPLES = 25;

function fail(message) {
  throw new Error(message);
}

function parseNumberFlag(value, label, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) fail(`${label} must be a non-negative number`);
  return parsed;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--')) fail(`unexpected argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`${flag} requires a value`);
    values.set(flag, value);
    index += 1;
  }
  const baseline = values.get('--baseline');
  const candidate = values.get('--candidate');
  if (!baseline || !candidate) {
    fail('usage: verify-performance-report.mjs --baseline <json> --candidate <json> [options]');
  }
  return {
    baseline,
    candidate,
    expectedCandidateBuildSha: values.get('--expected-candidate-build-sha'),
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
    targetMetrics: new Set(
      (values.get('--target-metrics') ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  };
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index];
}

function validateReport(raw, label) {
  if (raw?.schemaVersion !== 1 || typeof raw?.metrics !== 'object' || raw.metrics === null) {
    fail(`${label} is not an EZTerminal performance report (schemaVersion 1)`);
  }
  const environment = raw.environment;
  if (
    environment === null
    || typeof environment !== 'object'
    || typeof environment.platform !== 'string'
    || typeof environment.arch !== 'string'
    || typeof environment.osRelease !== 'string'
    || typeof environment.cpuModel !== 'string'
    || !Number.isSafeInteger(environment.logicalCpuCount)
    || environment.logicalCpuCount < 1
    || !Number.isSafeInteger(environment.totalMemoryGiB)
    || environment.totalMemoryGiB < 1
  ) {
    fail(`${label} is missing its non-identifying benchmark environment`);
  }
  const metrics = new Map();
  for (const [name, metric] of Object.entries(raw.metrics)) {
    if (
      metric === null
      || typeof metric !== 'object'
      || metric.unit !== 'ms'
      || metric.direction !== 'lower'
      || !Array.isArray(metric.samples)
      || metric.samples.length < MIN_MEASUREMENT_SAMPLES
      || metric.samples.some((sample) => !Number.isFinite(sample) || sample < 0)
    ) {
      fail(`${label} metric ${name} must contain at least ${MIN_MEASUREMENT_SAMPLES} finite millisecond samples`);
    }
    const p95 = percentile(metric.samples, 0.95);
    const max = Math.max(...metric.samples);
    const p95BudgetMs = metric.absoluteBudget?.p95Ms;
    const maxBudgetMs = metric.absoluteBudget?.maxMs;
    if (p95BudgetMs !== undefined && (!Number.isFinite(p95BudgetMs) || p95BudgetMs < 0)) {
      fail(`${label} metric ${name} has an invalid p95 budget`);
    }
    if (maxBudgetMs !== undefined && (!Number.isFinite(maxBudgetMs) || maxBudgetMs < 0)) {
      fail(`${label} metric ${name} has an invalid max budget`);
    }
    metrics.set(name, { p95, max, p95BudgetMs, maxBudgetMs, samples: metric.samples.length });
  }
  if (metrics.size === 0) fail(`${label} contains no metrics`);
  return { metrics, environment, buildSha: raw.buildSha };
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

  if (
    options.expectedCandidateBuildSha !== undefined
    && candidateReport.buildSha !== options.expectedCandidateBuildSha
  ) {
    failures.push(
      `candidate build SHA differs: expected ${options.expectedCandidateBuildSha}, `
      + `got ${String(candidateReport.buildSha)}`,
    );
  }

  const environmentFields = [
    'platform',
    'arch',
    'osRelease',
    'cpuModel',
    'logicalCpuCount',
    'totalMemoryGiB',
  ];
  if (environmentFields.some(
    (field) => baselineReport.environment[field] !== candidateReport.environment[field],
  )) {
    failures.push('benchmark environment differs between baseline and candidate');
  }

  for (const [name, base] of baseline) {
    const next = candidate.get(name);
    if (!next) {
      failures.push(`${name}: candidate metric is missing`);
      continue;
    }
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

  for (const target of options.targetMetrics) {
    if (!baseline.has(target)) failures.push(`${target}: targeted baseline metric is missing`);
    if (!candidate.has(target)) failures.push(`${target}: targeted candidate metric is missing`);
  }

  process.stdout.write(`${JSON.stringify({
    ok: failures.length === 0,
    maxRegressionPercent: options.maxRegressionPercent,
    minTargetImprovementPercent: options.minTargetImprovementPercent,
    results,
    failures,
  }, null, 2)}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

await main();
