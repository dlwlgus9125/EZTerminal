/**
 * Remote-control WS wire protocol (mobile remote-control M0) — a single
 * WebSocket connection multiplexes every interaction: auth, session listing/
 * create/destroy, one or more concurrent command runs (each correlated by
 * `runId`, echoing the shape of the desktop's per-command MessagePort broker
 * in `main.ts`'s `run-command` handler), and the status-panel mirror added in
 * M1 (stats + packet capture, §D1). `ClientToServerMessage`/
 * `ServerToClientMessage` wrap the existing `InterpreterFrame`/
 * `RendererControl`/`SystemStatsSnapshot`/packet-capture types from `ipc.ts`
 * rather than redefining them.
 *
 * `pty-data`'s `Uint8Array` cannot survive `JSON.stringify` — the wire form
 * (`WireInterpreterFrame`) carries it as base64 text instead (decision:
 * simplicity/correctness over throughput for M0). `encodeFrame`/`decodeFrame`
 * isolate this so a later swap to a binary WS frame (header + raw bytes) only
 * touches this module, not the bridge or transport call sites.
 *
 * No version negotiation: both sides ship from the same repo in lockstep, and
 * both are written to silently ignore any `kind` they don't recognize (rather
 * than erroring), so new message kinds can be added here without a protocol
 * bump. The `packets-*` kinds are defined now (M1) but only handled starting
 * in a later milestone (M3) — until then a client sending them gets no reply.
 */
import type {
  InterpreterFrame,
  PacketBatchFrame,
  PacketCaptureStatus,
  PtyDataFrame,
  RendererControl,
  SessionInfo,
  SystemStatsSnapshot,
} from './ipc';

// ── Uint8Array <-> base64 (isomorphic: relies only on global atob/btoa, no
//    Node Buffer — this module is shared with the browser-side mobile
//    transport shim, M1) ────────────────────────────────────────────────────

/** Below the safe argument-count ceiling for `String.fromCharCode(...chunk)`. */
const CHUNK_SIZE = 0x8000;

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ── Wire frame (pty-data's Uint8Array -> base64 text) ────────────────────────

export interface WirePtyDataFrame {
  readonly type: 'pty-data';
  readonly data: string;
}

/** Same union as `InterpreterFrame`, except `pty-data` carries base64 text. */
export type WireInterpreterFrame = Exclude<InterpreterFrame, PtyDataFrame> | WirePtyDataFrame;

export function encodeFrame(frame: InterpreterFrame): WireInterpreterFrame {
  if (frame.type === 'pty-data') {
    return { type: 'pty-data', data: uint8ArrayToBase64(frame.data) };
  }
  return frame;
}

export function decodeFrame(frame: WireInterpreterFrame): InterpreterFrame {
  if (frame.type === 'pty-data') {
    return { type: 'pty-data', data: base64ToUint8Array(frame.data) };
  }
  return frame;
}

// ── Client -> server envelopes ───────────────────────────────────────────────

/** Must be the FIRST message on a new connection — anything else closes the socket. */
export interface AuthMessage {
  readonly kind: 'auth';
  readonly token: string;
}

export interface ListSessionsMessage {
  readonly kind: 'list-sessions';
}

export interface CreateSessionRequest {
  readonly kind: 'create-session';
  /** Client-minted correlation id, echoed back on `session-created`. */
  readonly requestId: string;
  readonly cwd?: string;
}

export interface DestroySessionRequest {
  readonly kind: 'destroy-session';
  readonly sessionId: string;
}

export interface RunCommandRequest {
  readonly kind: 'run-command';
  /** Client-minted id correlating every `frame`/`control` for this run. */
  readonly runId: string;
  readonly sessionId: string;
  readonly commandText: string;
}

/** Relays a `RendererControl` (cancel/requestRows/pty-input/close/...) for `runId`. */
export interface ControlMessage {
  readonly kind: 'control';
  readonly runId: string;
  readonly control: RendererControl;
}

/** Tell main whether THIS connection wants the 1Hz stats push (mirrors `setStatsPanelVisible`). */
export interface StatsVisibleMessage {
  readonly kind: 'stats-visible';
  readonly visible: boolean;
}

/** Ask for the last up-to-60 stats snapshots (FIFO reply, no correlation id — same precedent as `list-sessions`). */
export interface StatsHistoryRequest {
  readonly kind: 'stats-history';
}

/** Ask main to broker packet-capture frames to this connection (view-only — desktop owns start/stop). */
export interface PacketsSubscribeMessage {
  readonly kind: 'packets-subscribe';
}

export interface PacketsUnsubscribeMessage {
  readonly kind: 'packets-unsubscribe';
}

export type ClientToServerMessage =
  | AuthMessage
  | ListSessionsMessage
  | CreateSessionRequest
  | DestroySessionRequest
  | RunCommandRequest
  | ControlMessage
  | StatsVisibleMessage
  | StatsHistoryRequest
  | PacketsSubscribeMessage
  | PacketsUnsubscribeMessage;

// ── Server -> client envelopes ───────────────────────────────────────────────

export interface AuthOkMessage {
  readonly kind: 'auth-ok';
}

export interface AuthFailMessage {
  readonly kind: 'auth-fail';
}

export interface SessionListMessage {
  readonly kind: 'session-list';
  readonly sessions: readonly SessionInfo[];
}

export interface SessionCreatedReply {
  readonly kind: 'session-created';
  readonly requestId: string;
  readonly session: SessionInfo;
}

/** Relays one `InterpreterFrame` (wire-encoded) for `runId`. */
export interface FrameMessage {
  readonly kind: 'frame';
  readonly runId: string;
  readonly frame: WireInterpreterFrame;
}

/** The shared interpreter utilityProcess died — every session is gone. */
export interface SessionDeadMessage {
  readonly kind: 'session-dead';
  readonly logPath?: string | null;
}

/** One 1Hz stats push while this connection has `stats-visible:true`. */
export interface StatsUpdateMessage {
  readonly kind: 'stats-update';
  readonly snapshot: SystemStatsSnapshot;
}

/** Reply to `stats-history`. */
export interface StatsHistoryReply {
  readonly kind: 'stats-history';
  readonly snapshots: readonly SystemStatsSnapshot[];
}

/** `'idle'` = the desktop isn't capturing right now (distinct from any `PacketCaptureStatus`). */
export type RemotePacketStatus = PacketCaptureStatus | 'idle';

/** Same shape as the desktop's packet-port frames, except `status` widens to include `'idle'`. */
export type RemotePacketFrame = PacketBatchFrame | { readonly type: 'status'; readonly status: RemotePacketStatus };

/** One packet-capture frame (batch or status), relayed while this connection subscribes. */
export interface PacketFrameMessage {
  readonly kind: 'packet-frame';
  readonly frame: RemotePacketFrame;
}

export type ServerToClientMessage =
  | AuthOkMessage
  | AuthFailMessage
  | SessionListMessage
  | SessionCreatedReply
  | FrameMessage
  | SessionDeadMessage
  | StatsUpdateMessage
  | StatsHistoryReply
  | PacketFrameMessage;
