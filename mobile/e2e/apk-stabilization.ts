import { existsSync } from 'node:fs';

import {
  APK_PATH,
  APP_ID,
  MAIN_ENTRY,
  closeMobileE2eResources,
  connectAndAuth,
  getWebViewHistorySnapshot,
  launchDesktop,
  runAdb,
  sleep,
  tapTestId,
  waitForTestId,
  waitForTestIdHidden,
} from './lib.ts';

interface Destination {
  readonly action: string;
  readonly view: string;
}

const DESTINATIONS: readonly Destination[] = [
  { action: 'more-sessions', view: 'session-switcher' },
  { action: 'more-files', view: 'mobile-file-view' },
  { action: 'more-stats', view: 'mobile-stats-view' },
  { action: 'more-theme', view: 'theme-menu' },
  { action: 'more-openclaw', view: 'mobile-openclaw-view' },
  { action: 'more-settings', view: 'mobile-settings-view' },
];

async function openFromMore(destination: Destination): Promise<void> {
  console.log(`[apk-stabilization] opening ${destination.action}`);
  await tapTestId('workspace-more-btn');
  await tapTestId(destination.action);
  await sleep(600); // cross the history cleanup microtask/task boundary
  await waitForTestId(destination.view);
  console.log('[apk-stabilization] history:', JSON.stringify(await getWebViewHistorySnapshot()));
}

async function androidBackToTerminal(closedView: string): Promise<void> {
  console.log(`[apk-stabilization] Android Back from ${closedView}`);
  runAdb(['shell', 'input', 'keyevent', '4']);
  await sleep(500);
  await waitForTestIdHidden(closedView);
  await waitForTestId('workspace-more-btn');
}

async function main(): Promise<void> {
  if (!existsSync(MAIN_ENTRY)) throw new Error(`Desktop build missing: ${MAIN_ENTRY}`);
  if (!existsSync(APK_PATH)) throw new Error(`APK missing: ${APK_PATH}`);

  const { app, token } = await launchDesktop();
  try {
    await connectAndAuth(token);

    // Keep the OpenClaw destination visible even when the fixture machine has
    // no CLI. The page must then render its typed unavailable guidance.
    await openFromMore({ action: 'more-settings', view: 'mobile-settings-view' });
    await tapTestId('settings-openclaw-mode-on');
    await tapTestId('mobile-settings-close');
    await waitForTestId('workspace-more-btn');
    await sleep(600);
    console.log('[apk-stabilization] post-settings history:', JSON.stringify(await getWebViewHistorySnapshot()));

    for (const destination of DESTINATIONS) {
      await openFromMore(destination);
      await androidBackToTerminal(destination.view);
    }

    // Repeated sheet -> page replacement is the original APK regression.
    // Alternate destinations so stale markers cannot accidentally cancel out.
    for (let i = 0; i < 20; i += 1) {
      const destination = DESTINATIONS[i % DESTINATIONS.length];
      await openFromMore(destination);
      await androidBackToTerminal(destination.view);
    }

    // Back closes the More sheet itself before it can leave the workspace.
    await tapTestId('workspace-more-btn');
    await waitForTestId('workspace-more-sheet');
    await androidBackToTerminal('workspace-more-sheet');

    console.log('[apk-stabilization] PASS: More destinations, async history, and Android Back');
  } finally {
    closeMobileE2eResources();
    try {
      runAdb(['shell', 'am', 'force-stop', APP_ID]);
    } catch {
      // best-effort device cleanup
    }
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error('[apk-stabilization] ERROR:', error);
  process.exitCode = 1;
});
