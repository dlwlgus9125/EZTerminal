import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  fileInsideRoots,
  installBrowserPartitionGuards,
  isPublicAddress,
  navigationRefusal,
  realRoots,
  requestVerdict,
  type BrowserNetworkGuardHost,
  type BrowserPartitionSession,
  type BrowserViewPolicy,
} from './browser-network-guard';

const PUBLIC = '93.184.216.34';
const CONTROL_PORT = 4100;
const ALLOWED = 'https://staging.cart-kit.example';

function policy(patch: Partial<BrowserViewPolicy> = {}): BrowserViewPolicy {
  return { guarded: true, personNavigating: false, topUrl: 'http://localhost:5173/', topExternal: false, allowedOrigins: [ALLOWED], roots: [], suspectOrigins: new Set(), ...patch };
}

function environment(answers: Readonly<Record<string, readonly string[]>> = {}) {
  return {
    controlPorts: new Set([CONTROL_PORT]),
    resolve: vi.fn(async (host: string) => {
      const addresses = answers[host];
      if (!addresses) throw new Error('net::ERR_NAME_NOT_RESOLVED');
      return addresses;
    }),
  };
}

const request = (url: string, resourceType = 'mainFrame') => ({ url, resourceType });

describe('isPublicAddress: only a global unicast address passes', () => {
  it.each([
    '127.0.0.1', '127.8.8.8', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '0.0.0.0', '100.64.0.1',
    '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::1', '::', 'fc00::1', 'fd12:3456:789a::1', 'fe80::1', 'ff02::1', '2001:db8::1',
    // Spelled as IPv6, the same loopback and LAN, as `session.resolveHost` returns them.
    '::ffff:7f00:1', '::ffff:127.0.0.1', '::ffff:c0a8:1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', '2002:7f00:1::1',
  ])('%s is not public', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([PUBLIC, '8.8.8.8', '172.32.0.1', '11.0.0.1', '2606:4700:4700::1111', '::ffff:5db8:d822'])('%s is public', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each(['', 'localhost', 'not an address', '[::1]', '999.1.1.1', 'fe80::1%eth0'])('fails closed on %j', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
});

describe('requestVerdict: every request, whoever made it', () => {
  it('refuses the app\'s own ports for every resource type, on any page, in a person\'s navigation too', async () => {
    for (const resourceType of ['mainFrame', 'subFrame', 'xhr', 'image', 'script', 'webSocket', 'ping', 'stylesheet', 'other']) {
      const verdict = await requestVerdict(request(`http://127.0.0.1:${String(CONTROL_PORT)}/mcp/x`, resourceType), policy({ personNavigating: true, guarded: false }), environment());
      expect(verdict, resourceType).toEqual({ cancel: true, reason: 'control-port' });
    }
    expect(await requestVerdict(request(`ws://localhost:${String(CONTROL_PORT)}/`, 'webSocket'), policy(), environment())).toEqual({ cancel: true, reason: 'control-port' });
    expect(await requestVerdict(request(`http://localhost:${String(CONTROL_PORT)}/`, 'xhr'), undefined, environment())).toEqual({ cancel: true, reason: 'control-port' });
  });

  it('lets a local page reach local servers without touching DNS', async () => {
    const env = environment();
    expect(await requestVerdict(request('http://localhost:5173/app.js', 'script'), policy(), env)).toEqual({ cancel: false });
    expect(await requestVerdict(request('ws://localhost:5173/hmr', 'webSocket'), policy(), env)).toEqual({ cancel: false });
    expect(env.resolve).not.toHaveBeenCalled();
  });

  it('refuses any request to a local server from an external top page, frames too', async () => {
    const top = policy({ topUrl: 'https://elsewhere.example/', topExternal: true });
    for (const resourceType of ['subFrame', 'xhr', 'image', 'script', 'webSocket', 'ping']) {
      expect(await requestVerdict(request('http://localhost:5173/admin', resourceType), top, environment()), resourceType).toEqual({ cancel: true, reason: 'site-not-allowed' });
    }
  });

  it('lets the top page itself leave an external site for a local one', async () => {
    expect(await requestVerdict(request('http://localhost:5173/'), policy({ topUrl: 'https://elsewhere.example/', topExternal: true }), environment())).toEqual({ cancel: false });
  });

  describe('the frame that asked, which need not be the page the pane shows now', () => {
    const asked = (frame: string | null) => ({ ...request('http://localhost:5173/admin', 'xhr'), frame });

    it('refuses an external page\'s parting request, though the pane has moved to a local page', async () => {
      expect(await requestVerdict(asked('https://elsewhere.example'), policy(), environment())).toEqual({ cancel: true, reason: 'site-not-allowed' });
    });

    it('refuses an external frame in a local page', async () => {
      expect(await requestVerdict(asked('https://evil.example'), policy({ guarded: false }), environment())).toEqual({ cancel: true, reason: 'site-not-allowed' });
    });

    it('takes a frame with no address of its own for the page it sits in', async () => {
      expect(await requestVerdict(asked('about:srcdoc'), policy({ topUrl: 'http://localhost:5173/' }), environment())).toEqual({ cancel: false });
      expect(await requestVerdict(asked('about:srcdoc'), policy({ topUrl: 'https://elsewhere.example/' }), environment())).toEqual({ cancel: true, reason: 'site-not-allowed' });
    });

    it('fails closed on a frame that is gone', async () => {
      expect(await requestVerdict(asked(null), policy(), environment())).toEqual({ cancel: true, reason: 'site-not-allowed' });
    });

    it('lets a local page, a file and an allowed site ask as they did', async () => {
      for (const frame of ['http://localhost:5173', 'file://', ALLOWED]) {
        expect(await requestVerdict(asked(frame), policy(), environment()), frame).toEqual({ cancel: false });
      }
    });

    it('takes no frame for a page\'s own navigation: that is the person leaving', async () => {
      expect(await requestVerdict({ ...request('http://localhost:5173/'), frame: 'https://elsewhere.example' }, policy(), environment())).toEqual({ cancel: false });
    });
  });

  it.each([
    ['a loopback answer', ['127.0.0.1']],
    ['a private answer', ['192.168.77.7']],
    ['a link-local answer', ['169.254.169.254']],
    ['an IPv6 loopback answer', ['::1']],
    ['a mapped loopback answer', ['::ffff:7f00:1']],
    ['one bad address among good ones', [PUBLIC, '127.0.0.1']],
  ])('cancels %s for an allowed host, before the connection', async (_name, answer) => {
    const env = environment({ 'staging.cart-kit.example': answer });
    for (const resourceType of ['mainFrame', 'subFrame', 'xhr', 'image', 'webSocket']) {
      expect(await requestVerdict(request(`${ALLOWED}/`, resourceType), policy(), env), resourceType).toEqual({ cancel: true, reason: 'rebind-suspected' });
    }
  });

  it('cancels the same answers for an external host, with the person at the wheel too', async () => {
    const env = environment({ 'rebind.example': ['127.0.0.1'] });
    const verdict = await requestVerdict(request('http://rebind.example/'), policy({ guarded: false, personNavigating: true }), env);
    expect(verdict).toEqual({ cancel: true, reason: 'rebind-suspected' });
  });

  it('unwraps an IPv6 literal before resolving it: the resolver refuses the bracketed form', async () => {
    const env = environment({ 'fd00::1': ['fd00::1'] });
    expect(await requestVerdict(request('http://[fd00::1]/'), policy(), env)).toEqual({ cancel: true, reason: 'rebind-suspected' });
    expect(env.resolve).toHaveBeenCalledWith('fd00::1');
  });

  it('fails closed when a name does not resolve', async () => {
    expect(await requestVerdict(request(`${ALLOWED}/`), policy(), environment())).toEqual({ cancel: true, reason: 'unresolved' });
  });

  it('lets an allowed host answering from public space through', async () => {
    expect(await requestVerdict(request(`${ALLOWED}/cart`), policy(), environment({ 'staging.cart-kit.example': [PUBLIC] }))).toEqual({ cancel: false });
  });

  describe('frames and top pages, once the AI has driven the pane', () => {
    const env = () => environment({ 'evil.example': [PUBLIC], 'staging.cart-kit.example': [PUBLIC] });

    it('stops an external page and an external frame', async () => {
      expect(await requestVerdict(request('http://evil.example/'), policy(), env())).toEqual({ cancel: true, reason: 'site-not-allowed' });
      expect(await requestVerdict(request('http://evil.example/', 'subFrame'), policy(), env())).toEqual({ cancel: true, reason: 'site-not-allowed' });
    });

    it('lets what a page pulls in through: a local app may use a CDN', async () => {
      for (const resourceType of ['image', 'script', 'stylesheet', 'xhr']) {
        expect(await requestVerdict(request('http://evil.example/lib.js', resourceType), policy(), env()), resourceType).toEqual({ cancel: false });
      }
    });

    it('keeps stopping after 중지 and after the turn: a guarded pane has no off', async () => {
      // `guarded` is the only input: nothing about a tool or a turn reaches this decision.
      const stopped = policy({ guarded: true, personNavigating: false });
      expect(await requestVerdict(request('http://evil.example/late'), stopped, env())).toEqual({ cancel: true, reason: 'site-not-allowed' });
    });

    it('excepts a navigation the person made', async () => {
      expect(await requestVerdict(request('http://evil.example/'), policy({ personNavigating: true }), env())).toEqual({ cancel: false });
    });

    it('does not extend the person\'s navigation to a frame', async () => {
      expect(await requestVerdict(request('http://evil.example/', 'subFrame'), policy({ personNavigating: true }), env())).toEqual({ cancel: true, reason: 'site-not-allowed' });
    });

    it('keeps a page the person went to whole: its own frames load', async () => {
      const top = policy({ topUrl: 'https://elsewhere.example/', topExternal: true });
      const env2 = environment({ 'elsewhere.example': [PUBLIC], 'evil.example': [PUBLIC] });
      expect(await requestVerdict(request('https://elsewhere.example/frame', 'subFrame'), top, env2)).toEqual({ cancel: false });
      expect(await requestVerdict(request('http://evil.example/', 'subFrame'), top, env2)).toEqual({ cancel: true, reason: 'site-not-allowed' });
    });

    it('lets an allowed site through', async () => {
      expect(await requestVerdict(request(`${ALLOWED}/`, 'subFrame'), policy(), env())).toEqual({ cancel: false });
    });
  });

  describe('a site that answered from where it must not', () => {
    const suspect = { suspectOrigins: new Set([ALLOWED]) };
    const env = () => environment({ 'staging.cart-kit.example': [PUBLIC] });

    it('is refused as a page and as a frame, however clean its name resolves now', async () => {
      expect(await requestVerdict(request(`${ALLOWED}/`), policy(suspect), env())).toEqual({ cancel: true, reason: 'rebind-suspected' });
      expect(await requestVerdict(request(`${ALLOWED}/`, 'subFrame'), policy(suspect), env())).toEqual({ cancel: true, reason: 'rebind-suspected' });
    });

    it('is refused for every resource type, in a person\'s navigation too', async () => {
      for (const resourceType of ['xhr', 'script', 'stylesheet', 'image', 'font', 'media', 'object', 'ping', 'webSocket', 'other']) {
        for (const patch of [{}, { guarded: false }, { personNavigating: true }]) {
          expect(await requestVerdict(request(`${ALLOWED}/data`, resourceType), policy({ ...suspect, ...patch }), env()), resourceType).toEqual({ cancel: true, reason: 'rebind-suspected' });
        }
      }
    });

    it('is refused over a socket: the origin is the site\'s, whatever the scheme', async () => {
      expect(await requestVerdict(request('wss://staging.cart-kit.example/live', 'webSocket'), policy(suspect), env())).toEqual({ cancel: true, reason: 'rebind-suspected' });
    });

    it('is not asked of the resolver: a clean answer now clears nothing', async () => {
      const resolver = env();
      await requestVerdict(request(`${ALLOWED}/data`, 'xhr'), policy(suspect), resolver);
      expect(resolver.resolve).not.toHaveBeenCalled();
    });

    it('is refused on a pane no AI has driven too', async () => {
      expect(await requestVerdict(request(`${ALLOWED}/`), policy({ ...suspect, guarded: false }), env())).toEqual({ cancel: true, reason: 'rebind-suspected' });
    });

    it('excepts the person\'s own navigation, for the top page only', async () => {
      expect(await requestVerdict(request(`${ALLOWED}/`), policy({ ...suspect, personNavigating: true }), env())).toEqual({ cancel: false });
      expect(await requestVerdict(request(`${ALLOWED}/`, 'subFrame'), policy({ ...suspect, personNavigating: true }), env())).toEqual({ cancel: true, reason: 'rebind-suspected' });
    });

    it('leaves another origin of the same name alone', async () => {
      expect(await requestVerdict(request('https://staging.cart-kit.example:8443/', 'subFrame'), policy({ ...suspect, guarded: false }), env())).toEqual({ cancel: false });
    });
  });

  it('leaves a pane no AI has driven to the person', async () => {
    const env = environment({ 'evil.example': [PUBLIC] });
    expect(await requestVerdict(request('http://evil.example/'), policy({ guarded: false }), env)).toEqual({ cancel: false });
    expect(await requestVerdict(request('http://evil.example/', 'subFrame'), policy({ guarded: false }), env)).toEqual({ cancel: false });
  });

  describe('a request no pane owns: a worker, or a page already gone', () => {
    const fromPage = (url: string, referrer: string) => ({ ...request(url, 'xhr'), referrer });

    it('reaches this PC only when a local page started it', async () => {
      const env = environment();
      expect(await requestVerdict(fromPage('http://localhost:5173/api', 'http://localhost:5173/sw.js'), undefined, env)).toEqual({ cancel: false });
      expect(await requestVerdict(fromPage('http://127.0.0.1:8000/api', 'http://localhost:5173/'), undefined, env)).toEqual({ cancel: false });
    });

    it.each([
      ['no referrer: a blob worker sends none', ''],
      ['an external page', 'https://evil.example/'],
      ['an allowed site: local is for local pages', ALLOWED],
      ['what cannot be read', 'not a url'],
      ['a name that only looks local', 'http://localhost.evil.example/'],
    ])('fails closed on %s', async (_name, referrer) => {
      expect(await requestVerdict(fromPage('http://127.0.0.1:5173/admin', referrer), undefined, environment())).toEqual({ cancel: true, reason: 'site-not-allowed' });
    });

    it('fails closed with no referrer given at all', async () => {
      expect(await requestVerdict(request('http://localhost:5173/admin', 'xhr'), undefined, environment())).toEqual({ cancel: true, reason: 'site-not-allowed' });
    });

    it('reaches nothing else, whoever started it', async () => {
      const env = environment({ 'evil.example': [PUBLIC] });
      expect(await requestVerdict(fromPage('http://evil.example/exfil', 'http://localhost:5173/'), undefined, env)).toEqual({ cancel: true, reason: 'site-not-allowed' });
      expect(await requestVerdict(fromPage('file:///C:/secret.txt', 'http://localhost:5173/'), undefined, env)).toEqual({ cancel: true, reason: 'file-outside' });
    });

    it('never reaches the app\'s own ports from a local page either', async () => {
      const port = String(CONTROL_PORT);
      expect(await requestVerdict(fromPage(`http://localhost:${port}/mcp`, 'http://localhost:5173/'), undefined, environment())).toEqual({ cancel: true, reason: 'control-port' });
      expect(await requestVerdict(fromPage('http://localhost:5173/', `http://localhost:${port}/`), undefined, environment())).toEqual({ cancel: true, reason: 'site-not-allowed' });
    });
  });

  it.each(['ftp://localhost/x', 'chrome-extension://abcdef/x', 'gopher://evil.example/'])('refuses the scheme of %s', async (url) => {
    expect(await requestVerdict(request(url, 'other'), policy(), environment())).toEqual({ cancel: true, reason: 'site-not-allowed' });
  });

  it('refuses what it cannot parse', async () => {
    expect(await requestVerdict(request('http://[bad', 'other'), policy(), environment())).toEqual({ cancel: true, reason: 'site-not-allowed' });
  });
});

describe('navigationRefusal: the view\'s own hooks, first', () => {
  const ports = new Set([CONTROL_PORT]);
  const evil = 'http://evil.example/';

  it('stops an external page and frame on a guarded pane, the person\'s exception aside', () => {
    expect(navigationRefusal(evil, 'top', policy(), ports, false)).toBe('site-not-allowed');
    expect(navigationRefusal(evil, 'top', policy(), ports, true)).toBeUndefined();
    expect(navigationRefusal(evil, 'sub', policy(), ports, false)).toBe('site-not-allowed');
    expect(navigationRefusal(evil, 'sub', policy(), ports, true), 'the exception is for the top page').toBe('site-not-allowed');
  });

  it('lets local, allowed and same-origin navigations through', () => {
    expect(navigationRefusal('http://localhost:5173/other', 'top', policy(), ports, false)).toBeUndefined();
    expect(navigationRefusal(`${ALLOWED}/cart`, 'top', policy(), ports, false)).toBeUndefined();
    expect(navigationRefusal('https://elsewhere.example/frame', 'sub', policy({ topUrl: 'https://elsewhere.example/' }), ports, false)).toBeUndefined();
  });

  it('takes the class of a blob or a blank page from the page that made it', () => {
    expect(navigationRefusal('blob:http://localhost:5173/9e4c', 'top', policy(), ports, false)).toBeUndefined();
    expect(navigationRefusal('about:blank', 'sub', policy(), ports, false)).toBeUndefined();
    expect(navigationRefusal('blob:http://evil.example/9e4c', 'top', policy(), ports, false)).toBe('site-not-allowed');
    expect(navigationRefusal('about:srcdoc', 'sub', policy({ topUrl: 'https://elsewhere.example/' }), ports, false), 'an external page\'s own blank frame is same-origin by class only').toBe('site-not-allowed');
  });

  it('refuses the app\'s own ports and outside files always, for a person and on an unguarded pane', () => {
    const open = policy({ guarded: false });
    expect(navigationRefusal(`http://localhost:${String(CONTROL_PORT)}/`, 'top', open, ports, true)).toBe('site-not-allowed');
    expect(navigationRefusal(`http://localhost:${String(CONTROL_PORT)}/`, 'sub', open, ports, true)).toBe('site-not-allowed');
    expect(navigationRefusal('file:///C:/secret.txt', 'top', open, ports, true)).toBe('site-not-allowed');
  });

  it.each(['javascript:alert(1)', 'data:text/html,hi', 'chrome://settings', 'view-source:http://localhost/', 'about:config'])('never lets a top page be %s', (url) => {
    expect(navigationRefusal(url, 'top', policy({ guarded: false }), ports, true)).toBe('site-not-allowed');
  });

  describe('a site that answered from where it must not', () => {
    const suspect = policy({ suspectOrigins: new Set([ALLOWED]) });

    it('is refused for a page and a frame, though the list still allows it', () => {
      expect(navigationRefusal(`${ALLOWED}/cart`, 'top', suspect, ports, false)).toBe('rebind-suspected');
      expect(navigationRefusal(`${ALLOWED}/cart`, 'sub', suspect, ports, false)).toBe('rebind-suspected');
    });

    it('is refused as a blob made from it', () => {
      expect(navigationRefusal(`blob:${ALLOWED}/9e4c`, 'top', suspect, ports, false)).toBe('rebind-suspected');
    });

    it('is refused on a pane no AI has driven too', () => {
      expect(navigationRefusal(`${ALLOWED}/cart`, 'top', { ...suspect, guarded: false }, ports, false)).toBe('rebind-suspected');
    });

    it('excepts the person\'s own navigation, for the top page only', () => {
      expect(navigationRefusal(`${ALLOWED}/cart`, 'top', suspect, ports, true)).toBeUndefined();
      expect(navigationRefusal(`${ALLOWED}/cart`, 'sub', suspect, ports, true)).toBe('rebind-suspected');
    });

    it('holds for each suspect, not only the latest', () => {
      const two = policy({ suspectOrigins: new Set([ALLOWED, 'https://other.example']) });
      expect(navigationRefusal(`${ALLOWED}/`, 'top', two, ports, false)).toBe('rebind-suspected');
      expect(navigationRefusal('https://other.example/', 'sub', two, ports, false)).toBe('rebind-suspected');
    });
  });

  it('leaves a pane no AI has driven to the person', () => {
    expect(navigationRefusal(evil, 'top', policy({ guarded: false }), ports, false)).toBeUndefined();
    expect(navigationRefusal(evil, 'sub', policy({ guarded: false }), ports, false)).toBeUndefined();
  });
});

describe('file pages: limited for every resource', () => {
  const scratch = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'ez-browser-file-')));
  const workspace = path.join(scratch, 'workspace');
  const outside = path.join(scratch, 'outside');
  mkdirSync(path.join(workspace, 'nested'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(workspace, 'page.html'), 'in');
  writeFileSync(path.join(workspace, 'nested', 'a.css'), 'in');
  writeFileSync(path.join(outside, 'secret.txt'), 'out');
  symlinkSync(outside, path.join(workspace, 'escape'), 'junction');
  writeFileSync(path.join(scratch, 'workspace-sibling.txt'), 'out');
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const roots = realRoots([workspace]);
  const url = (...parts: string[]) => pathToFileURL(path.join(...parts)).href;

  it('passes a file inside the roots', () => {
    expect(fileInsideRoots(url(workspace, 'page.html'), roots)).toBe(true);
    expect(fileInsideRoots(url(workspace, 'nested', 'a.css'), roots)).toBe(true);
  });

  it('refuses a file outside, whichever way it is reached', () => {
    expect(fileInsideRoots(url(outside, 'secret.txt'), roots)).toBe(false);
    expect(fileInsideRoots(url(scratch, 'workspace-sibling.txt'), roots)).toBe(false);
    expect(fileInsideRoots(url(workspace, 'escape', 'secret.txt'), roots), 'a junction out of the folder').toBe(false);
    expect(fileInsideRoots(`${url(workspace)}/nested/../../outside/secret.txt`, roots)).toBe(false);
    expect(fileInsideRoots(`${url(workspace)}/nested/%2e%2e/%2e%2e/outside/secret.txt`, roots)).toBe(false);
  });

  it('fails closed on what it cannot place', () => {
    expect(fileInsideRoots(url(workspace, 'missing.html'), roots)).toBe(false);
    expect(fileInsideRoots(`${url(workspace)}/..%5c..%5coutside%5csecret.txt`, roots)).toBe(false);
    expect(fileInsideRoots('file://server/share/page.html', roots)).toBe(false);
    expect(fileInsideRoots('not a url', roots)).toBe(false);
    expect(fileInsideRoots(url(workspace, 'page.html'), [])).toBe(false);
  });

  it('applies to every resource type, and to a page no AI has driven', async () => {
    const page = policy({ guarded: false, topUrl: url(workspace, 'page.html'), roots });
    for (const resourceType of ['mainFrame', 'subFrame', 'xhr', 'image', 'script', 'stylesheet', 'font', 'media', 'object', 'other']) {
      expect(await requestVerdict(request(url(outside, 'secret.txt'), resourceType), page, environment()), resourceType).toEqual({ cancel: true, reason: 'file-outside' });
      expect(await requestVerdict(request(url(workspace, 'page.html'), resourceType), page, environment()), resourceType).toEqual({ cancel: false });
    }
  });

  it('never lets a network file through', async () => {
    expect(await requestVerdict(request('file://server/share/page.html', 'image'), policy({ roots }), environment())).toEqual({ cancel: true, reason: 'file-outside' });
  });
});

describe('installBrowserPartitionGuards', () => {
  type Listener = (...args: unknown[]) => void;

  function fakeSession(endpoints: Readonly<Record<string, readonly string[]>> = {}) {
    const on = new Map<string, Listener>();
    const session = {
      webRequest: {
        onBeforeRequest: vi.fn(),
        onResponseStarted: vi.fn(),
      },
      resolveHost: vi.fn(async (host: string) => {
        if (!endpoints[host]) throw new Error('net::ERR_NAME_NOT_RESOLVED');
        return { endpoints: endpoints[host].map((address) => ({ address, family: 'ipv4' as const })) };
      }),
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
      setDisplayMediaRequestHandler: vi.fn(),
      setBluetoothPairingHandler: vi.fn(),
      on: vi.fn((event: string, listener: Listener) => { on.set(event, listener); }),
    };
    return { session: session as unknown as BrowserPartitionSession, fake: session, on };
  }

  function host(patch: Partial<BrowserNetworkGuardHost> = {}): BrowserNetworkGuardHost {
    return {
      policyFor: () => policy(),
      controlPorts: () => new Set([CONTROL_PORT]),
      onBlocked: vi.fn(),
      onRebind: vi.fn(),
      onPersonNavigation: vi.fn(),
      onDownloadBlocked: vi.fn(),
      ...patch,
    };
  }

  const before = async (fake: ReturnType<typeof fakeSession>['fake'], details: Record<string, unknown>) => new Promise<{ cancel?: boolean }>((resolve) => {
    const listener = fake.webRequest.onBeforeRequest.mock.calls[0]![1] as (details: unknown, callback: (response: { cancel?: boolean }) => void) => void;
    listener(details, resolve);
  });

  it('installs one listener per webRequest event: Electron keeps only the last', () => {
    const { session, fake } = fakeSession();
    installBrowserPartitionGuards(session, host());
    installBrowserPartitionGuards(session, host());
    expect(fake.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
    expect(fake.webRequest.onResponseStarted).toHaveBeenCalledTimes(1);
    expect(fake.webRequest.onBeforeRequest.mock.calls[0]![0]).toEqual({ urls: ['<all_urls>'] });
    expect(fake.webRequest.onResponseStarted.mock.calls[0]![0]).toEqual({ urls: ['<all_urls>'] });
  });

  it('refuses every permission, device and capture prompt', () => {
    const { session, fake, on } = fakeSession();
    installBrowserPartitionGuards(session, host());
    const request = vi.fn();
    (fake.setPermissionRequestHandler.mock.calls[0]![0] as Listener)(null, 'geolocation', request, {});
    expect(request).toHaveBeenCalledWith(false);
    expect((fake.setPermissionCheckHandler.mock.calls[0]![0] as (...args: unknown[]) => boolean)(null, 'hid', '', {})).toBe(false);
    expect((fake.setDevicePermissionHandler.mock.calls[0]![0] as (...args: unknown[]) => boolean)({ deviceType: 'hid' })).toBe(false);
    expect(fake.setDisplayMediaRequestHandler).toHaveBeenCalledTimes(1);
    const pairing = vi.fn();
    (fake.setBluetoothPairingHandler.mock.calls[0]![0] as Listener)({}, pairing);
    expect(pairing).toHaveBeenCalledWith({ confirmed: false });
    for (const name of ['select-hid-device', 'select-usb-device']) {
      const event = { preventDefault: vi.fn() };
      const choose = vi.fn();
      on.get(name)!(event, {}, choose);
      expect(event.preventDefault, name).toHaveBeenCalled();
      expect(choose, name).toHaveBeenCalledWith();
    }
    const event = { preventDefault: vi.fn() };
    const choose = vi.fn();
    on.get('select-serial-port')!(event, [], null, choose);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(choose).toHaveBeenCalledWith('');
  });

  it('refuses every download and says so', () => {
    const { session, on } = fakeSession();
    const onDownloadBlocked = vi.fn();
    installBrowserPartitionGuards(session, host({ onDownloadBlocked }));
    const event = { preventDefault: vi.fn() };
    on.get('will-download')!(event, { getURL: () => 'http://localhost:5173/thing.bin' }, { id: 7 });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(onDownloadBlocked).toHaveBeenCalledWith(7, 'http://localhost:5173/thing.bin');
  });

  it('resolves through the session, so the check and the connection share a resolver', async () => {
    const { session, fake } = fakeSession({ 'rebind.example': ['127.0.0.1'] });
    const onBlocked = vi.fn();
    installBrowserPartitionGuards(session, host({ onBlocked }));
    const response = await before(fake, { url: 'http://rebind.example/', resourceType: 'mainFrame', webContentsId: 3 });
    expect(response).toEqual({ cancel: true });
    expect(fake.resolveHost).toHaveBeenCalledWith('rebind.example');
    expect(onBlocked).toHaveBeenCalledWith(3, { url: 'http://rebind.example/', resourceType: 'mainFrame', reason: 'rebind-suspected' });
  });

  describe('reads who asked off the requesting frame', () => {
    const local = { url: 'http://localhost:5173/admin', resourceType: 'xhr', webContentsId: 3 };
    const guarded = (): ReturnType<typeof fakeSession> => {
      const made = fakeSession();
      installBrowserPartitionGuards(made.session, host());
      return made;
    };

    it('by origin, even of a frame already detached', async () => {
      expect(await before(guarded().fake, { ...local, frame: { origin: 'https://elsewhere.example', url: 'https://elsewhere.example/page', detached: true } })).toEqual({ cancel: true });
      expect(await before(guarded().fake, { ...local, frame: { origin: 'http://localhost:5173', url: 'http://localhost:5173/' } })).toEqual({});
    });

    it('by address for an opaque origin: a sandboxed external page hides nothing', async () => {
      expect(await before(guarded().fake, { ...local, frame: { origin: 'null', url: 'https://elsewhere.example/page' } })).toEqual({ cancel: true });
    });

    it('as gone when it is null, or when reading it throws', async () => {
      expect(await before(guarded().fake, { ...local, frame: null })).toEqual({ cancel: true });
      expect(await before(guarded().fake, { ...local, frame: { get origin(): string { throw new Error('Render frame was disposed'); } } })).toEqual({ cancel: true });
    });
  });

  it('judges a request no pane owns by the referrer Electron gives it', async () => {
    const { session, fake } = fakeSession();
    installBrowserPartitionGuards(session, host({ policyFor: () => undefined }));
    expect(await before(fake, { url: 'http://localhost:5173/api', resourceType: 'xhr', referrer: 'http://localhost:5173/sw.js' })).toEqual({});
    expect(await before(fake, { url: 'http://localhost:5173/api', resourceType: 'xhr', referrer: '' })).toEqual({ cancel: true });
  });

  it('tells the host a person\'s page is on its way, and only that', async () => {
    const { session, fake } = fakeSession({ 'evil.example': [PUBLIC], 'staging.cart-kit.example': [PUBLIC] });
    const onPersonNavigation = vi.fn();
    installBrowserPartitionGuards(session, host({ policyFor: () => policy({ guarded: false, personNavigating: true }), onPersonNavigation }));
    await before(fake, { url: `${ALLOWED}/cart`, resourceType: 'mainFrame', webContentsId: 3 });
    await before(fake, { url: `${ALLOWED}/frame`, resourceType: 'subFrame', webContentsId: 3 });
    await before(fake, { url: `${ALLOWED}/data`, resourceType: 'xhr', webContentsId: 3 });
    expect(onPersonNavigation.mock.calls).toEqual([[3, `${ALLOWED}/cart`]]);
  });

  it('does not take a page the host refused for a person\'s', async () => {
    const { session, fake } = fakeSession({ 'rebind.example': ['127.0.0.1'] });
    const onPersonNavigation = vi.fn();
    installBrowserPartitionGuards(session, host({ policyFor: () => policy({ personNavigating: true }), onPersonNavigation }));
    await before(fake, { url: 'http://rebind.example/', resourceType: 'mainFrame', webContentsId: 3 });
    expect(onPersonNavigation).not.toHaveBeenCalled();
  });

  it('answers a request once and cancels it if the host throws', async () => {
    const { session, fake } = fakeSession();
    installBrowserPartitionGuards(session, host({ policyFor: () => { throw new Error('gone'); } }));
    expect(await before(fake, { url: 'http://localhost:5173/', resourceType: 'mainFrame', webContentsId: 3 })).toEqual({ cancel: true });
  });

  describe('the second layer: the address the response really came from', () => {
    const started = (fake: ReturnType<typeof fakeSession>['fake'], details: Record<string, unknown>) => {
      (fake.webRequest.onResponseStarted.mock.calls[0]![1] as (details: unknown) => void)(details);
    };

    it('stops a site that answers from this PC or the LAN', () => {
      const { session, fake } = fakeSession();
      const onRebind = vi.fn();
      installBrowserPartitionGuards(session, host({ onRebind }));
      started(fake, { url: `${ALLOWED}/`, ip: '127.0.0.1', fromCache: false, webContentsId: 3, resourceType: 'mainFrame' });
      expect(onRebind).toHaveBeenCalledWith(3, ALLOWED);
    });

    it('leaves a local server, a public answer and a cached response alone', () => {
      const { session, fake } = fakeSession();
      const onRebind = vi.fn();
      installBrowserPartitionGuards(session, host({ onRebind }));
      started(fake, { url: 'http://localhost:5173/', ip: '127.0.0.1', fromCache: false, webContentsId: 3 });
      started(fake, { url: `${ALLOWED}/`, ip: PUBLIC, fromCache: false, webContentsId: 3 });
      started(fake, { url: `${ALLOWED}/`, fromCache: true, webContentsId: 3 });
      expect(onRebind).not.toHaveBeenCalled();
    });
  });
});
