/**
 * Android emulator e2e — the surfaces the handoff-completion pass added.
 *
 * Written because a coverage audit of the existing harnesses found that they
 * EXERCISE almost all of this pass's new code on every run and ASSERT none of
 * it: the latency probe fires on every connect, the Git arm round-trips on
 * every terminal tab, and the promoted CRT profile is applied at boot — yet a
 * revert of any of them would leave smoke/parity/release-soak green. A path
 * that runs without being checked is not covered.
 *
 * Four things are proven here, each of which fails if the corresponding change
 * is reverted:
 *
 *  1. CRT SIGNATURE APPLIED — `html[data-effect-*]` really carries scanlines,
 *     phosphor-glow and crt-rollbar on an untouched install (and NOT flicker),
 *     and the roll band uses mobile's own parameters rather than the shared
 *     desktop ones. Read from the live DOM, not from a settings switch: the
 *     switch and the applied state disagreeing is exactly the bug this pass
 *     shipped and then fixed.
 *  2. LATENCY PROBE ROUND-TRIPS — the terminal status line's RTT chip renders
 *     only when a `pong` has actually come back, so its presence is end-to-end
 *     proof of the v3 ping/pong through the real bridge.
 *  3. GIT ARM ROUND-TRIPS — the status line shows the desktop's real branch
 *     name, which can only come from a `git-status` reply.
 *  4. ONE-TIME PAIRING — a code issued by the desktop authenticates a phone
 *     that has never seen the bearer, is refused the second time, and leaves
 *     the phone holding a credential that still works after a restart.
 *
 * Prerequisites are the same as smoke.ts (booted AVD, fresh debug APK built in
 * e2e mode, `.vite/build/main.js`, no other desktop instance on the port).
 *
 * Run locally: `node mobile/e2e/handoff-surfaces.ts`.
 */
import { execFileSync } from 'node:child_process';

import {
  APP_ID,
  EMULATOR_HOST_URL,
  ROOT,
  assertNoWebViewJavaScriptRuntimeErrors,
  closeMobileE2eResources,
  connectAndAuth,
  createTerminalSession,
  evaluateWebView,
  getTestIdTextContent,
  launchDesktop,
  runAdb,
  setTestIdTextValue,
  sleep,
  tapTestId,
  waitForAnyTestId,
  waitForTestId,
} from './lib.ts';

/** The probe fires immediately on auth and then every 5s; one reply is enough. */
const RTT_TIMEOUT_MS = 30_000;
/** A git-status round trip spawns a real `git` process on the desktop. */
const BRANCH_TIMEOUT_MS = 30_000;

interface AppliedEffects {
  readonly scanlines: string | null;
  readonly phosphorGlow: string | null;
  readonly rollbar: string | null;
  readonly flicker: string | null;
  readonly thickness: string;
  readonly opacity: string;
}

function readAppliedEffects(): Promise<AppliedEffects> {
  return evaluateWebView<AppliedEffects>(`(() => {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    return {
      scanlines: root.getAttribute('data-effect-scanlines'),
      phosphorGlow: root.getAttribute('data-effect-phosphor-glow'),
      rollbar: root.getAttribute('data-effect-crt-rollbar'),
      flicker: root.getAttribute('data-effect-flicker'),
      thickness: style.getPropertyValue('--fx-rollbar-thickness').trim(),
      opacity: style.getPropertyValue('--fx-rollbar-opacity').trim(),
    };
  })()`);
}

function expect(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function main(): Promise<void> {
  console.log('[surfaces] launching desktop app (isolated userData)...');
  const { app, token } = await launchDesktop();

  try {
    // The phone's status line reports the branch of the SESSION's cwd, and a
    // session created through the bridge inherits the desktop's cwd — which is
    // this harness's cwd. Ask Git directly rather than through the app, so the
    // expectation cannot be produced by the same code path it is checking.
    let branch = '';
    try {
      branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: ROOT,
        encoding: 'utf8',
      }).trim();
      if (branch === 'HEAD') branch = '';
    } catch {
      branch = '';
    }

    await connectAndAuth(token);
    console.log('[surfaces] step OK: connected');

    // ── 1. the CRT profile the user actually gets ────────────────────────
    const effects = await readAppliedEffects();
    expect(effects.scanlines, 'on', 'html[data-effect-scanlines] on a fresh install');
    expect(effects.phosphorGlow, 'on', 'html[data-effect-phosphor-glow] on a fresh install');
    expect(effects.rollbar, 'on', 'html[data-effect-crt-rollbar] on a fresh install');
    // Not part of the signature: it costs frames on a phone.
    expect(effects.flicker, null, 'html[data-effect-flicker] on a fresh install');
    expect(effects.thickness, '130', 'mobile roll-band thickness (desktop default is 120)');
    expect(effects.opacity, '0.05', 'mobile roll-band opacity (desktop default is 0.20)');
    console.log('[surfaces] step OK: CRT Signature applied to the live DOM with mobile band params');

    // ── 2 + 3. the terminal status line ──────────────────────────────────
    await createTerminalSession();
    await waitForTestId('terminal-status-line');

    // Present only once `roundTripMs` is non-null, i.e. only after a real pong.
    await waitForTestId('terminal-rtt', RTT_TIMEOUT_MS);
    const rtt = (await getTestIdTextContent('terminal-rtt')) ?? '';
    if (!/\d+\s*ms/u.test(rtt)) throw new Error(`RTT chip did not render a latency: ${JSON.stringify(rtt)}`);
    console.log(`[surfaces] step OK: latency probe round-tripped over v3 (${rtt.trim()})`);

    if (branch) {
      // The status line shows the cwd until the reply lands — that fallback is
      // the product's design, so this polls rather than reading once. On a
      // WebView 74 device the round trip is comfortably slower than the RTT
      // chip appearing, and the chip is not a synchronisation point for it.
      const deadline = Date.now() + BRANCH_TIMEOUT_MS;
      let line = '';
      for (;;) {
        line = (await getTestIdTextContent('terminal-status-line')) ?? '';
        if (line.includes(branch)) break;
        if (Date.now() > deadline) {
          throw new Error(
            `status line never showed the desktop's branch ${JSON.stringify(branch)} `
            + `within ${BRANCH_TIMEOUT_MS}ms: ${JSON.stringify(line)}`,
          );
        }
        await sleep(500);
      }
      console.log(`[surfaces] step OK: git-status arm round-tripped (branch ${branch})`);
    } else {
      // Never silently skip: a run that could not establish the fixture has to
      // say so, or a green log would imply coverage it did not have.
      console.log('[surfaces] SKIPPED: desktop cwd is not a Git work tree, branch assertion not run');
    }

    // ── 4. one-time pairing, end to end ──────────────────────────────────
    const code: string = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const issued = await win.webContents.executeJavaScript('window.ezterminalDesktop.issuePairingCode()');
      return issued.code;
    });
    if (!/^[0-9A-Z]{4}-[0-9A-Z]{4}$/u.test(code)) {
      throw new Error(`desktop issued an unexpected pairing code: ${JSON.stringify(code)}`);
    }
    console.log(`[surfaces] desktop issued pairing code ${code}`);

    // A phone that has never seen the bearer.
    console.log('[surfaces] pairing a fresh install with the code (never the bearer)...');
    await connectAndAuth(code);
    console.log('[surfaces] step OK: a one-time code authenticated a phone with no bearer');

    // Single use: the desktop must refuse the same code now.
    runAdb(['shell', 'am', 'force-stop', APP_ID]);
    runAdb(['shell', 'pm', 'clear', APP_ID]);
    runAdb(['shell', 'am', 'start', '-n', `${APP_ID}/.MainActivity`]);
    await waitForTestId('connect-screen', 45_000);
    await setTestIdTextValue('connect-url', EMULATOR_HOST_URL);
    await setTestIdTextValue('connect-token', code);
    await tapTestId('connect-submit');
    const outcome = await waitForAnyTestId(
      ['connect-error', 'connect-protocol-incompatible', 'mobile-home-view'],
      45_000,
    );
    if (outcome === 'mobile-home-view') {
      throw new Error('a spent pairing code authenticated a second device — it must be single use');
    }
    console.log(`[surfaces] step OK: the spent code was refused (${outcome})`);

    // And the paired phone still holds a working credential. Re-pair, then
    // restart WITHOUT clearing app data and reconnect from the saved card:
    // that credential can only be the bearer the host handed back, because the
    // code it was typed with is dead by now.
    const second: string = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const issued = await win.webContents.executeJavaScript('window.ezterminalDesktop.issuePairingCode()');
      return issued.code;
    });
    await connectAndAuth(second);
    runAdb(['shell', 'am', 'force-stop', APP_ID]);
    await sleep(1_000);
    runAdb(['shell', 'am', 'start', '-n', `${APP_ID}/.MainActivity`]);
    await waitForTestId('connect-screen', 45_000);
    await waitForTestId('connect-saved-summary');
    await tapTestId('connect-saved-go');
    await waitForTestId('mobile-home-view', 45_000);
    console.log('[surfaces] step OK: the issued bearer was persisted and still authenticates after a restart');

    assertNoWebViewJavaScriptRuntimeErrors();
    console.log('[surfaces] ALL STEPS PASSED');
  } finally {
    console.log('[surfaces] teardown...');
    closeMobileE2eResources();
    await app.close().catch(() => undefined);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
