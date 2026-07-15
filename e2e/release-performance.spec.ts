import { expect, test } from '@playwright/test';

import { launchApp } from './launch-app';

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) throw new Error('cannot calculate a percentile without samples');
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index];
}

test('release gate: 100M-row cancellation stays below the p95 and maximum latency budgets', async ({ browserName }, testInfo) => {
  test.slow();
  void browserName; // Playwright requires a destructured fixture argument; Electron is launched below.
  const app = await launchApp();
  const window = await app.firstWindow();
  const samples: number[] = [];

  try {
    await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await window.getByTestId('cmd-input').fill('gen-rows 100000000');
      await window.getByTestId('btn-run').click();

      const block = window.getByTestId('block').last();
      await expect(block.getByTestId('block-status')).toHaveText('running');
      await expect
        .poll(async () => Number((await block.getByTestId('row-count').textContent()) ?? '0'), {
          timeout: 15_000,
        })
        .toBeGreaterThan(0);

      const startedAt = performance.now();
      await block.getByTestId('block-cancel').click();
      await expect(block.getByTestId('block-status')).toHaveText('cancelled', { timeout: 5_000 });
      samples.push(performance.now() - startedAt);
    }

    const metrics = {
      samplesMs: samples.map((sample) => Math.round(sample)),
      p95Ms: Math.round(percentile(samples, 0.95)),
      maxMs: Math.round(Math.max(...samples)),
    };
    console.log(`[release-performance] ${JSON.stringify(metrics)}`);
    await testInfo.attach('cancellation-latency.json', {
      body: Buffer.from(`${JSON.stringify(metrics, null, 2)}\n`, 'utf8'),
      contentType: 'application/json',
    });

    expect(metrics.p95Ms).toBeLessThanOrEqual(3_000);
    expect(metrics.maxMs).toBeLessThan(5_000);
  } finally {
    await app.close();
  }
});
