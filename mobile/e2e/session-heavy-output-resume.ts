/**
 * Real-device (AVD) confirmation for the mobile HEAVY-OUTPUT resume stall
 * (field report, recurred through v1.0.9):
 *
 *   create on mobile -> run a continuous ~64 KB/100 ms flood -> force-stop the
 *   Android app -> stay offline past the heartbeat terminate -> relaunch ->
 *   reconnect -> reopen the parked run
 *
 * `e2e/remote-resume-stall.spec.ts` pins the same defect at the WS protocol
 * level with a synthetic phone. This is its on-device sibling: it drives the
 * real APK through the real composer and accessory keys, so the two symptoms
 * the user actually reported are observed on the phone's own terminal surface —
 * output that KEEPS FLOWING after the resume, and an ESC key that VISIBLY
 * responds.
 *
 * Broken behavior: `resume-run` re-attached the phone as an ATTACH port and
 * closed the run's parked PRIMARY port, after which no port could reach
 * `PtySession.ack()` — the sole `pty.resume()` path — so the PTY paused at
 * PTY_HIGH_WATER (1 MiB, roughly 1,000 SEQ lines past the resume) and never
 * resumed for ANY surface, while input reached a child that could no longer
 * render its reply.
 *
 * Run directly with Node's native TypeScript stripping:
 *   pnpm --dir mobile e2e:session-heavy-resume
 *   node --experimental-strip-types mobile/e2e/session-heavy-output-resume.ts --offline-ms=330000
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  APK_PATH,
  APP_ID,
  MAIN_ENTRY,
  clearLogcat,
  closeMobileE2eResources,
  closeWebViewDevtools,
  connectAndAuth,
  createTerminalSession,
  evaluateWebView,
  getVisibleXtermBufferText,
  launchDesktop,
  openShellDestination,
  runAdb,
  setTestIdTextValue,
  sleep,
  submitConnectionOnce,
  tapTestId,
  waitForTestId,
  waitForTestIdHidden,
  waitForVisibleTestIdEnabled,
} from './lib.ts';

const FLOOD_FIXTURE = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  'e2e',
  'fixtures',
  'pty-flood-esc.js',
);
// Default past the ~60-90s heartbeat terminate, so the run is genuinely parked
// as a run LEASE rather than merely surviving a brief socket blip. The flag
// also carries a 330_000 expired-lease variant.
const DEFAULT_OFFLINE_MS = 100_000;
const MAX_OFFLINE_MS = 20 * 60 * 1_000;
// The broken build stalls roughly 1,000 SEQ lines (PTY_HIGH_WATER = 1 MiB)
// past the resume — well inside 10s of flood. Taking the baseline sample only
// after that point stops replayed history from passing as a live stream.
const RESUME_SETTLE_MS = 10_000;
const SEQ_SAMPLE_GAP_MS = 3_000;
const MIN_SEQ_GROWTH = 300;
const SEQ_GROWTH_TIMEOUT_MS = 15_000;
const MIN_FLOOD_SEQ = 100;
const ESC_ECHO_WINDOW_MS = 5_000;

function parseOfflineMs(): number {
  const args = process.argv.slice(2);
  const option = args.find((arg) => arg.startsWith('--offline-ms='));
  const unknown = args.find((arg) => !arg.startsWith('--offline-ms='));
  if (unknown) throw new Error(`Unknown argument: ${unknown}`);
  if (!option) return DEFAULT_OFFLINE_MS;
  const value = Number(option.slice('--offline-ms='.length));
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_OFFLINE_MS) {
    throw new Error(
      `--offline-ms must be an integer from 0 through ${MAX_OFFLINE_MS}`,
    );
  }
  return value;
}

/** Finds the phone's live terminal the same way `getVisibleXtermBufferText`
 * does — last `pty-block` that is actually laid out and visible. */
const FIND_LIVE_TERMINAL = `[...document.querySelectorAll('[data-testid="pty-block"]')]
  .reverse()
  .find((node) => {
    if (!(node instanceof HTMLElement)) return false;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0
      && style.display !== 'none' && style.visibility !== 'hidden';
  })`;

/** Wraps the terminal's write path so every byte the phone receives is scanned
 * for the marker, then clears the tap's state so the caller starts from "not
 * seen". Idempotent: re-arming reuses the wrapper already installed.
 *
 * `PtyBlock.tsx` funnels ALL PTY bytes through a single `term.write(bytes, cb)`
 * (`src/renderer/PtyBlock.tsx:411`), so this observes the whole stream. The scan
 * is a byte compare with an 11-byte carry rather than a decode, because the tap
 * sits on the flood's own hot path and must not perturb the throughput the
 * surrounding assertions measure. */
async function armEscEchoTap(): Promise<void> {
  const armed = await retryEvaluation(() => evaluateWebView<boolean>(`(() => {
    const element = ${FIND_LIVE_TERMINAL};
    const terminal = element && element.__ezTerm;
    if (!terminal) return false;
    if (!terminal.__ezEscTap) {
      terminal.__ezEscTap = { seen: false, carry: [] };
      const MARK = [69, 83, 67, 45, 82, 69, 67, 69, 73, 86, 69, 68]; // ESC-RECEIVED
      const original = terminal.write.bind(terminal);
      terminal.write = (data, callback) => {
        const tap = terminal.__ezEscTap;
        if (!tap.seen) {
          const bytes = typeof data === 'string'
            ? Array.from(data, (character) => character.charCodeAt(0) & 0xff)
            : data;
          const carry = tap.carry;
          const total = carry.length + bytes.length;
          const at = (index) => (index < carry.length ? carry[index] : bytes[index - carry.length]);
          for (let start = 0; start + MARK.length <= total; start += 1) {
            let hit = true;
            for (let offset = 0; offset < MARK.length; offset += 1) {
              if (at(start + offset) !== MARK[offset]) { hit = false; break; }
            }
            if (hit) { tap.seen = true; break; }
          }
          const keep = MARK.length - 1;
          const next = [];
          for (let index = Math.max(0, total - keep); index < total; index += 1) next.push(at(index));
          tap.carry = next;
        }
        return original(data, callback);
      };
    }
    terminal.__ezEscTap.seen = false;
    terminal.__ezEscTap.carry = [];
    return true;
  })()`));
  if (!armed) throw new Error('No live terminal on the phone to watch for the ESC echo');
}

async function escEchoWasDelivered(): Promise<boolean> {
  return retryEvaluation(() => evaluateWebView<boolean>(`(() => {
    const element = ${FIND_LIVE_TERMINAL};
    const terminal = element && element.__ezTerm;
    return Boolean(terminal && terminal.__ezEscTap && terminal.__ezEscTap.seen);
  })()`));
}

/** Same reasoning as `readMaxVisibleSeq`: under a flood a CDP evaluation can
 * time out and drop the DevTools socket, and a lost transport is not evidence
 * about the terminal. The tap's state lives in the page, so a retry reads the
 * same accumulated answer rather than restarting the observation. */
async function retryEvaluation<T>(read: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  throw new Error(`Unable to reach the phone's terminal: ${String(lastError)}`);
}

/** Highest `SEQ:<n>` marker in an xterm buffer snapshot. A flood line is ~1 KB
 * and wraps across many phone-width rows, but its marker always sits at the
 * start of a row, so the row-wise buffer read never splits one. */
function maxSeqIn(text: string): number {
  let max = 0;
  for (const match of text.matchAll(/SEQ:(\d+)/g)) {
    const value = Number(match[1]);
    if (value > max) max = value;
  }
  return max;
}

/** Reads the phone's visible terminal and returns its highest SEQ marker.
 * A CDP evaluation that times out drops the DevTools socket (lib.ts's
 * `resetWebViewCdp`) and the next call rebuilds it, so a transient read failure
 * is retried instead of being reported as a stalled stream. */
async function readMaxVisibleSeq(): Promise<number> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return maxSeqIn(await getVisibleXtermBufferText());
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  throw new Error(`Unable to read the phone's terminal buffer: ${String(lastError)}`);
}

/** Waits until flood output is actually reaching the phone, and returns the
 * highest SEQ marker on screen.
 *
 * `FLOOD-READY` is deliberately NOT the gate: the fixture prints it once, 100 ms
 * before the flood starts, and the flood then displaces the phone's entire
 * scrollback within seconds — requiring the banner would be a startup flake, and
 * after the resume it is long gone from both the restore snapshot and the
 * buffer. A SEQ marker proves strictly more (fixture launched AND streaming AND
 * the phone is receiving); the banner is logged when it happens to be sampled.
 */
async function waitForFloodOutput(label: string, timeoutMs = 30_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let lastBuffer = '';
  let sawBanner = false;
  for (;;) {
    try {
      lastBuffer = await getVisibleXtermBufferText();
    } catch {
      // A WebView that is still attaching is "not streaming yet", not a failure.
      lastBuffer = '';
    }
    if (!sawBanner && lastBuffer.includes('FLOOD-READY')) {
      sawBanner = true;
      console.log(`[repro] ${label}: saw FLOOD-READY`);
    }
    const seq = maxSeqIn(lastBuffer);
    if (seq > MIN_FLOOD_SEQ) return seq;
    if (Date.now() > deadline) {
      throw new Error(
        `Flood output never reached the phone (${label}); `
        + `last buffer: ${JSON.stringify(lastBuffer.slice(-1_000))}`,
      );
    }
    await sleep(250);
  }
}

/** Requires the phone's terminal to advance past `previous + MIN_SEQ_GROWTH`,
 * never sampling sooner than SEQ_SAMPLE_GAP_MS after the previous read. The gap
 * plus the margin is the assertion; the surrounding poll only absorbs a slow
 * emulator's throughput. It cannot rescue the defect — a paused PTY leaves the
 * counter frozen, so every sample reads the same value until the deadline. */
async function requireSeqGrowth(label: string, previous: number): Promise<number> {
  const deadline = Date.now() + SEQ_GROWTH_TIMEOUT_MS;
  for (;;) {
    await sleep(SEQ_SAMPLE_GAP_MS);
    const current = await readMaxVisibleSeq();
    if (current >= previous + MIN_SEQ_GROWTH) {
      console.log(`[repro] ${label}: SEQ ${previous} -> ${current}`);
      return current;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Heavy output stalled after resume (${label}): SEQ went ${previous} -> ${current}, `
        + `needed at least +${MIN_SEQ_GROWTH}`,
      );
    }
  }
}

/** Taps the ESC accessory key and requires the fixture's ESC-RECEIVED echo to
 * actually reach the phone's terminal.
 *
 * Deliberately NOT a buffer poll. The fixture answers ESC with ONE line while
 * the flood writes ~640 lines a second, so the echo survives on screen for a
 * few milliseconds and a quarter-second poll can only sample it by luck — that
 * check failed and passed on identical builds, which is a coin toss reporting
 * itself as a verdict. The tap on the write path sees every byte instead, so
 * the outcome is decided by the product rather than by the sampler.
 *
 * It cannot mask the defect: the broken build's PTY was paused, so no echo was
 * ever drained to the phone and the tap would observe nothing at all. */
async function requireEscEchoDelivered(): Promise<void> {
  // An instrument that reports success without the stimulus proves nothing, and
  // this one is watching a stream of a thousand lines a second. Arm it, let the
  // flood run through it, and require silence before the first ESC is sent.
  await armEscEchoTap();
  await sleep(1_000);
  if (await escEchoWasDelivered()) {
    throw new Error('The ESC-echo tap fired on flood traffic alone — it is not a valid probe');
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await armEscEchoTap();
    await tapTestId('touch-key-escape');
    const deadline = Date.now() + ESC_ECHO_WINDOW_MS;
    for (;;) {
      if (await escEchoWasDelivered()) return;
      if (Date.now() > deadline) break;
      await sleep(250);
    }
    console.log(`[repro] ESC echo attempt ${attempt} produced nothing; re-sending ESC`);
  }
  throw new Error(
    `ESC produced no response on the phone within ${ESC_ECHO_WINDOW_MS}ms across 3 attempts`,
  );
}

async function main(): Promise<void> {
  const offlineMs = parseOfflineMs();
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(`Desktop build is missing: ${MAIN_ENTRY}`);
  }
  if (!existsSync(APK_PATH)) {
    throw new Error(`Mobile debug APK is missing: ${APK_PATH}`);
  }
  if (!existsSync(FLOOD_FIXTURE)) {
    throw new Error(`PTY flood fixture is missing: ${FLOOD_FIXTURE}`);
  }

  const { dispose, token } = await launchDesktop();
  let scenarioFailure: { readonly error: unknown } | undefined;
  let disposeFailure: { readonly error: unknown } | undefined;

  try {
    await connectAndAuth(token);
    await createTerminalSession();

    // `!cmd` is the interpreter's interactive-run sigil. The child runs on the
    // DESKTOP, so a desktop-absolute fixture path is correct even though the
    // composer submitting it belongs to the phone.
    await setTestIdTextValue('cmd-input', `!node ${FLOOD_FIXTURE}`);
    await tapTestId('btn-run');
    await waitForTestId('pty-block', 20_000);
    const seqBeforeOffline = await waitForFloodOutput('flood start');
    console.log(`[repro] flood is live in the mobile-created session (SEQ:${seqBeforeOffline})`);

    runAdb(['shell', 'am', 'force-stop', APP_ID]);
    closeWebViewDevtools();
    console.log(`[repro] Android app stopped mid-flood; waiting ${offlineMs}ms before relaunch`);
    await sleep(offlineMs);
    clearLogcat();
    runAdb(['shell', 'am', 'start', '-n', `${APP_ID}/.MainActivity`]);

    await waitForTestId('connect-screen', 45_000);
    await submitConnectionOnce();
    await openShellDestination('more-sessions', 'session-switcher');
    await waitForTestId('session-open', 15_000);
    await tapTestId('session-open');
    await waitForTestId('mobile-session-view', 20_000);
    await waitForTestId('pty-block', 20_000);

    const seqAtResume = await waitForFloodOutput('resume');
    console.log(`[repro] terminal replay proves the flooding PTY survived the app restart (SEQ:${seqAtResume})`);

    await waitForTestIdHidden('pty-control-chip', 10_000);
    await waitForVisibleTestIdEnabled('touch-key-escape', 10_000);
    console.log('[repro] restarted app automatically restored input control');

    // The reported freeze: the resumed run must KEEP STREAMING. Sampling only
    // starts past the broken build's stall point, so a frozen stream cannot
    // pass on replayed history alone.
    console.log(`[repro] streaming for ${RESUME_SETTLE_MS}ms before the first post-resume sample`);
    await sleep(RESUME_SETTLE_MS);
    let seq = await readMaxVisibleSeq();
    console.log(`[repro] post-resume baseline SEQ:${seq}`);
    seq = await requireSeqGrowth('growth sample 1', seq);
    seq = await requireSeqGrowth('growth sample 2', seq);
    console.log('[repro] heavy output keeps flowing on the phone after the resume');

    // And ESC must produce a response that REACHES the phone — the broken build
    // delivered the byte to a child whose paused PTY could never drain the reply.
    await requireEscEchoDelivered();
    console.log('[repro] PASS: resumed heavy-output run keeps streaming and ESC visibly responds');
  } catch (error) {
    scenarioFailure = { error };
  } finally {
    try {
      runAdb(['shell', 'am', 'force-stop', APP_ID]);
    } catch {
      // Best-effort cleanup for a disconnected emulator.
    }
    closeMobileE2eResources();
    try {
      await dispose();
    } catch (disposeError) {
      disposeFailure = { error: disposeError };
    }
  }
  if (scenarioFailure && disposeFailure) {
    throw new AggregateError(
      [scenarioFailure.error, disposeFailure.error],
      'Heavy-output resume scenario and desktop disposal both failed',
    );
  }
  if (scenarioFailure) throw scenarioFailure.error;
  if (disposeFailure) throw disposeFailure.error;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
