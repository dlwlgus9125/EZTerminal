#!/usr/bin/env node
/**
 * Fake OpenClaw gateway (openclaw-management M2 e2e). A single long-running
 * Node process serving BOTH the HTTP liveness/Control-UI probe and the WS RPC
 * surface `OpenClawService` talks to (openclaw-service.ts) — reproducing the
 * real anti-embed headers + RPC handshake verified live in M0
 * (docs/research/2026-07-12-openclaw-stage0.md ②③④).
 *
 * Simplification: the real gateway's port simply stops listening when
 * stopped; this fixture always listens (so the fake CLI's `gateway start`
 * has a fixed port to flip state for) and instead answers `GET /` with 503
 * while `state.running` is false. `OpenClawService.getStatus()`'s liveness
 * check only cares that `statusCode < 500`, so a 503 is behaviorally
 * identical to a refused connection (both resolve `{ok:false}` -> 'stopped').
 *
 * State is a shared JSON file (path = argv[2]) the fake CLI also writes to
 * (`running`, `config`) — re-read on every request/RPC call so a `gateway
 * start` from the CLI is visible on this process's very next answer.
 *
 * Usage: `node fake-openclaw-gateway.mjs <statePath>` — prints `READY
 * <port>` to stdout once listening (ephemeral port, so parallel e2e runs
 * never collide).
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';

const statePath = process.argv[2];

function readState() {
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

function handleRpc(method, params, state) {
  if (method === 'status') return { runtimeVersion: state.version };
  if (method === 'sessions.list') return { sessions: state.sessions ?? [] };
  if (method === 'logs.tail') {
    const limit = params?.limit ?? 200;
    const cursor = typeof params?.cursor === 'number' ? params.cursor : 0;
    const lines = (state.logLines ?? []).slice(cursor, cursor + limit);
    return { cursor: cursor + lines.length, lines, reset: false };
  }
  return undefined; // unknown method -> caller sends ok:false
}

const server = createServer((req, res) => {
  const state = readState();
  if (req.method === 'GET' && req.url === '/') {
    if (!state.running) {
      res.writeHead(503);
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html',
      // The real Control UI's exact anti-embed headers (M0 ③ control baseline).
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
    });
    res.end('<!doctype html><html><head><title>OpenClaw Control</title></head><body></body></html>');
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'e2e-nonce' } }));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type !== 'req') return;
    const state = readState();

    if (msg.method === 'connect') {
      const token = msg.params?.auth?.token;
      const ok = typeof token === 'string' && token.length > 0 && token === state.token;
      ws.send(
        JSON.stringify(
          ok
            ? {
                type: 'res',
                id: msg.id,
                ok: true,
                payload: {
                  type: 'hello-ok',
                  features: { methods: ['health', 'status', 'sessions.list', 'sessions.usage', 'logs.tail'] },
                },
              }
            : { type: 'res', id: msg.id, ok: false, error: { message: 'invalid token' } },
        ),
      );
      return;
    }

    const payload = handleRpc(msg.method, msg.params, state);
    ws.send(
      JSON.stringify(
        payload !== undefined
          ? { type: 'res', id: msg.id, ok: true, payload }
          : { type: 'res', id: msg.id, ok: false, error: { message: `unknown method: ${msg.method}` } },
      ),
    );
  });
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`READY ${server.address().port}\n`);
});
