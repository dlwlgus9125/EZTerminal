/**
 * OpenClawProxy — mobile-only reverse proxy tunnel to the local OpenClaw
 * gateway's Control UI (openclaw-management M4/M5 — architecture decision
 * (b)). Plain `node:http` (no framework); WS upgrades are spliced as raw
 * sockets, never parsed as WS frames — the M0 Stage-0 spike (docs/research/
 * 2026-07-12-openclaw-stage0.md ③) confirmed this minimal approach is
 * sufficient for the PIPE itself; two Origin/cookie assumptions from that
 * spike did NOT hold up against a real cross-site embed and were amended
 * after the M5 emulator live gate (see below).
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
 * it mints an HttpOnly session cookie AND records the redeeming request's
 * source IP as authorized (see "M5 amendment ①" below), then 302-redirects
 * to the clean URL (dropping `?t=...`) — the browser retains the ORIGINAL
 * fragment across that redirect automatically (this server never writes one
 * into `Location`). Every subsequent request/WS upgrade is authorized by
 * EITHER the cookie OR the source-IP binding, checked with `timingSafeEqual`
 * for the cookie (never a plain `===`/`Set.has`), same discipline as
 * remote-bridge.ts's `tokensMatch`.
 *
 * M5 amendment ① (source-IP-bound session, `isAuthorizedIp`): the M5
 * emulator live gate (real Android WebView, real OpenClaw gateway) found
 * that `SameSite=Lax` — the cookie's original, sole auth mechanism — is
 * simply never SENT on a cross-site iframe subframe navigation (the mobile
 * app's origin, `http://localhost`, differs from this proxy's LAN origin;
 * Lax cookies are only sent on a cross-site TOP-LEVEL navigation), so the
 * ticket-redemption redirect's own follow-up request arrived cookie-less and
 * was rejected — even though the ticket itself had already been correctly
 * validated and consumed. Binding the redeeming request's source IP
 * (`req.socket.remoteAddress`, not spoofable within a TCP handshake) as a
 * SHORT-lived (`IP_SESSION_TTL_MS`, unlike the cookie's indefinite-until-
 * `stop()` lifetime) parallel authorization covers this: the phone (a single
 * physical device on the LAN/tailnet, already authenticated twice over —
 * once to the mobile WS bridge, once via the single-use ticket itself) keeps
 * making authorized follow-up requests by IP alone, no cookie required. The
 * cookie mechanism is NOT removed — a top-level navigation (the "브라우저로
 * 열기" fallback) still gets and uses one same as before.
 *
 * M5 amendment ② (Origin rewrite to the gateway's own origin): even past
 * amendment ①, the Control UI's own client-side WS RPC `connect` was
 * rejected by the LIVE gateway with "Browser origin not allowed" — the real
 * OpenClaw gateway DOES enforce `gateway.controlUi.allowedOrigins`
 * (contradicting the M0 spike's loopback/token-auth-only assumption above),
 * and this proxy's own LAN-facing origin is never going to be in that
 * allowlist. Since this proxy already terminates and re-originates every
 * forwarded request/WS upgrade, it rewrites the outbound `Origin` header (on
 * BOTH plain HTTP requests and the WS upgrade handshake) to the upstream
 * gateway's OWN origin — from the gateway's perspective the Control UI page
 * it's serving is now presenting the same-origin `Origin` a normal same-host
 * browser tab would. If the gateway's `controlUi.allowedOrigins` doesn't
 * even include its own default origin, this rewrite cannot fix it — that's
 * a gateway-config gap this proxy cannot solve in code (the fix is
 * `openclaw config set gateway.controlUi.allowedOrigins ...` on the
 * machine running the gateway).
 *
 * M5 amendment ③ (frame-ancestors targets the MOBILE APP's origin, not this
 * proxy's own address): a latent bug from the ORIGINAL M4 implementation,
 * only surfaced once amendments ①/② let a request finally reach this far —
 * every earlier attempt died at the auth layer (a plain-text 403 has no CSP
 * header to violate), so this was never observed until the AC5
 * re-verification live gate hit `net::ERR_BLOCKED_BY_RESPONSE` ("Refused to
 * frame ... because an ancestor violates ... frame-ancestors"). The
 * `frame-ancestors` directive lists which ORIGINS ARE ALLOWED TO EMBED this
 * page — that's the Capacitor mobile app's own origin (`http://localhost`,
 * `MOBILE_APP_ORIGIN` below), never this proxy's own listen address (no real
 * page is ever served FROM there to act as an ancestor).
 *
 * Three header rewrites beyond the three amendments above (spike-confirmed
 * sufficient, no others needed): drop `X-Frame-Options` entirely, rewrite
 * ONLY the `frame-ancestors` CSP directive (every other directive —
 * `script-src` hashes, `connect-src`, etc. — passes through byte-identical),
 * and rewrite the outbound `Host` header to the upstream loopback origin.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net, { type Socket } from 'node:net';

export const DEFAULT_OPENCLAW_PROXY_PORT = 7421;

/** The Capacitor mobile app's OWN origin (mobile/capacitor.config.ts's
 * `androidScheme: 'http'`, no hostname override -> `http://localhost`,
 * fixed regardless of the device's actual LAN address/port) — the ONLY page
 * that should ever be allowed to iframe-embed the Control UI through this
 * proxy, so it's the `frame-ancestors` value `rewriteFrameAncestors` adds
 * below. M5 amendment ③ (found by the AC5 re-verification live gate,
 * post amendments ①/②): the ORIGINAL value here was this proxy's OWN
 * `http://127.0.0.1:<proxyPort>` address, which is not an ancestor ANY real
 * page is ever served from — it silently blocked every embed once a request
 * finally got far enough (past amendments ①/②) to receive a real CSP header
 * back to enforce ("Refused to frame ... because an ancestor violates
 * frame-ancestors"), never observed before since every earlier attempt died
 * at the auth layer (a plain-text 403 has no CSP header to violate). */
const MOBILE_APP_ORIGIN = 'http://localhost';

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
const PROXY_UPSTREAM_TIMEOUT_MS = 15_000;
const PROXY_WS_CONNECT_TIMEOUT_MS = 10_000;
/** Idle timeout for an established WS tunnel (chat/log streams can go quiet
 * between messages without being dead) — bounds a half-open tunnel. */
const PROXY_TUNNEL_IDLE_TIMEOUT_MS = 10 * 60_000;
const SESSION_COOKIE_NAME = 'ez_openclaw_session';
/** M5 amendment ① — source-IP-bound session TTL (see module doc). Short and
 * fixed-window from redemption (not sliding), unlike the cookie's
 * indefinite-until-`stop()` lifetime: long enough to cover one page load's
 * asset requests plus a WS reconnect after a network blip (same order of
 * magnitude as `PROXY_TUNNEL_IDLE_TIMEOUT_MS`), short enough that a stale
 * binding doesn't linger — the mobile client re-tickets on every tab
 * activate/reload/retry anyway (MobileOpenClawView.tsx's M5 design). */
const IP_SESSION_TTL_MS = 10 * 60_000;
/** M5/S3 (openclaw-stabilization reliability sweep): the cookie session
 * itself used to never expire at all (a plain `Set<string>` — every ticket
 * redemption added one, forever; unbounded growth). Fixed-window from
 * redemption, same non-sliding shape as `IP_SESSION_TTL_MS` above, but
 * considerably longer: unlike the IP binding (which covers the mobile
 * embed's own follow-up requests), this cookie is what the "브라우저로 열기"
 * TOP-LEVEL-navigation fallback relies on for its whole lifetime, so it
 * should comfortably outlast one browser session rather than expire
 * mid-use — 24h is that margin without being effectively unbounded again. */
const SESSION_TTL_MS = 24 * 60 * 60_000;

export interface OpenClawProxyOptions {
  /** Listen port — pass `0` for an OS-assigned ephemeral port (tests). */
  readonly port: number;
  /** The real gateway's origin, e.g. `http://127.0.0.1:18789`. */
  readonly upstreamOrigin: string;
  /** Test seam: defaults to `Date.now`. */
  readonly now?: () => number;
  /** Test seams; production uses bounded defaults. */
  readonly upstreamTimeoutMs?: number;
  readonly wsConnectTimeoutMs?: number;
}

export interface OpenClawProxyHandle {
  /** The actual bound port (equals `options.port` unless it was `0`). */
  readonly port: number;
  /** Mint a fresh, single-use, 60s-TTL ticket — see the module doc's auth flow. */
  mintTicket(): string;
  /** Retarget future traffic without rebinding the LAN-facing listener. */
  setUpstreamOrigin(origin: string): void;
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

/** Strips the IPv4-mapped-IPv6 prefix (`::ffff:10.0.2.2` -> `10.0.2.2`) so
 * the SAME physical client always binds/matches under one representation —
 * a dual-stack listener (`0.0.0.0`, see `startOpenClawProxy` below) can
 * report either form for the identical IPv4 peer depending on platform.
 * Exported for direct unit testing (same precedent as `rewriteFrameAncestors`
 * above). */
export function normalizeIp(address: string | undefined): string | undefined {
  if (!address) return undefined;
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
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

/** Constant-time "is `candidate` a currently-valid (non-expired) session key
 * of `sessions`" — every comparison runs through `timingSafeEqual` (never a
 * plain `===`/`Map.has`), and the loop never short-circuits on a match, so
 * total response time doesn't leak which (if any) stored value matched.
 * `expectedBytes` is the decoded byte length every valid hex-encoded key
 * must have. M5/S3: `sessions` now carries an expiry (see `SESSION_TTL_MS`'s
 * doc) — a match past its `expiresAt` is treated the same as no match. */
function constantTimeSessionMatch(
  sessions: ReadonlyMap<string, number>,
  candidate: string | undefined,
  expectedBytes: number,
  now: number,
): boolean {
  if (!candidate || candidate.length !== expectedBytes * 2) return false;
  let candidateBuf: Buffer;
  try {
    candidateBuf = Buffer.from(candidate, 'hex');
  } catch {
    return false;
  }
  if (candidateBuf.length !== expectedBytes) return false;
  let matchedExpiry: number | undefined;
  for (const [key, expiresAt] of sessions) {
    const keyBuf = Buffer.from(key, 'hex');
    if (keyBuf.length === candidateBuf.length && timingSafeEqual(candidateBuf, keyBuf)) matchedExpiry = expiresAt;
  }
  return matchedExpiry !== undefined && matchedExpiry >= now;
}

// ── Proxy server ──────────────────────────────────────────────────────────

export function startOpenClawProxy(options: OpenClawProxyOptions): Promise<OpenClawProxyHandle> {
  const now = options.now ?? Date.now;
  const parseUpstream = (origin: string): URL => {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:') throw new Error('OpenClaw proxy upstream must use http');
    return new URL(parsed.origin);
  };
  let upstream = parseUpstream(options.upstreamOrigin);
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? PROXY_UPSTREAM_TIMEOUT_MS;
  const wsConnectTimeoutMs = options.wsConnectTimeoutMs ?? PROXY_WS_CONNECT_TIMEOUT_MS;

  const tickets = new Map<string, { readonly expiresAt: number }>();
  /** M5/S3 — cookie session -> expiresAt (`SESSION_TTL_MS`, fixed-window
   * from redemption); see `SESSION_TTL_MS`'s doc for why this used to be a
   * plain unbounded `Set<string>`. */
  const sessions = new Map<string, number>();
  /** M5 amendment ① — source IP -> expiry, populated on every ticket
   * redemption alongside (never instead of) the cookie session above. */
  const ipSessions = new Map<string, number>();
  /** Inbound sockets (phone/browser -> this proxy), tracked via the server's
   * own 'connection' event — used for the connection cap AND `stop()`. */
  const activeSockets = new Set<Socket>();
  /** Outbound sockets (this proxy -> the gateway) opened per WS upgrade —
   * see `handleUpgrade`'s comment for why `stop()` must also destroy these. */
  const upstreamSockets = new Set<Socket>();
  const upstreamRequests = new Set<http.ClientRequest>();
  let resolvedPort = options.port;

  const setUpstreamOrigin = (origin: string): void => {
    const next = parseUpstream(origin);
    if (next.origin === upstream.origin) return;
    upstream = next;
    tickets.clear();
    sessions.clear();
    ipSessions.clear();
    for (const request of upstreamRequests) request.destroy(new Error('OpenClaw upstream changed'));
    for (const socket of upstreamSockets) socket.destroy();
  };

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
    constantTimeSessionMatch(sessions, candidate, SESSION_BYTES, now());

  /** M5 amendment ① — is `address` a source IP that redeemed a ticket within
   * `IP_SESSION_TTL_MS`? Not `timingSafeEqual`-guarded like the cookie/ticket
   * checks above: an IP address isn't a secret being compared against a
   * stored secret (unlike a session token), so there's no meaningful timing
   * side-channel to close here. */
  const isAuthorizedIp = (address: string | undefined): boolean => {
    const ip = normalizeIp(address);
    if (!ip) return false;
    const expiresAt = ipSessions.get(ip);
    return expiresAt !== undefined && expiresAt >= now();
  };

  /** Combined auth check shared by `handleRequest` and `handleUpgrade` — the
   * cookie session OR the M5 amendment ① IP-bound session, either suffices. */
  const isAuthorized = (req: IncomingMessage): boolean => {
    const cookies = parseCookies(req.headers.cookie);
    if (isValidSession(cookies[SESSION_COOKIE_NAME])) return true;
    return isAuthorizedIp(req.socket.remoteAddress);
  };

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
      sessions.set(session, now() + SESSION_TTL_MS);
      const redeemerIp = normalizeIp(req.socket.remoteAddress);
      if (redeemerIp) ipSessions.set(redeemerIp, now() + IP_SESSION_TTL_MS);
      parsedUrl.searchParams.delete('t');
      const location = parsedUrl.pathname + parsedUrl.search;
      res.writeHead(302, {
        'set-cookie': `${SESSION_COOKIE_NAME}=${session}; HttpOnly; Path=/; SameSite=Lax`,
        location,
      });
      res.end();
      return;
    }

    if (!isAuthorized(req)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('unauthorized');
      return;
    }

    const requestUpstream = upstream;
    const outHeaders: http.OutgoingHttpHeaders = { ...req.headers };
    delete outHeaders.host;
    outHeaders.host = requestUpstream.host;
    // M5 amendment ② — see module doc: the Control UI's own WS RPC connect
    // is otherwise rejected by the gateway's `controlUi.allowedOrigins`.
    if (outHeaders.origin !== undefined) outHeaders.origin = requestUpstream.origin;

    const proxyReq = http.request(
      {
        protocol: requestUpstream.protocol,
        hostname: requestUpstream.hostname,
        port: requestUpstream.port,
        method: req.method,
        path: req.url,
        headers: outHeaders,
      },
      (upstreamRes) => {
        const responseHeaders: http.OutgoingHttpHeaders = { ...upstreamRes.headers };
        delete responseHeaders['x-frame-options'];
        const csp = responseHeaders['content-security-policy'];
        if (typeof csp === 'string') {
          responseHeaders['content-security-policy'] = rewriteFrameAncestors(csp, MOBILE_APP_ORIGIN);
        }
        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
        upstreamRes.pipe(res);
      },
    );
    upstreamRequests.add(proxyReq);
    proxyReq.once('close', () => upstreamRequests.delete(proxyReq));
    let upstreamTimedOut = false;
    proxyReq.setTimeout(upstreamTimeoutMs, () => {
      upstreamTimedOut = true;
      proxyReq.destroy(new Error('OpenClaw upstream timeout'));
    });
    proxyReq.on('error', () => {
      if (!res.headersSent) res.writeHead(upstreamTimedOut ? 504 : 502, { 'content-type': 'text/plain' });
      res.end();
    });
    req.pipe(proxyReq);
  };

  const handleUpgrade = (req: IncomingMessage, clientSocket: Socket, head: Buffer): void => {
    if (!isAuthorized(req)) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    const requestUpstream = upstream;
    let connected = false;
    const upstreamSocket = net.connect(Number(requestUpstream.port || 80), requestUpstream.hostname, () => {
      connected = true;
      clearTimeout(connectTimer);
      const outHeaders: Record<string, string | string[]> = { ...req.headers, host: requestUpstream.host } as Record<
        string,
        string | string[]
      >;
      // M5 amendment ② — see module doc: the Control UI's own WS RPC connect
      // is otherwise rejected by the gateway's `controlUi.allowedOrigins`.
      if (outHeaders.origin !== undefined) outHeaders.origin = requestUpstream.origin;
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
    const connectTimer = setTimeout(() => {
      if (connected) return;
      if (!clientSocket.destroyed) clientSocket.write('HTTP/1.1 504 Gateway Timeout\r\n\r\n');
      upstreamSocket.destroy();
      clientSocket.destroy();
    }, wsConnectTimeoutMs);
    connectTimer.unref?.();
    upstreamSocket.once('close', () => clearTimeout(connectTimer));
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
    for (const [ip, expiresAt] of ipSessions) {
      if (expiresAt < t) ipSessions.delete(ip);
    }
    for (const [session, expiresAt] of sessions) {
      if (expiresAt < t) sessions.delete(session);
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
        setUpstreamOrigin,
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
            for (const request of upstreamRequests) request.destroy();
            server.close(() => res());
          }),
      });
    });
  });
}
