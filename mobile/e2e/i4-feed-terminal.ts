/**
 * I4 on a real Android device against an isolated desktop and the deterministic Codex fixture:
 * the feed is the first screen; a command approval waits there and is allowed from its card; the
 * conversation opens from its card and Back returns to the feed; the terminal's AI input sends a
 * finished block to that conversation (the toast opens it) and shares its draft with the
 * conversation screen; a cold start opens what waits first, else the terminal left.
 *
 * Run: node --experimental-strip-types mobile/e2e/i4-feed-terminal.ts (APK + desktop build first).
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OwnedDesktopProfileRegistry } from '../../e2e/owned-desktop-profile.ts';
import {
  APP_ID, SHELL_ROOT_TEST_ID, closeMobileE2eResources, closeWebViewDevtools, connectAndAuth, evaluateWebView, launchDesktop,
  openFeed, openTerminalRoot, runAdb, runAdbBinary, setTestIdTextValue, sleep, tapTestId, tapTestIdOnce, waitForTestId,
  waitForTestIdAttribute, waitForTestIdHidden,
} from './lib.ts';

const artifacts = path.resolve(process.env.EZTERMINAL_MOBILE_E2E_ARTIFACT_DIR ?? 'artifacts/ux2/i4/android');
const input = '[data-testid="structured-agent-composer-input"]';

async function waitFor(expression: string, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await evaluateWebView(expression)) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await sleep(200); }
}
async function capture(name: string): Promise<void> { await writeFile(path.join(artifacts, `${name}.png`), runAdbBinary(['exec-out', 'screencap', '-p'])); }
const visibleCount = (testId: string): string => `[...document.querySelectorAll('[data-testid="${testId}"]')].filter(function (node) { return node.getBoundingClientRect().width > 0; }).length`;

async function main(): Promise<void> {
  await mkdir(artifacts, { recursive: true });
  const registry = new OwnedDesktopProfileRegistry();
  const fixture = registry.createTempDir('ezterm-mobile-i4-');
  const root = path.join(fixture, 'project');
  await mkdir(root, { recursive: true });
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  const checks: string[] = [];
  let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    const fakeCodex = path.resolve(import.meta.dirname, '../../e2e/fixtures/fake-codex');
    desktop = await launchDesktop({ env: { [pathKey]: `${fakeCodex}${path.delimiter}${process.env[pathKey] ?? ''}`, USERPROFILE: fixture, HOME: fixture } });
    const host = desktop.window;
    const saved = await host.evaluate(root => window.ezterminal.saveAgentProject({ name: 'Feed project', primaryRoot: root, additionalRoots: [], pinned: true }), root);
    assert.ok(saved.ok);
    const probe = await host.evaluate(() => window.ezterminal.inspectDaemonProvider('codex'));
    assert.ok(probe.ok);
    const enabled = await host.evaluate(async (inspection) => {
      const snapshot = await window.ezterminal.getDaemonSnapshot();
      if (!snapshot) throw new Error('Missing snapshot');
      const { probe, reviewDigest } = inspection;
      return window.ezterminal.sendDaemonCommand({ protocolVersion: snapshot.protocolVersion, commandId: 'i4-enable', idempotencyKey: 'i4-enable', expectedRevision: snapshot.revision,
        issuedAt: new Date().toISOString(), principal: { kind: 'desktop', id: 'fixture' }, type: 'provider.enable', payload: { providerId: probe.providerId, displayName: probe.displayName,
          protocol: probe.protocol, executablePath: probe.executablePath, executableVersion: probe.executableVersion, argv: probe.argv,
          environmentVariableNames: probe.environmentVariableNames, capabilities: probe.capabilities, reviewDigest } });
    }, probe.value);
    assert.ok(enabled.ok, JSON.stringify(enabled));
    const snapshot = () => host.evaluate(() => window.ezterminal.getDaemonSnapshot());

    // 1. A fresh install opens on the feed.
    await connectAndAuth(desktop.token);
    await waitForTestId('mobile-feed', 30_000);
    await capture('01-feed');
    checks.push('opens on the feed');

    // 2. The ask bar starts a conversation whose command waits on the person.
    await tapTestId('mobile-feed-new');
    await waitForTestId('conversation-start');
    await setTestIdTextValue('structured-agent-composer-input', 'EZTERMINAL_E2E_APPROVAL run the phone tests');
    await waitFor(`(document.querySelector('[data-testid="structured-agent-send"]') || {}).disabled === false`, 'first Send ready');
    await tapTestIdOnce('structured-agent-send');
    await waitForTestIdHidden('conversation-start', 30_000);
    await waitForTestId('structured-agent-session');
    const deadline = Date.now() + 30_000;
    while (!(await snapshot())?.approvals.some(approval => approval.state === 'pending')) {
      if (Date.now() > deadline) throw new Error('The command approval never waited');
      await sleep(200);
    }
    // Opened from the feed: its back button returns straight to the feed.
    await tapTestId('mobile-structured-agent-back');
    await waitForTestId('mobile-feed');
    await waitFor(`${visibleCount('mobile-feed-waiting')} >= 1`, 'the waiting card');
    await waitFor(`document.querySelector('[data-testid="mobile-feed-waiting"]').textContent.indexOf('pnpm --dir mobile test') >= 0`, 'the command on the card');
    await capture('02-feed-waiting');
    checks.push('a command approval waits on the feed with its command');

    // 3. 허용 on the card answers it; the turn finishes with the decision.
    await tapTestId('mobile-feed-allow');
    const answered = Date.now() + 30_000;
    let state = await snapshot();
    while (state?.approvals.some(approval => approval.state === 'pending') || !state?.turns.some(turn => turn.state === 'completed')) {
      if (Date.now() > answered) throw new Error('The approval was not answered from the feed');
      await sleep(200); state = await snapshot();
    }
    await waitFor(`${visibleCount('mobile-feed-waiting')} === 0`, 'the card leaves the feed');
    checks.push('허용 on the feed card resolves the approval and the turn completes');

    // 4. The conversation card opens it; Back returns to the feed.
    await waitFor(`${visibleCount('mobile-feed-conversation')} >= 1`, 'the conversation card');
    await tapTestId('mobile-feed-conversation');
    await waitForTestId('structured-agent-session');
    await waitFor(`document.querySelector('[data-testid="structured-agent-session"]').textContent.indexOf('Approval answered') >= 0`, 'the answered turn in the conversation');
    await capture('03-conversation');
    runAdb(['shell', 'input', 'keyevent', '4']);
    await waitForTestId('mobile-feed');
    checks.push('the conversation opens from its card; Android Back returns to the feed');

    // 5. The terminal: a finished block goes to the last conversation through the AI input.
    await openTerminalRoot();
    await tapTestId('tab-add-btn');
    await waitForTestId('mobile-session-view', 30_000);
    await setTestIdTextValue('cmd-input', 'echo i4-chip-output');
    await tapTestId('btn-run');
    await waitFor(`document.querySelector('[data-testid="block-list"]').textContent.indexOf('i4-chip-output') >= 0`, 'the block output', 45_000);
    await waitForTestId('terminal-mode-ai', 30_000);
    await tapTestId('terminal-mode-ai');
    await waitFor(`!!document.querySelector('.mobile-session-view [data-testid="terminal-ai-chip"]')`, 'the output chip');
    await setTestIdTextValue('structured-agent-composer-input', 'From the phone terminal');
    await capture('04-terminal-ai');
    await waitFor(`(document.querySelector('.mobile-session-view [data-testid="structured-agent-send"]') || {}).disabled === false`, 'terminal Send ready');
    const turnsBefore = (await snapshot())?.turns.length ?? 0;
    await tapTestIdOnce('structured-agent-send');
    await waitForTestId('mobile-toast-action', 15_000);
    const sent = Date.now() + 30_000;
    while (((await snapshot())?.turns.length ?? 0) <= turnsBefore) { if (Date.now() > sent) throw new Error('The terminal message was not sent'); await sleep(200); }
    checks.push('the terminal AI input sends a finished block with a message');
    await tapTestId('mobile-toast-action');
    await waitForTestId('structured-agent-session');
    await waitFor(`document.querySelector('[data-testid="structured-agent-session"]').textContent.indexOf('From the phone terminal') >= 0`, 'the message in the conversation');
    await capture('05-sent-to-conversation');
    checks.push('the sent toast opens the conversation, which shows the message');

    // 6. One draft: typed in the terminal box, it is in the conversation screen.
    await openTerminalRoot();
    await waitFor(`!!document.querySelector('.mobile-session-view ${input}')`, 'the terminal AI box');
    await setTestIdTextValue('structured-agent-composer-input', 'Shared draft from the terminal');
    await sleep(1500);
    await openFeed();
    await tapTestId('mobile-feed-conversation');
    await waitForTestId('structured-agent-session');
    await waitFor(`(document.querySelector(${JSON.stringify(input)}) || {}).value === 'Shared draft from the terminal'`, 'the shared draft');
    checks.push('the terminal box and the conversation screen share one draft');

    // 7. Cold start: nothing waits and the terminal was left → the terminal.
    await openTerminalRoot();
    await sleep(1000);
    closeWebViewDevtools();
    runAdb(['shell', 'am', 'force-stop', APP_ID]);
    runAdb(['shell', 'am', 'start', '-n', `${APP_ID}/.MainActivity`]);
    await waitForTestId('connect-screen', 45_000);
    await tapTestId('connect-saved-go');
    await waitForTestId(SHELL_ROOT_TEST_ID, 45_000);
    await waitForTestIdAttribute(SHELL_ROOT_TEST_ID, 'data-terminal-active', 'true', 15_000);
    await capture('06-cold-terminal');
    checks.push('a cold start with nothing waiting returns to the terminal left');

    // 8. Cold start with something waiting → the feed.
    await openFeed();
    await tapTestId('mobile-feed-conversation');
    await waitForTestId('structured-agent-session');
    await setTestIdTextValue('structured-agent-composer-input', 'EZTERMINAL_E2E_APPROVAL once more');
    await waitFor(`(document.querySelector('[data-testid="structured-agent-send"]') || {}).disabled === false`, 'Send ready');
    await tapTestIdOnce('structured-agent-send');
    const waits = Date.now() + 30_000;
    while (!(await snapshot())?.approvals.some(approval => approval.state === 'pending')) { if (Date.now() > waits) throw new Error('The second approval never waited'); await sleep(200); }
    await openTerminalRoot();
    await sleep(1000);
    closeWebViewDevtools();
    runAdb(['shell', 'am', 'force-stop', APP_ID]);
    runAdb(['shell', 'am', 'start', '-n', `${APP_ID}/.MainActivity`]);
    await waitForTestId('connect-screen', 45_000);
    await tapTestId('connect-saved-go');
    await waitForTestId('mobile-feed', 45_000);
    await waitFor(`${visibleCount('mobile-feed-waiting')} >= 1`, 'the waiting card after the cold start');
    await capture('07-cold-feed-waiting');
    await tapTestId('mobile-feed-deny');
    await waitFor(`${visibleCount('mobile-feed-waiting')} === 0`, 'the denied card leaves');
    checks.push('a cold start with something waiting opens the feed; 거부 answers it');

    await writeFile(path.join(artifacts, 'i4-feed-terminal.json'), JSON.stringify({ ok: true, androidApi: runAdb(['shell', 'getprop', 'ro.build.version.sdk']).trim(), checks }, null, 2));
    console.log(`[i4-feed-terminal] PASS ${checks.length} checks`);
  } catch (error) {
    await capture('failure').catch(() => undefined);
    const text = await evaluateWebView<string>('document.body.innerText').catch(() => 'WebView unavailable');
    await writeFile(path.join(artifacts, 'failure.txt'), `${String(error)}\n${checks.join('\n')}\n---\n${text}`);
    if (desktop) await writeFile(path.join(artifacts, 'failure-snapshot.json'), JSON.stringify(await desktop.window.evaluate(() => window.ezterminal.getDaemonSnapshot()), null, 2)).catch(() => undefined);
    throw error;
  } finally { await desktop?.dispose(); closeMobileE2eResources(); await registry.disposeAll(); }
}
await main();
