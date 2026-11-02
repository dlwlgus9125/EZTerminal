import { realpathSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isControlPortUrl, isLocalHostName, siteClass, webForm } from '../shared/browser';

/**
 * What the in-app browser's partition does for every request, of every page, for the whole life of the app: the host
 * is the only gate, so nothing here asks a model or depends on a turn. Electron keeps one listener per `webRequest` event
 * per session, so this is the one composed listener and it reaches each pane's state through `policyFor`.
 *
 * Measured: `session.resolveHost` shares the connection's resolver (host-resolver-rules apply to both) and answers from
 * `onBeforeRequest` in about a millisecond; a cancelled main frame commits an error page at the banned URL, which is why
 * the view's navigation hooks come first and this layer is the backstop.
 *
 * Residual window (design risk 2): the name can change between this check and the connection. `onResponseStarted` is the
 * second layer and sees the real address, but by then one response has landed.
 */

const NOT_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) NOT_PUBLIC.addSubnet(network, prefix, 'ipv4');
// `::/96` holds `::` and `::1`. Node checks a mapped `::ffff:` address against the IPv4 rules above.
for (const [network, prefix] of [
  ['::', 96], ['64:ff9b::', 96], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) NOT_PUBLIC.addSubnet(network, prefix, 'ipv6');

/** Only a global unicast address passes: loopback, private, link-local and everything unreadable do not. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !NOT_PUBLIC.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

function realPath(target: string): string | undefined {
  try {
    return realpathSync.native(target);
  } catch {
    return undefined;
  }
}

/** The folders a conversation may show, as they really are on disk. */
export function realRoots(roots: readonly string[]): readonly string[] {
  return roots.flatMap((root) => realPath(root) ?? []);
}

function insideRoot(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** The main-process check: a realpath, so neither a junction nor an 8.3 name leads out. Anything it cannot place fails closed. */
export function fileInsideRoots(url: string, roots: readonly string[]): boolean {
  let target: string | undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:' || parsed.hostname) return false;
    target = realPath(fileURLToPath(parsed));
  } catch {
    return false;
  }
  return target !== undefined && roots.some((root) => insideRoot(target, root));
}

export interface BrowserViewPolicy {
  /** The AI has driven this pane: frames and top pages stay guarded for good. No tool or turn state reaches here. */
  readonly guarded: boolean;
  /** A navigation the person made is on its way: its main-frame hops are theirs. */
  readonly personNavigating: boolean;
  readonly topUrl: string;
  /** The page, or the page it is leaving for, is external. */
  readonly topExternal: boolean;
  readonly allowedOrigins: readonly string[];
  /** Real paths (`realRoots`). */
  readonly roots: readonly string[];
  /** Sites that answered from where they must not, on any pane: out of reach by every road, whatever the list says, except the site a person is visiting on this pane. */
  readonly suspectOrigins: ReadonlySet<string>;
}

export type BrowserRequestReason = 'site-not-allowed' | 'rebind-suspected' | 'control-port' | 'file-outside' | 'unresolved';
export type BrowserRequestVerdict = { readonly cancel: false } | { readonly cancel: true; readonly reason: BrowserRequestReason };

const PASS: BrowserRequestVerdict = { cancel: false };
const refuse = (reason: BrowserRequestReason): BrowserRequestVerdict => ({ cancel: true, reason });

/** Schemes with no connection behind them; what they load is judged by the view's navigation hooks. */
const NO_NETWORK = new Set(['about:', 'blob:', 'data:']);

function hostForResolver(hostname: string): string {
  return hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

/** A `blob:` has the origin of the page that made it, and a socket that of its site. */
export function originOf(url: string): string {
  try {
    return new URL(webForm(url)).origin;
  } catch {
    return url;
  }
}

export interface BrowserRequestEnvironment {
  readonly controlPorts: ReadonlySet<number>;
  readonly resolve: (host: string) => Promise<readonly string[]>;
}

/**
 * One request. `policy` is undefined when no pane owns it: a service or shared worker, or a pane already gone. Measured: an
 * external site gets no service worker, because its script request is one of these, but its page's `blob:` shared worker
 * needs no script and runs on plain http, sends no referrer, and went straight to loopback. So nothing owned by no pane
 * reaches this PC on its name alone: only what a local page started, by a referrer no worker can forge across origins.
 */
export async function requestVerdict(
  request: { readonly url: string; readonly resourceType: string; readonly referrer?: string },
  policy: BrowserViewPolicy | undefined,
  environment: BrowserRequestEnvironment,
): Promise<BrowserRequestVerdict> {
  const { url, resourceType } = request;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return refuse('site-not-allowed');
  }
  if (NO_NETWORK.has(parsed.protocol)) return PASS;
  if (parsed.protocol === 'file:') return policy && fileInsideRoots(url, policy.roots) ? PASS : refuse('file-outside');
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return refuse('site-not-allowed');
  if (isControlPortUrl(url, environment.controlPorts)) return refuse('control-port');
  if (!policy) {
    const fromLocalPage = siteClass(request.referrer ?? '', [], { controlPorts: environment.controlPorts }) === 'local';
    return isLocalHostName(parsed.hostname) && fromLocalPage ? PASS : refuse('site-not-allowed');
  }
  const top = resourceType === 'mainFrame';
  if (isLocalHostName(parsed.hostname)) return policy.topExternal && !top ? refuse('site-not-allowed') : PASS;
  // Before the resolver: a clean answer now says nothing about the address it answered from before.
  if (!(top && policy.personNavigating) && policy.suspectOrigins.has(originOf(url))) return refuse('rebind-suspected');

  let addresses: readonly string[];
  try {
    addresses = await environment.resolve(hostForResolver(parsed.hostname));
  } catch {
    return refuse('unresolved');
  }
  if (addresses.length === 0) return refuse('unresolved');
  if (!addresses.every(isPublicAddress)) return refuse('rebind-suspected');

  if (!policy.guarded || (!top && resourceType !== 'subFrame')) return PASS;
  if (siteClass(url, policy.allowedOrigins) !== 'external') return PASS;
  if (top ? policy.personNavigating : sameOrigin(url, policy.topUrl)) return PASS;
  return refuse('site-not-allowed');
}

/** Where a top page may go at all. `about:` here is what a page makes of itself; the rest of `about:` is the browser's. */
const TOP_PAGE = /^(?:https?:|file:|blob:|about:blank$|about:srcdoc$)/iu;

/**
 * Whether a view's own navigation hooks stop this navigation, and why. These run first: a stopped navigation leaves the
 * page where it was, where a cancelled request would commit an error page at the banned URL. `personMade` is the only
 * exception, and only for a top page: the page then stays unread by the AI because its class says so. A suspect site is
 * refused on any pane, guarded or not: it is the site that is in doubt, not who is at the page.
 */
export function navigationRefusal(
  url: string,
  frame: 'top' | 'sub',
  policy: BrowserViewPolicy,
  controlPorts: ReadonlySet<number>,
  personMade: boolean,
): 'site-not-allowed' | 'rebind-suspected' | undefined {
  if (frame === 'top' && !TOP_PAGE.test(url)) return 'site-not-allowed';
  if (isControlPortUrl(url, controlPorts)) return 'site-not-allowed';
  if (/^file:/iu.test(url) && !fileInsideRoots(url, policy.roots)) return 'site-not-allowed';
  if (!(frame === 'top' && personMade) && policy.suspectOrigins.has(originOf(url))) return 'rebind-suspected';
  if (!policy.guarded) return undefined;
  if (siteClass(url, policy.allowedOrigins, { creator: policy.topUrl, controlPorts }) !== 'external') return undefined;
  return (frame === 'top' ? personMade : sameOrigin(url, policy.topUrl)) ? undefined : 'site-not-allowed';
}

/** The part of a session the guards use, so the tests can hold one. */
export interface BrowserPartitionSession {
  readonly webRequest: Pick<Electron.WebRequest, 'onBeforeRequest' | 'onResponseStarted'>;
  resolveHost: Electron.Session['resolveHost'];
  setPermissionRequestHandler: Electron.Session['setPermissionRequestHandler'];
  setPermissionCheckHandler: Electron.Session['setPermissionCheckHandler'];
  setDevicePermissionHandler: Electron.Session['setDevicePermissionHandler'];
  setDisplayMediaRequestHandler: Electron.Session['setDisplayMediaRequestHandler'];
  setBluetoothPairingHandler: Electron.Session['setBluetoothPairingHandler'];
  on(event: 'will-download', listener: (event: Electron.Event, item: Electron.DownloadItem, webContents: Electron.WebContents) => void): unknown;
  on(event: 'select-hid-device', listener: (event: Electron.Event, details: unknown, callback: () => void) => void): unknown;
  on(event: 'select-usb-device', listener: (event: Electron.Event, details: unknown, callback: () => void) => void): unknown;
  on(event: 'select-serial-port', listener: (event: Electron.Event, portList: unknown, webContents: unknown, callback: (portId: string) => void) => void): unknown;
}

export interface BrowserNetworkGuardHost {
  policyFor(webContentsId: number | undefined): BrowserViewPolicy | undefined;
  /** The app's own listening ports, read per request: some open later. */
  controlPorts(): ReadonlySet<number>;
  onBlocked(webContentsId: number | undefined, blocked: { readonly url: string; readonly resourceType: string; readonly reason: BrowserRequestReason }): void;
  /** A response arrived from where this site must not be: the second layer. No pane need own it. */
  onRebind(webContentsId: number | undefined, origin: string): void;
  /** A page of the person's is on its way: the one road to a suspect site, and it opens before anything of that page can ask. */
  onPersonNavigation(webContentsId: number | undefined, url: string): void;
  onDownloadBlocked(webContentsId: number, url: string): void;
}

const guarded = new WeakSet<BrowserPartitionSession>();

/** Set once on the partition; everything a page could ask for is refused here, whichever pane asks. */
export function installBrowserPartitionGuards(session: BrowserPartitionSession, host: BrowserNetworkGuardHost): void {
  if (guarded.has(session)) return;
  guarded.add(session);

  // Handlers that default to "ask the person" or "grant" do neither here. This also stops `mailto:` (the `openExternal` permission).
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
  session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  session.setBluetoothPairingHandler((_details, callback) => callback({ confirmed: false }));
  session.on('select-hid-device', (event, _details, callback) => { event.preventDefault(); callback(); });
  session.on('select-usb-device', (event, _details, callback) => { event.preventDefault(); callback(); });
  session.on('select-serial-port', (event, _ports, _contents, callback) => { event.preventDefault(); callback(''); });
  session.on('will-download', (event, item, contents) => {
    event.preventDefault();
    host.onDownloadBlocked(contents.id, item.getURL());
  });

  const resolve = async (name: string): Promise<readonly string[]> => (await session.resolveHost(name)).endpoints.map((endpoint) => endpoint.address);
  session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const { url, resourceType, webContentsId, referrer } = details;
    void (async () => {
      const policy = host.policyFor(webContentsId);
      const verdict = await requestVerdict({ url, resourceType, referrer }, policy, { controlPorts: host.controlPorts(), resolve });
      if (verdict.cancel) host.onBlocked(webContentsId, { url, resourceType, reason: verdict.reason });
      else if (resourceType === 'mainFrame' && policy?.personNavigating) host.onPersonNavigation(webContentsId, url);
      return verdict.cancel;
    })().then((cancel) => callback(cancel ? { cancel: true } : {}), () => callback({ cancel: true }));
  });
  session.webRequest.onResponseStarted({ urls: ['<all_urls>'] }, (details) => {
    // `ip` is on this event at runtime (measured) though Electron's types leave it out.
    const { url, ip, fromCache, webContentsId } = details as typeof details & { readonly ip?: string };
    if (!ip || fromCache) return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || isLocalHostName(parsed.hostname) || isPublicAddress(ip)) return;
    host.onRebind(webContentsId, parsed.origin);
  });
}
