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
import { WebSocketServer, type WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

import type { InterpreterFrame, InterpreterToMain, MainToInterpreter, PacketRow, SessionInfo, SystemStatsSnapshot } from '../shared/ipc';
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
import type { SessionDirectory } from './session-directory';

/** Non-standard WS close code: auth was missing/wrong on this connection. */
export const AUTH_CLOSE_CODE = 4001;

/** Default bridge port — overridable via `EZTERMINAL_REMOTE_PORT`. */
export const DEFAULT_REMOTE_BRIDGE_PORT = 7420;

/** Ping cadence + missed-pong tolerance for `startRemoteBridge`'s heartbeat sweep. */
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_MAX_MISSED_PONGS = 2;

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
  readonly interpreter: RemoteInterpreter;
  readonly sessionDirectory: SessionDirectory;
  readonly createMessageChannel: () => RemoteMessageChannel;
  /** Test seam: overrides crypto.randomUUID for deterministic internal ids. */
  readonly newId?: () => string;
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
export function attachConnection(ws: RemoteWs, options: RemoteBridgeOptions): void {
  const newId = options.newId ?? randomUUID;
  let authed = false;
  const runs = new Map<string, RemotePort>();
  // Bridge-minted requestId -> the client's own requestId (echoed back on reply).
  const pendingCreates = new Map<string, string>();
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

  const onInterpreterMessage = (msg: InterpreterToMain): void => {
    if (msg.type === 'session-created') {
      const clientRequestId = pendingCreates.get(msg.requestId);
      if (clientRequestId === undefined) return; // some other connection's create
      pendingCreates.delete(msg.requestId);
      const session: SessionInfo = { sessionId: msg.sessionId, cwd: msg.cwd };
      // Correlated reply BEFORE the directory add — sessionDirectory.add()'s
      // own session-added broadcast to THIS connection (via the subscription
      // below) is deferred internally (setImmediate), but replying first here
      // is extra, cheap defense-in-depth for the same ordering guarantee (ADR C6).
      send({ kind: 'session-created', requestId: clientRequestId, session });
      options.sessionDirectory.add(session);
    } else if (msg.type === 'run-started' && authed) {
      // M2 mirroring: runId is caller-minted, so unlike session-added there's
      // no "learn my own id first" race — a plain broadcast is enough.
      send({ kind: 'run-started', sessionId: msg.sessionId, runId: msg.runId, commandText: msg.commandText });
    }
  };
  options.interpreter.on('message', onInterpreterMessage);

  // Session mirroring (M2): every connection observes every session change,
  // origin-agnostic (including one THIS connection just created — same
  // self-echo shape as the desktop's session-added IPC push, see
  // SessionDirectory's doc for why the ordering is safe). Gated on `authed`
  // so an unauthenticated socket never sees session data.
  const unsubSessionAdded = options.sessionDirectory.onSessionAdded((session) => {
    if (authed) send({ kind: 'session-added', session });
  });
  const unsubSessionRemoved = options.sessionDirectory.onSessionRemoved((sessionId) => {
    if (authed) send({ kind: 'session-removed', sessionId });
  });

  ws.on('close', () => {
    options.interpreter.off('message', onInterpreterMessage);
    unsubSessionAdded();
    unsubSessionRemoved();
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
          { type: 'run', commandText: msg.commandText, sessionId: msg.sessionId, runId },
          [port2],
        );
        break;
      }

      // Attach as a non-initiating observer to a run (M2 mirroring) — reuses
      // the SAME `runs` map + frame-relay/control-forwarding shape as
      // `run-command` above (a `control` for this `runId` already forwards
      // correctly with no further changes needed).
      case 'attach-run': {
        const { runId } = msg;
        const { port1, port2 } = options.createMessageChannel();
        runs.set(runId, port1);
        port1.on('message', (event) => {
          send({ kind: 'frame', runId, frame: encodeFrame(event.data as InterpreterFrame) });
        });
        port1.on('close', () => runs.delete(runId));
        port1.start();
        options.interpreter.postMessage({ type: 'attach-run', runId }, [port2]);
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
  stop(): void;
}

/** Start the WS server (binds `0.0.0.0` — LAN/Tailscale reachable, token-gated). */
export function startRemoteBridge(options: RemoteBridgeOptions): RemoteBridgeHandle {
  const wss = new WebSocketServer({ port: options.port, host: '0.0.0.0' });

  // Heartbeat sweep (attachConnection itself is untouched — fakes/tests never
  // see this): counts consecutive missed pongs per socket, terminating once a
  // connection misses HEARTBEAT_MAX_MISSED_PONGS in a row.
  const missedPongs = new WeakMap<WebSocket, number>();
  wss.on('connection', (ws) => {
    missedPongs.set(ws, 0);
    ws.on('pong', () => missedPongs.set(ws, 0));
    attachConnection(ws as unknown as RemoteWs, options);
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
    stop: () => {
      clearInterval(heartbeat);
      wss.close();
    },
  };
}
