import { test, expect } from './test';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { launchApp } from './launch-app';
import { TestWsClient } from './ws-client';
import { readXtermBuffer } from './xterm-buffer';

const FLOOD_FIXTURE = path.resolve(__dirname, 'fixtures', 'pty-flood-esc.js');

// Mobile resume stall (field report, recurred through v1.0.9): a phone-initiated
// heavy-output run (CLI agent) freezes for EVERY surface — phone AND desktop —
// a while after the phone disconnects and resumes. Mechanism under test: the
// run's PRIMARY port is the phone's bridge relay; `resume-run` re-attaches the
// phone as an ATTACH port and closes the parked primary (remote-bridge.ts
// resumeRun), after which no port can ever reach `PtySession.ack()` — the sole
// `pty.resume()` path — so output stops for everyone at PTY_HIGH_WATER (1 MiB)
// while the child blocks on its output pipe and input appears dead.
//
// Port isolation: 17420/17422 (session-mirror), 17421 (remote-toggle), and
// 17431 (remote-bridge.test.ts's real-WS unit describe) are taken — this spec
// pins its own pair so a real running desktop instance (or a concurrently
// running unit suite) can never collide (EADDRINUSE, see session-mirror.spec.ts).
const REMOTE_PORT = 17441;
const OPENCLAW_PROXY_PORT = 17442;

/** Track a run's PTY output on a TestWsClient: decode every pty-data frame,
 * immediately ack the CUMULATIVE received byte count — the renderer
 * BlockController's exact ack coordinate (replay + live in one counter) — and
 * scan for the flood fixture's `SEQ:<n>` markers. */
function trackPtyRun(
  client: TestWsClient,
  runId: string,
): { maxSeq: () => number; sawEsc: () => boolean } {
  let bytes = 0;
  let carry = '';
  let maxSeq = 0;
  // Latched in the listener, not sampled from a rolling buffer: the flood
  // displaces a one-shot marker within milliseconds, far faster than a poll.
  let sawEsc = false;
  client.onEachMessage((msg) => {
    if (msg.kind !== 'frame' || msg.runId !== runId) return;
    if (msg.frame.type !== 'pty-data') return;
    const chunk = Buffer.from(msg.frame.data, 'base64').toString('latin1');
    bytes += Buffer.byteLength(chunk, 'latin1');
    // Small carry so a marker split across chunk boundaries still counts.
    const combined = carry + chunk;
    for (const m of combined.matchAll(/SEQ:(\d+)/g)) {
      const n = Number(m[1]);
      if (n > maxSeq) maxSeq = n;
    }
    if (combined.includes('ESC-RECEIVED')) sawEsc = true;
    carry = combined.slice(-16);
    client.send({ kind: 'control', runId, control: { type: 'pty-ack', bytes } });
  });
  return { maxSeq: () => maxSeq, sawEsc: () => sawEsc };
}

/** Highest SEQ:<n> marker visible in an xterm buffer snapshot. */
function maxSeqIn(text: string): number {
  let max = 0;
  for (const m of text.matchAll(/SEQ:(\d+)/g)) {
    const n = Number(m[1]);
    if (n > max) max = n;
  }
  return max;
}

test('mobile resume stall: output keeps flowing and ESC stays visible after disconnect → resume-run', async () => {
  // Flood + park + resume + generous stall-detection polls need more than the
  // suite's 60s default.
  test.setTimeout(120_000);
  const app = await launchApp(undefined, {
    EZTERMINAL_REMOTE_PORT: String(REMOTE_PORT),
    EZTERMINAL_REMOTE_VPN_INTERFACE: '127.0.0.1',
    EZTERMINAL_OPENCLAW_PROXY_PORT: String(OPENCLAW_PROXY_PORT),
  });
  const win = await app.firstWindow();
  await expect(win.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  const token = await win.evaluate(() => window.ezterminal.getRemoteToken());
  await win.evaluate(() => window.ezterminal.setRemoteEnabled(true));

  // One install identity across both connections — the same phone leaving and
  // coming back (protocol v2 initiator-owned resume, v1.0.9).
  const identity = {
    clientId: randomUUID(),
    clientName: 'e2e-phone',
    platform: 'android' as const,
  };
  const url = `ws://127.0.0.1:${REMOTE_PORT}`;
  const phone1 = await TestWsClient.connectAuthed(url, token, identity);
  let phone2: TestWsClient | null = null;

  try {
    // Phone-initiated session — its run's primary port is the phone's relay.
    const createRequestId = randomUUID();
    phone1.send({ kind: 'create-session', requestId: createRequestId });
    const created = await phone1.waitFor(
      (msg) => msg.kind === 'session-created' && msg.requestId === createRequestId,
    );
    if (created.kind !== 'session-created') throw new Error('unreachable');
    const { sessionId } = created.session;

    // The desktop mirrors the session into a pane; that pane's ATTACH port is
    // what keeps the run alive across the phone's disconnect — the user's PC
    // view of the same session.
    const mirroredPane = win.locator(`[data-testid="pane"][data-session-id="${sessionId}"]`);
    await expect(mirroredPane).toHaveCount(1, { timeout: 5_000 });

    const runId = randomUUID();
    const phone1Run = trackPtyRun(phone1, runId);
    phone1.send({ kind: 'run-command', runId, sessionId, commandText: `!node ${FLOOD_FIXTURE}` });

    // Flood is live and the phone is consuming (with continuous acks).
    await expect.poll(() => phone1Run.maxSeq(), { timeout: 15_000 }).toBeGreaterThan(100);
    const desktopPty = mirroredPane.getByTestId('pty-block');
    await expect(desktopPty).toBeVisible({ timeout: 5_000 });

    // ── The user leaves: the phone's socket dies mid-flood. The bridge parks
    // the run's primary port as a run lease.
    phone1.close();
    await phone1.waitForClose();

    // False-red guard: while parked the lease auto-acks every pty-data frame,
    // so the DESKTOP mirror keeps streaming (exactly what the user's PC shows
    // until the resume/expiry). If THIS stalls, the defect is elsewhere.
    const seqWhileParked = maxSeqIn(await readXtermBuffer(desktopPty));
    await expect
      .poll(async () => maxSeqIn(await readXtermBuffer(desktopPty)), { timeout: 15_000 })
      .toBeGreaterThan(seqWhileParked + 200);

    // ── The user returns: the same install reconnects and resumes its run.
    phone2 = await TestWsClient.connectAuthed(url, token, identity);
    const phone2Run = trackPtyRun(phone2, runId);
    const ready = phone2.waitFor(
      (msg) => msg.kind === 'resume-run-ready' && msg.runId === runId,
      10_000,
    );
    phone2.send({ kind: 'resume-run', sessionId, runId, generation: 1 });
    await ready;
    const seqAtResume = phone2Run.maxSeq();

    // ── RED A (the reported freeze): the stream must KEEP FLOWING after the
    // resume. Broken behavior: the resume closed the parked primary port, no
    // primary ack sink exists anymore, and `pty.pause()` fires ~1 MiB
    // (~1,000 SEQ lines) later with no reachable resume — the poll then never
    // sees +2,500 and times out, while the child sits alive but blocked.
    await expect
      .poll(() => phone2Run.maxSeq(), { timeout: 30_000 })
      .toBeGreaterThan(seqAtResume + 2_500);

    // ── RED B: ESC must produce a VISIBLE response (the fixture prints
    // ESC-RECEIVED). Broken behavior: the byte reaches the child, but with the
    // PTY paused nothing ever renders — the user's "input/ESC dead".
    phone2.send({ kind: 'control', runId, control: { type: 'pty-input', data: '\x1b' } });
    await expect
      .poll(() => phone2Run.sawEsc(), { timeout: 10_000 })
      .toBe(true);

    // And the desktop view of the same session stays live too (the field
    // report's PC froze together with the phone).
    const desktopSeqAfterResume = maxSeqIn(await readXtermBuffer(desktopPty));
    await expect
      .poll(async () => maxSeqIn(await readXtermBuffer(desktopPty)), { timeout: 10_000 })
      .toBeGreaterThan(desktopSeqAfterResume);
  } finally {
    phone2?.close();
    phone1.close();
    await app.close();
  }
});
