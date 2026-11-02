/**
 * Runs under Electron for `browser-view-manager.os.test.ts`: a real `WebContentsView`, a real partition, a loopback server.
 * Every `*.example` name maps to 127.0.0.1, so nothing leaves this PC, and the profile lives in the scratch folder. What
 * "reached" means is read off the server's own log, never off a page, a tool or a model.
 */
import { app, BrowserWindow, session, type WebContents } from 'electron';
import { createHash } from 'node:crypto';
import { promises as fs, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { BROWSER_PARTITION, type BrowserPickedElement, type BrowserViewState } from '../shared/browser';
import { BrowserRefused, parseKeys } from './browser-cdp';
import type { BrowserPartitionSession } from './browser-network-guard';
import { BrowserSiteStore } from './browser-site-store';
import { BrowserTools, type BrowserToolResult } from './browser-tools';
import { BrowserViewManager } from './browser-view-manager';

const scratch = process.argv[process.argv.indexOf('--scratch') + 1]!;
app.setPath('userData', path.join(scratch, 'profile'));
app.setPath('sessionData', path.join(scratch, 'profile'));
app.setPath('downloads', path.join(scratch, 'downloads'));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP *.example 127.0.0.1, MAP gone.test ~NOTFOUND');
// A service worker needs a secure context: this stands in for an https site, which loopback here does not have.
app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', '*.sw.example');

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

/** Scoped to its folder: a controlled page must not leak into the cases after it. */
const WORKERS_PAGE = `<!doctype html><title>workers</title><script>
const within=(promise)=>Promise.race([promise,new Promise((ok)=>setTimeout(()=>ok('no answer'),2500))]);
window.register=()=>within(navigator.serviceWorker.register('sw.js',{scope:'./'}).then(()=>navigator.serviceWorker.ready).then(async()=>{
  for(let i=0;i<60&&!navigator.serviceWorker.controller;i+=1)await new Promise((ok)=>setTimeout(ok,50));
  return navigator.serviceWorker.controller?'controlled':'active';
}).catch(()=>'refused'));
window.askWorker=(url,init)=>within(new Promise((ok)=>{
  navigator.serviceWorker.addEventListener('message',(e)=>ok(e.data),{once:true});
  navigator.serviceWorker.controller.postMessage({url,init});
}));
const answer='onconnect=(e)=>{const p=e.ports[0];p.onmessage=(m)=>fetch(m.data,{mode:"no-cors"}).then(()=>p.postMessage("reached"),()=>p.postMessage("refused"))}';
window.shared=(url,source)=>within(new Promise((ok)=>{
  const worker=new SharedWorker(source??URL.createObjectURL(new Blob([answer],{type:'text/javascript'})));
  worker.port.onmessage=(e)=>ok(e.data);
  worker.onerror=()=>ok('refused');
  worker.port.postMessage(url);
}));
</script>`;
const SERVICE_WORKER = `self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',(e)=>e.waitUntil(clients.claim()));
self.addEventListener('message',(e)=>fetch(e.data.url,e.data.init).then(()=>e.source.postMessage('reached'),()=>e.source.postMessage('refused')));
self.addEventListener('fetch',(e)=>{if(e.request.url.includes('through-worker'))e.respondWith(fetch(e.request))});`;
const SHARED_WORKER = 'onconnect=(e)=>{const p=e.ports[0];p.onmessage=(m)=>fetch(m.data,{mode:"no-cors"}).then(()=>p.postMessage("reached"),()=>p.postMessage("refused"))}';

function startServer(record: Hit[], respond: (url: URL, response: http.ServerResponse, port: number) => boolean): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    record.push({ host: String(request.headers.host ?? '').split(':')[0]!, path: `${url.pathname}${url.search}`, method: request.method ?? '' });
    const { port } = server.address() as { port: number };
    if (respond(url, response, port)) return;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>landed</title><p>landed</p>');
  });
  server.on('upgrade', (request, socket) => {
    record.push({ host: String(request.headers.host ?? '').split(':')[0]!, path: request.url ?? '', method: 'UPGRADE' });
    if (!request.url?.startsWith('/ws-accept')) {
      socket.destroy();
      return;
    }
    // A real handshake: a socket that opens is the case the second layer must see.
    const accept = createHash('sha1').update(`${String(request.headers['sec-websocket-key'])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
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
      case '/nest-sandbox': {
        const target = url.searchParams.get('target') ?? '';
        return html(response, `<!doctype html><title>n</title><iframe sandbox="allow-scripts" srcdoc="&lt;img src=&quot;${target}/nested-img&quot;&gt;&lt;script&gt;fetch(&quot;${target}/nested-fetch&quot;,{mode:&quot;no-cors&quot;}).catch(()=&gt;0)&lt;/script&gt;"></iframe>`);
      }
      case '/srcdoc-parting': {
        const target = url.searchParams.get('target') ?? '';
        const sandbox = url.searchParams.get('sandbox') === '1' ? ' sandbox="allow-scripts"' : '';
        return html(response, `<!doctype html><title>p</title><iframe${sandbox} srcdoc="&lt;script&gt;addEventListener(&quot;pagehide&quot;,()=&gt;{fetch(&quot;${target}/srcdoc-fetch&quot;,{mode:&quot;no-cors&quot;,keepalive:true}).catch(()=&gt;0);navigator.sendBeacon(&quot;${target}/srcdoc-beacon&quot;,&quot;x&quot;)})&lt;/script&gt;"></iframe>`);
      }
      case '/hidden-text':
        return html(response, `<!doctype html><title>h</title><body style="margin:0">
<p>VISIBLE-WORDS</p>
<p style="opacity:0">OPACITY-WORDS</p>
<div style="opacity:0"><p>NESTED-OPACITY-WORDS</p><button>NESTED-BUTTON</button></div>
<p style="font-size:0">FONT-ZERO-WORDS</p>
<p style="position:absolute;left:-9999px">OFF-LEFT-WORDS</p>
<p style="position:absolute;top:-9999px">OFF-TOP-WORDS</p>
<p style="color:#fff;background:#fff">WHITE-WORDS</p>
<div style="font-size:0"><span style="font-size:16px">RESTORED-WORDS</span></div>
<button><span style="font-size:0">BUTTON-HIDDEN-WORDS </span>Buy now</button>
<a href="#x"><span style="opacity:0">LINK-HIDDEN-WORDS</span></a>
<h2>Heading <span style="position:absolute;left:-9999px">HEADING-HIDDEN-WORDS</span>shown</h2>
<div style="font-size:0"><button style="font-size:16px">Keep this button</button></div>
<select aria-label=Size><option>SIZE-OPTION</option></select>
<iframe srcdoc="<p>SHOWN-FRAME-WORDS</p>" width=200 height=60></iframe>
<iframe srcdoc="<p>TRANSPARENT-FRAME-WORDS</p>" style="opacity:0"></iframe>
<div style="position:absolute;left:-9999px"><iframe srcdoc="<p>OFF-PAGE-FRAME-WORDS</p>"></iframe></div>
<iframe srcdoc="<p>TINY-FRAME-WORDS</p>" width=0 height=0 style="border:0"></iframe>
<div style="opacity:0"><iframe srcdoc="&lt;iframe srcdoc='&lt;p&gt;NESTED-FRAME-WORDS&lt;/p&gt;'&gt;&lt;/iframe&gt;"></iframe></div>`);
      case '/workers/page': return html(response, WORKERS_PAGE);
      case '/workers/sw.js':
        response.writeHead(200, { 'content-type': 'text/javascript' });
        response.end(SERVICE_WORKER);
        return true;
      case '/workers/shared.js':
        response.writeHead(200, { 'content-type': 'text/javascript' });
        response.end(SHARED_WORKER);
        return true;
      case '/with-cousin':
        return html(response, `<!doctype html><title>t</title><p>TOP-TEXT</p><iframe src="${url.searchParams.get('frame') ?? ''}"></iframe>`);
      case '/frame-text':
        return html(response, '<!doctype html><title>f</title><p>COUSIN-FRAME-TEXT</p>');
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
      // Two pages of one site that read alike, for an approval the page moves under.
      case '/bound':
      case '/bound-next':
        return html(response, `<!doctype html><title>b</title><body style="margin:0">
<input id=first aria-label=First onkeydown="if(event.key==='Enter')window.pressed=(window.pressed||0)+1">
<input id=second aria-label=Second onkeydown="if(event.key==='Enter')window.pressedSecond=(window.pressedSecond||0)+1">
<button id=act style="position:fixed;left:10px;top:100px;font-size:22px" onclick="window.clicked=(window.clicked||0)+1">Save</button>
<a id=link href="/one" onclick="event.preventDefault();window.clicked=(window.clicked||0)+1" style="position:fixed;left:10px;top:140px;font-size:22px">Go on</a>
<form id=owner action="/one" onsubmit="event.preventDefault();window.clicked=(window.clicked||0)+1" style="position:fixed;left:10px;top:180px"><button id=send style="font-size:22px">Send</button></form>
<div id=closed></div>
<iframe id=frame srcdoc="<input id=inner aria-label=Inner onkeydown=&quot;if(event.key==='Enter')parent.pressed=(parent.pressed||0)+1&quot;>" style="position:fixed;left:10px;top:240px;width:200px;height:50px"></iframe>
<script>document.getElementById('first').focus();
const shadow=document.getElementById('closed').attachShadow({mode:'closed'});shadow.innerHTML='<input aria-label=Sealed onkeydown="if(event.key===\\'Enter\\')window.pressed=(window.pressed||0)+1">';window.focusSealed=()=>shadow.querySelector('input').focus();
${url.searchParams.get('foreign') ? `const f=document.createElement('iframe');f.id='foreign';f.src=${JSON.stringify(url.searchParams.get('foreign')).replaceAll('</', '<\\/')};document.body.append(f);` : ''}</script>`);
      case '/link-to':
        return html(response, `<!doctype html><title>l</title><body style="margin:0"><a id=out href="${url.searchParams.get('to') ?? ''}" style="position:fixed;left:10px;top:10px;font-size:22px">out</a>`);
      case '/frame-moves-top':
        return html(response, `<!doctype html><title>m</title><body style="margin:0;height:100vh" onclick="top.location=${JSON.stringify(url.searchParams.get('to') ?? '').replaceAll('"', '&quot;')}">frame`);
      case '/frame-logs':
        return html(response, '<!doctype html><title>f</title><script>console.log("COUSIN-CONSOLE-WORDS")</script>');
      default: return false;
    }
  });
  const control = await startServer(controlHits, () => false);
  const port = (server.address() as { port: number }).port;
  const controlPort = (control.address() as { port: number }).port;
  const base = `http://127.0.0.1:${String(port)}`;
  const evil = `http://evil.example:${String(port)}`;
  const allowedOrigin = `http://allowed.example:${String(port)}`;
  const otherOrigin = `http://other.example:${String(port)}`;
  const siteOn = (name: string): string => `http://${name}.example:${String(port)}`;
  const controlBase = `http://127.0.0.1:${String(controlPort)}`;

  // Stands in for a site whose public DNS answer differs from where the connection goes. Everything else is the real resolver.
  const publicNames = new Set(['evil', 'allowed', 'other', 'second', 'later', 'wide', 'clean', 'live', 'visit', 'flip', 'split', 'sub.split', 'a.sw'].map((name) => `${name}.example`));
  const turning = new Set<string>();
  let secondLayer = false;
  const guardedRequests: string[] = [];
  const partition = session.fromPartition(BROWSER_PARTITION);
  const wrapped: BrowserPartitionSession = {
    webRequest: {
      // What reached the guard, so a case that expects nothing at the server can show the request was really made.
      onBeforeRequest: ((filter: Electron.WebRequestFilter, listener: (details: Electron.OnBeforeRequestListenerDetails, callback: (response: Electron.CallbackResponse) => void) => void) => {
        partition.webRequest.onBeforeRequest(filter, (details, callback) => {
          if (/\/(?:srcdoc|nested)-/u.test(details.url)) guardedRequests.push(new URL(details.url).pathname);
          listener(details, callback);
        });
      }) as unknown as Electron.WebRequest['onBeforeRequest'],
      onResponseStarted: ((filter: Electron.WebRequestFilter, listener: (details: Electron.OnResponseStartedListenerDetails) => void) => {
        partition.webRequest.onResponseStarted(filter, (details) => { if (secondLayer) listener(details); });
      }) as Electron.WebRequest['onResponseStarted'],
    },
    resolveHost: (host, options) => {
      if (!publicNames.has(host)) return partition.resolveHost(host, options);
      // One clean answer, then the truth: a name that turns to this PC once it has passed the check before the request.
      if (turning.delete(host)) publicNames.delete(host);
      return Promise.resolve({ endpoints: [{ address: '93.184.216.34', family: 'ipv4' }] });
    },
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
  const blockRows: { readonly conversationId: string; readonly reason: string; readonly turnId: string }[] = [];
  const pickedElements: BrowserPickedElement[] = [];
  const storeDir = path.join(scratch, 'store');
  const sites = new BrowserSiteStore(storeDir);
  await sites.load();
  const manager = new BrowserViewManager({
    scope: (conversationId) => Promise.resolve({ projectId: `project-of-${conversationId}`, roots: [workspace] }),
    allowedOrigins: () => allowed,
    controlPorts: () => new Set([controlPort]),
    onState: (state) => { states.set(state.conversationId, state); },
    onBlocked: (conversationId, blocked, turnId) => { blockRows.push({ conversationId, reason: blocked.reason, turnId }); },
    onPicked: (picked) => { pickedElements.push(picked); },
    candidates: (conversationId) => (conversationId === 'pane-candidates' ? [{ url: `${base}/`, source: 'terminal' }] : []),
    suspects: sites,
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
      frames: contents.isDestroyed() ? [] : await js(contents, 'return [...document.querySelectorAll("iframe")].map((f)=>{try{return f.contentWindow.location.href}catch{return "cross-origin"}})').catch(() => []),
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
  // A real click out of a site, and one that only a frame of that site heard: real input lands only before the window is minimized below.
  await record('person-click-external-to-local', async (_id, contents) => personClick(contents, '#out'), (id) => open(id, `${evil}/link-to?to=${encodeURIComponent(`${base}/person-click`)}`, true));
  await record('external-frame-moves-top', async (_id, contents) => {
    await delay(SETTLE_MS);
    const { x, y } = await centre(contents, 'iframe');
    contents.focus();
    contents.sendInputEvent({ type: 'mouseMove', x, y });
    await delay(60);
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  }, (id) => open(id, `${base}/with-cousin?frame=${encodeURIComponent(`${evil}/frame-moves-top?to=${encodeURIComponent(`${base}/pwn-frame-top`)}`)}`, true));
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
  await record('rebind-subresources', async (id, contents) => {
    await js(contents, `const e='http://rebind.example:${String(port)}';new Image().src=e+'/img';fetch(e+'/fetch',{mode:'no-cors'}).catch(()=>0);navigator.sendBeacon(e+'/beacon','x');try{new WebSocket(e.replace('http','ws')+'/ws')}catch{}`);
    await delay(SETTLE_MS);
    report['rebind-subresources-suspect'] = manager.suspected(id, `http://rebind.example:${String(port)}/`);
  });
  allowed = [siteOn('second')];
  secondLayer = true;
  await record('rebind-second-layer', async (id) => {
    await manager.navigateAsPerson(id, `${siteOn('second')}/landed`);
    await delay(SETTLE_MS);
    const page = manager.page(id);
    report['rebind-second-layer-page'] = page.ok ? page.site : page.reason;
  });
  secondLayer = false;
  allowed = [allowedOrigin];
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

  // A site answers from here after its page is already up: the page ends, and the tools refuse it from then on.
  allowed = [siteOn('later')];
  await record('rebind-later-response', async (id, contents) => {
    secondLayer = true;
    await js(contents, `fetch('/landed?via=later',{mode:'no-cors'}).catch(()=>0)`);
    await delay(SETTLE_MS);
    const page = manager.page(id);
    const state = manager.state(id);
    report['rebind-later-page'] = page.ok ? page.site : page.reason;
    report['rebind-later-ended'] = contents.isDestroyed();
    report['rebind-later-state'] = { url: state.url, needsReopen: state.needsReopen ?? false, site: state.site };
    secondLayer = false;
  }, (id) => open(id, `${siteOn('later')}/landed?via=up`));

  // A name that flips under a page already up is caught by the resolver before any response: the same detection.
  allowed = [siteOn('flip')];
  await record('rebind-name-flips', async (id, contents) => {
    publicNames.delete('flip.example');
    await js(contents, `fetch('/landed?via=flip',{mode:'no-cors'}).catch(()=>0)`);
    await delay(SETTLE_MS);
    report['rebind-name-flips-ended'] = contents.isDestroyed();
    report['rebind-name-flips-suspect'] = manager.suspected(id, `${siteOn('flip')}/`);
  }, (id) => open(id, `${siteOn('flip')}/landed?via=up-flip`));

  // A suspect site is out of reach by every road, not only the tool's own, and stays so until the person goes to it.
  allowed = [allowedOrigin, otherOrigin];
  const suspectPad = async (id: string): Promise<WebContents> => {
    const contents = await drivenPad(id);
    manager.onRebind(contents.id, allowedOrigin);
    await delay(50);
    return contents;
  };
  const toSuspect = (via: string): string => `${allowedOrigin}/landed?via=${via}`;
  await record('suspect-script', scripted(`location.href=${JSON.stringify(toSuspect('suspect-script'))}`), suspectPad);
  await record('suspect-redirect', async (id) => {
    manager.beginTool(id, 'turn-1');
    await manager.navigateForTool(id, `${base}/redirect-302?to=${encodeURIComponent(toSuspect('suspect-redirect'))}`);
    await delay(SETTLE_MS);
    manager.endTool(id);
  }, suspectPad);
  await record('suspect-click', async (id, contents) => {
    await js(contents, `const a=document.createElement('a');a.id='to-suspect';a.href=${JSON.stringify(toSuspect('suspect-click'))};a.textContent='go';a.style='position:fixed;left:10px;top:300px;font-size:22px';document.body.append(a)`);
    manager.beginTool(id, 'turn-1');
    await toolClick(contents, '#to-suspect');
    manager.endTool(id);
  }, suspectPad);
  await record('suspect-iframe', scripted(`const f=document.createElement('iframe');f.src=${JSON.stringify(toSuspect('suspect-iframe'))};document.body.append(f)`), suspectPad);
  await record('suspect-window-open', scripted(`window.open(${JSON.stringify(toSuspect('suspect-window-open'))})`), suspectPad);
  await record('suspect-person', async (id) => {
    await manager.navigateAsPerson(id, toSuspect('suspect-person'));
    await delay(SETTLE_MS);
    report['suspect-person-cleared'] = !manager.suspected(id, toSuspect('x'));
  }, suspectPad);
  await record('suspects-accumulate', async (id, contents) => {
    manager.onRebind(contents.id, allowedOrigin);
    manager.onRebind(contents.id, otherOrigin);
    const page = manager.page(id);
    report['suspects-page'] = page.ok ? page.site : page.reason;
    report['suspects-both'] = [manager.suspected(id, `${allowedOrigin}/a`), manager.suspected(id, `${otherOrigin}/b`)];
  }, (id) => open(id, `${allowedOrigin}/landed?via=two`));
  await record('suspect-outlives-elsewhere', async (id) => {
    await manager.navigateAsPerson(id, `${base}/landed?via=elsewhere`);
    await delay(SETTLE_MS);
    await manager.navigateAsPerson(id, `${otherOrigin}/landed?via=other-site`);
    await delay(SETTLE_MS);
    manager.close(id);
    report['suspect-outlives'] = manager.suspected(id, toSuspect('x'));
  }, suspectPad);

  // Every kind of request. The control shows these roads are real: the same script reaches a site in good standing.
  const everyRoad = (origin: string): string => `const e=${JSON.stringify(origin)};new Image().src=e+'/img';fetch(e+'/fetch',{mode:'no-cors'}).catch(()=>0);navigator.sendBeacon(e+'/beacon','x');
const s=document.createElement('script');s.src=e+'/s.js';document.body.append(s);const l=document.createElement('link');l.rel='stylesheet';l.href=e+'/c.css';document.head.append(l);
try{new WebSocket(e.replace('http','ws')+'/ws')}catch{}`;
  await record('suspect-every-road', scripted(everyRoad(allowedOrigin)), suspectPad);
  await record('clean-every-road', scripted(everyRoad(siteOn('clean'))));
  // What a local dev server's page does all day: every road home, HMR's socket and a sandboxed preview's image included.
  await record('local-every-road', async (_id, contents) => {
    await js(contents, everyRoad(`${base}/own`));
    await js(contents, `const f=document.createElement('iframe');f.sandbox='allow-scripts';f.srcdoc=${JSON.stringify(`<img src="${base}/own/sandboxed-img">`)};document.body.append(f)`);
    await js(contents, `const f=document.createElement('iframe');f.srcdoc=${JSON.stringify(`<img src="${base}/own/srcdoc-img">`)};document.body.append(f)`);
  });

  // Suspicion belongs to the partition: what one pane learnt holds on every other, and after a restart.
  allowed = [siteOn('wide')];
  await record('suspect-other-pane', async (id, contents) => {
    const witness = await drivenPad('pane-witness');
    manager.onRebind(witness.id, siteOn('wide'));
    await delay(50);
    report['suspect-other-pane-answers'] = { suspected: manager.suspected(id, `${siteOn('wide')}/a`), site: manager.classify(id, `${siteOn('wide')}/a`) };
    await js(contents, `location.href=${JSON.stringify(`${siteOn('wide')}/landed?via=other-pane`)}`);
    await delay(SETTLE_MS);
    await js(contents, `window.open(${JSON.stringify(`${siteOn('wide')}/landed?via=other-pane-open`)})`);
    manager.forget('pane-witness');
  });
  manager.onRebind(undefined, siteOn('no-pane'));
  report['suspect-no-pane'] = manager.suspected('pane-any', `${siteOn('no-pane')}/`);
  await delay(SETTLE_MS);
  {
    const reopened = new BrowserSiteStore(storeDir);
    await reopened.load();
    const restarted = new BrowserViewManager({ scope: () => Promise.resolve(undefined), allowedOrigins: () => [], controlPorts: () => new Set(), onState: () => undefined, suspects: reopened, partition: () => wrapped });
    report['suspect-restart'] = restarted.suspected('after-restart', `${siteOn('wide')}/a`);
  }

  // A suspect's live page ends on every pane, the one that heard nothing too.
  allowed = [siteOn('live')];
  {
    const elsewhere = await open('pane-live-elsewhere', `${siteOn('live')}/landed?via=elsewhere`);
    await record('suspect-document-elsewhere', async (_id, contents) => {
      manager.onRebind(contents.id, siteOn('live'));
      await delay(50);
      report['suspect-document-elsewhere-ended'] = elsewhere.isDestroyed();
      report['suspect-document-elsewhere-reopen'] = manager.state('pane-live-elsewhere').needsReopen ?? false;
    });
    manager.forget('pane-live-elsewhere');
  }

  // A frame of a suspect site: same site as its page, so one process and one accessibility tree, and it stops being read.
  allowed = [siteOn('sub.split'), siteOn('split')];
  {
    const id = 'pane-split';
    const contents = await open(id, `${siteOn('sub.split')}/with-cousin?frame=${encodeURIComponent(`${siteOn('split')}/frame-text`)}`);
    await delay(SETTLE_MS);
    manager.beginTool(id, 'turn-1');
    const page = manager.page(id);
    if (!page.ok) throw new Error(page.reason);
    report['suspect-frame-before'] = await page.cdp.snapshot();
    manager.onRebind(contents.id, siteOn('split'));
    await delay(50);
    report['suspect-frame-after'] = await page.cdp.snapshot();
    report['suspect-frame-top-up'] = !contents.isDestroyed();
    manager.endTool(id);
    manager.forget(id);
  }

  // The person's own visit: the site works for them on that pane, the AI still reads nothing, and it ends with the visit.
  allowed = [siteOn('visit')];
  const visitUrl = `${siteOn('visit')}/with-frames`;
  await record('suspect-visit', async (id) => {
    await manager.navigateAsPerson(id, visitUrl);
    await delay(SETTLE_MS);
    const page = manager.page(id);
    report['suspect-visit-page'] = page.ok ? page.site : page.reason;
    report['suspect-visit-state'] = manager.state(id).site;
    report['suspect-visit-own-fetch'] = page.ok ? await js(page.contents, `return fetch('/landed?via=visit-fetch').then((r)=>r.status,()=>'refused')`) : 'no page';
    report['suspect-visit-here'] = manager.suspected(id, visitUrl);
    report['suspect-visit-other-pane'] = manager.suspected('pane-any', visitUrl);
    await manager.navigateAsPerson(id, `${base}/landed?via=left`);
    await delay(SETTLE_MS);
    report['suspect-visit-after'] = manager.suspected(id, visitUrl);
    // Back is a navigation of the person's too.
    manager.goBackAsPerson(id);
    await delay(SETTLE_MS);
    const back = manager.page(id);
    report['suspect-visit-back'] = back.ok ? back.site : back.reason;
    await manager.navigateAsPerson(id, `${base}/landed?via=left-again`);
    await delay(SETTLE_MS);
    report['suspect-visit-still'] = manager.suspected(id, visitUrl);
    // Only allowing it again ends the suspicion.
    manager.sitesChanged(`project-of-${id}`, siteOn('visit'), 'allow');
    report['suspect-visit-allowed'] = { suspected: manager.suspected('pane-any', visitUrl), site: manager.classify(id, visitUrl) };
  }, async (id) => {
    const contents = await drivenPad(id);
    manager.onRebind(contents.id, siteOn('visit'));
    await delay(50);
    return contents;
  });
  allowed = [];

  // A person picks an element: their click goes to the picker, and the page never hears it.
  {
    const id = 'pane-pick';
    const contents = await open(id, `${base}/counter`, true);
    report['pick-allowed'] = manager.canPick(id);
    manager.pick(id);
    await delay(150);
    report['pick-state'] = manager.state(id).picking ?? false;
    await personClick(contents, '#go');
    await delay(SETTLE_MS);
    report['pick-page-heard'] = await js(contents, 'return window.clicked ?? 0');
    report['pick-after'] = manager.state(id).picking ?? false;
    report.picked = pickedElements.map((entry) => ({ ...entry, url: entry.url.replace(String(port), 'PORT'), imageBase64: entry.imageBase64?.slice(0, 4) }));
    await personClick(contents, '#go');
    await delay(150);
    report['pick-then-page-heard'] = await js(contents, 'return window.clicked ?? 0');
    pickedElements.length = 0;
    manager.pick(id);
    await delay(150);
    contents.focus();
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await delay(150);
    report['pick-escape'] = { picking: manager.state(id).picking ?? false, picked: pickedElements.length };
    manager.pick(id);
    await delay(100);
    manager.cancelPick(id);
    await delay(100);
    report['pick-cancel'] = { picking: manager.state(id).picking ?? false, clicked: await js(contents, 'document.getElementById("go").click();return window.clicked') };
    manager.pick(id);
    await delay(100);
    await manager.navigateAsPerson(id, `${base}/landed?via=pick-left`);
    await delay(SETTLE_MS);
    report['pick-navigated'] = manager.state(id).picking ?? false;
    manager.forget(id);
    const outside = 'pane-pick-outside';
    await open(outside, `${evil}/landed?via=pick-outside`, true);
    report['pick-outside'] = { can: manager.canPick(outside), picking: (manager.pick(outside), manager.state(outside).picking ?? false) };
    manager.forget(outside);
    report['pick-no-page'] = manager.canPick('pane-pick-nothing');
  }

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
    // This page's external frame loaded before the first tool, so a picture of it stays with the person. Without it, the rest.
    await js(contents, 'document.querySelector(\'iframe[src*="evil.example"]\').remove()');
    await delay(100);
    const shot = await cdp.screenshot();
    report['tools-shot'] = { width: shot.width, height: shot.height, jpeg: shot.jpegBase64.slice(0, 4) };
    report['tools-thumb'] = { bytes: Buffer.from(shot.thumbBase64 ?? '', 'base64').length, jpeg: shot.thumbBase64?.slice(0, 4), noisy: false };
    // The worst page for a thumbnail: noise, which no JPEG can shrink much.
    await js(contents, `const c=document.createElement('canvas');c.width=1280;c.height=800;c.style='position:fixed;left:0;top:0';const x=c.getContext('2d');const d=x.createImageData(1280,800);crypto.getRandomValues(d.data.subarray(0,65536));for(let i=0;i<d.data.length;i+=1)d.data[i]=i%4===3?255:Math.random()*256;x.putImageData(d,0,0);document.body.append(c)`);
    await delay(150);
    const noisy = await cdp.screenshot();
    report['tools-thumb-noisy'] = noisy.thumbBase64 === undefined ? 'dropped' : Buffer.from(noisy.thumbBase64, 'base64').length;
    await js(contents, 'document.querySelector("canvas").remove()');
    const crop = await cdp.screenshot(refOf(first.text, 'button "Save"'));
    report['tools-crop'] = { width: crop.width, height: crop.height, smaller: crop.width < 300 };
    await js(contents, `location.href='/landed?via=refs'`);
    await delay(SETTLE_MS);
    report['tools-after-navigation'] = await cdp.click(refOf(first.text, 'button "Save"')).then(() => 'clicked', (error: unknown) => (error instanceof BrowserRefused ? error.reason : String(error)));
    manager.endTool(id);
    manager.forget(id);
  }

  // What a page hides from the person stays out of what the AI reads.
  {
    const id = 'pane-hidden';
    await open(id, `${base}/hidden-text`);
    await delay(SETTLE_MS);
    manager.beginTool(id, 'turn-1');
    const page = manager.page(id);
    if (!page.ok) throw new Error(page.reason);
    const snapshot = await page.cdp.snapshot();
    report['hidden-text'] = snapshot.text;
    report['hidden-text-unread'] = snapshot.unreadFrames;
    manager.endTool(id);
    manager.forget(id);
  }

  // Earlier cases left `allowedOrigin` suspect, so these keep to a name of their own.
  publicNames.add('kept.example');
  const keptOrigin = siteOn('kept');
  const allowedBefore = allowed;

  // What a person approved must still be what runs. The real tools on a real page, which moves while they ask.
  {
    allowed = [keptOrigin];
    let whileAsked: ((contents: WebContents) => Promise<void>) | undefined;
    let held: WebContents | undefined;
    let current = '';
    let asked = 0;
    const tools = new BrowserTools({
      pages: manager,
      getSnapshot: () => ({ runtime: { browserEnabled: true }, agents: [{ sessionId: current, state: 'working', currentTurnId: 'turn-bound' }] }) as never,
      turnAttended: () => true,
      requestApproval: async () => {
        asked += 1;
        await whileAsked?.(held!);
        await delay(SETTLE_MS);
        return 'allow';
      },
    });
    const call = (id: string, name: Parameters<BrowserTools['call']>[1], value: unknown): Promise<BrowserToolResult> => tools.call({ sessionId: id, projectId: `project-of-${id}`, permissionPreset: 'standard', turnId: 'turn-bound' }, name, value);
    const codeOf = (result: BrowserToolResult): string => {
      const first = result.content[0];
      return result.isError && first?.type === 'text' ? String((JSON.parse(first.text) as { code?: string }).code) : 'ran';
    };
    type Moves = (contents: WebContents) => Promise<unknown>;
    const bound = async (name: string, tool: 'browser_press' | 'browser_click' | 'browser_type', args: (ref: (label: string) => string) => unknown, moves?: Moves, options: { readonly before?: Moves; readonly query?: string } = {}): Promise<void> => {
      const id = `pane-${name}`;
      current = id;
      const contents = await open(id, `${keptOrigin}/bound${options.query ?? ''}`);
      held = contents;
      await delay(100);
      await options.before?.(contents);
      const read = await call(id, 'browser_snapshot', {});
      const words = read.content[0]?.type === 'text' ? read.content[0].text : '';
      const refOf = (label: string): string => new RegExp(`${label}[^\\[]*\\[ref=(e\\d+)\\]`, 'u').exec(words)?.[1] ?? '';
      asked = 0;
      whileAsked = moves ? async (page) => { await moves(page); } : undefined;
      const answer = await call(id, tool, args(refOf));
      await delay(150);
      report[name] = { code: codeOf(answer), asked, facts: await js(contents, 'return {pressed:window.pressed??0,second:window.pressedSecond??0,clicked:window.clicked??0,first:document.getElementById("first").value,path:location.pathname}') };
      manager.forget(id);
    };
    const enter = (): unknown => ({ key: 'Enter' });
    const click = (label: string) => (ref: (label: string) => string): unknown => ({ ref: ref(label) });
    await bound('bound-press-unchanged', 'browser_press', enter);
    await bound('bound-press-same-origin', 'browser_press', enter, (contents) => js(contents, 'location.href="/bound-next"'));
    await bound('bound-press-focus', 'browser_press', enter, (contents) => js(contents, 'document.getElementById("second").focus()'));
    await bound('bound-click-unchanged', 'browser_click', click('Save'));
    await bound('bound-click-renamed', 'browser_click', click('Save'), (contents) => js(contents, 'document.getElementById("act").textContent="Delete everything"'));
    await bound('bound-click-role', 'browser_click', click('Save'), (contents) => js(contents, 'document.getElementById("act").setAttribute("role","link")'));
    await bound('bound-click-replaced', 'browser_click', click('Save'), (contents) => js(contents, 'const b=document.getElementById("act");const n=b.cloneNode(true);b.replaceWith(n)'));
    await bound('bound-type-same-origin', 'browser_type', (ref) => ({ ref: ref('First'), text: 'x' }), (contents) => js(contents, 'location.href="/bound-next"'));
    // The same document, reading differently: its address, and what the element would do.
    await bound('bound-press-pushed', 'browser_press', enter, (contents) => js(contents, 'history.pushState(null,"","/bound?to=other")'));
    await bound('bound-click-href', 'browser_click', click('Go on'), (contents) => js(contents, 'document.getElementById("link").href="/elsewhere"'));
    await bound('bound-click-formaction', 'browser_click', click('Send'), (contents) => js(contents, 'document.getElementById("send").setAttribute("formaction","/elsewhere")'));
    await bound('bound-click-form-action', 'browser_click', click('Send'), (contents) => js(contents, 'document.getElementById("owner").setAttribute("action","/elsewhere")'));
    await bound('bound-click-disabled', 'browser_click', click('Save'), (contents) => js(contents, 'document.getElementById("act").disabled=true'));
    await bound('bound-press-focus-attribute', 'browser_press', enter, (contents) => js(contents, 'document.getElementById("first").setAttribute("formaction","/elsewhere")'));
    // Where the keyboard is, when the host cannot read it: no key goes there on a person's say-so.
    await bound('bound-press-readable-frame', 'browser_press', enter, undefined, { before: (contents) => js(contents, 'const f=document.getElementById("frame");f.contentDocument.getElementById("inner").focus()') });
    await bound('bound-press-closed-shadow', 'browser_press', enter, undefined, { before: (contents) => js(contents, 'window.focusSealed()') });
    await bound('bound-press-foreign-frame', 'browser_press', enter, undefined, { query: `?foreign=${encodeURIComponent(`${evil}/landed?via=foreign`)}`, before: async (contents) => { await delay(SETTLE_MS); await js(contents, 'document.getElementById("foreign").focus()'); } });
  }

  // What a page left behind stays with it: no line of it reads as the next page's, and no capture holds a site the AI may not read.
  {
    const id = 'pane-console-left';
    const contents = await open(id, `${evil}/landed?via=console`);
    await js(contents, 'console.log("EVIL-CONSOLE-WORDS");setTimeout(()=>{throw new Error("EVIL-THROWN-WORDS")},0)');
    await delay(150);
    await manager.navigateAsPerson(id, `${base}/landed?via=after-console`);
    await delay(SETTLE_MS);
    await js(contents, 'console.log("LOCAL-CONSOLE-WORDS")');
    await delay(150);
    const page = manager.page(id);
    report['console-after-leaving'] = page.ok ? page.cdp.consoleLines() : page.reason;
    manager.forget(id);
  }
  {
    const id = 'pane-console-cousin';
    allowed = [siteOn('split')];
    await open(id, `${siteOn('split')}/with-cousin?frame=${encodeURIComponent(`${siteOn('sub.split')}/frame-logs`)}`);
    await delay(SETTLE_MS);
    const page = manager.page(id);
    report['console-cousin'] = page.ok ? page.cdp.consoleLines() : page.reason;
    report['console-cousin-frames'] = page.ok ? page.contents.mainFrame.framesInSubtree.length : 0;
    manager.forget(id);
    allowed = [keptOrigin];
  }
  {
    const id = 'pane-shot-frame';
    const contents = await open(id, `${base}/with-cousin?frame=${encodeURIComponent(`${evil}/frame-text`)}`);
    await delay(SETTLE_MS);
    manager.beginTool(id, 'turn-1');
    const page = manager.page(id);
    if (!page.ok) throw new Error(page.reason);
    report['shot-unread-frame'] = await page.cdp.screenshot().then(() => 'captured', (error: unknown) => (error instanceof BrowserRefused ? { reason: error.reason, detail: error.detail } : String(error)));
    await js(contents, 'document.querySelector("iframe").remove()');
    await delay(100);
    report['shot-after-frame-left'] = await page.cdp.screenshot().then(() => 'captured', (error: unknown) => (error instanceof BrowserRefused ? error.reason : String(error)));
    manager.endTool(id);
    manager.forget(id);
  }

  // Allowing a site is not letting it at this PC. A person went to each page here; nothing else came from a person.
  {
    const onEvil = (id: string): Promise<WebContents> => open(id, `${evil}/landed?via=start`);
    const onAllowed = (id: string): Promise<WebContents> => open(id, `${keptOrigin}/landed?via=start`);
    const out = (name: string): string => `${base}/pwn-${name}`;
    await record('external-script-to-local', scripted(`location.href=${JSON.stringify(out('script'))}`), onEvil);
    await record('external-meta-to-local', scripted(`const m=document.createElement('meta');m.httpEquiv='refresh';m.content=${JSON.stringify(`0;url=${out('meta')}`)};document.head.append(m)`), onEvil);
    await record('external-redirect-to-local', scripted(`location.href=${JSON.stringify(`${evil}/redirect-302?to=${encodeURIComponent(out('redirect'))}`)}`), onEvil);
    await record('external-open-to-local', scripted(`window.open(${JSON.stringify(out('open'))})`), onEvil);
    await record('allowed-subresources-to-local', scripted(`const b=${JSON.stringify(base)};fetch(b+'/pwn-fetch',{mode:'no-cors'}).catch(()=>0);const x=new XMLHttpRequest();x.open('GET',b+'/pwn-xhr');x.send();new Image().src=b+'/pwn-img';navigator.sendBeacon(b+'/pwn-beacon','x');new WebSocket(b.replace('http','ws')+'/pwn-ws');const f=document.createElement('iframe');f.src=b+'/pwn-frame';document.body.append(f)`), onAllowed);
    await record('allowed-script-to-local', scripted(`location.href=${JSON.stringify(out('allowed-script'))}`), onAllowed);
    await record('allowed-open-to-local', scripted(`window.open(${JSON.stringify(out('allowed-open'))})`), onAllowed);
    await record('tool-allowed-redirect-to-local', async (id) => {
      await manager.navigateForTool(id, `${keptOrigin}/redirect-302?to=${encodeURIComponent(out('tool-redirect'))}`);
    });
    // The person's own, and the AI's own: neither is the page's.
    await record('person-bar-external-to-local', async (id) => { await manager.navigateAsPerson(id, `${base}/person-bar`); }, onEvil);
    await record('tool-from-allowed-to-local', async (id) => {
      manager.beginTool(id, 'turn-1');
      await manager.navigateForTool(id, `${base}/tool-from-allowed`);
      manager.endTool(id);
    }, onAllowed);
  }

  // A socket that opens from an address it must not: the name passes the resolver here, and the connection lands on loopback.
  for (const [name, own] of [['rebind-socket-other', false], ['rebind-socket-own', true]] as const) {
    const target = own ? 'socket-own' : 'socket-other';
    publicNames.add(`${target}.example`);
    await record(name, async (id, contents) => {
      secondLayer = true;
      turning.add(`${target}.example`);
      const socket = `${siteOn(target).replace('http', 'ws')}/ws-accept`;
      report[`${name}-opened`] = await contents.executeJavaScript(`new Promise((ok)=>{const s=new WebSocket(${JSON.stringify(socket)});window.socket=s;s.onopen=()=>ok('open');s.onerror=()=>ok('error');setTimeout(()=>ok('no answer'),1500)})`, true).catch(() => 'gone');
      await delay(SETTLE_MS);
      report[`${name}-suspect`] = manager.suspected(id, `${siteOn(target)}/`);
      report[`${name}-ended`] = contents.isDestroyed();
      secondLayer = false;
    }, (id) => open(id, `${siteOn(own ? target : 'clean')}/landed?via=socket`));
  }
  allowed = allowedBefore;

  // The app's own ports, from a local page and for the person.
  await record('control-subresources', scripted(`const c=${JSON.stringify(controlBase)};new Image().src=c+'/img';fetch(c+'/fetch',{mode:'no-cors'}).catch(()=>0);navigator.sendBeacon(c+'/beacon','x');const s=document.createElement('script');s.src=c+'/s.js';document.body.append(s);try{new WebSocket(c.replace('http','ws')+'/ws')}catch{}const f=document.createElement('iframe');f.src=c+'/frame';document.body.append(f)`));
  await record('control-script-top', scripted(`location.href=${JSON.stringify(`${controlBase}/top`)}`));
  await record('control-person', async (id) => { await manager.navigateAsPerson(id, `${controlBase}/person`); }, (id) => open(id, `${base}/pad`));
  report.controlHits = controlHits.length;

  // An external top page reaches for this PC.
  await record('external-to-local', async (id) => { await manager.navigateAsPerson(id, `${evil}/reaches-local`); });
  await record('person-site-own-frames', async (id) => { await manager.navigateAsPerson(id, `${evil}/with-frames`); });
  // What the pane shows now says nothing about who asked: a frame answers for itself, and a document that left for nobody.
  await record('sandboxed-in-external-frame', async (id, contents) => {
    await manager.navigateAsPerson(id, `${base}/with-cousin?frame=${encodeURIComponent(`${evil}/nest-sandbox?target=${encodeURIComponent(base)}`)}`);
    await delay(SETTLE_MS);
    report['sandboxed-in-external-frame-frames'] = contents.mainFrame.framesInSubtree.length;
  }, (id) => open(id, `${base}/landed?via=before-nest`));
  for (const [name, sandbox] of [['srcdoc-parting', '0'], ['srcdoc-parting-sandboxed', '1']] as const) {
    await record(name, async (id) => {
      await manager.navigateAsPerson(id, `${base}/landed?via=left-${name}`);
      await delay(SETTLE_MS);
    }, async (id) => {
      const contents = await open(id, `${evil}/srcdoc-parting?sandbox=${sandbox}&target=${encodeURIComponent(base)}`);
      await delay(SETTLE_MS);
      return contents;
    });
  }
  report['guarded-requests'] = guardedRequests;
  const parting = (name: string, init: string): string => `addEventListener('pagehide',()=>{fetch(${JSON.stringify(`${base}/parting-${name}`)},{mode:'no-cors',keepalive:true${init}}).catch(()=>0);navigator.sendBeacon(${JSON.stringify(`${base}/parting-beacon-${name}`)},'x')})`;
  await record('external-parting-shot', async (id, contents) => {
    await js(contents, parting('plain', ''));
    await manager.navigateAsPerson(id, `${base}/landed?via=left-external`);
  }, (id) => open(id, `${evil}/landed?via=parting`));
  await record('external-parting-shot-hidden', async (id, contents) => {
    await js(contents, parting('hidden', `,referrerPolicy:'no-referrer'`));
    await manager.navigateAsPerson(id, `${base}/landed?via=left-external-2`);
  }, (id) => open(id, `${evil}/landed?via=parting-2`));

  // What runs with no frame. The worker's own answer says what it managed; the server's log says what really arrived.
  const fromPage = (contents: WebContents, code: string): Promise<unknown> => contents.executeJavaScript(code, true) as Promise<unknown>;
  await record('worker-external-service', async (_id, contents) => {
    report['worker-external-secure'] = await fromPage(contents, 'isSecureContext');
    report['worker-external-service-answer'] = await fromPage(contents, 'register()');
  }, (id) => open(id, `${siteOn('a.sw')}/workers/page?service`));
  await record('worker-external-shared', async (_id, contents) => {
    report['worker-external-shared-answer'] = await fromPage(contents, `shared(${JSON.stringify(`${base}/shared-external`)})`);
  }, (id) => open(id, `${evil}/workers/page?shared`));
  await record('worker-local', async (_id, contents) => {
    report['worker-local-service'] = await fromPage(contents, 'register()');
    report['worker-local-reach'] = await fromPage(contents, `askWorker(${JSON.stringify(`${base}/sw-reaches-local`)},{mode:'no-cors'})`);
    report['worker-local-through'] = await fromPage(contents, `fetch('through-worker').then((r)=>r.status,()=>'refused')`);
    report['worker-local-no-referrer'] = await fromPage(contents, `askWorker(${JSON.stringify(`${base}/sw-no-referrer`)},{mode:'no-cors',referrerPolicy:'no-referrer'})`);
    report['worker-local-outside'] = await fromPage(contents, `askWorker(${JSON.stringify(`${siteOn('clean')}/sw-outside`)},{mode:'no-cors'})`);
    report['worker-local-shared'] = await fromPage(contents, `shared(${JSON.stringify(`${base}/shared-local`)},'shared.js')`);
    report['worker-local-control'] = await fromPage(contents, `askWorker(${JSON.stringify(`${controlBase}/sw-control`)},{mode:'no-cors'})`);
  }, (id) => open(id, `${base}/workers/page?local`));
  report.controlHitsAfterWorkers = controlHits.length;

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
    manager.setWaiting(id, true);
    report['waiting-on'] = manager.state(id).waiting ?? false;
    manager.setWaiting(id, false);
    report['waiting-off'] = manager.state(id).waiting ?? false;
    await manager.clearData();
    report['cookies-cleared'] = (await partition.cookies.get({ name: 'probe' })).length;
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

  report['block-rows'] = blockRows;
  report['candidates'] = manager.state('pane-candidates').candidates?.map((entry) => ({ ...entry, url: entry.url.replace(String(port), 'PORT') }));
  report['no-candidates'] = manager.state('pane-no-candidates').candidates ?? null;
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
