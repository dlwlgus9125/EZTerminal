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
 *
 * `startRemoteBridge` also runs a ws ping/pong heartbeat sweep so a
 * half-open phone socket (app backgrounded/killed without a clean close)
 * doesn't keep a `statsSource`/packet-mirror acquire alive forever.
 */
import { timingSafeEqual } from 'node:crypto';

import { WebSocketServer, type WebSocket } from 'ws';

import type { InterpreterFrame, PacketRow, SystemStatsSnapshot } from '../shared/ipc';
import {
  base64ToUint8Array,
  encodeFrame,
  uint8ArrayToBase64,
  type ClientToServerMessage,
  type RemotePacketFrame,
  type ServerToClientMessage,
} from '../shared/remote-protocol';
import { FILE_CHUNK_BYTES, type FileListResult, type FileOpResult } from '../shared/files';
import type { FileReadStream } from './file-service';
import type { InterpreterBroker, RemoteInterpreter, RemoteMessageChannel, RemotePort } from './interpreter-broker';

/** Non-standard WS close code: auth was missing/wrong on this connection. */
export const AUTH_CLOSE_CODE = 4001;

/** Default bridge port — overridable via `EZTERMINAL_REMOTE_PORT`. */
export const DEFAULT_REMOTE_BRIDGE_PORT = 7420;

/** Ping cadence + missed-pong tolerance for `startRemoteBridge`'s heartbeat sweep. */
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_MAX_MISSED_PONGS = 2;

// ── Network hardening (public-repo security review) ─────────────────────────
/** Cap on a single inbound frame. The largest legitimate client frame is a
 * base64-encoded file-upload chunk (`FILE_CHUNK_BYTES * 2` raw ≈ 683 KiB of
 * base64); 1 MiB leaves headroom while stopping an unauthenticated client from
 * forcing `ws`'s 100 MiB default allocation on every frame (pre-auth DoS). */
const MAX_INBOUND_FRAME_BYTES = 1024 * 1024;
/** Max concurrent connections — one phone plus a little slack. Beyond this the
 * server refuses new sockets (WS close 1013 "Try Again Later") so a socket
 * flood can't exhaust the main process. */
const MAX_REMOTE_CONNECTIONS = 64;
/** A socket that hasn't authenticated within this window is terminated, so an
 * unauthenticated client can't sit holding a connection slot indefinitely
 * (which, with `MAX_REMOTE_CONNECTIONS`, would otherwise starve real clients). */
const AUTH_DEADLINE_MS = 10_000;
/** WebView/localhost origins allowed to open the bridge. The Capacitor Android
 * WebView presents `http://localhost` (capacitor.config.ts's `androidScheme`);
 * a real browser page presents its own site origin and is rejected — this is
 * the Cross-Site WebSocket Hijacking / DNS-rebinding defense. Non-browser
 * clients (the e2e Node `ws` client, curl) send no Origin header at all, which
 * is allowed: the token remains the real authentication gate. */
const ALLOWED_WS_ORIGINS: ReadonlySet<string> = new Set([
  'http://localhost',
  'https://localhost',
  'capacitor://localhost',
]);

/** `verifyClient` predicate — allow no-Origin (non-browser) clients and the
 * known WebView origins; reject any explicit foreign browser origin. Exported
 * for unit testing (the real `verifyClient` wiring needs a live server). */
export function isRemoteOriginAllowed(origin: string | undefined): boolean {
  return !origin || ALLOWED_WS_ORIGINS.has(origin);
}

/** Constant-time token comparison. Length-checks first (so a length mismatch
 * never reaches `timingSafeEqual`, which throws on unequal-length buffers) and
 * then compares without an early-exit byte loop, so a network attacker learns
 * nothing about the token from response timing. Exported for unit testing. */
export function tokensMatch(candidate: unknown, token: string): boolean {
  if (typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Per-connection packet-frame coalescing (M3): the host already flushes at
 * 100ms (`PACKET_FLUSH_INTERVAL_MS`); this widens it to 500ms over the phone
 * link so a busy LAN doesn't spam the socket at 10 msg/s. */
const MOBILE_PACKET_FLUSH_MS = 500;
/** Oldest rows drop once a connection's coalescing buffer exceeds this many
 * (mobile only ever renders `PACKET_ROW_CAP` (200) rows anyway). */
const MOBILE_PACKET_PENDING_CAP = 500;
/** Skip (and clear) a flush while the socket's send buffer is this backed up,
 * rather than piling more onto an already-slow link. 256 KiB. */
const MOBILE_PACKET_BACKPRESSURE_BYTES = 262_144;

// ── DI seams (narrow slices of Electron's MessagePortMain / UtilityProcess /
//    `ws`'s WebSocket — real instances satisfy these structurally, fakes in
//    tests need implement nothing more) ─────────────────────────────────────

// `RemotePort` / `RemoteMessageChannel` / `RemoteInterpreter` are owned by the
// interpreter broker (they describe its interpreter/port seams). Re-exported
// here so existing importers of this module (e.g. remote-bridge.test.ts) keep
// resolving them unchanged.
export type { RemoteInterpreter, RemoteMessageChannel, RemotePort };

export interface RemoteWs {
  readonly readyState: number;
  /** `ws`'s own backpressure gauge (bytes queued, not yet flushed to the OS
   * socket) — `undefined` on a fake that never reports one (never treated as
   * backed up). Used to skip a packet-frame flush rather than pile onto an
   * already-slow link (M3). */
  readonly bufferedAmount?: number;
  send(data: string): void;
  close(code?: number): void;
  on(event: 'message', listener: (data: { toString(): string }, isBinary: boolean) => void): void;
  on(event: 'close', listener: () => void): void;
}

/** Matches `ws`'s `WebSocket.OPEN` (standard WebSocket readyState 1). */
const WS_OPEN = 1;

/**
 * DI seam over the desktop's `StatsVisibility` + `SystemStatsService`: the
 * bridge only ever acquires/releases and reads snapshots/history through
 * this, so it never imports either directly. `onSnapshot`'s feed is
 * UNGATED (every 1Hz tick, regardless of desktop panel visibility) — this
 * connection's own `statsVisible` flag decides whether to relay it.
 */
export interface RemoteStatsSource {
  getHistory(): SystemStatsSnapshot[];
  onSnapshot(listener: (snapshot: SystemStatsSnapshot) => void): () => void;
  acquire(): void;
  release(): void;
}

/**
 * DI seam over `PacketMirror` (src/main/packet-mirror.ts): the bridge only
 * ever subscribes/unsubscribes through this, so it never imports the mirror
 * (or `PacketCaptureRegistry`) directly. Each `subscribe()` call is this
 * connection's OWN feed — `PacketMirror` gives every subscriber its own
 * viewer port, so one connection's subscribe/unsubscribe never affects
 * another's.
 */
export interface RemotePacketSource {
  subscribe(listener: (frame: RemotePacketFrame) => void): () => void;
}

/**
 * DI seam over `FileService` (src/main/file-service.ts, file-explorer plan
 * M0): the bridge only ever calls through this, so it never imports
 * `FileService` directly — the method signatures mirror it exactly so
 * `fileService satisfies RemoteFileSource` (main.ts) holds structurally with
 * zero adaptation. Deliberately has NO `readTextFile` — the bridge always
 * streams via `openReadStream`, even for `'text'` (viewer) mode.
 */
export interface RemoteFileSource {
  listDirectory(dirPath: string): Promise<FileListResult>;
  listRoots(): Promise<string[]>;
  openReadStream(
    filePath: string,
    mode: 'text' | 'raw',
  ): Promise<{ ok: false; error: string } | ({ ok: true } & FileReadStream)>;
  createFolder(dirPath: string, name: string): Promise<FileOpResult>;
  renameEntry(entryPath: string, newName: string): Promise<FileOpResult>;
  trashEntry(entryPath: string): Promise<FileOpResult>;
  beginUpload(
    dirPath: string,
    name: string,
    size: number,
  ): Promise<{ ok: true; uploadId: string; finalName: string } | { ok: false; error: string }>;
  writeUploadChunk(
    uploadId: string,
    offset: number,
    data: Uint8Array,
  ): Promise<{ ok: true; receivedBytes: number } | { ok: false; error: string }>;
  commitUpload(uploadId: string): Promise<{ ok: true; finalName: string } | { ok: false; error: string }>;
  abortUpload(uploadId: string): Promise<void>;
}

export interface RemoteBridgeOptions {
  readonly port: number;
  readonly getToken: () => Promise<string> | string;
  /** The single shared interpreter broker — main.ts and this bridge adapt to
   * ONE instance, so there is exactly one interpreter listener + one session
   * directory across both transports. */
  readonly broker: InterpreterBroker;
  /** Optional so existing fixtures/tests without stats wiring keep working. */
  readonly statsSource?: RemoteStatsSource;
  /** Optional so existing fixtures/tests without packet wiring keep working. */
  readonly packetSource?: RemotePacketSource;
  /** Optional so existing fixtures/tests without file wiring keep working. */
  readonly fileSource?: RemoteFileSource;
}

/**
 * Attach the bridge's protocol handling to one already-open WS connection.
 * Exported standalone (not bundled into `startRemoteBridge`) so tests can
 * drive it with a fake `RemoteWs` without opening a real network socket.
 */
export function attachConnection(
  ws: RemoteWs,
  options: RemoteBridgeOptions,
  hooks?: { onAuthenticated?: () => void },
): void {
  let authed = false;
  const runs = new Map<string, RemotePort>();
  // This connection's own stats subscription (independent of the desktop panel
  // and of every other connection — statsSource.acquire()/release() combine
  // them all via refcount, see StatsVisibility).
  let statsVisible = false;
  let statsUnsub: (() => void) | null = null;
  // This connection's own packet subscription (M3) — independent of every
  // other connection, same shape as stats above. Batch frames are coalesced
  // into `pendingPacketRows` and flushed on `packetFlushTimer`; status frames
  // bypass coalescing entirely (sent immediately, see the subscribe handler).
  let packetsSubscribed = false;
  let packetsUnsub: (() => void) | null = null;
  let pendingPacketRows: PacketRow[] = [];
  let packetFlushTimer: ReturnType<typeof setInterval> | null = null;
  // File explorer (M3): open read streams keyed by the client's `requestId`,
  // and uploadIds this connection currently owns (for close-teardown abort —
  // FileService's own idle sweep is a backstop, not relied on here).
  const fileReads = new Map<string, FileReadStream>();
  const fileUploads = new Set<string>();

  const send = (msg: ServerToClientMessage): void => {
    if (ws.readyState === WS_OPEN) ws.send(JSON.stringify(msg));
  };

  /** Pull one chunk from an open read stream and send it — called once right
   * after `file-read-meta` and again on every `file-read-ack` (the one-in-
   * flight-chunk contract documented in remote-protocol.ts). */
  const sendNextReadChunk = async (requestId: string, stream: FileReadStream): Promise<void> => {
    const { offset, data, done } = await stream.next();
    send({ kind: 'file-read-chunk', requestId, offset, data: uint8ArrayToBase64(data), done });
    if (done) {
      fileReads.delete(requestId);
      await stream.close();
    }
  };

  const flushPendingPackets = (): void => {
    if (pendingPacketRows.length === 0) return;
    if ((ws.bufferedAmount ?? 0) > MOBILE_PACKET_BACKPRESSURE_BYTES) {
      pendingPacketRows = []; // skip AND clear — don't pile onto a backed-up link
      return;
    }
    const rows = pendingPacketRows;
    pendingPacketRows = [];
    send({ kind: 'packet-frame', frame: { type: 'packets', rows } });
  };

  const stopPacketsSubscription = (): void => {
    if (!packetsSubscribed) return;
    packetsSubscribed = false;
    packetsUnsub?.();
    packetsUnsub = null;
    if (packetFlushTimer !== null) {
      clearInterval(packetFlushTimer);
      packetFlushTimer = null;
    }
    pendingPacketRows = [];
  };

  // Session/run mirroring (M2): every connection observes every session/run
  // change via the SHARED broker, origin-agnostic (including one THIS connection
  // just created — the broker resolves the create-session reply BEFORE its
  // deferred onSessionAdded fan-out, so a requester always learns "this sessionId
  // is mine" before the broadcast echo, see ADR C6). Gated on `authed` so an
  // unauthenticated socket never sees session/run data. The broker holds the
  // single interpreter listener; this connection adds none.
  const unsubSessionAdded = options.broker.onSessionAdded((session) => {
    if (authed) send({ kind: 'session-added', session });
  });
  const unsubSessionRemoved = options.broker.onSessionRemoved((sessionId) => {
    if (authed) send({ kind: 'session-removed', sessionId });
  });
  const unsubRunStarted = options.broker.onRunStarted((info) => {
    // runId is caller-minted, so unlike session-added there's no "learn my own
    // id first" race — a plain broadcast is enough.
    if (authed) {
      send({ kind: 'run-started', sessionId: info.sessionId, runId: info.runId, commandText: info.commandText });
    }
  });

  ws.on('close', () => {
    unsubSessionAdded();
    unsubSessionRemoved();
    unsubRunStarted();
    for (const port of runs.values()) port.close();
    runs.clear();
    if (statsVisible) {
      statsVisible = false;
      statsUnsub?.();
      statsUnsub = null;
      options.statsSource?.release();
    }
    stopPacketsSubscription();
    // File explorer (M3): a dropped connection is the only owner of its open
    // reads/uploads — close every stream and abort every upload rather than
    // leaving a `.ezpart` file or an fd open until the idle sweep gets to it.
    for (const stream of fileReads.values()) void stream.close();
    fileReads.clear();
    for (const uploadId of fileUploads) void options.fileSource?.abortUpload(uploadId);
    fileUploads.clear();
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
        if (tokensMatch(msg.token, token)) {
          authed = true;
          hooks?.onAuthenticated?.();
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
        send({ kind: 'session-list', sessions: options.broker.listSessions() });
        break;

      case 'list-runs': {
        // The reply now flows through a `.then` microtask (the broker resolves
        // the pending promise), still strictly ahead of any onSessionAdded
        // fan-out (setImmediate). `.catch` swallows a post-interpreter-death
        // reject — no error frame, keeping the client's silent-hang parity (M1/G2).
        options.broker
          .listRuns()
          .then((runs) => {
            if (authed) send({ kind: 'run-list', runs });
          })
          .catch(() => {});
        break;
      }

      case 'create-session': {
        // Echo the CLIENT's own requestId (captured here) on reply so mobile
        // correlation holds; `.catch` swallows a post-death reject (silent-hang
        // parity, M1/G2).
        const { requestId, cwd } = msg;
        options.broker
          .createSession(cwd)
          .then((session) => {
            send({ kind: 'session-created', requestId, session });
          })
          .catch(() => {});
        break;
      }

      case 'destroy-session':
        options.broker.destroySession(msg.sessionId);
        break;

      case 'run-command': {
        const { runId } = msg;
        // Broker mints the port pair + posts port2 to the interpreter; a `null`
        // return (dead interpreter) means no port to relay — skip, don't throw.
        const port1 = options.broker.runCommand(msg.sessionId, runId, msg.commandText);
        if (!port1) break;
        runs.set(runId, port1);
        port1.on('message', (event) => {
          send({ kind: 'frame', runId, frame: encodeFrame(event.data as InterpreterFrame) });
        });
        port1.on('close', () => runs.delete(runId));
        port1.start();
        break;
      }

      // Attach as a non-initiating observer to a run (M2 mirroring) — reuses
      // the SAME `runs` map + frame-relay/control-forwarding shape as
      // `run-command` above (a `control` for this `runId` already forwards
      // correctly with no further changes needed).
      case 'attach-run': {
        const { runId } = msg;
        // Same null-guard as run-command: a dead interpreter yields no port.
        const port1 = options.broker.attachRun(runId);
        if (!port1) break;
        runs.set(runId, port1);
        port1.on('message', (event) => {
          send({ kind: 'frame', runId, frame: encodeFrame(event.data as InterpreterFrame) });
        });
        port1.on('close', () => runs.delete(runId));
        port1.start();
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

      case 'stats-visible': {
        if (!options.statsSource) break;
        if (msg.visible) {
          if (statsVisible) break; // idempotent — already on
          statsVisible = true;
          options.statsSource.acquire();
          statsUnsub = options.statsSource.onSnapshot((snapshot) => send({ kind: 'stats-update', snapshot }));
        } else {
          if (!statsVisible) break; // idempotent — already off
          statsVisible = false;
          statsUnsub?.();
          statsUnsub = null;
          options.statsSource.release();
        }
        break;
      }

      case 'stats-history':
        send({ kind: 'stats-history', snapshots: options.statsSource?.getHistory() ?? [] });
        break;

      case 'packets-subscribe': {
        if (!options.packetSource) break;
        if (packetsSubscribed) break; // idempotent — already on
        packetsSubscribed = true;
        packetsUnsub = options.packetSource.subscribe((frame) => {
          if (frame.type === 'status') {
            send({ kind: 'packet-frame', frame }); // never coalesced — always immediate
            return;
          }
          pendingPacketRows.push(...frame.rows);
          if (pendingPacketRows.length > MOBILE_PACKET_PENDING_CAP) {
            pendingPacketRows = pendingPacketRows.slice(pendingPacketRows.length - MOBILE_PACKET_PENDING_CAP);
          }
        });
        packetFlushTimer = setInterval(flushPendingPackets, MOBILE_PACKET_FLUSH_MS);
        break;
      }

      case 'packets-unsubscribe':
        stopPacketsSubscription();
        break;

      // ── File explorer (file-explorer plan, M3) ────────────────────────────
      // Every arm below guards `if (!options.fileSource) break;` — silent
      // no-op, same convention as stats/packets above when their source is absent.

      case 'file-list': {
        if (!options.fileSource) break;
        const { requestId } = msg;
        void options.fileSource.listDirectory(msg.path).then((result) => {
          send({ kind: 'file-list-reply', requestId, result });
        });
        break;
      }

      case 'file-roots': {
        if (!options.fileSource) break;
        const { requestId } = msg;
        void options.fileSource.listRoots().then((roots) => {
          send({ kind: 'file-roots-reply', requestId, roots });
        });
        break;
      }

      case 'file-mkdir': {
        if (!options.fileSource) break;
        const { requestId } = msg;
        void options.fileSource.createFolder(msg.dirPath, msg.name).then((result) => {
          send({ kind: 'file-op-reply', requestId, result });
        });
        break;
      }

      case 'file-rename': {
        if (!options.fileSource) break;
        const { requestId } = msg;
        void options.fileSource.renameEntry(msg.path, msg.newName).then((result) => {
          send({ kind: 'file-op-reply', requestId, result });
        });
        break;
      }

      case 'file-trash': {
        if (!options.fileSource) break;
        const { requestId } = msg;
        void options.fileSource.trashEntry(msg.path).then((result) => {
          send({ kind: 'file-op-reply', requestId, result });
        });
        break;
      }

      case 'file-read': {
        if (!options.fileSource) break;
        const { requestId } = msg;
        void options.fileSource.openReadStream(msg.path, msg.mode).then(async (result) => {
          if (!result.ok) {
            send({ kind: 'file-read-meta', requestId, ok: false, error: result.error });
            return;
          }
          const { meta } = result;
          send({
            kind: 'file-read-meta',
            requestId,
            ok: true,
            fileSize: meta.fileSize,
            sendBytes: meta.sendBytes,
            isText: meta.isText,
            truncated: meta.truncated,
          });
          if (meta.sendBytes <= 0) {
            await result.close(); // binary in 'text' mode, or a genuinely empty file
            return;
          }
          fileReads.set(requestId, result);
          await sendNextReadChunk(requestId, result);
        });
        break;
      }

      case 'file-read-ack': {
        const stream = fileReads.get(msg.requestId);
        if (!stream) break;
        void sendNextReadChunk(msg.requestId, stream);
        break;
      }

      case 'file-read-cancel': {
        const stream = fileReads.get(msg.requestId);
        if (!stream) break;
        fileReads.delete(msg.requestId);
        void stream.close();
        break;
      }

      case 'file-upload-begin': {
        if (!options.fileSource) break;
        const { requestId } = msg;
        void options.fileSource.beginUpload(msg.dirPath, msg.name, msg.size).then((result) => {
          if (!result.ok) {
            send({ kind: 'file-upload-begin-reply', requestId, ok: false, error: result.error });
            return;
          }
          fileUploads.add(result.uploadId);
          send({
            kind: 'file-upload-begin-reply',
            requestId,
            ok: true,
            uploadId: result.uploadId,
            finalName: result.finalName,
          });
        });
        break;
      }

      case 'file-upload-chunk': {
        if (!options.fileSource) break;
        const { uploadId, offset } = msg;
        let bytes: Uint8Array;
        try {
          bytes = base64ToUint8Array(msg.data);
        } catch {
          fileUploads.delete(uploadId);
          void options.fileSource.abortUpload(uploadId);
          send({ kind: 'file-upload-ack', uploadId, ok: false, error: 'malformed chunk' });
          break;
        }
        // Hard cap regardless of what the client claims — never trust size alone.
        if (bytes.length > FILE_CHUNK_BYTES * 2) {
          fileUploads.delete(uploadId);
          void options.fileSource.abortUpload(uploadId);
          send({ kind: 'file-upload-ack', uploadId, ok: false, error: 'chunk exceeds the wire chunk limit' });
          break;
        }
        void options.fileSource.writeUploadChunk(uploadId, offset, bytes).then((result) => {
          if (!result.ok) {
            // FileService already aborted+unlinked on any rejection (out-of-
            // order/oversized/write-error) — this id is done either way.
            fileUploads.delete(uploadId);
            send({ kind: 'file-upload-ack', uploadId, ok: false, error: result.error });
            return;
          }
          send({ kind: 'file-upload-ack', uploadId, ok: true, receivedBytes: result.receivedBytes });
        });
        break;
      }

      case 'file-upload-commit': {
        if (!options.fileSource) break;
        const { uploadId } = msg;
        void options.fileSource.commitUpload(uploadId).then((result) => {
          fileUploads.delete(uploadId);
          if (!result.ok) {
            send({ kind: 'file-upload-done', uploadId, ok: false, error: result.error });
            return;
          }
          send({ kind: 'file-upload-done', uploadId, ok: true, finalName: result.finalName });
        });
        break;
      }

      case 'file-upload-abort':
        if (!options.fileSource) break;
        fileUploads.delete(msg.uploadId);
        void options.fileSource.abortUpload(msg.uploadId);
        break;

      // 'auth' after auth already succeeded — ignored (no-op, not an error).
      default:
        break;
    }
  });
}

export interface RemoteBridgeHandle {
  /** Terminates every connected client (fires each socket's 'close', see
   * attachConnection's per-connection teardown) then closes the listening
   * socket — resolves only once the port is actually released, so an
   * immediate restart on the same port never races EADDRINUSE. */
  stop(): Promise<void>;
}

/**
 * Start the WS server. Binds `0.0.0.0` (LAN/Tailscale reachable) — remote
 * control is OFF by default (see `LayoutStore.getRemoteEnabled`), so the
 * listener only exists once the user opts in. Access is gated by the persisted
 * token (`tokensMatch`, constant-time); browser origins are rejected
 * (`isRemoteOriginAllowed`); frames are capped (`MAX_INBOUND_FRAME_BYTES`) and
 * connections are bounded (`MAX_REMOTE_CONNECTIONS` + `AUTH_DEADLINE_MS`). The
 * transport itself is plain `ws://` — intended for a trusted LAN or an
 * encrypted overlay (Tailscale/WireGuard); see SECURITY.md.
 */
export function startRemoteBridge(options: RemoteBridgeOptions): RemoteBridgeHandle {
  const wss = new WebSocketServer({
    port: options.port,
    host: '0.0.0.0',
    maxPayload: MAX_INBOUND_FRAME_BYTES,
    verifyClient: (info: { origin?: string }) => isRemoteOriginAllowed(info.origin),
  });
  // A bind failure (e.g. EADDRINUSE from a stale listener) must not crash main.
  wss.on('error', (err) => {
    console.error('[remote-bridge] WebSocketServer error:', err);
  });

  // Heartbeat sweep (attachConnection itself is untouched — fakes/tests never
  // see this): counts consecutive missed pongs per socket, terminating once a
  // connection misses HEARTBEAT_MAX_MISSED_PONGS in a row.
  const missedPongs = new WeakMap<WebSocket, number>();
  wss.on('connection', (ws) => {
    // Refuse beyond the connection cap so a socket flood can't exhaust main
    // (1013 = Try Again Later). `wss.clients` already includes this socket.
    if (wss.clients.size > MAX_REMOTE_CONNECTIONS) {
      ws.close(1013);
      return;
    }
    // Terminate a socket that never authenticates in time (cleared the moment
    // auth succeeds, via the onAuthenticated hook, or when the socket closes).
    // `.unref()` so the timer never keeps the process alive on its own.
    const authTimer = setTimeout(() => ws.terminate(), AUTH_DEADLINE_MS);
    authTimer.unref?.();
    missedPongs.set(ws, 0);
    ws.on('pong', () => missedPongs.set(ws, 0));
    ws.on('close', () => clearTimeout(authTimer));
    attachConnection(ws as unknown as RemoteWs, options, {
      onAuthenticated: () => clearTimeout(authTimer),
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const missed = missedPongs.get(ws) ?? 0;
      if (missed >= HEARTBEAT_MAX_MISSED_PONGS) {
        ws.terminate();
        continue;
      }
      missedPongs.set(ws, missed + 1);
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  return {
    stop: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat);
        for (const ws of wss.clients) ws.terminate();
        wss.close((err) => {
          if (err) console.error('[remote-bridge] error closing WebSocketServer:', err);
          resolve();
        });
      }),
  };
}
