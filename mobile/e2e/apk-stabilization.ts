import { existsSync } from 'node:fs';

import {
  APK_PATH,
  APP_ID,
  MAIN_ENTRY,
  closeMobileE2eResources,
  connectAndAuth,
  getWebViewHistorySnapshot,
  launchDesktop,
  openHubDestination,
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
  { action: 'hub-sessions', view: 'session-switcher' },
  { action: 'hub-files', view: 'mobile-file-view' },
  { action: 'hub-stats', view: 'mobile-stats-view' },
  { action: 'hub-openclaw', view: 'mobile-openclaw-view' },
  { action: 'hub-settings', view: 'mobile-settings-view' },
];

async function openFromHub(destination: Destination): Promise<void> {
  console.log(`[apk-stabilization] opening ${destination.action}`);
  await openHubDestination(destination.action, destination.view);
  await sleep(600); // cross the history registration task boundary
  console.log('[apk-stabilization] history:', JSON.stringify(await getWebViewHistorySnapshot()));
}

async function androidBackToHub(closedView: string): Promise<void> {
  console.log(`[apk-stabilization] Android Back from ${closedView}`);
  runAdb(['shell', 'input', 'keyevent', '4']);
  await sleep(500);
  await waitForTestIdHidden(closedView);
  await waitForTestId('mobile-remote-hub');
}

async function main(): Promise<void> {
  if (!existsSync(MAIN_ENTRY)) throw new Error(`Desktop build missing: ${MAIN_ENTRY}`);
  if (!existsSync(APK_PATH)) throw new Error(`APK missing: ${APK_PATH}`);

  const { app, token } = await launchDesktop();
  try {
    await connectAndAuth(token);

    // Keep the OpenClaw destination visible even when the fixture machine has
    // no CLI. The page must then render its typed unavailable guidance.
    await openFromHub({ action: 'hub-settings', view: 'mobile-settings-view' });
    await tapTestId('settings-category-integrations');
    await tapTestId('settings-openclaw-mode-on');
    await tapTestId('mobile-settings-close');
    await waitForTestId('settings-category-integrations');
    await tapTestId('mobile-settings-close');
    await waitForTestId('mobile-remote-hub');
    await sleep(600);
    console.log('[apk-stabilization] post-settings history:', JSON.stringify(await getWebViewHistorySnapshot()));

    for (const destination of DESTINATIONS) {
      await openFromHub(destination);
      await androidBackToHub(destination.view);
    }

    // Back closes the appearance sheet before it can leave the hub root.
    await openFromHub({ action: 'hub-appearance', view: 'theme-menu' });
    await androidBackToHub('theme-menu');

    // A Settings category is an internal layer: first Back returns to the
    // Settings index, then a second Back returns to the hub.
    await openFromHub({ action: 'hub-settings', view: 'mobile-settings-view' });
    await tapTestId('settings-category-general');
    runAdb(['shell', 'input', 'keyevent', '4']);
    await waitForTestId('settings-category-general');
    await waitForTestIdHidden('settings-language');
    await androidBackToHub('mobile-settings-view');

    console.log('[apk-stabilization] PASS: hub destinations, nested history, and Android Back');
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
