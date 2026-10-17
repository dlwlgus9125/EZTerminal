/** Real Android UI: subagent chats stay under their parent and a provider-owned one opens read-only. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { OwnedDesktopProfileRegistry } from '../../e2e/owned-desktop-profile.ts';
import { closeMobileE2eResources, connectAndAuth, evaluateWebView, launchDesktop, runAdb, runAdbBinary, sleep, tapTestId, waitForTestId } from './lib.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const artifacts = path.resolve(process.env.EZTERMINAL_MOBILE_E2E_ARTIFACT_DIR ?? 'artifacts/subagents/android');

async function waitFor(expression: string, label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!await evaluateWebView(expression)) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await sleep(200); }
}
async function clickSelector(selector: string): Promise<void> {
  await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, selector);
  await evaluateWebView(`(function () { document.querySelector(${JSON.stringify(selector)}).click(); return true; })()`);
}
/** Clicks the first button whose text includes `text` (evaluated in WebView 74: no optional chaining). */
async function clickText(text: string): Promise<void> {
  const find = `Array.from(document.querySelectorAll('button,[role="button"]')).filter(function (node) { return node.offsetParent !== null && node.textContent.indexOf(${JSON.stringify(text)}) >= 0; })[0]`;
  await waitFor(`!!(${find})`, `button ${text}`);
  await evaluateWebView(`(function () { ${find}.click(); return true; })()`);
}
const bodyText = (): Promise<string> => evaluateWebView<string>('document.body.innerText');
async function capture(name: string): Promise<void> { await writeFile(path.join(artifacts, `${name}.png`), runAdbBinary(['exec-out', 'screencap', '-p'])); }

async function main(): Promise<void> {
  await mkdir(artifacts, { recursive: true });
  const registry = new OwnedDesktopProfileRegistry();
  const fixture = registry.createTempDir('ezterm-mobile-subagents-');
  const workspaceRoot = path.join(fixture, 'project');
  await mkdir(workspaceRoot, { recursive: true });
  // The shared desktop fixture imports daemon modules without extensions; bundle it for Node.
  const seedModule = path.join(fixture, 'agent-tree-fixture.mjs');
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'), path.join(ROOT, 'e2e', 'fixtures', 'agent-tree-fixture.ts'),
    '--bundle', '--platform=node', '--format=esm', `--outfile=${seedModule}`, '--log-level=warning'], { cwd: ROOT });
  const { seedAgentTree, NATIVE_SESSION_ID } = await import(pathToFileURL(seedModule).href) as typeof import('../../e2e/fixtures/agent-tree-fixture.ts');
  let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    desktop = await launchDesktop({ prepareProfile: userDataDir => seedAgentTree(userDataDir, workspaceRoot) });
    const host = desktop.window;
    await connectAndAuth(desktop.token);
    // The project tree: children are reached through their parent, never listed beside it.
    await tapTestId('shell-tab-home');
    const tree = `document.querySelector('[data-testid="project-conversation-tree"]').innerText`;
    await clickSelector('button[aria-label="Expand: Structured child fixture"]');
    await waitFor(`${tree}.indexOf('Lead Agent') >= 0`, 'parent row');
    let listed = await evaluateWebView<string>(tree);
    assert.ok(!listed.includes('Managed Implementer') && !listed.includes('Provider Native Reviewer'), 'a child is listed beside its parent');
    assert.ok(listed.includes('Subagents 1'), 'the parent does not say it has a subagent');
    await capture('01-tree-collapsed');
    await clickSelector('button[aria-label="Expand: Lead Agent"]');
    await waitFor(`${tree}.indexOf('Managed Implementer') >= 0`, 'managed child under its parent');
    await clickSelector('button[aria-label="Expand: Managed Implementer"]');
    await waitFor(`${tree}.indexOf('Provider Native Reviewer') >= 0`, 'provider-owned child under its parent');
    listed = await evaluateWebView<string>(tree);
    await capture('02-tree-expanded');

    await clickSelector('[role="treeitem"][aria-label^="Lead Agent"]');
    await waitForTestId('structured-agent-session');
    await waitFor(`document.body.innerText.indexOf('Managed Implementer') >= 0`, 'child track');
    await capture('02-parent-with-child-track');
    await clickText('Managed Implementer');
    await waitFor(`document.body.innerText.indexOf('Implementation is ready for direct follow-up.') >= 0`, 'managed child view');
    await waitFor(`!!document.querySelector('[data-testid="structured-agent-composer-input"]')`, 'managed child composer');
    await capture('03-managed-child');

    const before = (await host.evaluate(() => window.ezterminal.getDaemonSnapshot()))?.revision;
    await clickText('Provider Native Reviewer');
    await waitForTestId('structured-agent-subagent-footer');
    await waitFor(`document.body.innerText.indexOf('Provider-owned review is visible but controlled by Codex.') >= 0`, 'provider-owned transcript');
    assert.equal(await evaluateWebView('!!document.querySelector(\'[data-testid="structured-agent-composer-input"]\')'), false, 'composer shown for a provider-owned child');
    assert.equal(await evaluateWebView('!!document.querySelector(".mobile-v2-draft-status")'), false, 'draft status shown without a composer');
    await capture('04-provider-owned-child');
    const after = (await host.evaluate(() => window.ezterminal.getDaemonSnapshot()))?.revision;
    assert.equal(after, before, 'viewing a provider-owned child changed the daemon');
    await writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ ok: true, androidApi: runAdb(['shell', 'getprop', 'ro.build.version.sdk']).trim(),
      childSession: NATIVE_SESSION_ID, tree: listed, checks: ['children folded under their parent in the project tree', 'parent shows its child track', 'managed child opens with a composer',
        'provider-owned child opens read-only with the parent footer', 'viewing changes nothing'] }, null, 2));
  } catch (error) {
    await capture('failure').catch(() => undefined);
    const text = await bodyText().catch(() => 'WebView unavailable');
    await writeFile(path.join(artifacts, 'failure.txt'), `${String(error)}\n${text}`);
    throw error;
  } finally { await desktop?.dispose(); closeMobileE2eResources(); await registry.disposeAll(); }
}

await main();
