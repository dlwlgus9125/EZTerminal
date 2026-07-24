import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const verifier = path.resolve('scripts', 'verify-performance-report.mjs');
const baselineSha = 'a'.repeat(40);
const candidateSha = 'b'.repeat(40);
const metricOrder = [
  'cancellationLatencyMs',
  'rows100kCompletionMs',
  'plainOutput1_1MiBCompletionMs',
  'plainOutput12MiBRetentionPressureMs',
] as const;
const fileHash = 'c'.repeat(64);

function file(pathname: string) {
  return { path: pathname, bytes: 123, sha256: fileHash };
}

function metric(samples: readonly number[], cancellation = false) {
  return {
    unit: 'ms',
    direction: 'lower',
    warmupRuns: 5,
    samples,
    p95Ms: Math.max(...samples),
    maxMs: Math.max(...samples),
    ...(cancellation ? { absoluteBudget: { p95Ms: 3_000, maxMs: 5_000 } } : {}),
  };
}

function report(
  samples: readonly number[],
  buildSha: string,
  options: { productVersion?: string } = {},
) {
  const metrics = Object.fromEntries(metricOrder.map((name) => [
    name,
    metric(samples, name === 'cancellationLatencyMs'),
  ]));
  return {
    schemaVersion: 2,
    evidenceMode: 'release',
    buildSha,
    generatedAtUtc: '2026-07-24T00:00:00.000Z',
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
        version: options.productVersion ?? '1.0.4',
        protocolVersion: 2,
        buildSha,
        source: { gitHeadSha: buildSha, workingTreeDirty: false },
        lock: file('pnpm-lock.yaml'),
        runtime: {
          electron: '42.5.0',
          chrome: '142.0.0.0',
          node: '24.14.0',
        },
        launchArtifacts: {
          entry: 'build/main.js',
          files: [
            file('build/interpreter-process.js'),
            file('build/main.js'),
            file('build/packet-capture-host.js'),
            file('build/preload.js'),
            file('build/script-host.js'),
            file('renderer/main_window/assets/index.css'),
            file('renderer/main_window/assets/index.js'),
            file('renderer/main_window/index.html'),
          ],
        },
      },
      harness: {
        source: { gitHeadSha: 'd'.repeat(40), workingTreeDirty: false },
        lock: file('pnpm-lock.yaml'),
        runner: { node: '24.14.0', playwright: '1.61.1' },
        spec: file('e2e/release-performance.spec.ts'),
        fixtures: [
          {
            id: 'largePlainOutput',
            ...file('e2e/fixtures/large-plain-output.js'),
            stdoutBytes: 1_101_119,
            stdoutSha256: 'bbab0e75bbec8e2b80d281ab814a67d841e03167099d787a407d69a038ed717a',
            completionMarker: 'LARGE-OUTPUT-DONE',
          },
          {
            id: 'retentionPressureOutput',
            ...file('e2e/fixtures/retention-pressure-output.js'),
            stdoutBytes: 12_012_025,
            stdoutSha256: '8f4d6337d2637244a47991f82383f798e78b36a145b579c01c027b6a3bdeced7',
            completionMarker: 'RETENTION-PRESSURE-DONE',
          },
        ],
      },
    },
    metrics,
  };
}

function fixtures(
  baselineSamples: readonly number[],
  candidateSamples: readonly number[],
) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ezterminal-perf-report-'));
  const baseline = path.join(dir, 'baseline.json');
  const candidate = path.join(dir, 'candidate.json');
  writeFileSync(baseline, JSON.stringify(report(baselineSamples, baselineSha, {
    productVersion: '1.0.2',
  })));
  writeFileSync(candidate, JSON.stringify(report(candidateSamples, candidateSha)));
  return { baseline, candidate };
}

function verifierArgs(baseline: string, candidate: string): string[] {
  return [
    verifier,
    '--baseline', baseline,
    '--candidate', candidate,
    '--expected-baseline-build-sha', baselineSha,
    '--expected-candidate-build-sha', candidateSha,
  ];
}

describe('performance report verifier', () => {
  it('accepts schema v2 evidence inside the relative and absolute budgets', () => {
    const { baseline, candidate } = fixtures(
      Array.from({ length: 25 }, () => 100),
      Array.from({ length: 25 }, () => 95),
    );
    const output = execFileSync(process.execPath, verifierArgs(baseline, candidate), {
      encoding: 'utf8',
    });
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      schemaVersion: 2,
      baselineBuildSha: baselineSha,
      candidateBuildSha: candidateSha,
    });
  });

  it('rejects a p95 regression above five percent', () => {
    const { baseline, candidate } = fixtures(
      Array.from({ length: 25 }, () => 100),
      Array.from({ length: 25 }, () => 106),
    );
    const result = spawnSync(process.execPath, verifierArgs(baseline, candidate), {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).failures[0]).toContain('regressed 6.00%');
  });

  it('enforces the fifteen-percent target only for named bottlenecks', () => {
    const { baseline, candidate } = fixtures(
      Array.from({ length: 25 }, () => 100),
      Array.from({ length: 25 }, () => 90),
    );
    const result = spawnSync(process.execPath, [
      ...verifierArgs(baseline, candidate),
      '--target-metrics', 'plainOutput12MiBRetentionPressureMs',
    ], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).failures[0]).toContain('below 15.00%');
  });

  it('rejects any sample count other than exactly 25', () => {
    const { baseline, candidate } = fixtures(
      Array.from({ length: 24 }, () => 100),
      Array.from({ length: 25 }, () => 90),
    );
    const result = spawnSync(process.execPath, verifierArgs(baseline, candidate), {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('exactly 25');
  });

  it('rejects a changed metric order or metric set', () => {
    const { baseline, candidate } = fixtures(
      Array.from({ length: 25 }, () => 100),
      Array.from({ length: 25 }, () => 90),
    );
    const candidateReport = JSON.parse(readFileSync(candidate, 'utf8')) as {
      metricOrder: string[];
    };
    candidateReport.metricOrder = [...candidateReport.metricOrder].reverse();
    writeFileSync(candidate, JSON.stringify(candidateReport));

    const result = spawnSync(process.execPath, verifierArgs(baseline, candidate), {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('exact approved metric order');
  });

  it('rejects a comparison collected on different hardware', () => {
    const { baseline, candidate } = fixtures(
      Array.from({ length: 25 }, () => 100),
      Array.from({ length: 25 }, () => 90),
    );
    const candidateReport = JSON.parse(readFileSync(candidate, 'utf8')) as {
      environment: { logicalCpuCount: number };
    };
    candidateReport.environment.logicalCpuCount = 16;
    writeFileSync(candidate, JSON.stringify(candidateReport));

    const result = spawnSync(process.execPath, verifierArgs(baseline, candidate), {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).failures).toContain(
      'benchmark host, hardware, operating system, or power plan differs between baseline and candidate',
    );
  });

  it('rejects matching hardware metadata from a different host fingerprint', () => {
    const { baseline, candidate } = fixtures(
      Array.from({ length: 25 }, () => 100),
      Array.from({ length: 25 }, () => 90),
    );
    const candidateReport = JSON.parse(readFileSync(candidate, 'utf8')) as {
      environment: { hostFingerprint: { sha256: string } };
    };
    candidateReport.environment.hostFingerprint.sha256 = '3'.repeat(64);
    writeFileSync(candidate, JSON.stringify(candidateReport));

    const result = spawnSync(process.execPath, verifierArgs(baseline, candidate), {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).failures).toContain(
      'benchmark host, hardware, operating system, or power plan differs between baseline and candidate',
    );
  });

  it('rejects the same host under different base power-plan settings', () => {
    const { baseline, candidate } = fixtures(
      Array.from({ length: 25 }, () => 100),
      Array.from({ length: 25 }, () => 90),
    );
    const candidateReport = JSON.parse(readFileSync(candidate, 'utf8')) as {
      environment: { powerPlan: { baseSettingsSha256: string } };
    };
    candidateReport.environment.powerPlan.baseSettingsSha256 = '4'.repeat(64);
    writeFileSync(candidate, JSON.stringify(candidateReport));

    const result = spawnSync(process.execPath, verifierArgs(baseline, candidate), {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).failures).toContain(
      'benchmark host, hardware, operating system, or power plan differs between baseline and candidate',
    );
  });

  it('rejects the same host under different effective overlay settings', () => {
    const { baseline, candidate } = fixtures(
      Array.from({ length: 25 }, () => 100),
      Array.from({ length: 25 }, () => 90),
    );
    const candidateReport = JSON.parse(readFileSync(candidate, 'utf8')) as {
      environment: { powerPlan: { effectiveSettingsSha256: string } };
    };
    candidateReport.environment.powerPlan.effectiveSettingsSha256 = '4'.repeat(64);
    writeFileSync(candidate, JSON.stringify(candidateReport));

    const result = spawnSync(process.execPath, verifierArgs(baseline, candidate), {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).failures).toContain(
      'benchmark host, hardware, operating system, or power plan differs between baseline and candidate',
    );
  });

  it('rejects the same host after switching from AC to battery power', () => {
    const { baseline, candidate } = fixtures(
      Array.from({ length: 25 }, () => 100),
      Array.from({ length: 25 }, () => 90),
    );
    const candidateReport = JSON.parse(readFileSync(candidate, 'utf8')) as {
      environment: { powerPlan: { powerSource: 'ac' | 'dc' } };
    };
    candidateReport.environment.powerPlan.powerSource = 'dc';
    writeFileSync(candidate, JSON.stringify(candidateReport));

    const result = spawnSync(process.execPath, verifierArgs(baseline, candidate), {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).failures).toContain(
      'benchmark host, hardware, operating system, or power plan differs between baseline and candidate',
    );
  });

  it('rejects the same host under a different effective power mode', () => {
    const { baseline, candidate } = fixtures(
      Array.from({ length: 25 }, () => 100),
      Array.from({ length: 25 }, () => 90),
    );
    const candidateReport = JSON.parse(readFileSync(candidate, 'utf8')) as {
      environment: { powerPlan: { effectivePowerMode: string } };
    };
    candidateReport.environment.powerPlan.effectivePowerMode = 'high-performance';
    writeFileSync(candidate, JSON.stringify(candidateReport));

    const result = spawnSync(process.execPath, verifierArgs(baseline, candidate), {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).failures).toContain(
      'benchmark host, hardware, operating system, or power plan differs between baseline and candidate',
    );
  });

  it('rejects evidence from an unexpected baseline or candidate build SHA', () => {
    const { baseline, candidate } = fixtures(
      Array.from({ length: 25 }, () => 100),
      Array.from({ length: 25 }, () => 95),
    );
    const result = spawnSync(process.execPath, [
      verifier,
      '--baseline', baseline,
      '--candidate', candidate,
      '--expected-baseline-build-sha', 'e'.repeat(40),
      '--expected-candidate-build-sha', 'f'.repeat(40),
    ], { encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).failures).toEqual([
      `baseline build SHA differs: expected ${'e'.repeat(40)}, got ${baselineSha}`,
      `candidate build SHA differs: expected ${'f'.repeat(40)}, got ${candidateSha}`,
    ]);
  });

  it('rejects dirty product or harness source provenance', () => {
    const { baseline, candidate } = fixtures(
      Array.from({ length: 25 }, () => 100),
      Array.from({ length: 25 }, () => 95),
    );
    const candidateReport = JSON.parse(readFileSync(candidate, 'utf8')) as {
      provenance: { product: { source: { workingTreeDirty: boolean } } };
    };
    candidateReport.provenance.product.source.workingTreeDirty = true;
    writeFileSync(candidate, JSON.stringify(candidateReport));

    const result = spawnSync(process.execPath, verifierArgs(baseline, candidate), {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dirty working tree');
  });

  it('rejects diagnostic reports even when their samples resemble release evidence', () => {
    const { baseline, candidate } = fixtures(
      Array.from({ length: 25 }, () => 100),
      Array.from({ length: 25 }, () => 95),
    );
    const candidateReport = JSON.parse(readFileSync(candidate, 'utf8')) as {
      evidenceMode: string;
    };
    candidateReport.evidenceMode = 'diagnostic';
    writeFileSync(candidate, JSON.stringify(candidateReport));

    const result = spawnSync(process.execPath, verifierArgs(baseline, candidate), {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('evidenceMode release');
  });

  it('rejects changed harness, fixture, lock, or runner provenance', () => {
    const { baseline, candidate } = fixtures(
      Array.from({ length: 25 }, () => 100),
      Array.from({ length: 25 }, () => 95),
    );
    const candidateReport = JSON.parse(readFileSync(candidate, 'utf8')) as {
      provenance: { harness: { fixtures: Array<{ sha256: string }> } };
    };
    candidateReport.provenance.harness.fixtures[0].sha256 = 'e'.repeat(64);
    writeFileSync(candidate, JSON.stringify(candidateReport));

    const result = spawnSync(process.execPath, verifierArgs(baseline, candidate), {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).failures).toContain(
      'benchmark harness, fixtures, lock, or runner provenance differs',
    );
  });

  it('rejects incomplete launch artifact evidence', () => {
    const { baseline, candidate } = fixtures(
      Array.from({ length: 25 }, () => 100),
      Array.from({ length: 25 }, () => 95),
    );
    const candidateReport = JSON.parse(readFileSync(candidate, 'utf8')) as {
      provenance: { product: { launchArtifacts: { files: Array<{ path: string }> } } };
    };
    candidateReport.provenance.product.launchArtifacts.files =
      candidateReport.provenance.product.launchArtifacts.files.filter(
        (artifact) => artifact.path !== 'build/preload.js',
      );
    writeFileSync(candidate, JSON.stringify(candidateReport));

    const result = spawnSync(process.execPath, verifierArgs(baseline, candidate), {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing build/preload.js');
  });
});
