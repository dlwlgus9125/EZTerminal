/**
 * Runs under Electron for `browser-view-manager.os.test.ts`: a real `WebContentsView`, a real partition, a loopback server.
 * Every `*.example` name maps to 127.0.0.1, so nothing leaves this PC, and the profile lives in the scratch folder. What
 * "reached" means is read off the server's own log, never off a page, a tool or a model.
 */
import { app, BrowserWindow, session, type WebContents } from 'electron';
import { promises as fs, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { BROWSER_PARTITION, type BrowserViewState } from '../shared/browser';
import { BrowserRefused, parseKeys } from './browser-cdp';
import type { BrowserPartitionSession } from './browser-network-guard';
import { BrowserViewManager } from './browser-view-manager';

const scratch = process.argv[process.argv.indexOf('--scratch') + 1]!;
app.setPath('userData', path.join(scratch, 'profile'));
app.setPath('sessionData', path.join(scratch, 'profile'));
app.setPath('downloads', path.join(scratch, 'downloads'));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP *.example 127.0.0.1, MAP gone.test ~NOTFOUND');

const SETTLE_MS = 400;
const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
const report: Record<string, unknown> = {};

interface Hit { readonly host: string; readonly path: string; readonly method: string }
const hits: Hit[] = [];
const controlHits: Hit[] = [];

function pad(evil: string, base: string, outsideFile: string): string {
  return `<!doctype html><title>pad</title><body style="margin:0">
<a id=link href="${evil}/landed?via=link" style="position:fixed;left:10px;top:10px;font-size:22px">link</a>
<a id=redirect href="${base}/redirect-302?to=${encodeURIComponent(`${evil}/landed?via=redirect`)}" style="position:fixed;left:10px;top:50px;font-size:22px">redirect</a>
<a id=blank target=_blank href="${evil}/landed?via=blank" style="position:fixed;left:10px;top:90px;font-size:22px">blank</a>
<a id=filelink href="${outsideFile}" style="position:fixed;left:10px;top:130px;font-size:22px">file</a>
<form id=form method=post action="${evil}/landed?via=form" style="position:fixed;left:10px;top:170px"><button id=post style="font-size:22px">send</button></form>
<button id=scripted style="position:fixed;left:10px;top:230px;font-size:22px" onclick="location.href='${evil}/landed?via=click-script'">scripted</button>`;
}

function startServer(record: Hit[], respond: (url: URL, response: http.ServerResponse, port: number) => boolean): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    record.push({ host: String(request.headers.host ?? '').split(':')[0]!, path: `${url.pathname}${url.search}`, method: request.method ?? '' });
    const { port } = server.address() as { port: number };
    if (respond(url, response, port)) return;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>landed</title><p>landed</p>');
  });
  server.on('upgrade', (request, socket) => { record.push({ host: String(request.headers.host ?? '').split(':')[0]!, path: request.url ?? '', method: 'UPGRADE' }); socket.destroy(); });
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(server)); });
}

async function main(): Promise<void> {
  await app.whenReady();
  const workspace = path.join(scratch, 'workspace');
  const outside = path.join(scratch, 'outside');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(path.join(scratch, 'downloads'), { recursive: true });
  const secret = path.join(outside, 'secret.html');
  writeFileSync(secret, '<p>OUTSIDE-SECRET</p>');
  symlinkSync(outside, path.join(workspace, 'escape'), 'junction');
  const secretUrl = pathToFileURL(secret).href;
  const insidePage = path.join(workspace, 'page.html');
  writeFileSync(path.join(workspace, 'own.css'), 'body{color:red}');
  writeFileSync(insidePage, `<!doctype html><title>inside</title><link rel=stylesheet href=own.css><p>inside</p><iframe id=f src="${secretUrl}"></iframe><img id=i src="${secretUrl}">`);

  const html = (response: http.ServerResponse, body: string, headers: http.OutgoingHttpHeaders = {}): true => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers });
    response.end(body);
    return true;
  };
  const server = await startServer(hits, (url, response, port) => {
    const base = `http://127.0.0.1:${String(port)}`;
    switch (url.pathname) {
      case '/pad': return html(response, pad(`http://evil.example:${String(port)}`, base, secretUrl));
      case '/redirect-302':
        response.writeHead(302, { location: url.searchParams.get('to') ?? '/' });
        response.end();
        return true;
      case '/meta': return html(response, `<meta http-equiv=refresh content="0;url=${url.searchParams.get('to') ?? ''}">`);
      case '/download':
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="thing.bin"' });
        response.end('payload');
        return true;
      case '/reaches-local':
        return html(response, `<!doctype html><title>external</title><img src="${base}/pwn-img"><script src="${base}/pwn-script"></script><iframe src="${base}/pwn-frame"></iframe>
<script>fetch('${base}/pwn-fetch',{mode:'no-cors'}).catch(()=>0);navigator.sendBeacon('${base}/pwn-beacon','x')</script>`);
      case '/with-frames':
        return html(response, `<!doctype html><title>t</title><iframe src="/landed?via=own-frame"></iframe>`);
      case '/form':
        return html(response, `<!doctype html><title>form</title><body style="margin:0">
<script>
Node.prototype.contains=()=>{window.poisoned=1;return true};HTMLElement.prototype.focus=()=>{window.poisoned=1};
console.log('page says hello');setTimeout(()=>{throw new Error('thrown here')},0);
</script>
<h1 style="margin:10px">Order summary</h1>
<form onsubmit="event.preventDefault();window.submitted=(window.submitted||0)+1" style="margin:10px">
<input id=name aria-label=Name value="old" onkeydown="if(event.key==='Enter')window.submitted=(window.submitted||0)+1"><input id=pw type=password aria-label=Password value="hunter2-secret">
<button type=button onclick="window.saved=(window.saved||0)+1">Save</button>
<button type=button onclick="document.getElementById('file').click()">Attach</button><input id=file type=file style="display:none">
</form>
<iframe srcdoc="<p>SAME-ORIGIN-FRAME-TEXT</p>" width=200 height=60></iframe>
<iframe src="http://evil.example:${String(port)}/landed?via=cross-frame" width=200 height=60></iframe>
<div id=cover style="display:none;position:fixed;left:0;top:0;width:100%;height:100%;background:#fff"></div>`);
      case '/counter':
        return html(response, `<!doctype html><title>c</title><body style="margin:0"><button id=go style="position:fixed;left:20px;top:20px;font-size:22px" onclick="window.clicked=(window.clicked||0)+1">go</button>`);
      default: return false;
    }
  });
  const control = await startServer(controlHits, () => false);
  const port = (server.address() as { port: number }).port;
  const controlPort = (control.address() as { port: number }).port;
  const base = `http://127.0.0.1:${String(port)}`;
  const evil = `http://evil.example:${String(port)}`;
  const allowedOrigin = `http://allowed.example:${String(port)}`;
  const controlBase = `http://127.0.0.1:${String(controlPort)}`;

  // Stands in for a site whose public DNS answer differs from where the connection goes. Everything else is the real resolver.
  const publicNames = new Set(['evil.example', 'allowed.example']);
  let secondLayer = false;
  const partition = session.fromPartition(BROWSER_PARTITION);
  const wrapped: BrowserPartitionSession = {
    webRequest: {
      onBeforeRequest: partition.webRequest.onBeforeRequest.bind(partition.webRequest),
      onResponseStarted: ((filter: Electron.WebRequestFilter, listener: (details: Electron.OnResponseStartedListenerDetails) => void) => {
        partition.webRequest.onResponseStarted(filter, (details) => { if (secondLayer) listener(details); });
      }) as Electron.WebRequest['onResponseStarted'],
    },
    resolveHost: (host, options) => (publicNames.has(host)
      ? Promise.resolve({ endpoints: [{ address: '93.184.216.34', family: 'ipv4' }] })
      : partition.resolveHost(host, options)),
    setPermissionRequestHandler: partition.setPermissionRequestHandler.bind(partition),
    setPermissionCheckHandler: partition.setPermissionCheckHandler.bind(partition),
    setDevicePermissionHandler: partition.setDevicePermissionHandler.bind(partition),
    setDisplayMediaRequestHandler: partition.setDisplayMediaRequestHandler.bind(partition),
    setBluetoothPairingHandler: partition.setBluetoothPairingHandler.bind(partition),
    on: partition.on.bind(partition) as BrowserPartitionSession['on'],
  };

  const win = new BrowserWindow({ width: 1280, height: 800, x: 40, y: 40, frame: false, useContentSize: true, skipTaskbar: true, show: false });
  win.showInactive();
  await win.loadURL('about:blank');

  let allowed: string[] = [];
  const states = new Map<string, BrowserViewState>();
  const manager = new BrowserViewManager({
    scope: (conversationId) => Promise.resolve({ projectId: `project-of-${conversationId}`, roots: [workspace] }),
    allowedOrigins: () => allowed,
    controlPorts: () => new Set([controlPort]),
    onState: (state) => { states.set(state.conversationId, state); },
    partition: () => wrapped,
  });
  manager.attach(win);

  const js =(contents: WebContents, code: string): Promise<unknown> => contents.executeJavaScript(`(()=>{${code}})()`).catch(() => undefined);
  const centre = async (contents: WebContents, selector: string): Promise<{ x: number; y: number }> => contents.executeJavaScript(
    `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  ) as Promise<{ x: number; y: number }>;
  const toolClick = async (contents: WebContents, selector: string): Promise<void> => {
    const { x, y } = await centre(contents, selector);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) });
    }
  };
  const personClick = async (contents: WebContents, selector: string): Promise<void> => {
    const { x, y } = await centre(contents, selector);
    contents.focus();
    contents.sendInputEvent({ type: 'mouseMove', x, y });
    await delay(60);
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  };
  const open = async (id: string, url: string, visible = false): Promise<WebContents> => {
    if (visible) manager.updateSurface(id, { mounted: true, bounds: { x: 0, y: 0, width: 1280, height: 800 }, visible: true });
    await manager.navigateAsPerson(id, url);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await delay(20);
      const page = manager.page(id);
      if (page.ok && page.url !== 'about:blank' && !page.contents.isLoading()) return page.contents;
    }
    throw new Error(`${id} did not load ${url}: ${JSON.stringify(manager.state(id))}`);
  };
  /** Opens the pad and lets the AI drive it once: the pane is guarded from here on. */
  const drivenPad = async (id: string): Promise<WebContents> => {
    const contents = await open(id, `${base}/pad`);
    manager.beginTool(id, 'turn-1');
    manager.endTool(id);
    await delay(SETTLE_MS);
    return contents;
  };
  const record = async (name: string, fire: (id: string, contents: WebContents) => Promise<unknown>, prepare: (id: string) => Promise<WebContents> = drivenPad): Promise<void> => {
    const id = `pane-${name}`;
    const contents = await prepare(id);
    const start = hits.length;
    await fire(id, contents);
    await delay(SETTLE_MS);
    const url = contents.isDestroyed() ? '' : contents.mainFrame.url;
    report[name] = {
      reached: hits.slice(start).filter((hit) => hit.host.endsWith('.example')).map((hit) => hit.path),
      all: hits.slice(start).map((hit) => hit.path),
      url: url.replace(String(port), 'PORT'),
      blocked: manager.state(id).blocked?.reason ?? null,
      frames: await js(contents, 'return [...document.querySelectorAll("iframe")].map((f)=>{try{return f.contentWindow.location.href}catch{return "cross-origin"}})').catch(() => []),
    };
    manager.forget(id);
  };

  // Every reaching path, on a pane the AI has driven: nothing reaches the site and the page stays.
  const scripted = (code: string) => (_id: string, contents: WebContents) => js(contents, code);
  await record('guard-link', async (id, contents) => {
    manager.beginTool(id, 'turn-1');
    await toolClick(contents, '#link');
    manager.endTool(id);
  });
  await record('guard-script', scripted(`location.href=${JSON.stringify(`${evil}/landed?via=script`)}`));
  await record('guard-redirect-link', async (id, contents) => {
    manager.beginTool(id, 'turn-1');
    await toolClick(contents, '#redirect');
    manager.endTool(id);
  });
  await record('guard-redirect-tool', async (id) => { await manager.navigateForTool(id, `${base}/redirect-302?to=${encodeURIComponent(`${evil}/landed?via=tool-redirect`)}`); });
  await record('guard-meta-refresh', scripted(`location.href=${JSON.stringify(`${base}/meta?to=${encodeURIComponent(`${evil}/landed?via=meta`)}`)}`));
  await record('guard-form', async (id, contents) => {
    manager.beginTool(id, 'turn-1');
    await toolClick(contents, '#post');
    manager.endTool(id);
  });
  await record('guard-iframe', scripted(`const f=document.createElement('iframe');f.src=${JSON.stringify(`${evil}/landed?via=iframe`)};document.body.append(f)`));
  await record('guard-iframe-redirect', scripted(`const f=document.createElement('iframe');f.src=${JSON.stringify(`${base}/redirect-302?to=${encodeURIComponent(`${evil}/landed?via=iframe-redirect`)}`)};document.body.append(f)`));
  await record('guard-window-open', scripted(`window.open(${JSON.stringify(`${evil}/landed?via=open`)})`));
  await record('guard-target-blank', async (id, contents) => {
    manager.beginTool(id, 'turn-1');
    await toolClick(contents, '#blank');
    manager.endTool(id);
  });
  await record('guard-file-link', scripted(`location.href=${JSON.stringify(secretUrl)}`));

  // The guard outlives everything that stops the tools.
  await record('after-stop', async (id, contents) => {
    manager.beginTool(id, 'turn-1');
    manager.endTool(id);
    manager.stopAi(id);
    report['after-stop-refusal'] = manager.beginTool(id, 'turn-1') ?? null;
    await js(contents, `setTimeout(()=>{location.href=${JSON.stringify(`${evil}/landed?via=late`)}},50)`);
  });
  await record('after-turn-end', async (id, contents) => {
    manager.beginTool(id, 'turn-1');
    manager.endTool(id);
    manager.turnEnded(id, 'turn-1');
    await js(contents, `setTimeout(()=>{location.href=${JSON.stringify(`${evil}/landed?via=late`)}},50)`);
  });
  await record('survives-close', async (id) => {
    manager.close(id);
    const contents = await open(id, `${base}/pad`);
    await js(contents, `location.href=${JSON.stringify(`${evil}/landed?via=after-close`)}`);
    await delay(SETTLE_MS);
    report['survives-close-url'] = contents.mainFrame.url.replace(String(port), 'PORT');
  });

  // The person's own navigations are excepted, and only those.
  await record('person-address-bar', async (id) => {
    await manager.navigateAsPerson(id, `${evil}/landed?via=address-bar`);
    await delay(SETTLE_MS);
    const page = manager.page(id);
    report['person-address-bar-site'] = page.ok ? page.site : page.reason;
    report['person-address-bar-state'] = manager.state(id).site;
  });
  await record('person-address-bar-redirect', async (id) => { await manager.navigateAsPerson(id, `${base}/redirect-302?to=${encodeURIComponent(`${evil}/landed?via=person-redirect`)}`); });
  const shownPad = async (id: string): Promise<WebContents> => {
    const contents = await open(id, `${base}/pad`, true);
    manager.beginTool(id, 'turn-1');
    manager.endTool(id);
    await delay(SETTLE_MS);
    return contents;
  };
  await record('person-click', async (_id, contents) => personClick(contents, '#link'), shownPad);
  await record('person-click-script', async (_id, contents) => personClick(contents, '#scripted'), shownPad);
  await record('person-click-while-tool-runs', async (id, contents) => {
    manager.beginTool(id, 'turn-1');
    await personClick(contents, '#link');
    await delay(SETTLE_MS);
    manager.endTool(id);
  }, shownPad);
  await record('person-click-then-late-script', async (_id, contents) => {
    await personClick(contents, 'body');
    await delay(1_200);
    await js(contents, `location.href=${JSON.stringify(`${evil}/landed?via=late-after-click`)}`);
  }, shownPad);
  await record('script-anchor-without-input', scripted('document.getElementById("link").click()'), shownPad);
  await record('never-driven', scripted(`location.href=${JSON.stringify(`${evil}/landed?via=person-only`)}`), (id) => open(id, `${base}/pad`));
  await record('popup-local-opens-here', scripted(`window.open(${JSON.stringify(`${base}/landed?via=popup`)})`));

  // The person's pass ends with their navigation, whatever shape it took: a back that stays in the document commits nothing.
  await record('person-pass-ends', async (id, contents) => {
    await contents.executeJavaScript('history.pushState({}, "", "/pad?step=2")', true);
    await delay(100);
    report['person-pass-ends-could-go-back'] = contents.navigationHistory.canGoBack();
    manager.goBackAsPerson(id);
    await delay(SETTLE_MS);
    manager.beginTool(id, 'turn-1');
    await manager.navigateForTool(id, `${base}/redirect-302?to=${encodeURIComponent(`${evil}/landed?via=stale-pass`)}`);
    await delay(SETTLE_MS);
    manager.endTool(id);
  });
  await record('name-that-does-not-resolve', async (id) => {
    await manager.navigateAsPerson(id, `http://gone.test:${String(port)}/`);
    await delay(SETTLE_MS);
    report['name-that-does-not-resolve-fault'] = manager.state(id).fault ?? null;
  });

  // DNS rebinding, both layers.
  await record('rebind-before-request', async (id) => { await manager.navigateAsPerson(id, `http://rebind.example:${String(port)}/landed`); });
  await record('rebind-subresources', scripted(`const e='http://rebind.example:${String(port)}';new Image().src=e+'/img';fetch(e+'/fetch',{mode:'no-cors'}).catch(()=>0);navigator.sendBeacon(e+'/beacon','x');try{new WebSocket(e.replace('http','ws')+'/ws')}catch{}`));
  allowed = [allowedOrigin];
  secondLayer = true;
  await record('rebind-second-layer', async (id) => {
    await manager.navigateAsPerson(id, `${allowedOrigin}/landed`);
    await delay(SETTLE_MS);
    const page = manager.page(id);
    report['rebind-second-layer-page'] = page.ok ? page.site : page.reason;
  });
  secondLayer = false;
  await record('allowed-loads', async (id) => {
    await manager.navigateForTool(id, `${allowedOrigin}/with-frames`);
    await delay(SETTLE_MS);
    const page = manager.page(id);
    report['allowed-loads-site'] = page.ok ? page.site : page.reason;
  });
  await record('revoked-at-once', async (id) => {
    await delay(50);
    await manager.navigateForTool(id, `${allowedOrigin}/landed`);
    await delay(SETTLE_MS);
    allowed = [];
    const page = manager.page(id);
    report['revoked-at-once-site'] = page.ok ? page.site : page.reason;
  });

  // A site answers from here after its page is already up: the tools refuse it from then on.
  allowed = [allowedOrigin];
  await record('rebind-later-response', async (id, contents) => {
    secondLayer = true;
    await js(contents, `fetch('/landed?via=later',{mode:'no-cors'}).catch(()=>0)`);
    await delay(SETTLE_MS);
    const page = manager.page(id);
    report['rebind-later-page'] = page.ok ? page.site : page.reason;
    secondLayer = false;
  }, (id) => open(id, `${allowedOrigin}/landed?via=up`));
  allowed = [];

  // A tool's input reaches a pane no one has ever seen, with the app minimized too.
  const clickUnseen = async (name: string): Promise<void> => {
    const id = `pane-${name}`;
    const contents = await open(id, `${base}/counter`);
    manager.beginTool(id, 'turn-1');
    const started = Date.now();
    await toolClick(contents, '#go');
    await delay(250);
    report[name] = { clicked: await js(contents, 'return window.clicked ?? 0'), ms: Date.now() - started };
    const shot = await contents.capturePage();
    report[`${name}-shot`] = { empty: shot.isEmpty(), width: shot.getSize().width };
    manager.endTool(id);
    manager.forget(id);
  };
  await clickUnseen('unseen-click');
  win.minimize();
  await delay(200);
  await clickUnseen('unseen-click-minimized');
  win.restore();
  win.showInactive();
  await delay(200);

  // What the tools do to a real page, unseen. The page's own `contains` and `focus` are poisoned: the host must not ask them.
  {
    const id = 'pane-tools';
    const contents = await open(id, `${base}/form`);
    await delay(SETTLE_MS);
    manager.beginTool(id, 'turn-1');
    const page = manager.page(id);
    if (!page.ok) throw new Error(page.reason);
    const { cdp } = page;
    const first = await cdp.snapshot();
    report['tools-snapshot'] = first;
    const refOf = (text: string, label: string): string => new RegExp(`${label}[^\\n]*\\[ref=(e\\d+)\\]`, 'u').exec(text)?.[1] ?? '';
    await cdp.click(refOf(first.text, 'button "Save"'));
    await delay(150);
    report['tools-clicked'] = await js(contents, 'return window.saved ?? 0');
    await cdp.type(refOf(first.text, 'textbox "Name"'), 'Ada');
    report['tools-typed'] = await js(contents, 'return document.getElementById("name").value');
    await cdp.type(refOf(first.text, 'textbox "Name"'), 'Grace');
    report['tools-retyped'] = await js(contents, 'return document.getElementById("name").value');
    const pressed = parseKeys('Enter');
    await cdp.press(pressed!);
    await delay(150);
    report['tools-pressed'] = await js(contents, 'return window.submitted ?? 0');
    report['tools-password'] = await cdp.target(refOf(first.text, 'textbox "Password"'));
    report['tools-name-target'] = await cdp.target(refOf(first.text, 'textbox "Name"'));
    await js(contents, 'document.getElementById("cover").style.display="block"');
    await delay(100);
    report['tools-covered'] = await cdp.click(refOf(first.text, 'button "Save"')).then(() => 'clicked', (error: unknown) => (error instanceof BrowserRefused ? error.reason : String(error)));
    await js(contents, 'document.getElementById("cover").style.display="none"');
    await cdp.click(refOf(first.text, 'button "Attach"'));
    await delay(150);
    report['tools-chooser'] = { opened: cdp.fileChooserOpened(), url: contents.mainFrame.url.replace(String(port), 'PORT') };
    report['tools-poisoned'] = await js(contents, 'return window.poisoned ?? 0');
    report['tools-console'] = cdp.consoleLines().filter((line) => line.includes('page says') || line.includes('thrown here'));
    const shot = await cdp.screenshot();
    report['tools-shot'] = { width: shot.width, height: shot.height, jpeg: shot.jpegBase64.slice(0, 4) };
    const crop = await cdp.screenshot(refOf(first.text, 'button "Save"'));
    report['tools-crop'] = { width: crop.width, height: crop.height, smaller: crop.width < 300 };
    await js(contents, `location.href='/landed?via=refs'`);
    await delay(SETTLE_MS);
    report['tools-after-navigation'] = await cdp.click(refOf(first.text, 'button "Save"')).then(() => 'clicked', (error: unknown) => (error instanceof BrowserRefused ? error.reason : String(error)));
    manager.endTool(id);
    manager.forget(id);
  }

  // The app's own ports, from a local page and for the person.
  await record('control-subresources', scripted(`const c=${JSON.stringify(controlBase)};new Image().src=c+'/img';fetch(c+'/fetch',{mode:'no-cors'}).catch(()=>0);navigator.sendBeacon(c+'/beacon','x');const s=document.createElement('script');s.src=c+'/s.js';document.body.append(s);try{new WebSocket(c.replace('http','ws')+'/ws')}catch{}const f=document.createElement('iframe');f.src=c+'/frame';document.body.append(f)`));
  await record('control-script-top', scripted(`location.href=${JSON.stringify(`${controlBase}/top`)}`));
  await record('control-person', async (id) => { await manager.navigateAsPerson(id, `${controlBase}/person`); }, (id) => open(id, `${base}/pad`));
  report.controlHits = controlHits.length;

  // An external top page reaches for this PC.
  await record('external-to-local', async (id) => { await manager.navigateAsPerson(id, `${evil}/reaches-local`); });
  await record('person-site-own-frames', async (id) => { await manager.navigateAsPerson(id, `${evil}/with-frames`); });

  // file: pages.
  await record('file-inside', async (_id, contents) => {
    report['file-fetch-outside'] = await contents.executeJavaScript(`fetch(${JSON.stringify(secretUrl)}).then((r)=>r.text()).catch(()=>'refused')`);
    report['file-fetch-junction'] = await contents.executeJavaScript(`fetch('escape/secret.html').then((r)=>r.text()).catch(()=>'refused')`);
    report['file-fetch-own'] = await contents.executeJavaScript(`fetch('own.css').then((r)=>r.text()).catch(()=>'refused')`);
    report['file-frame'] = await contents.mainFrame.frames[0]?.executeJavaScript('document.body.innerText').catch(() => 'no-access');
  }, (id) => open(id, pathToFileURL(insidePage).href));
  await record('file-outside-person', async (id) => {
    await manager.navigateAsPerson(id, secretUrl);
    await delay(SETTLE_MS);
    report['file-outside-person-url'] = manager.state(id).url;
  });

  // The page's world.
  {
    const id = 'pane-world';
    const contents = await open(id, `${base}/landed?via=world`);
    report.world = await contents.executeJavaScript(`(async()=>{
      const within=(p)=>Promise.race([Promise.resolve(p).then(()=>'granted',(e)=>e.name),new Promise((ok)=>setTimeout(()=>ok('stalled'),1500))]);
      const r={};
      r.globals={require:typeof require,process:typeof process,ezterminal:typeof ezterminal,electron:typeof electron,module:typeof module};
      r.geolocation=await new Promise((ok)=>navigator.geolocation.getCurrentPosition(()=>ok('granted'),()=>ok('denied'),{timeout:1000}));
      r.notification=await Notification.requestPermission();
      r.media=await within(navigator.mediaDevices.getUserMedia({audio:true}));
      r.display=await within(navigator.mediaDevices.getDisplayMedia({video:true}));
      r.clipboardRead=await within(navigator.clipboard.readText());
      r.clipboardWrite=await within(navigator.clipboard.writeText('x'));
      return r})()`, true);
    const started = Date.now();
    report.dialogs = await js(contents, 'const r={};for(const [k,f] of [["alert",()=>alert("x")],["confirm",()=>confirm("y")],["prompt",()=>prompt("z")]]){try{r[k]=String(f())}catch(e){r[k]="threw"}}return JSON.stringify(r)');
    report.dialogMs = Date.now() - started;
    // Electron leaves this out of its types; it reads back what the view really runs with.
    const preferences = (contents as WebContents & { getLastWebPreferences(): Electron.WebPreferences | null }).getLastWebPreferences();
    report.preferences = {
      sandbox: preferences?.sandbox, contextIsolation: preferences?.contextIsolation, nodeIntegration: preferences?.nodeIntegration,
      disableDialogs: preferences?.disableDialogs, preload: preferences?.preload ?? null, webviewTag: preferences?.webviewTag,
      ownPartition: contents.session === partition && contents.session !== session.defaultSession,
    };
    report.webRtcPolicy = contents.getWebRTCIPHandlingPolicy();
    await js(contents, 'document.cookie="probe=1; max-age=3600"');
    await delay(100);
    report.cookies = {
      partition: (await partition.cookies.get({ name: 'probe' })).length,
      defaultSession: (await session.defaultSession.cookies.get({ name: 'probe' })).length,
    };
    await js(contents, `const a=document.createElement('a');a.href='/download';a.download='thing.bin';document.body.append(a);a.click()`);
    await delay(SETTLE_MS);
    report.download = { blocked: manager.state(id).blocked?.reason ?? null, onDisk: await fs.readdir(path.join(scratch, 'downloads')) };
    manager.forget(id);
  }

  // Live cap: the oldest hidden view goes, keeping its address and its guard, and nothing reloads by itself.
  {
    const ids = ['cap-1', 'cap-2', 'cap-3', 'cap-4'];
    for (const id of ids) await open(id, `${base}/landed?cap=${id}`);
    const after = hits.length;
    manager.beginTool('cap-2', 'turn-1');
    manager.endTool('cap-2');
    await open('cap-5', `${base}/landed?cap=cap-5`);
    await delay(SETTLE_MS);
    report.cap = Object.fromEntries(ids.concat('cap-5').map((id) => {
      const state = manager.state(id);
      const page = manager.page(id);
      return [id, { live: page.ok, needsReopen: state.needsReopen ?? false, url: state.url.replace(String(port), 'PORT') }];
    }));
    report.capReloads = hits.slice(after).map((hit) => hit.path);
    for (const id of ids.concat('cap-5')) manager.forget(id);
  }

  // A crashed page.
  {
    const id = 'pane-crash';
    const contents = await open(id, `${base}/landed?via=crash`);
    contents.forcefullyCrashRenderer();
    await delay(SETTLE_MS);
    const page = manager.page(id);
    report.crash = { page: page.ok ? 'alive' : page.reason, fault: manager.state(id).fault ?? null };
    manager.forget(id);
  }

  report.done = true;
  await fs.writeFile(path.join(scratch, 'report.json'), JSON.stringify(report, null, 1));
  server.closeAllConnections();
  server.close();
  control.closeAllConnections();
  control.close();
  manager.destroy();
  win.destroy();
  app.exit(0);
}

main().catch(async (error: unknown) => {
  report.fatal = String(error instanceof Error ? error.stack : error);
  await fs.writeFile(path.join(scratch, 'report.json'), JSON.stringify(report, null, 1)).catch(() => undefined);
  app.exit(1);
});
