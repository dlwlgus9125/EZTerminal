import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const verifier = path.resolve('scripts', 'verify-performance-report.mjs');

function report(samples: readonly number[], budget = false, buildSha?: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    ...(buildSha ? { buildSha } : {}),
    environment: {
      platform: 'win32',
      arch: 'x64',
      osRelease: 'test',
      cpuModel: 'test cpu',
      logicalCpuCount: 8,
      totalMemoryGiB: 16,
    },
    metrics: {
      completionMs: {
        unit: 'ms',
        direction: 'lower',
        samples,
        ...(budget ? { absoluteBudget: { p95Ms: 150, maxMs: 200 } } : {}),
      },
    },
  });
}

function fixtures(
  baselineSamples: readonly number[],
  candidateSamples: readonly number[],
  budget = false,
  candidateBuildSha?: string,
) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ezterminal-perf-report-'));
  const baseline = path.join(dir, 'baseline.json');
  const candidate = path.join(dir, 'candidate.json');
  writeFileSync(baseline, report(baselineSamples));
  writeFileSync(candidate, report(candidateSamples, budget, candidateBuildSha));
  return { baseline, candidate };
}

describe('performance report verifier', () => {
  it('accepts a candidate inside the relative and absolute budgets', () => {
    const { baseline, candidate } = fixtures(
      Array.from({ length: 25 }, () => 100),
      Array.from({ length: 25 }, () => 95),
      true,
    );
    const output = execFileSync(process.execPath, [
      verifier,
      '--baseline', baseline,
      '--candidate', candidate,
    ], { encoding: 'utf8' });
    expect(JSON.parse(output)).toMatchObject({ ok: true });
  });

  it('rejects a p95 regression above five percent', () => {
    const { baseline, candidate } = fixtures(
      Array.from({ length: 25 }, () => 100),
      Array.from({ length: 25 }, () => 106),
    );
    const result = spawnSync(process.execPath, [
      verifier,
      '--baseline', baseline,
      '--candidate', candidate,
    ], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).failures[0]).toContain('regressed 6.00%');
  });

  it('enforces the fifteen-percent target only for named bottlenecks', () => {
    const { baseline, candidate } = fixtures(
      Array.from({ length: 25 }, () => 100),
      Array.from({ length: 25 }, () => 90),
    );
    const result = spawnSync(process.execPath, [
      verifier,
      '--baseline', baseline,
      '--candidate', candidate,
      '--target-metrics', 'completionMs',
    ], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).failures[0]).toContain('below 15.00%');
  });

  it('rejects undersampled reports instead of treating noise as evidence', () => {
    const { baseline, candidate } = fixtures(
      Array.from({ length: 24 }, () => 100),
      Array.from({ length: 25 }, () => 90),
    );
    const result = spawnSync(process.execPath, [
      verifier,
      '--baseline', baseline,
      '--candidate', candidate,
    ], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('at least 25');
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

    const result = spawnSync(process.execPath, [
      verifier,
      '--baseline', baseline,
      '--candidate', candidate,
    ], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).failures).toContain(
      'benchmark environment differs between baseline and candidate',
    );
  });

  it('rejects candidate evidence from a different build SHA', () => {
    const expectedSha = 'a'.repeat(40);
    const { baseline, candidate } = fixtures(
      Array.from({ length: 25 }, () => 100),
      Array.from({ length: 25 }, () => 95),
      false,
      'b'.repeat(40),
    );

    const result = spawnSync(process.execPath, [
      verifier,
      '--baseline', baseline,
      '--candidate', candidate,
      '--expected-candidate-build-sha', expectedSha,
    ], { encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).failures).toContain(
      `candidate build SHA differs: expected ${expectedSha}, got ${'b'.repeat(40)}`,
    );
  });
});
