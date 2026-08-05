import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const verifier = path.resolve('scripts', 'verify-release-source-evidence.mjs');
const appVersion = '1.0.13';
const baselineSha = 'a'.repeat(40);
const candidateSha = 'b'.repeat(40);
const targetMetric = 'plainOutput12MiBRetentionPressureMs';
const metricOrder = [
  'cancellationLatencyMs',
  'rows100kCompletionMs',
  'plainOutput1_1MiBCompletionMs',
  targetMetric,
] as const;
const genericFileHash = 'c'.repeat(64);
const temporaryRoots: string[] = [];

function sha256(pathname: string): string {
  return createHash('sha256').update(readFileSync(pathname)).digest('hex');
}

function writeJson(pathname: string, value: unknown): void {
  writeFileSync(pathname, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function fileEvidence(pathname: string) {
  return { path: pathname, bytes: 123, sha256: genericFileHash };
}

function performanceMetric(value: number, cancellation = false) {
  const samples = Array.from({ length: 25 }, () => value);
  return {
    unit: 'ms',
    direction: 'lower',
    warmupRuns: 5,
    samples,
    p95Ms: value,
    maxMs: value,
    ...(cancellation ? { absoluteBudget: { p95Ms: 3_000, maxMs: 5_000 } } : {}),
  };
}

function performanceReport(value: number, buildSha: string, version: string) {
  return {
    schemaVersion: 2,
    evidenceMode: 'release',
    buildSha,
    generatedAtUtc: '2026-07-28T00:00:00.000Z',
    environment: {
      platform: 'win32',
      arch: 'x64',
      osRelease: 'test',
      cpuModel: 'test cpu',
      logicalCpuCount: 8,
      totalMemoryGiB: 16,
      hostFingerprint: {
        algorithm: 'windows-machine-guid-sha256-v1',
        sha256: '1'.repeat(64),
      },
      powerPlan: {
        schemeGuid: '381b4222-f694-41f0-9685-ff5bb260df2e',
        powerSource: 'ac',
        effectivePowerMode: 'balanced',
        baseSettingsSha256: '2'.repeat(64),
        effectiveSettingsSha256: '3'.repeat(64),
      },
    },
    warmupRuns: 5,
    measurementRuns: 25,
    metricOrder,
    provenance: {
      product: {
        name: 'EZTerminal',
        version,
        protocolVersion: 3,
        buildSha,
        source: { gitHeadSha: buildSha, workingTreeDirty: false },
        lock: fileEvidence('pnpm-lock.yaml'),
        runtime: {
          electron: '42.5.0',
          chrome: '142.0.0.0',
          node: '24.14.0',
        },
        launchArtifacts: {
          entry: 'build/main.js',
          files: [
            fileEvidence('build/interpreter-process.js'),
            fileEvidence('build/main.js'),
            fileEvidence('build/packet-capture-host.js'),
            fileEvidence('build/preload.js'),
            fileEvidence('build/script-host.js'),
            fileEvidence('renderer/main_window/assets/index.css'),
            fileEvidence('renderer/main_window/assets/index.js'),
            fileEvidence('renderer/main_window/index.html'),
          ],
        },
      },
      harness: {
        source: { gitHeadSha: candidateSha, workingTreeDirty: false },
        lock: fileEvidence('pnpm-lock.yaml'),
        runner: { node: '24.14.0', playwright: '1.61.1' },
        spec: fileEvidence('e2e/release-performance.spec.ts'),
        fixtures: [
          {
            id: 'largePlainOutput',
            ...fileEvidence('e2e/fixtures/large-plain-output.js'),
            stdoutBytes: 1_101_119,
            stdoutSha256: 'bbab0e75bbec8e2b80d281ab814a67d841e03167099d787a407d69a038ed717a',
            completionMarker: 'LARGE-OUTPUT-DONE',
          },
          {
            id: 'retentionPressureOutput',
            ...fileEvidence('e2e/fixtures/retention-pressure-output.js'),
            stdoutBytes: 12_012_025,
            stdoutSha256: '8f4d6337d2637244a47991f82383f798e78b36a145b579c01c027b6a3bdeced7',
            completionMarker: 'RETENTION-PRESSURE-DONE',
          },
        ],
      },
    },
    metrics: Object.fromEntries(metricOrder.map((name) => [
      name,
      performanceMetric(value, name === 'cancellationLatencyMs'),
    ])),
  };
}

function timestamp(offsetSeconds: number): string {
  return new Date(Date.UTC(2026, 6, 28, 0, 0, offsetSeconds)).toISOString();
}

function memorySample(
  phase: 'baseline' | 'soak' | 'final',
  cycle: number | null,
  totalPssKb: number,
  usedJsHeapBytes: number,
  index: number,
) {
  return {
    phase,
    cycle,
    collectedAt: timestamp(index),
    elapsedMs: index * 1_000,
    totalPssKb,
    nativeHeapKb: 500,
    javaHeapKb: 250,
    renderer: {
      usedJsHeapBytes,
      totalJsHeapBytes: usedJsHeapBytes * 2,
      jsHeapLimitBytes: usedJsHeapBytes * 10,
      domNodeCount: 100,
      collectedAt: timestamp(index),
    },
  };
}

function growthCheck(
  metric: 'totalPssKb' | 'rendererUsedJsHeapBytes',
  baselineMedian: number,
  finalMedian: number,
  slack: number,
) {
  const rawGrowth = finalMedian - baselineMedian;
  const growthAfterSlack = Math.max(0, rawGrowth - slack);
  return {
    metric,
    baselineMedian,
    finalMedian,
    rawGrowth,
    slack,
    growthAfterSlack,
    growthAfterSlackPercent: growthAfterSlack / baselineMedian * 100,
    maxGrowthPercent: 20,
    threshold: baselineMedian * 1.2 + slack,
    passed: finalMedian <= baselineMedian * 1.2 + slack,
  };
}

function mobileSoakReport() {
  const cycles = Array.from({ length: 20 }, (_, index) => ({
    index: index + 1,
    startedAt: timestamp(index),
    finishedAt: timestamp(index + 1),
    elapsedMs: 1_000,
    reconnectGeneration: index + 2,
    resumedRunId: 'persistent-run-id',
    reconnectMarkerCount: 1,
    resumeMarkerCount: 1,
    sessionCount: 8,
  }));
  const reconnectGenerations = cycles.map((cycle) => cycle.reconnectGeneration);
  const resumeKeys = cycles.map(
    (cycle) => `${cycle.reconnectGeneration}:${cycle.resumedRunId}`,
  );
  const memorySamples = [
    ...Array.from({ length: 3 }, (_, index) =>
      memorySample('baseline', null, 1_000, 10_000, index)),
    ...Array.from({ length: 20 }, (_, index) =>
      memorySample('soak', index + 1, 1_050, 10_500, index + 3)),
    ...Array.from({ length: 3 }, (_, index) =>
      memorySample('final', null, 1_100, 11_000, index + 23)),
  ];
  return {
    schemaVersion: 1,
    status: 'passed',
    startedAt: timestamp(0),
    finishedAt: timestamp(1_801),
    elapsedMs: 1_801_000,
    apkPath: 'mobile/android/app/build/outputs/apk/debug/app-debug.apk',
    releaseIdentity: {
      appVersion,
      buildSha: candidateSha,
    },
    config: {
      durationMs: 1_800_000,
      quiescenceMs: 15_000,
      sessionCount: 8,
      recoveryCycles: 20,
      networkFault: 'desktop-bridge-disabled-while-android-backgrounded',
      memoryRule: 'final <= baseline * 1.20 + absolute measurement slack',
      pssSlackKb: 16_384,
      rendererHeapSlackBytes: 4_194_304,
    },
    e2eApkMarker: '[ez-e2e] theme:ready',
    initialConnectionGeneration: 1,
    cycles,
    memorySamples,
    growthChecks: [
      growthCheck('totalPssKb', 1_000, 1_100, 16_384),
      growthCheck('rendererUsedJsHeapBytes', 10_000, 11_000, 4_194_304),
    ],
    markerAudit: {
      reconnectGenerations,
      resumeKeys,
      resumedRunIds: ['persistent-run-id'],
      duplicateReconnectGenerations: [],
      duplicateResumeKeys: [],
      passed: true,
    },
    cleanupErrors: [],
  };
}

function expectedSoakSummary(reportSha256: string) {
  return {
    status: 'passed',
    buildSha: candidateSha,
    appVersion,
    durationMs: 1_800_000,
    sessionCount: 8,
    recoveryCycles: 20,
    memoryPassed: true,
    markerAuditPassed: true,
    cleanupPassed: true,
    reportSha256,
  };
}

function releaseComparisonResults() {
  return metricOrder.map((name) => ({
    name,
    samples: 25,
    baselineP95Ms: 100,
    candidateP95Ms: 80,
    deltaPercent: -20,
    targeted: name === targetMetric,
    relativeRegressionBudgetApplied: name !== 'cancellationLatencyMs',
  }));
}

function fixtures(stage: 'candidate' | 'release') {
  const directory = mkdtempSync(path.join(tmpdir(), 'ezterminal-source-evidence-'));
  temporaryRoots.push(directory);
  const reportPath = path.join(directory, 'local-rc-report.json');
  const soakPath = path.join(directory, 'mobile-soak-report.json');
  const baselinePath = path.join(directory, 'desktop-performance-baseline.json');
  const candidatePath = path.join(directory, 'desktop-performance-candidate.json');
  const soak = mobileSoakReport();
  writeJson(soakPath, soak);

  const baseline = performanceReport(100, baselineSha, '1.0.12');
  const candidate = performanceReport(80, candidateSha, appVersion);
  if (stage === 'release') {
    writeJson(baselinePath, baseline);
    writeJson(candidatePath, candidate);
  }

  const report = {
    schemaVersion: 2,
    releaseStage: stage,
    evidenceCompleteness: stage === 'candidate'
      ? 'functional-complete-performance-pending'
      : 'complete',
    appVersion,
    buildSha: candidateSha,
    desktopPerformance: stage === 'candidate'
      ? {
          status: 'pending-final-release-measurement',
          reason: 'not-requested-for-this-local-rc',
        }
      : {
          status: 'passed',
          schemaVersion: 2,
          baselineBuildSha: baselineSha,
          candidateBuildSha: candidateSha,
          baselineReportSha256: sha256(baselinePath),
          candidateReportSha256: sha256(candidatePath),
          maxP95RegressionPercent: 5,
          minTargetP95ImprovementPercent: 15,
          targetMetrics: [targetMetric],
          results: releaseComparisonResults(),
          candidate,
        },
    mobileSoak: expectedSoakSummary(sha256(soakPath)),
  };
  writeJson(reportPath, report);
  return {
    reportPath,
    soakPath,
    baselinePath,
    candidatePath,
    report,
  };
}

function args(
  fixture: ReturnType<typeof fixtures>,
  stage: 'candidate' | 'release',
): string[] {
  const values = [
    verifier,
    '--report', fixture.reportPath,
    '--mobile-soak', fixture.soakPath,
    '--expected-version', appVersion,
    '--expected-build-sha', candidateSha,
    '--expected-stage', stage,
  ];
  if (stage === 'release') {
    values.push(
      '--performance-baseline', fixture.baselinePath,
      '--performance-candidate', fixture.candidatePath,
    );
  }
  return values;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('release source-evidence verifier', () => {
  it('accepts a candidate with exact pending performance state', () => {
    const fixture = fixtures('candidate');
    const result = spawnSync(process.execPath, args(fixture, 'candidate'), {
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      reportSha256: sha256(fixture.reportPath),
      mobileSoakSha256: sha256(fixture.soakPath),
    });
  });

  it('accepts a release after reproducing the raw 5%/15% performance comparison', () => {
    const fixture = fixtures('release');
    const result = spawnSync(process.execPath, args(fixture, 'release'), {
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      reportSha256: sha256(fixture.reportPath),
      mobileSoakSha256: sha256(fixture.soakPath),
      performanceBaselineSha256: sha256(fixture.baselinePath),
      performanceCandidateSha256: sha256(fixture.candidatePath),
    });
  });

  it('accepts a regression-only policy with cancellation on its absolute budget', () => {
    const fixture = fixtures('release');
    const baseline = JSON.parse(readFileSync(fixture.baselinePath, 'utf8')) as ReturnType<
      typeof performanceReport
    >;
    const candidate = JSON.parse(readFileSync(fixture.candidatePath, 'utf8')) as ReturnType<
      typeof performanceReport
    >;
    for (const name of metricOrder) {
      baseline.metrics[name] = performanceMetric(100, name === 'cancellationLatencyMs');
      candidate.metrics[name] = performanceMetric(
        name === 'cancellationLatencyMs' ? 110 : 104,
        name === 'cancellationLatencyMs',
      );
    }
    writeJson(fixture.baselinePath, baseline);
    writeJson(fixture.candidatePath, candidate);
    const performance = fixture.report.desktopPerformance as {
      baselineReportSha256: string;
      candidateReportSha256: string;
      maxP95RegressionPercent: number;
      minTargetP95ImprovementPercent: number;
      targetMetrics: string[];
      results: Array<Record<string, unknown>>;
      candidate: unknown;
    };
    performance.baselineReportSha256 = sha256(fixture.baselinePath);
    performance.candidateReportSha256 = sha256(fixture.candidatePath);
    performance.minTargetP95ImprovementPercent = 0;
    performance.targetMetrics = [];
    performance.results = metricOrder.map((name) => ({
      name,
      samples: 25,
      baselineP95Ms: 100,
      candidateP95Ms: name === 'cancellationLatencyMs' ? 110 : 104,
      deltaPercent: name === 'cancellationLatencyMs' ? 10 : 4,
      targeted: false,
      relativeRegressionBudgetApplied: name !== 'cancellationLatencyMs',
    }));
    performance.candidate = candidate;
    writeJson(fixture.reportPath, fixture.report);

    const result = spawnSync(process.execPath, args(fixture, 'release'), {
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects a raw mobile-soak hash mismatch', () => {
    const fixture = fixtures('candidate');
    const claimedHash = 'f'.repeat(64);
    const actualHash = sha256(fixture.soakPath);
    fixture.report.mobileSoak.reportSha256 = claimedHash;
    writeJson(fixture.reportPath, fixture.report);
    const result = spawnSync(process.execPath, args(fixture, 'candidate'), {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `mobile soak report hash mismatch: expected ${actualHash}, got ${claimedHash}`,
    );
  });

  it('rejects a local summary that differs from the raw soak report', () => {
    const fixture = fixtures('candidate');
    fixture.report.mobileSoak.recoveryCycles = 19;
    writeJson(fixture.reportPath, fixture.report);
    const result = spawnSync(process.execPath, args(fixture, 'candidate'), {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('mobileSoak summary does not equal the raw soak evidence');
  });

  it('rejects a machine-local path serialized into mobile soak evidence', () => {
    const fixture = fixtures('candidate');
    const rawSoak = JSON.parse(readFileSync(fixture.soakPath, 'utf8')) as {
      reportPath?: string;
    };
    rawSoak.reportPath = 'C:\\runner\\private\\mobile-soak-report.json';
    writeJson(fixture.soakPath, rawSoak);
    fixture.report.mobileSoak.reportSha256 = sha256(fixture.soakPath);
    writeJson(fixture.reportPath, fixture.report);
    const result = spawnSync(process.execPath, args(fixture, 'candidate'), {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must not expose a machine-local reportPath');
  });

  it('rejects string-encoded NaN before invoking the performance comparison', () => {
    const fixture = fixtures('release');
    const rawCandidate = JSON.parse(readFileSync(fixture.candidatePath, 'utf8')) as {
      metrics: Record<string, { samples: Array<number | string> }>;
    };
    rawCandidate.metrics.cancellationLatencyMs.samples[0] = 'NaN';
    writeJson(fixture.candidatePath, rawCandidate);
    const desktopPerformance = fixture.report.desktopPerformance as Record<string, unknown>;
    desktopPerformance.candidateReportSha256 = sha256(fixture.candidatePath);
    desktopPerformance.candidate = rawCandidate;
    writeJson(fixture.reportPath, fixture.report);
    const result = spawnSync(process.execPath, args(fixture, 'release'), {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('string-encoded non-finite number');
  });

  it('rejects performance arguments for a candidate stage', () => {
    const fixture = fixtures('candidate');
    const result = spawnSync(process.execPath, [
      ...args(fixture, 'candidate'),
      '--performance-baseline', fixture.baselinePath,
      '--performance-candidate', fixture.candidatePath,
    ], { encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('candidate evidence must not include performance');
  });
});
