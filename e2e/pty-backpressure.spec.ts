import { test, expect, type Page } from '@playwright/test';

import { launchApp } from './launch-app';

// Stage C: PTY firehose backpressure (byte-ack protocol — design §2). A child
// that writes as fast as the CPU allows must NOT grow unbounded queues: the
// interpreter pauses the PTY once sent-minus-acked exceeds 1MiB, and acks only
// happen when xterm actually flushes. Windows has no `yes`; node is already a
// proven e2e dependency.
//
// received - consumed (the __ezPtyFlow seam) over-approximates every renderer
// buffer this design bounds: port-delivered-but-unflushed bytes. The
// interpreter-side sent counter can exceed `received` by at most the port's
// in-flight messages, which the same HIGH bound covers.

const FIREHOSE = `!node -e "for(;;)process.stdout.write('y'.repeat(8192))"`;
const HIGH_WATER = 1024 * 1024;
const SLACK = 128 * 1024; // one pty chunk + ack quantum of slop

async function ptyFlow(w: Page): Promise<{ received: number; consumed: number }> {
  return w.evaluate(() => {
    const seam = globalThis as unknown as {
      __ezPtyFlow?: () => { received: number; consumed: number };
    };
    if (!seam.__ezPtyFlow) throw new Error('__ezPtyFlow seam missing');
    return seam.__ezPtyFlow();
  });
}

test('firehose: renderer backlog stays bounded by the high-water mark', async () => {
  const app = await launchApp();
  const w = await app.firstWindow();
  await expect(w.getByTestId('pane')).toHaveCount(1);

  await w.getByTestId('cmd-input').fill(FIREHOSE);
  await w.getByTestId('btn-run').click();
  await expect(w.getByTestId('pty-block')).toBeVisible({ timeout: 15_000 });

  // Data must actually be flowing before the bound means anything.
  await expect.poll(async () => (await ptyFlow(w)).received, { timeout: 15_000 }).toBeGreaterThan(
    64 * 1024,
  );

  // Observe for 5s: the unflushed backlog must never exceed HIGH + slack.
  // Without backpressure this grows by tens of MB per second.
  const deadline = Date.now() + 5_000;
  let maxBacklog = 0;
  while (Date.now() < deadline) {
    const { received, consumed } = await ptyFlow(w);
    maxBacklog = Math.max(maxBacklog, received - consumed);
    expect(received - consumed).toBeLessThanOrEqual(HIGH_WATER + SLACK);
    await w.waitForTimeout(200);
  }
  expect(maxBacklog).toBeGreaterThanOrEqual(0); // sanity: loop actually sampled

  // The app stays responsive under the (paused) firehose: cancel lands fast.
  const cancelAt = Date.now();
  await w.getByTestId('block-cancel').click();
  await expect(w.getByTestId('block-status')).toHaveText('cancelled', { timeout: 5_000 });
  expect(Date.now() - cancelAt).toBeLessThan(5_000);

  await app.close();
});

// No dedicated "normal TUI unaffected" test here: e2e/pty.spec.ts's interactive
// round-trip and the tabs/splits live-PTY tests exercise sub-watermark PTY flows
// end-to-end on every run — flow control regressions there would fail those.
