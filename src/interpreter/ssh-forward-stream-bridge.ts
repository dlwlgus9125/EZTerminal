/** Relays one main-owned loopback TCP socket to one ssh2 direct-tcpip channel. */

import {
  SSH_FORWARD_STREAM_HIGH_WATER,
  SSH_FORWARD_STREAM_LOW_WATER,
  SSH_FORWARD_STREAM_OPEN_TIMEOUT_MS,
  SshForwardError,
  sshForwardFailure,
  type MainToSshForwardStream,
  type SshForwardStreamToMain,
} from '../shared/ssh-forward';
import type { SshForwardChannelLike } from './external/ssh-client';
import type { SshSession } from './ssh-session';

const MAX_STREAM_CHUNK_BYTES = 256 * 1024;

export interface SshForwardPort {
  postMessage(message: SshForwardStreamToMain): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  on(event: 'close', listener: () => void): void;
  start(): void;
  close(): void;
}

export interface SshForwardStreamOpenInput {
  readonly sourceHost: '127.0.0.1';
  readonly sourcePort: number;
  readonly remoteHost: string;
  readonly remotePort: number;
}

function streamOpenFailure(error: unknown): SshForwardError {
  if (error instanceof SshForwardError) return error;
  let message = 'SSH forward stream failed';
  try {
    message = error instanceof Error ? error.message : String(error);
  } catch {
    // An exotic thrown value may itself fail string conversion.
  }
  return new SshForwardError('STREAM_OPEN_FAILED', message);
}

/** Error reporting is best-effort: a dead transferred port must never throw
 * back into the shared interpreter utility process. */
function postError(port: SshForwardPort, error: unknown): void {
  let message: SshForwardStreamToMain = {
    type: 'error',
    error: { code: 'INTERNAL', message: 'unknown SSH forwarding error' },
  };
  try {
    const failure = sshForwardFailure(error);
    if (!failure.ok) message = { type: 'error', error: failure.error };
  } catch {
    // Keep the cloneable INTERNAL fallback above.
  }
  try {
    port.postMessage(message);
  } catch {
    // Main already closed its half of the stream.
  }
}

export function rejectSshForwardStream(port: SshForwardPort, error: SshForwardError): void {
  postError(port, error);
  try {
    port.close();
  } catch {
    // Closing an already-torn-down MessagePort is idempotent at this boundary.
  }
}

export async function bridgeSshForwardStream(
  session: SshSession,
  input: SshForwardStreamOpenInput,
  port: SshForwardPort,
): Promise<void> {
  const openAbort = new AbortController();
  let openTimer: ReturnType<typeof setTimeout> | null = null;
  let channel: SshForwardChannelLike | null = null;
  let closed = false;

  const clearOpenTimer = (): void => {
    if (openTimer === null) return;
    clearTimeout(openTimer);
    openTimer = null;
  };
  const abortOpen = (): void => {
    try {
      openAbort.abort();
    } catch {
      // Abort listeners belong to the SSH adapter and cannot escape cleanup.
    }
  };
  const destroyChannel = (target: SshForwardChannelLike | null): void => {
    if (!target) return;
    try {
      target.destroy();
    } catch {
      // The SSH channel was already closed or failed while being destroyed.
    }
  };
  const closePort = (): void => {
    try {
      port.close();
    } catch {
      // The main side already won the close race.
    }
  };
  /** The only terminal state transition. Set `closed` before touching either
   * transport because destroy/close may synchronously emit their own events. */
  const cleanup = (destroy: boolean, shouldClosePort = true): void => {
    if (closed) return;
    closed = true;
    clearOpenTimer();
    abortOpen();
    if (destroy) destroyChannel(channel);
    if (shouldClosePort) closePort();
  };
  const fail = (error: unknown): void => {
    if (closed) return;
    postError(port, streamOpenFailure(error));
    cleanup(true);
  };
  const post = (message: SshForwardStreamToMain): boolean => {
    if (closed) return false;
    try {
      port.postMessage(message);
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  };

  try {
    port.on('close', () => cleanup(true, false));
    if (closed) return;
    // Start before awaiting ssh2 so a main-side timeout/close cancels the
    // pending open instead of leaving an unobserved forwardOut callback.
    port.start();
    if (closed) return;
    openTimer = setTimeout(() => {
      if (closed) return;
      abortOpen();
    }, SSH_FORWARD_STREAM_OPEN_TIMEOUT_MS);
    openTimer.unref?.();
  } catch (error) {
    fail(error);
    return;
  }

  let openedChannel: SshForwardChannelLike;
  try {
    openedChannel = await session.openForward(
      input.sourceHost,
      input.sourcePort,
      input.remoteHost,
      input.remotePort,
      openAbort.signal,
    );
  } catch (error) {
    clearOpenTimer();
    if (!closed) fail(error);
    return;
  }
  clearOpenTimer();
  if (closed) {
    // Port close may win while ssh2's uncancellable forwardOut callback is in
    // flight. The late channel never becomes owned by the live bridge.
    destroyChannel(openedChannel);
    return;
  }
  channel = openedChannel;

  let receivedFromMain = 0;
  let sentToMain = 0;
  let ackedByMain = 0;
  let pendingWriteAck = 0;
  let waitingForDrain = false;
  let sshPaused = false;

  const acknowledgeWrites = (): void => {
    if (closed) return;
    try {
      waitingForDrain = false;
      if (pendingWriteAck <= 0) return;
      post({ type: 'ack', bytes: pendingWriteAck });
    } catch (error) {
      fail(error);
    }
  };

  const onData = (chunk: Buffer): void => {
    if (closed) return;
    try {
      const data = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      sentToMain += data.byteLength;
      if (!post({ type: 'data', data, bytes: sentToMain })) return;
      if (!sshPaused && sentToMain - ackedByMain > SSH_FORWARD_STREAM_HIGH_WATER) {
        sshPaused = true;
        openedChannel.pause();
      }
    } catch (error) {
      fail(error);
    }
  };
  const onEnd = (): void => {
    if (closed) return;
    try {
      post({ type: 'end' });
    } catch (error) {
      fail(error);
    }
  };
  const onChannelClose = (): void => cleanup(false);
  const onChannelError = (error: Error): void => {
    if (closed) return;
    try {
      fail(new SshForwardError('STREAM_OPEN_FAILED', error.message));
    } catch (callbackError) {
      fail(callbackError);
    }
  };

  const onMessage = (event: { data: unknown }): void => {
    if (closed) return;
    try {
      const message = event.data as MainToSshForwardStream;
      if (message?.type === 'data') {
        if (!(message.data instanceof Uint8Array)
          || message.data.byteLength > MAX_STREAM_CHUNK_BYTES
          || message.bytes !== receivedFromMain + message.data.byteLength) {
          fail(new SshForwardError('STREAM_OPEN_FAILED', 'invalid SSH forward stream sequence'));
          return;
        }
        receivedFromMain = message.bytes;
        pendingWriteAck = receivedFromMain;
        const writable = openedChannel.write(Buffer.from(message.data));
        if (writable && !waitingForDrain) acknowledgeWrites();
        else waitingForDrain = true;
        return;
      }
      if (message?.type === 'ack') {
        if (!Number.isFinite(message.bytes) || message.bytes < ackedByMain) return;
        ackedByMain = Math.min(message.bytes, sentToMain);
        if (sshPaused && sentToMain - ackedByMain <= SSH_FORWARD_STREAM_LOW_WATER) {
          sshPaused = false;
          openedChannel.resume();
        }
        return;
      }
      if (message?.type === 'end') openedChannel.end();
    } catch (error) {
      fail(error);
    }
  };

  try {
    // Register the error/close containment first. If a later registration
    // fails, cleanup can safely destroy a channel that already has handlers.
    openedChannel.on('error', onChannelError);
    if (closed) return;
    openedChannel.on('close', onChannelClose);
    if (closed) return;
    openedChannel.on('drain', acknowledgeWrites);
    if (closed) return;
    openedChannel.on('data', onData);
    if (closed) return;
    openedChannel.on('end', onEnd);
    if (closed) return;
    port.on('message', onMessage);
    if (closed) return;
  } catch (error) {
    fail(error);
    return;
  }
  post({ type: 'ready' });
}
