import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { rewriteFrameAncestors, startOpenClawProxy, type OpenClawProxyHandle } from './openclaw-proxy';

const CSP_BASELINE =
  "default-src 'self'; script-src 'self' 'sha256-abc123'; style-src 'self'; connect-src 'self' ws: wss: https://api.openai.com; frame-ancestors 'none'";

/** Real `node:http` server + `ws` server standing in for the OpenClaw
 * gateway — mirrors the M0 spike's control baseline (X-Frame-Options: DENY,
 * CSP frame-ancestors 'none', every other directive present). Never the
 * real gateway (127.0.0.1:18789) — always an ephemeral local port. */
interface FakeUpstream {
  readonly origin: string;
  readonly server: http.Server;
  readonly wss: WebSocketServer;
  readonly lastRequest: { method?: string; url?: string; headers?: http.IncomingHttpHeaders } | null;
}

function startFakeUpstream(): Promise<FakeUpstream> {
  return new Promise((resolve) => {
    const state: { lastRequest: FakeUpstream['lastRequest'] } = { lastRequest: null };
    const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
      state.lastRequest = { method: req.method, url: req.url, headers: req.headers };
      res.writeHead(200, {
        'x-frame-options': 'DENY',
        'content-security-policy': CSP_BASELINE,
        'content-type': 'text/html',
      });
      res.end('<title>OpenClaw Control</title>');
    });
    const wss = new WebSocketServer({ server });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => ws.send(`echo:${data.toString()}`));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      // `lastRequest` is a live getter over `state` (mutated by the request
      // handler above), not a value snapshot taken here at bind time.
      resolve({
        origin: `http://127.0.0.1:${port}`,
        server,
        wss,
        get lastRequest() {
          return state.lastRequest;
        },
      });
    });
  });
}

/** Minimal HTTP client that never follows redirects (so 302s are directly
 * assertable) and never throws on a non-2xx status. */
function rawGet(
  origin: string,
  path: string,
  headers: http.OutgoingHttpHeaders = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${origin}${path}`, { headers }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function extractCookie(setCookieHeader: string | string[] | undefined): string | null {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) return null;
  return raw.split(';')[0] ?? null;
}

describe('openclaw-proxy — ticket redemption + cookie auth', () => {
  let upstream: Awaited<ReturnType<typeof startFakeUpstream>>;
  let proxy: OpenClawProxyHandle;

  afterEach(async () => {
    await proxy?.stop();
    upstream?.wss.close();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  });

  it('redeems a valid ticket: sets an HttpOnly cookie and 302-redirects to the clean URL', async () => {
    upstream = await startFakeUpstream();
    proxy = await startOpenClawProxy({ port: 0, upstreamOrigin: upstream.origin });
    const ticket = proxy.mintTicket();

    const res = await rawGet(`http://127.0.0.1:${proxy.port}`, `/?t=${ticket}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    const cookie = extractCookie(res.headers['set-cookie']);
    expect(cookie).toBeTruthy();
    expect(res.headers['set-cookie']?.toString()).toMatch(/HttpOnly/i);
  });

  it('the minted session cookie authorizes a subsequent request: 200 with forwarded body', async () => {
    upstream = await startFakeUpstream();
    proxy = await startOpenClawProxy({ port: 0, upstreamOrigin: upstream.origin });
    const ticket = proxy.mintTicket();
    const redemption = await rawGet(`http://127.0.0.1:${proxy.port}`, `/?t=${ticket}`);
    const cookie = extractCookie(redemption.headers['set-cookie']);

    const res = await rawGet(`http://127.0.0.1:${proxy.port}`, '/', { cookie: cookie ?? '' });
    expect(res.status).toBe(200);
    expect(res.body).toContain('OpenClaw Control');
  });

  it('an unrecognized ticket is rejected with 403', async () => {
    upstream = await startFakeUpstream();
    proxy = await startOpenClawProxy({ port: 0, upstreamOrigin: upstream.origin });

    const res = await rawGet(`http://127.0.0.1:${proxy.port}`, '/?t=' + 'ab'.repeat(32));
    expect(res.status).toBe(403);
  });

  it('an expired ticket is rejected with 403', async () => {
    upstream = await startFakeUpstream();
    let currentTime = 1_000_000;
    proxy = await startOpenClawProxy({ port: 0, upstreamOrigin: upstream.origin, now: () => currentTime });
    const ticket = proxy.mintTicket();
    currentTime += 60_001; // past the 60s TTL

    const res = await rawGet(`http://127.0.0.1:${proxy.port}`, `/?t=${ticket}`);
    expect(res.status).toBe(403);
  });

  it('a reused (already-redeemed) ticket is rejected with 403 on the second attempt', async () => {
    upstream = await startFakeUpstream();
    proxy = await startOpenClawProxy({ port: 0, upstreamOrigin: upstream.origin });
    const ticket = proxy.mintTicket();

    const first = await rawGet(`http://127.0.0.1:${proxy.port}`, `/?t=${ticket}`);
    expect(first.status).toBe(302);

    const second = await rawGet(`http://127.0.0.1:${proxy.port}`, `/?t=${ticket}`);
    expect(second.status).toBe(403);
  });

  it('a request with no cookie and no ticket is rejected with 403', async () => {
    upstream = await startFakeUpstream();
    proxy = await startOpenClawProxy({ port: 0, upstreamOrigin: upstream.origin });

    const res = await rawGet(`http://127.0.0.1:${proxy.port}`, '/');
    expect(res.status).toBe(403);
  });

  it('a garbage cookie value is rejected with 403 (not a crash)', async () => {
    upstream = await startFakeUpstream();
    proxy = await startOpenClawProxy({ port: 0, upstreamOrigin: upstream.origin });

    const res = await rawGet(`http://127.0.0.1:${proxy.port}`, '/', { cookie: 'ez_openclaw_session=not-a-real-session' });
    expect(res.status).toBe(403);
  });
});

describe('openclaw-proxy — header rewrites (M0 spike parity)', () => {
  let upstream: Awaited<ReturnType<typeof startFakeUpstream>>;
  let proxy: OpenClawProxyHandle;

  afterEach(async () => {
    await proxy?.stop();
    upstream?.wss.close();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  });

  it('strips X-Frame-Options and rewrites ONLY frame-ancestors, leaving every other CSP directive byte-identical', async () => {
    upstream = await startFakeUpstream();
    proxy = await startOpenClawProxy({ port: 0, upstreamOrigin: upstream.origin });
    const ticket = proxy.mintTicket();
    const redemption = await rawGet(`http://127.0.0.1:${proxy.port}`, `/?t=${ticket}`);
    const cookie = extractCookie(redemption.headers['set-cookie']);

    const res = await rawGet(`http://127.0.0.1:${proxy.port}`, '/', { cookie: cookie ?? '' });
    expect(res.headers['x-frame-options']).toBeUndefined();

    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain(`frame-ancestors 'self' http://127.0.0.1:${proxy.port}`);
    expect(csp).not.toContain("frame-ancestors 'none'");
    // Every OTHER directive from the baseline survives byte-identical.
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'sha256-abc123'");
    expect(csp).toContain('connect-src \'self\' ws: wss: https://api.openai.com');
  });

  it('rewrites the outbound Host header to the upstream loopback origin', async () => {
    upstream = await startFakeUpstream();
    proxy = await startOpenClawProxy({ port: 0, upstreamOrigin: upstream.origin });
    const ticket = proxy.mintTicket();
    const redemption = await rawGet(`http://127.0.0.1:${proxy.port}`, `/?t=${ticket}`);
    const cookie = extractCookie(redemption.headers['set-cookie']);

    await rawGet(`http://127.0.0.1:${proxy.port}`, '/', { cookie: cookie ?? '' });
    expect(upstream.lastRequest?.headers?.host).toBe(new URL(upstream.origin).host);
  });
});

describe('rewriteFrameAncestors (pure helper)', () => {
  it('replaces a frame-ancestors directive anywhere in the list, preserving directive order otherwise', () => {
    const csp = "default-src 'self'; frame-ancestors 'none'; style-src 'self'";
    const out = rewriteFrameAncestors(csp, 'http://127.0.0.1:7421');
    expect(out).toBe("default-src 'self'; frame-ancestors 'self' http://127.0.0.1:7421; style-src 'self'");
  });

  it('is a no-op (aside from whitespace normalization) when no frame-ancestors directive is present', () => {
    const csp = "default-src 'self'; style-src 'self'";
    const out = rewriteFrameAncestors(csp, 'http://127.0.0.1:7421');
    expect(out).toBe("default-src 'self'; style-src 'self'");
  });
});

describe('openclaw-proxy — WS upgrade raw pipe', () => {
  let upstream: Awaited<ReturnType<typeof startFakeUpstream>>;
  let proxy: OpenClawProxyHandle;

  afterEach(async () => {
    await proxy?.stop();
    upstream?.wss.close();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  });

  it('pipes a WS upgrade end-to-end through the proxy once a valid session cookie is presented', async () => {
    upstream = await startFakeUpstream();
    proxy = await startOpenClawProxy({ port: 0, upstreamOrigin: upstream.origin });
    const ticket = proxy.mintTicket();
    const redemption = await rawGet(`http://127.0.0.1:${proxy.port}`, `/?t=${ticket}`);
    const cookie = extractCookie(redemption.headers['set-cookie']);

    const echoed = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/`, { headers: { cookie: cookie ?? '' } });
      ws.on('open', () => ws.send('hello'));
      ws.on('message', (data) => {
        resolve(data.toString());
        ws.close();
      });
      ws.on('error', reject);
    });
    expect(echoed).toBe('echo:hello');
  });

  it('rejects a WS upgrade with no valid session cookie', async () => {
    upstream = await startFakeUpstream();
    proxy = await startOpenClawProxy({ port: 0, upstreamOrigin: upstream.origin });

    const failed = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/`);
      ws.on('open', () => resolve(false));
      ws.on('error', () => resolve(true));
      ws.on('unexpected-response', () => resolve(true));
    });
    expect(failed).toBe(true);
  });
});

describe('openclaw-proxy — lifecycle', () => {
  it('stop() closes the listener: an immediate re-bind on the same port succeeds', async () => {
    const upstream = await startFakeUpstream();
    try {
      const proxy = await startOpenClawProxy({ port: 0, upstreamOrigin: upstream.origin });
      const { port } = proxy;
      await proxy.stop();

      const second = await startOpenClawProxy({ port, upstreamOrigin: upstream.origin });
      expect(second.port).toBe(port);
      await second.stop();
    } finally {
      upstream.wss.close();
      await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
    }
  });

  it('stop() terminates an open WS tunnel (its close fires)', async () => {
    const upstream = await startFakeUpstream();
    try {
      const proxy = await startOpenClawProxy({ port: 0, upstreamOrigin: upstream.origin });
      const ticket = proxy.mintTicket();
      const redemption = await rawGet(`http://127.0.0.1:${proxy.port}`, `/?t=${ticket}`);
      const cookie = extractCookie(redemption.headers['set-cookie']);

      const closed = new Promise<void>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/`, { headers: { cookie: cookie ?? '' } });
        ws.on('close', () => resolve());
        ws.on('open', () => {
          void proxy.stop();
        });
      });
      await closed;
    } finally {
      upstream.wss.close();
      await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
    }
  });
});
