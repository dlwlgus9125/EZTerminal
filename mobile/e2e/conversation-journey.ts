/** Real Android UI against an isolated desktop and a deterministic provider fixture. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OwnedDesktopProfileRegistry } from '../../e2e/owned-desktop-profile.ts';
import { APP_ID, closeMobileE2eResources, closeWebViewDevtools, connectAndAuth, evaluateWebView, launchDesktop,
  runAdb, runAdbBinary, setTestIdTextValue, sleep, tapTestId, tapTestIdOnce, waitForTestId, waitForTestIdHidden } from './lib.ts';

const artifacts = path.resolve(process.env.EZTERMINAL_MOBILE_E2E_ARTIFACT_DIR ?? 'artifacts/conversation-ux/android');
const input = '[data-testid="structured-agent-composer-input"]';
async function waitFor(expression: string, label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!await evaluateWebView(expression)) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await sleep(200); }
}
async function click(selector: string): Promise<void> {
  await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, selector);
  await evaluateWebView(`(() => { document.querySelector(${JSON.stringify(selector)}).click(); return true; })()`);
}
async function capture(name: string): Promise<void> { await writeFile(path.join(artifacts, `${name}.png`), runAdbBinary(['exec-out', 'screencap', '-p'])); }

async function main(): Promise<void> {
  await mkdir(artifacts, { recursive: true });
  const registry = new OwnedDesktopProfileRegistry();
  const fixture = registry.createTempDir('ezterm-mobile-conversation-');
  const root = path.join(fixture, 'project');
  const claude = path.join(fixture, '.claude');
  // Claude's project folder encoding is the CLI's stable on-disk convention.
  const historyRoot = path.join(claude, 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(historyRoot, { recursive: true }); await mkdir(root, { recursive: true });
  const nativeId = randomUUID();
  const timestamp = new Date().toISOString();
  await writeFile(path.join(historyRoot, `${nativeId}.jsonl`), [
    { uuid: 'user-1', parentUuid: null, sessionId: nativeId, cwd: root, type: 'user', isSidechain: false, timestamp, origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: 'Android previous CLI conversation' } },
    { uuid: 'assistant-1', parentUuid: 'user-1', sessionId: nativeId, cwd: root, type: 'assistant', isSidechain: false, timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'Saved CLI answer. Reading this must not launch a provider.' }] } },
  ].map(record => JSON.stringify(record)).join('\n') + '\n');
  await writeFile(path.join(claude, 'history.jsonl'), JSON.stringify({ display: 'Android previous CLI conversation', timestamp: Date.now(), project: root, sessionId: nativeId }) + '\n');
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    desktop = await launchDesktop({ env: { [pathKey]: `${path.resolve('e2e/fixtures/fake-codex')}${path.delimiter}${process.env[pathKey] ?? ''}`, USERPROFILE: fixture, HOME: fixture, CLAUDE_CONFIG_DIR: claude } });
    const host = desktop.window;
    const saved = await host.evaluate(root => window.ezterminal.saveAgentProject({ name: 'Conversation UX', primaryRoot: root, additionalRoots: [], pinned: true }), root);
    assert.ok(saved.ok);
    const probe = await host.evaluate(() => window.ezterminal.inspectDaemonProvider('codex'));
    assert.ok(probe.ok);
    const enabled = await host.evaluate(async inspection => {
      const snapshot = await window.ezterminal.getDaemonSnapshot();
      if (!snapshot) throw new Error('Missing snapshot');
      const { probe, reviewDigest } = inspection;
      return window.ezterminal.sendDaemonCommand({ protocolVersion: snapshot.protocolVersion, commandId: 'mobile-ux-enable', idempotencyKey: 'mobile-ux-enable', expectedRevision: snapshot.revision,
        issuedAt: new Date().toISOString(), principal: { kind: 'desktop', id: 'fixture' }, type: 'provider.enable', payload: { providerId: probe.providerId, displayName: probe.displayName,
          protocol: probe.protocol, executablePath: probe.executablePath, executableVersion: probe.executableVersion, argv: probe.argv,
          environmentVariableNames: probe.environmentVariableNames, capabilities: probe.capabilities, reviewDigest } });
    }, probe.value);
    assert.ok(enabled.ok, JSON.stringify(enabled));
    await connectAndAuth(desktop.token);
    await tapTestId('shell-tab-agents');
    await tapTestId('mobile-project-history');
    await waitForTestId('conversation-history-picker');
    await waitFor(`Array.from(document.querySelectorAll('.conversation-history__list button')).some(node => node.textContent.includes('Android previous CLI conversation'))`, 'native history row');
    await evaluateWebView(`(() => { Array.from(document.querySelectorAll('.conversation-history__list button')).find(node => node.textContent.includes('Android previous CLI conversation')).click(); return true; })()`);
    await waitForTestId('conversation-start');
    await waitFor(`document.querySelector('[data-testid="conversation-start"]').textContent.includes('Saved CLI answer')`, 'native transcript');
    assert.equal((await host.evaluate(() => window.ezterminal.getDaemonSnapshot()))?.agents.length, 0);
    await capture('01-previous-conversation');
    await click('.mobile-back-button');
    await tapTestId('mobile-agent-new-session');
    await waitForTestId('conversation-start');
    await setTestIdTextValue('structured-agent-composer-input', 'Draft restored after Android force stop');
    await waitFor(`!document.querySelector('[data-testid="conversation-start"]').textContent.includes('could not be saved securely')`, 'secure draft');
    await sleep(1000);
    await capture('02-new-draft');
    runAdb(['shell', 'am', 'force-stop', APP_ID]); closeWebViewDevtools();
    runAdb(['shell', 'am', 'start', '-n', `${APP_ID}/.MainActivity`]);
    await waitForTestId('connect-screen', 45_000);
    await click('[data-testid="connect-saved-go"]');
    await waitForTestId('mobile-workspace', 45_000);
    await tapTestId('shell-tab-agents');
    await waitForTestId('conversation-start');
    await waitFor(`document.querySelector(${JSON.stringify(input)}).value === 'Draft restored after Android force stop'`, 'restored draft');
    assert.equal((await host.evaluate(() => window.ezterminal.getDaemonSnapshot()))?.agents.length, 0);
    await capture('03-restored-draft');
    await waitFor(`document.querySelector('[data-testid="structured-agent-send"]')?.disabled === false`, 'first Send ready');
    await tapTestIdOnce('structured-agent-send');
    await waitForTestIdHidden('conversation-start', 30_000);
    await waitForTestId('structured-agent-session');
    const deadline = Date.now() + 30_000;
    let snapshot = await host.evaluate(() => window.ezterminal.getDaemonSnapshot());
    while (!snapshot?.turns.some(turn => turn.state === 'completed')) {
      if (Date.now() > deadline) throw new Error('First turn did not complete');
      await sleep(200); snapshot = await host.evaluate(() => window.ezterminal.getDaemonSnapshot());
    }
    assert.equal(snapshot.agents.length, 1); assert.equal(snapshot.turns.length, 1);
    await waitFor(`!!document.querySelector('.mobile-v2-draft-status[data-state="saved"]')`, 'live composer recovery ready');
    await waitFor(`document.querySelector(${JSON.stringify(input)}).value === ''`, 'accepted draft cleared');
    await capture('04-after-first-send');
    await writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ ok: true, androidApi: runAdb(['shell', 'getprop', 'ro.build.version.sdk']).trim(), provider: 'deterministic Codex fixture', checks: ['CLI history opens directly', 'reading starts no provider', 'full process restart retains draft', 'restart sends nothing', 'explicit first send creates one session and turn'], inputMethod: 'native Android navigation taps and controlled WebView composer input' }, null, 2));
  } catch (error) {
    await capture('failure').catch(() => undefined);
    const text = await evaluateWebView<string>('document.body.innerText').catch(() => 'WebView unavailable');
    await writeFile(path.join(artifacts, 'failure.txt'), `${String(error)}\n${text}`);
    if (desktop) await writeFile(path.join(artifacts, 'failure-snapshot.json'), JSON.stringify(await desktop.window.evaluate(() => window.ezterminal.getDaemonSnapshot()), null, 2)).catch(() => undefined);
    throw error;
  } finally { await desktop?.dispose(); closeMobileE2eResources(); await registry.disposeAll(); }
}
await main();
