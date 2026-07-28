/**
 * M3 — Android emulator e2e smoke test.
 *
 * Boots the REAL desktop app (electron.launch, isolated userData dir — same
 * pattern as e2e/launch-app.ts) so its remote-bridge (src/main/remote-bridge.ts)
 * is genuinely live, reads its real persisted token via the same
 * `getRemoteToken()` API the desktop pairing panel (M4) uses, installs+launches
 * the mobile debug APK on a running Android emulator, drives the UI via `adb
 * shell input` (no Appium — element positions are found dynamically via
 * `uiautomator dump`'s accessibility tree, which DOES expose the WebView's DOM
 * as native-looking nodes with real screen-pixel `bounds`), and verifies
 * `echo hello`'s output reached the phone by grepping logcat for the
 * `[ez-e2e]` marker MobileSessionView.tsx's test-only MutationObserver hook
 * logs (see its comment for why: the WebView's DOM isn't otherwise
 * introspectable from outside without Appium, but console.log IS forwarded to
 * logcat).
 *
 * Shared helpers (adb wrapper, uiautomator dump/parse, tap/type/fill,
 * launchDesktop/connectAndAuth, logcat polling) live in `./lib.ts` (M6, mobile-
 * parity plan D8) — see that file's doc comments for the empirical traps
 * behind each one (coordinates are NEVER hardcoded there either, for the same
 * reasons documented originally in this file: the on-screen keyboard is a
 * SEPARATE system overlay that covers whatever WebView content sits under it,
 * and ConnectScreen's fields reflow slightly as error text appears/disappears
 * — dumpUi() always re-dumps the CURRENT UI tree before every interaction).
 *
 * Two real, non-test-only bugs were found and fixed getting this to pass —
 * see mobile/capacitor.config.ts (androidScheme:'http', mixed-content) and
 * mobile/android/app/src/main/AndroidManifest.xml (usesCleartextTraffic,
 * Android's Network Security Config blocking plain ws:// by default) — plus a
 * real desktop-side bug: `ws` bundled into main.js crashed parsing the first
 * real WS frame (see vite.main.config.ts's `external: ['ws']` comment).
 *
 * Prerequisites this script does NOT manage (too heavy/slow to do per-run):
 *  - An AVD must already exist and be BOOTED (`adb devices` shows a `device`).
 *  - `mobile/android/app/build/outputs/apk/debug/app-debug.apk` must be fresh
 *    (`pnpm run build && npx cap sync android && cd android && ./gradlew assembleDebug`).
 *  - `.vite/build/main.js` (+ interpreter-process.js/script-host.js) must exist
 *    (`pnpm package`, or just run `pnpm e2e` once — its globalSetup builds them).
 *  - No OTHER desktop app instance (a manual `pnpm start`, a leftover process
 *    from a previous interrupted run of THIS script, etc.) may already be
 *    bound to loopback port 17420. This script's own try/finally always
 *    disposes the owned desktop session, so back-to-back clean runs are fine
 *    — but a prior run
 *    that was killed externally (Ctrl-C, a crashed shell) leaves an orphaned
 *    Electron process holding the port. Symptom if this happens: main.log
 *    shows `EADDRINUSE` for `127.0.0.1:17420` and the phone's
 *    Connect keeps silently timing out (it's actually talking to the STALE
 *    instance, whose token doesn't match the fresh one this run fetched).
 *    Fix: close any stray EZTerminal window before running this script.
 *
 * Run locally: `pnpm --dir mobile e2e:smoke` (no ts-node/tsx needed; see
 * package.json's `e2e:smoke` script).
 */
import { existsSync, unlinkSync } from 'node:fs';
import {
  APK_PATH,
  APP_ID,
  DUMP_LOCAL_PATH,
  MAIN_ENTRY,
  assertNoWebViewJavaScriptRuntimeErrors,
  closeMobileE2eResources,
  connectAndAuth,
  createTerminalSession,
  evaluateWebView,
  launchDesktop,
  pollLogcat,
  runAdb,
  setTestIdTextValue,
  sleep,
  tapTestId,
  tapTestIdOnce,
  waitForVisibleTestIdDescendant,
  waitForVisibleTestIdEnabled,
} from './lib.ts';

interface ElementGeometry {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

interface ElementIdentity {
  readonly tag: string;
  readonly testId: string | null;
}

interface ViewportGeometry {
  readonly width: number;
  readonly height: number;
  readonly offsetLeft?: number;
  readonly offsetTop?: number;
}

interface TerminalSubmissionState {
  readonly command: string | null;
  readonly inputGeometry: ElementGeometry | null;
  readonly runDisabled: boolean | null;
  readonly runGeometry: ElementGeometry | null;
  readonly runCenterTarget: ElementIdentity | null;
  readonly activeElement: ElementIdentity | null;
  readonly blocks: readonly {
    readonly command: string | null;
    readonly status: string | null;
    readonly ptyHosts: number;
    readonly xtermScreens: number;
  }[];
  readonly innerViewport: ViewportGeometry;
  readonly visualViewport: ViewportGeometry | null;
}

interface TerminalViewportBaseline {
  readonly innerViewport: ViewportGeometry;
  readonly visualViewport: ViewportGeometry | null;
}

async function captureTerminalSubmissionState(): Promise<TerminalSubmissionState> {
  return evaluateWebView<TerminalSubmissionState>(`(() => {
    const visible = (testId) => [...document.querySelectorAll('[data-testid]')]
      .filter((node) => node.getAttribute('data-testid') === testId)
      .reverse()
      .find((node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0
          && style.display !== 'none' && style.visibility !== 'hidden';
      });
    const geometry = (node) => {
      if (!(node instanceof HTMLElement)) return null;
      const rect = node.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };
    const input = visible('cmd-input');
    const run = visible('btn-run');
    const active = document.activeElement;
    const terminal = visible('mobile-session-view');
    const runRect = geometry(run);
    const centerTarget = runRect
      ? document.elementFromPoint(
          runRect.left + runRect.width / 2,
          runRect.top + runRect.height / 2,
        )
      : null;
    const centerTestNode = centerTarget instanceof Element
      ? centerTarget.closest('[data-testid]')
      : null;
    const activeTestNode = active instanceof Element
      ? active.closest('[data-testid]')
      : null;
    return {
      command: input instanceof HTMLInputElement ? input.value : null,
      inputGeometry: geometry(input),
      runDisabled: run instanceof HTMLButtonElement ? run.disabled : null,
      runGeometry: runRect,
      runCenterTarget: centerTarget instanceof Element
        ? {
            tag: centerTarget.tagName,
            testId: centerTestNode ? centerTestNode.getAttribute('data-testid') : null,
          }
        : null,
      activeElement: active instanceof Element
        ? {
            tag: active.tagName,
            testId: activeTestNode ? activeTestNode.getAttribute('data-testid') : null,
          }
        : null,
      blocks: terminal
        ? [...terminal.querySelectorAll('[data-testid="block"]')].map((block) => ({
            command: block.querySelector('[data-testid="block-command"]')
              ? block.querySelector('[data-testid="block-command"]').textContent
              : null,
            status: block.getAttribute('data-status'),
            ptyHosts: block.querySelectorAll('[data-testid="pty-block"]').length,
            xtermScreens: block.querySelectorAll('.xterm-screen').length,
          }))
        : [],
      innerViewport: { width: innerWidth, height: innerHeight },
      visualViewport: window.visualViewport
        ? {
            width: window.visualViewport.width,
            height: window.visualViewport.height,
            offsetLeft: window.visualViewport.offsetLeft,
            offsetTop: window.visualViewport.offsetTop,
          }
        : null,
    };
  })()`);
}

function viewportCoordinateMatches(actual: number | undefined, expected: number | undefined): boolean {
  if (actual === undefined || expected === undefined) return actual === expected;
  return Math.abs(actual - expected) <= 1;
}

function viewportMatchesBaseline(
  state: TerminalSubmissionState,
  baseline: TerminalViewportBaseline,
): boolean {
  const innerMatches = viewportCoordinateMatches(
    state.innerViewport.width,
    baseline.innerViewport.width,
  ) && viewportCoordinateMatches(
    state.innerViewport.height,
    baseline.innerViewport.height,
  );
  if (!innerMatches) return false;
  if (!state.visualViewport || !baseline.visualViewport) {
    return state.visualViewport === baseline.visualViewport;
  }
  return viewportCoordinateMatches(state.visualViewport.width, baseline.visualViewport.width)
    && viewportCoordinateMatches(state.visualViewport.height, baseline.visualViewport.height)
    && viewportCoordinateMatches(state.visualViewport.offsetLeft, baseline.visualViewport.offsetLeft)
    && viewportCoordinateMatches(state.visualViewport.offsetTop, baseline.visualViewport.offsetTop);
}

function submissionGeometrySignature(state: TerminalSubmissionState): string {
  return JSON.stringify({
    input: state.inputGeometry,
    run: state.runGeometry,
    innerViewport: state.innerViewport,
    visualViewport: state.visualViewport,
    centerTarget: state.runCenterTarget,
    activeElement: state.activeElement,
  });
}

async function stabilizeTerminalSubmissionSurface(
  command: string,
  label: string,
  expectedViewport?: TerminalViewportBaseline,
): Promise<TerminalSubmissionState> {
  // A focused composer can keep Android's IME resize animation in flight.
  // Blurring through the real WebView asks the IME to close without sending
  // Android Back, which could navigate if the keyboard has already gone. A
  // late run-exit focus effect can race this first blur, so the loop repeats
  // it whenever the composer regains focus and also requires the unobscured
  // viewport captured before the first command.
  await evaluateWebView<void>(`(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  })()`);

  const deadline = Date.now() + 7_000;
  let previousSignature: string | null = null;
  let stableSamples = 0;
  let lastState: TerminalSubmissionState | null = null;
  for (;;) {
    const state = await captureTerminalSubmissionState();
    lastState = state;
    if (state.command !== command) {
      throw new Error(
        `${label} draft changed before native submit: ${JSON.stringify(state)}`,
      );
    }
    if (state.activeElement?.testId === 'cmd-input') {
      await evaluateWebView<void>(`(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement) active.blur();
      })()`);
    }
    const viewportReady = expectedViewport === undefined
      || viewportMatchesBaseline(state, expectedViewport);
    const targetReady = state.inputGeometry !== null
      && state.runGeometry !== null
      && state.runDisabled === false
      && state.activeElement?.testId !== 'cmd-input'
      && state.runCenterTarget?.testId === 'btn-run'
      && viewportReady;
    if (targetReady) {
      const signature = submissionGeometrySignature(state);
      stableSamples = signature === previousSignature ? stableSamples + 1 : 1;
      previousSignature = signature;
      if (stableSamples >= 3) return state;
    } else {
      stableSamples = 0;
      previousSignature = null;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${label} native submit surface did not stabilize: ${JSON.stringify(lastState)}`,
      );
    }
    await sleep(200);
  }
}

async function waitForCommandSubmissionAcknowledgement(
  command: string,
  label: string,
  initialBlockCount: number,
): Promise<void> {
  // The product's run-port handoff may legitimately use its full 15-second
  // broker deadline before the pending block gains its exact command label.
  // Keep this observation window outside that contract without ever retrying
  // the native tap.
  const deadline = Date.now() + 20_000;
  let lastState: TerminalSubmissionState | null = null;
  let lastError: unknown;
  for (;;) {
    let state: TerminalSubmissionState | null = null;
    try {
      state = await captureTerminalSubmissionState();
      lastState = state;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (state) {
      const addedBlocks = state.blocks.length - initialBlockCount;
      const submittedBlock = state.blocks[state.blocks.length - 1];
      if (
        addedBlocks === 1
        && (state.command === '' || state.command === null)
        && submittedBlock?.command === command
      ) {
        return;
      }
      if (
        addedBlocks > 1
        || (state.command !== command && state.command !== '' && state.command !== null)
      ) {
        throw new Error(
          `${label} single native submit reached an ambiguous state: ${JSON.stringify(state)}`,
        );
      }
    }
    if (Date.now() > deadline) {
      const detail = lastError ? `; observation error=${String(lastError)}` : '';
      throw new Error(
        `${label} single native submit was not acknowledged: ${JSON.stringify(lastState)}${detail}`,
      );
    }
    await sleep(200);
  }
}

async function submitCommandThroughNativeTap(
  command: string,
  label: string,
  expectedViewport?: TerminalViewportBaseline,
): Promise<TerminalViewportBaseline> {
  await setTestIdTextValue('cmd-input', command);
  const ready = await stabilizeTerminalSubmissionSurface(
    command,
    label,
    expectedViewport,
  );
  console.log(`[smoke] ${label} pre-submit state:`, JSON.stringify(ready));

  // This is intentionally the only native injection. Even an adb timeout is
  // ambiguous because Android may already have dispatched the tap, so the
  // harness fails red instead of ever issuing a second command.
  const tapReceipt = await tapTestIdOnce('btn-run');
  console.log(`[smoke] ${label} native tap:`, JSON.stringify(tapReceipt));
  await waitForCommandSubmissionAcknowledgement(
    command,
    label,
    ready.blocks.length,
  );
  return expectedViewport ?? {
    innerViewport: ready.innerViewport,
    visualViewport: ready.visualViewport,
  };
}

async function logTerminalSubmissionDiagnostics(label: string): Promise<void> {
  try {
    console.error(
      `[smoke] ${label} state:`,
      JSON.stringify(await captureTerminalSubmissionState()),
    );
  } catch (diagnosticError) {
    console.error(`[smoke] ${label} state capture failed:`, diagnosticError);
  }
  try {
    assertNoWebViewJavaScriptRuntimeErrors();
  } catch (runtimeError) {
    console.error(`[smoke] ${label} runtime errors:`, runtimeError);
  }
}

async function main(): Promise<void> {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(`Desktop build missing: ${MAIN_ENTRY} — run 'pnpm package' or 'pnpm e2e' once first.`);
  }
  if (!existsSync(APK_PATH)) {
    throw new Error(`APK missing: ${APK_PATH} — build it first (see this file's header comment).`);
  }
  const devices = runAdb(['devices']);
  if (!/\bdevice\b/.test(devices.split('\n').slice(1).join('\n'))) {
    throw new Error(`No booted Android device/emulator found. 'adb devices' returned:\n${devices}`);
  }

  console.log('[smoke] launching desktop app (isolated userData)...');
  const { dispose, token } = await launchDesktop();
  console.log('[smoke] real remote token acquired:', token.slice(0, 8) + '…');
  let scenarioFailure: { readonly error: unknown } | undefined;
  let disposeFailure: { readonly error: unknown } | undefined;

  try {
    await connectAndAuth(token);

    console.log('[smoke] creating a session...');
    await createTerminalSession();

    console.log('[smoke] running cmd /c echo hello...');
    // NOTE: `echo` is NOT a command in EZTerminal's structured shell — there is
    // no `echo` builtin (see interpreter/core/builtins.ts: ls/where/sort-by/
    // gen-rows/cd/history/ps/run-script/ssh-connect) and `echo` is a cmd.exe
    // internal, not a standalone `echo.exe` on PATH. A bare `echo hello` returns
    // an `error` frame ("command not found: echo") and never produces output —
    // so it can never satisfy this assertion. Invoke cmd.exe explicitly so the
    // external-command PTY path actually emits "hello" (verified end-to-end
    // against the real bridge: the pty-data stream carries "hello\r\n").
    const terminalViewportBaseline = await submitCommandThroughNativeTap(
      'cmd /c echo hello',
      'plain PTY',
    );

    console.log('[smoke] polling logcat for [ez-e2e] output containing "hello"...');
    // cmd.exe PTY spawn + output render can take a few seconds on a cold
    // emulator — poll rather than assume a single fixed delay is enough.
    const hit = await pollLogcat('[ez-e2e] output:', 20000, (l) => l.includes('hello'));
    console.log('[smoke] PASS —', hit.trim());

    console.log('[smoke] running held-open forced xterm command...');
    // The output marker can arrive before the desktop's terminal-end frame.
    // Wait for the active session to leave its running state; otherwise the
    // native tap below lands on a still-disabled Run button and no PTY starts.
    await waitForVisibleTestIdEnabled('btn-run', 20_000);
    // Keep the PTY alive long enough for the 250ms CDP polling loop to observe
    // its real DOM. A one-shot `echo` can mount and finish between polls.
    await submitCommandThroughNativeTap(
      '!cmd /d /c ping -n 11 127.0.0.1',
      'forced xterm',
      terminalViewportBaseline,
    );

    console.log('[smoke] waiting for the real xterm DOM...');
    try {
      await waitForVisibleTestIdDescendant('pty-block', '.xterm-screen', 20_000);
    } catch (error) {
      await logTerminalSubmissionDiagnostics('forced xterm timeout');
      throw error;
    }

    // Use a real Android input tap so this reaches xterm's pointer-coordinate
    // path (including the WebView 74 WeakRef compatibility seam). A CDP click
    // would bypass the native coordinate translation this smoke must cover.
    await tapTestId('pty-block');
    assertNoWebViewJavaScriptRuntimeErrors();
    console.log('[smoke] PASS — forced xterm DOM and native pointer path');

    console.log('[smoke] PASS teardown...');
  } catch (error) {
    scenarioFailure = { error };
  } finally {
    // Always close the WebView, including on assertion failure. Otherwise its
    // CDP socket keeps this Node process alive and hides the original error
    // behind the outer command timeout.
    closeMobileE2eResources();
    try {
      runAdb(['shell', 'am', 'force-stop', APP_ID]);
    } catch {
      // best-effort cleanup; preserve the original smoke failure
    }
    try {
      await dispose();
    } catch (error) {
      disposeFailure = { error };
    }
    try {
      unlinkSync(DUMP_LOCAL_PATH);
    } catch {
      // best-effort cleanup
    }
  }
  if (scenarioFailure && disposeFailure) {
    throw new AggregateError(
      [scenarioFailure.error, disposeFailure.error],
      'Mobile smoke scenario and desktop disposal both failed',
    );
  }
  if (scenarioFailure) throw scenarioFailure.error;
  if (disposeFailure) throw disposeFailure.error;
}

main().catch((err: unknown) => {
  console.error('[smoke] ERROR:', err);
  process.exitCode = 1;
});
