/**
 * OpenClawProxy — mobile-only reverse proxy tunnel to the local OpenClaw
 * gateway's Control UI (openclaw-management M4/M5 — architecture decision
 * (b)). Plain `node:http` (no framework); WS upgrades are spliced as raw
 * sockets, never parsed as WS frames — the M0 Stage-0 spike (docs/research/
 * 2026-07-12-openclaw-stage0.md ③) confirmed this minimal approach is
 * sufficient: the gateway does not reject on Origin at the HTTP/WS-upgrade
 * layer for a loopback/token-auth install, so no Origin-allowlist logic is
 * needed here — the ticket+cookie flow below is the sole control point.
 *
 * Auth flow: a phone that already authenticated to the mobile WS bridge
 * (remote-bridge.ts) asks it for a chat ticket (`openclaw-chat-ticket` — see
 * remote-protocol.ts); main mints one via `mintTicket()` here (random 32
 * bytes, hex-encoded, 60s TTL, single-redemption). The phone's WebView then
 * loads `http://<host>:<proxyPort>/?t=<ticket>#token=<gatewayToken>` — the
 * `#token=` fragment never reaches this server (browsers never send
 * fragments to the server), so the real gateway auth token only ever exists
 * client-side, consumed by the Control UI's own SPA over its WS RPC
 * `connect`. This server only cares about the ticket: on a valid redemption
 * it mints an HttpOnly session cookie and 302-redirects to the clean URL
 * (dropping `?t=...`) — the browser retains the ORIGINAL fragment across
 * that redirect automatically (this server never writes one into
 * `Location`). Every subsequent request/WS upgrade is authorized by that
 * cookie alone, checked with `timingSafeEqual` (never a plain `===`/
 * `Set.has`), same discipline as remote-bridge.ts's `tokensMatch`.
 *
 * Three header rewrites (spike-confirmed sufficient, no others needed):
 * drop `X-Frame-Options` entirely, rewrite ONLY the `frame-ancestors` CSP
 * directive (every other directive — `script-src` hashes, `connect-src`,
 * etc. — passes through byte-identical), and rewrite the outbound `Host`
 * header to the upstream loopback origin.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net, { type Socket } from 'node:net';

export const DEFAULT_OPENCLAW_PROXY_PORT = 7421;

const TICKET_BYTES = 32;
const SESSION_BYTES = 32;
const TICKET_TTL_MS = 60_000;
const TICKET_SWEEP_INTERVAL_MS = 30_000;
/** Mirrors remote-bridge.ts's `MAX_REMOTE_CONNECTIONS` — bounds a socket
 * flood the same way, at the TCP layer (covers both plain HTTP and
 * upgraded/piped WS sockets, which share the same underlying connection). */
const MAX_OPENCLAW_PROXY_CONNECTIONS = 64;
/** Mirrors remote-bridge.ts's `AUTH_DEADLINE_MS` intent: fail fast on a
 * slow/incomplete request rather than holding a connection slot open. */
const PROXY_HEADERS_TIMEOUT_MS = 10_000;
/** Idle timeout for an established WS tunnel (chat/log streams can go quiet
 * between messages without being dead) — bounds a half-open tunnel. */
const PROXY_TUNNEL_IDLE_TIMEOUT_MS = 10 * 60_000;
const SESSION_COOKIE_NAME = 'ez_openclaw_session';

export interface OpenClawProxyOptions {
  /** Listen port — pass `0` for an OS-assigned ephemeral port (tests). */
  readonly port: number;
  /** The real gateway's origin, e.g. `http://127.0.0.1:18789`. */
  readonly upstreamOrigin: string;
  /** Test seam: defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface OpenClawProxyHandle {
  /** The actual bound port (equals `options.port` unless it was `0`). */
  readonly port: number;
  /** Mint a fresh, single-use, 60s-TTL ticket — see the module doc's auth flow. */
  mintTicket(): string;
  /** Closes the listener and terminates every open connection (including
   * live WS tunnels) — resolves once the port is released. Never touches
   * the upstream gateway. */
  stop(): Promise<void>;
}

// ── Small pure helpers (exported for direct unit testing) ───────────────────

/** Rewrites ONLY the `frame-ancestors` directive of a CSP header value,
 * leaving every other directive byte-identical — see the module doc. */
export function rewriteFrameAncestors(csp: string, allowedOrigin: string): string {
  const directives = csp
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
  const rewritten = directives.map((d) =>
    /^frame-ancestors\b/i.test(d) ? `frame-ancestors 'self' ${allowedOrigin}` : d,
  );
  return rewritten.join('; ');
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    const rawValue = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(rawValue);
    } catch {
      out[key] = rawValue;
    }
  }
  return out;
}

/** Constant-time "is `candidate` a member of `values`" — every comparison
 * runs through `timingSafeEqual` (never a plain `===`/`Set.has`), and the
 * loop never short-circuits on a match, so total response time doesn't leak
 * which (if any) stored value matched. `expectedBytes` is the decoded byte
 * length every valid hex-encoded value must have. */
function constantTimeMember(values: Iterable<string>, candidate: string | undefined, expectedBytes: number): boolean {
  if (!candidate || candidate.length !== expectedBytes * 2) return false;
  let candidateBuf: Buffer;
  try {
    candidateBuf = Buffer.from(candidate, 'hex');
  } catch {
    return false;
  }
  if (candidateBuf.length !== expectedBytes) return false;
  let found = false;
  for (const value of values) {
    const valueBuf = Buffer.from(value, 'hex');
    if (valueBuf.length === candidateBuf.length && timingSafeEqual(candidateBuf, valueBuf)) found = true;
  }
  return found;
}

// ── Proxy server ──────────────────────────────────────────────────────────

export function startOpenClawProxy(options: OpenClawProxyOptions): Promise<OpenClawProxyHandle> {
  const now = options.now ?? Date.now;
  const upstream = new URL(options.upstreamOrigin);

  const tickets = new Map<string, { readonly expiresAt: number }>();
  const sessions = new Set<string>();
  /** Inbound sockets (phone/browser -> this proxy), tracked via the server's
   * own 'connection' event — used for the connection cap AND `stop()`. */
  const activeSockets = new Set<Socket>();
  /** Outbound sockets (this proxy -> the gateway) opened per WS upgrade —
   * see `handleUpgrade`'s comment for why `stop()` must also destroy these. */
  const upstreamSockets = new Set<Socket>();
  let resolvedPort = options.port;

  /** Single-use: deletes the ticket on ANY redemption attempt (valid or
   * not), so a reused ticket always fails the same way an unknown one does
   * — the caller can't distinguish "expired" from "already used". */
  const redeemTicket = (candidate: string | undefined): boolean => {
    if (!candidate || candidate.length !== TICKET_BYTES * 2) return false;
    let candidateBuf: Buffer;
    try {
      candidateBuf = Buffer.from(candidate, 'hex');
    } catch {
      return false;
    }
    if (candidateBuf.length !== TICKET_BYTES) return false;
    for (const [ticket, record] of tickets) {
      const ticketBuf = Buffer.from(ticket, 'hex');
      if (ticketBuf.length === candidateBuf.length && timingSafeEqual(candidateBuf, ticketBuf)) {
        tickets.delete(ticket);
        return record.expiresAt >= now();
      }
    }
    return false;
  };

  const isValidSession = (candidate: string | undefined): boolean =>
    constantTimeMember(sessions, candidate, SESSION_BYTES);

  const handleRequest = (req: IncomingMessage, res: ServerResponse): void => {
    const parsedUrl = new URL(req.url ?? '/', 'http://proxy.local');
    const ticket = parsedUrl.searchParams.get('t');

    if (ticket !== null) {
      if (!redeemTicket(ticket)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('ticket invalid or expired');
        return;
      }
      const session = randomBytes(SESSION_BYTES).toString('hex');
      sessions.add(session);
      parsedUrl.searchParams.delete('t');
      const location = parsedUrl.pathname + parsedUrl.search;
      res.writeHead(302, {
        'set-cookie': `${SESSION_COOKIE_NAME}=${session}; HttpOnly; Path=/; SameSite=Lax`,
        location,
      });
      res.end();
      return;
    }

    const cookies = parseCookies(req.headers.cookie);
    if (!isValidSession(cookies[SESSION_COOKIE_NAME])) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('unauthorized');
      return;
    }

    const outHeaders: http.OutgoingHttpHeaders = { ...req.headers };
    delete outHeaders.host;
    outHeaders.host = upstream.host;

    const proxyReq = http.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers: outHeaders,
      },
      (upstreamRes) => {
        const responseHeaders: http.OutgoingHttpHeaders = { ...upstreamRes.headers };
        delete responseHeaders['x-frame-options'];
        const csp = responseHeaders['content-security-policy'];
        if (typeof csp === 'string') {
          responseHeaders['content-security-policy'] = rewriteFrameAncestors(csp, `http://127.0.0.1:${resolvedPort}`);
        }
        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
        upstreamRes.pipe(res);
      },
    );
    proxyReq.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end();
    });
    req.pipe(proxyReq);
  };

  const handleUpgrade = (req: IncomingMessage, clientSocket: Socket, head: Buffer): void => {
    const cookies = parseCookies(req.headers.cookie);
    if (!isValidSession(cookies[SESSION_COOKIE_NAME])) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    const upstreamSocket = net.connect(Number(upstream.port), upstream.hostname, () => {
      const outHeaders: Record<string, string | string[]> = { ...req.headers, host: upstream.host } as Record<
        string,
        string | string[]
      >;
      const headerLines = Object.entries(outHeaders)
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
        .join('\r\n');
      upstreamSocket.write(`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1\r\n${headerLines}\r\n\r\n`);
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
    // Tracked separately from `activeSockets` (which only covers INBOUND
    // connections via the server's own 'connection' event) — `stop()` must
    // destroy these too: `.pipe()` only auto-`.end()`s its destination on a
    // graceful 'end' from the source, never on an abrupt `.destroy()`, so a
    // destroyed `clientSocket` alone would leave this outbound half dangling
    // (and, in a test, block the fake upstream's own `server.close()`).
    upstreamSockets.add(upstreamSocket);
    upstreamSocket.once('close', () => upstreamSockets.delete(upstreamSocket));
    upstreamSocket.setTimeout(PROXY_TUNNEL_IDLE_TIMEOUT_MS, () => upstreamSocket.destroy());
    clientSocket.setTimeout(PROXY_TUNNEL_IDLE_TIMEOUT_MS, () => clientSocket.destroy());
    upstreamSocket.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstreamSocket.destroy());
  };

  const server = http.createServer(handleRequest);
  server.headersTimeout = PROXY_HEADERS_TIMEOUT_MS;
  server.on('upgrade', handleUpgrade);
  server.on('connection', (socket) => {
    activeSockets.add(socket);
    socket.once('close', () => activeSockets.delete(socket));
    // Refuse beyond the connection cap so a socket flood can't exhaust main
    // (mirrors remote-bridge.ts's MAX_REMOTE_CONNECTIONS gate).
    if (activeSockets.size > MAX_OPENCLAW_PROXY_CONNECTIONS) socket.destroy();
  });

  const sweepTimer = setInterval(() => {
    const t = now();
    for (const [ticket, record] of tickets) {
      if (record.expiresAt < t) tickets.delete(ticket);
    }
  }, TICKET_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  return new Promise((resolve, reject) => {
    let settled = false;
    // A bind failure (e.g. EADDRINUSE) must reject the initial promise; any
    // LATER error (post-listen) must not crash main — log instead.
    server.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearInterval(sweepTimer);
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      console.error('[openclaw-proxy] server error:', err);
    });
    server.listen(options.port, '0.0.0.0', () => {
      settled = true;
      const address = server.address();
      resolvedPort = typeof address === 'object' && address ? address.port : options.port;
      resolve({
        port: resolvedPort,
        mintTicket: () => {
          const ticket = randomBytes(TICKET_BYTES).toString('hex');
          tickets.set(ticket, { expiresAt: now() + TICKET_TTL_MS });
          return ticket;
        },
        stop: () =>
          new Promise((res) => {
            clearInterval(sweepTimer);
            for (const socket of activeSockets) socket.destroy();
            for (const socket of upstreamSockets) socket.destroy();
            server.close(() => res());
          }),
      });
    });
  });
}
