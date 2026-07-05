/**
 * RemoteBridge — WS multiplexer for the mobile remote-control bridge (M0).
 *
 * Reuses the SAME per-run MessagePort broker shape as `main.ts`'s
 * `run-command` IPC handler (a fresh port pair per run; one half transferred
 * to the interpreter, the other kept here): a WS connection stands in for the
 * renderer's side of that port, relaying `InterpreterFrame`/`RendererControl`
 * over the single multiplexed socket instead of a dedicated MessagePort.
 * `create-session`/`destroy-session`/`list-sessions` are handled the same way
 * main.ts's IPC handlers do (session-created round-trip correlated by a
 * bridge-minted `requestId`, distinct from the client's own `requestId`).
 *
 * Everything Electron-specific (the real `WebSocketServer`, the interpreter
 * `UtilityProcess`, real `MessageChannelMain`s) is injected — this module
 * never imports `electron`, so the connection-handling logic (`attachConnection`)
 * is unit-testable with fake ports/interpreter/WS objects.
 *
 * Auth: the FIRST message on a new connection must be `{kind:'auth', token}`
 * matching the persisted token — anything else (wrong kind, wrong token)
 * closes the socket immediately (WS close code 4001) and no other message is
 * processed before auth succeeds.
 */
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

import type { InterpreterFrame, InterpreterToMain, MainToInterpreter, SessionInfo } from '../shared/ipc';
import {
  encodeFrame,
  type ClientToServerMessage,
  type ServerToClientMessage,
} from '../shared/remote-protocol';
import type { SessionDirectory } from './session-directory';

/** Non-standard WS close code: auth was missing/wrong on this connection. */
export const AUTH_CLOSE_CODE = 4001;

/** Default bridge port — overridable via `EZTERMINAL_REMOTE_PORT`. */
export const DEFAULT_REMOTE_BRIDGE_PORT = 7420;

// ── DI seams (narrow slices of Electron's MessagePortMain / UtilityProcess /
//    `ws`'s WebSocket — real instances satisfy these structurally, fakes in
//    tests need implement nothing more) ─────────────────────────────────────

export interface RemotePort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  on(event: 'close', listener: () => void): void;
  start(): void;
  close(): void;
}

export interface RemoteMessageChannel {
  readonly port1: RemotePort;
  readonly port2: RemotePort;
}

export interface RemoteInterpreter {
  postMessage(message: MainToInterpreter, transfer?: readonly RemotePort[]): void;
  on(event: 'message', listener: (message: InterpreterToMain) => void): void;
  off(event: 'message', listener: (message: InterpreterToMain) => void): void;
}

export interface RemoteWs {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number): void;
  on(event: 'message', listener: (data: { toString(): string }, isBinary: boolean) => void): void;
  on(event: 'close', listener: () => void): void;
}

/** Matches `ws`'s `WebSocket.OPEN` (standard WebSocket readyState 1). */
const WS_OPEN = 1;

export interface RemoteBridgeOptions {
  readonly port: number;
  readonly getToken: () => Promise<string> | string;
  readonly interpreter: RemoteInterpreter;
  readonly sessionDirectory: SessionDirectory;
  readonly createMessageChannel: () => RemoteMessageChannel;
  /** Test seam: overrides crypto.randomUUID for deterministic internal ids. */
  readonly newId?: () => string;
}

/**
 * Attach the bridge's protocol handling to one already-open WS connection.
 * Exported standalone (not bundled into `startRemoteBridge`) so tests can
 * drive it with a fake `RemoteWs` without opening a real network socket.
 */
export function attachConnection(ws: RemoteWs, options: RemoteBridgeOptions): void {
  const newId = options.newId ?? randomUUID;
  let authed = false;
  const runs = new Map<string, RemotePort>();
  // Bridge-minted requestId -> the client's own requestId (echoed back on reply).
  const pendingCreates = new Map<string, string>();

  const send = (msg: ServerToClientMessage): void => {
    if (ws.readyState === WS_OPEN) ws.send(JSON.stringify(msg));
  };

  const onInterpreterMessage = (msg: InterpreterToMain): void => {
    if (msg.type !== 'session-created') return;
    const clientRequestId = pendingCreates.get(msg.requestId);
    if (clientRequestId === undefined) return; // some other connection's create
    pendingCreates.delete(msg.requestId);
    const session: SessionInfo = { sessionId: msg.sessionId, cwd: msg.cwd };
    options.sessionDirectory.add(session);
    send({ kind: 'session-created', requestId: clientRequestId, session });
  };
  options.interpreter.on('message', onInterpreterMessage);

  ws.on('close', () => {
    options.interpreter.off('message', onInterpreterMessage);
    for (const port of runs.values()) port.close();
    runs.clear();
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return; // never sent by a compliant client — ignore
    let msg: ClientToServerMessage;
    try {
      msg = JSON.parse(data.toString()) as ClientToServerMessage;
    } catch {
      return;
    }

    if (!authed) {
      if (msg.kind !== 'auth') {
        ws.close(AUTH_CLOSE_CODE);
        return;
      }
      void Promise.resolve(options.getToken()).then((token) => {
        if (msg.token === token) {
          authed = true;
          send({ kind: 'auth-ok' });
        } else {
          send({ kind: 'auth-fail' });
          ws.close(AUTH_CLOSE_CODE);
        }
      });
      return;
    }

    switch (msg.kind) {
      case 'list-sessions':
        send({ kind: 'session-list', sessions: options.sessionDirectory.list() });
        break;

      case 'create-session': {
        const requestId = newId();
        pendingCreates.set(requestId, msg.requestId);
        options.interpreter.postMessage({ type: 'create-session', requestId, cwd: msg.cwd });
        break;
      }

      case 'destroy-session':
        options.sessionDirectory.remove(msg.sessionId);
        options.interpreter.postMessage({ type: 'destroy-session', sessionId: msg.sessionId });
        break;

      case 'run-command': {
        const { runId } = msg;
        const { port1, port2 } = options.createMessageChannel();
        runs.set(runId, port1);
        port1.on('message', (event) => {
          send({ kind: 'frame', runId, frame: encodeFrame(event.data as InterpreterFrame) });
        });
        port1.on('close', () => runs.delete(runId));
        port1.start();
        options.interpreter.postMessage(
          { type: 'run', commandText: msg.commandText, sessionId: msg.sessionId },
          [port2],
        );
        break;
      }

      case 'control': {
        const port = runs.get(msg.runId);
        if (!port) break;
        port.postMessage(msg.control);
        if (msg.control.type === 'close') {
          port.close();
          runs.delete(msg.runId);
        }
        break;
      }

      // 'auth' after auth already succeeded — ignored (no-op, not an error).
      default:
        break;
    }
  });
}

export interface RemoteBridgeHandle {
  stop(): void;
}

/** Start the WS server (binds `0.0.0.0` — LAN/Tailscale reachable, token-gated). */
export function startRemoteBridge(options: RemoteBridgeOptions): RemoteBridgeHandle {
  const wss = new WebSocketServer({ port: options.port, host: '0.0.0.0' });
  wss.on('connection', (ws) => attachConnection(ws as unknown as RemoteWs, options));
  return {
    stop: () => wss.close(),
  };
}
