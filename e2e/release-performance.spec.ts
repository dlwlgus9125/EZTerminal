import { mkdir, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import path from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { launchApp } from './launch-app';

const LARGE_OUTPUT_FIXTURE = path.resolve(__dirname, 'fixtures', 'large-plain-output.js');
const RETENTION_PRESSURE_FIXTURE = path.resolve(
  __dirname,
  'fixtures',
  'retention-pressure-output.js',
);
const WARMUP_RUNS = 5;
const MEASUREMENT_RUNS = 25;

interface PerformanceMetric {
  readonly unit: 'ms';
  readonly direction: 'lower';
  readonly warmupRuns: number;
  readonly samples: readonly number[];
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly absoluteBudget?: {
    readonly p95Ms?: number;
    readonly maxMs?: number;
  };
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) throw new Error('cannot calculate a percentile without samples');
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index];
}

function metric(samples: readonly number[], absoluteBudget?: PerformanceMetric['absoluteBudget']): PerformanceMetric {
  return {
    unit: 'ms',
    direction: 'lower',
    warmupRuns: WARMUP_RUNS,
    samples,
    p95Ms: percentile(samples, 0.95),
    maxMs: Math.max(...samples),
    ...(absoluteBudget ? { absoluteBudget } : {}),
  };
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

async function dismissOnlyBlock(window: Page): Promise<void> {
  await window.getByTestId('block-dismiss').click();
  await expect(window.getByTestId('block')).toHaveCount(0);
}

async function waitForPlainMarker(
  plain: Locator,
  marker: string,
  timeoutMs: number,
): Promise<void> {
  await plain.evaluate((element, options) => new Promise<void>((resolve, reject) => {
    const containsMarker = (node: Node): boolean => node.textContent?.includes(options.marker) ?? false;
    if (containsMarker(element)) {
      resolve();
      return;
    }
    const observer = new MutationObserver((records) => {
      const found = records.some((record) => (
        (record.type === 'characterData' && containsMarker(record.target))
        || [...record.addedNodes].some(containsMarker)
      ));
      if (!found) return;
      window.clearTimeout(timeout);
      observer.disconnect();
      resolve();
    });
    observer.observe(element, { childList: true, subtree: true, characterData: true });
    const timeout = window.setTimeout(() => {
      observer.disconnect();
      reject(new Error(`plain-output marker did not render within ${options.timeoutMs}ms`));
    }, options.timeoutMs);
  }), { marker, timeoutMs });
}

async function sampleRuns(measure: () => Promise<number>): Promise<number[]> {
  const samples: number[] = [];
  for (let attempt = 0; attempt < WARMUP_RUNS + MEASUREMENT_RUNS; attempt += 1) {
    const duration = await measure();
    if (attempt >= WARMUP_RUNS) samples.push(duration);
  }
  return samples;
}

test('release performance evidence uses warmups and 25 measured runs', async ({ browserName }, testInfo) => {
  test.setTimeout(15 * 60_000);
  void browserName;
  const app = await launchApp();
  const window = await app.firstWindow();

  try {
    await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
    const input = window.getByTestId('cmd-input');
    const run = window.getByTestId('btn-run');

    const cancellationSamples = await sampleRuns(async () => {
      await input.fill('gen-rows 100000000');
      await run.click();
      const block = window.getByTestId('block');
      await expect(block.getByTestId('block-status')).toHaveText('running');
      await expect
        .poll(async () => Number((await block.getByTestId('row-count').textContent()) ?? '0'), {
          timeout: 15_000,
        })
        .toBeGreaterThan(0);
      const startedAt = performance.now();
      await block.getByTestId('block-cancel').click();
      await expect(block.getByTestId('block-status')).toHaveText('cancelled', { timeout: 5_000 });
      const duration = elapsedMs(startedAt);
      await dismissOnlyBlock(window);
      return duration;
    });

    const rowCompletionSamples = await sampleRuns(async () => {
      await input.fill('gen-rows 100000');
      const startedAt = performance.now();
      await run.click();
      const block = window.getByTestId('block');
      await expect(block.getByTestId('row-count')).toHaveText('100000', { timeout: 20_000 });
      await expect(block.getByTestId('block-status')).toHaveText('done', { timeout: 20_000 });
      const duration = elapsedMs(startedAt);
      await dismissOnlyBlock(window);
      return duration;
    });

    const plainOutputSamples = await sampleRuns(async () => {
      await input.fill(`node ${LARGE_OUTPUT_FIXTURE}`);
      const startedAt = performance.now();
      await run.click();
      const block = window.getByTestId('block');
      const plain = block.getByTestId('pty-plain-block');
      await expect(plain).toBeVisible({ timeout: 15_000 });
      await waitForPlainMarker(plain, 'LARGE-OUTPUT-DONE', 20_000);
      await expect(block.getByTestId('block-status')).toHaveText('done', { timeout: 20_000 });
      const duration = elapsedMs(startedAt);
      await dismissOnlyBlock(window);
      return duration;
    });

    const retentionPressureSamples = await sampleRuns(async () => {
      await input.fill(`node ${RETENTION_PRESSURE_FIXTURE}`);
      const startedAt = performance.now();
      await run.click();
      const block = window.getByTestId('block');
      const plain = block.getByTestId('pty-plain-block');
      await expect(plain).toBeVisible({ timeout: 15_000 });
      await waitForPlainMarker(plain, 'RETENTION-PRESSURE-DONE', 45_000);
      await expect(block.getByTestId('block-status')).toHaveText('done', { timeout: 45_000 });
      const duration = elapsedMs(startedAt);
      await dismissOnlyBlock(window);
      return duration;
    });

    const report = {
      schemaVersion: 1,
      buildSha: process.env.EZTERMINAL_BUILD_SHA ?? process.env.GITHUB_SHA ?? 'dev',
      generatedAtUtc: new Date().toISOString(),
      environment: {
        platform: platform(),
        arch: arch(),
        osRelease: release(),
        cpuModel: cpus()[0]?.model.trim() ?? 'unknown',
        logicalCpuCount: cpus().length,
        totalMemoryGiB: Math.round(totalmem() / (1024 ** 3)),
      },
      warmupRuns: WARMUP_RUNS,
      measurementRuns: MEASUREMENT_RUNS,
      metrics: {
        cancellationLatencyMs: metric(cancellationSamples, { p95Ms: 3_000, maxMs: 5_000 }),
        rows100kCompletionMs: metric(rowCompletionSamples),
        plainOutput1_1MiBCompletionMs: metric(plainOutputSamples),
        plainOutput12MiBRetentionPressureMs: metric(retentionPressureSamples),
      },
    };
    console.log(`[release-performance] ${JSON.stringify(report)}`);
    const encoded = `${JSON.stringify(report, null, 2)}\n`;
    await testInfo.attach('release-performance.json', {
      body: Buffer.from(encoded, 'utf8'),
      contentType: 'application/json',
    });
    const reportPath = process.env.EZTERMINAL_PERFORMANCE_REPORT_PATH;
    if (reportPath) {
      await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
      await writeFile(path.resolve(reportPath), encoded, 'utf8');
    }

    expect(report.metrics.cancellationLatencyMs.p95Ms).toBeLessThanOrEqual(3_000);
    expect(report.metrics.cancellationLatencyMs.maxMs).toBeLessThan(5_000);
  } finally {
    await app.close();
  }
});
