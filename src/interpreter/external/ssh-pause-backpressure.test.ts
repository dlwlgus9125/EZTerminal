import { Server, utils as ssh2Utils } from 'ssh2';
import type { Connection, ServerChannel } from 'ssh2';
import { afterEach, describe, expect, it } from 'vitest';

import { createSshClient, type SshChannelLike } from './ssh-client';

/**
 * The load-bearing hermetic proof the gate demanded (docs/research/
 * 2026-07-03-codex-ssh-review.md B2): "pause -> SSH window freeze must be
 * proven with a REAL ssh2 Server+Client in-process — NEEDS-INSTALL-VERIFY
 * cannot be retired on documentation alone." A fake channel's pause()/resume()
 * are trivially correct (they're just method calls the test controls); the
 * open question was whether ssh2's `Channel.pause()` actually throttles the
 * SSH-protocol window (stops the flow the client is receiving) rather than
 * merely buffering already-arrived bytes locally in Node's Readable buffer.
 *
 * This spins up a REAL `ssh2.Server` on 127.0.0.1 (random port), connects
 * through the actual production adapter (`createSshClient`, external/ssh-
 * client.ts — the same code path `ssh-session.ts` drives), opens a shell, and
 * has the SERVER firehose data with no regard for the client's readiness. If
 * `pause()` only buffered locally, `received` would keep climbing (Node
 * unboundedly draining the socket into its internal buffer) even while
 * "paused" from the app's perspective. Actual SSH-level backpressure is
 * confirmed by observing zero growth for a sustained window.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await sleep(20);
  }
}

const HOST_KEY = ssh2Utils.generateKeyPairSync('ed25519', {}).private;

/** Start a throwaway ssh2 Server that accepts any auth and firehoses a shell
 * with 8KB writes on a tight setImmediate loop, ignoring write() backpressure
 * (a real "does not care about the reader" firehose). */
function startFirehoseServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = new Server({ hostKeys: [HOST_KEY] }, (client: Connection) => {
      client.on('authentication', (ctx) => ctx.accept());
      client.on('ready', () => {
        client.on('session', (acceptSession) => {
          const session = acceptSession();
          session.on('pty', (acceptPty) => acceptPty());
          session.on('shell', (acceptShell) => {
            const channel: ServerChannel = acceptShell();
            let stopped = false;
            const chunk = Buffer.alloc(8192, 'y');
            const pump = (): void => {
              if (stopped) return;
              channel.write(chunk);
              setImmediate(pump);
            };
            pump();
            channel.on('close', () => {
              stopped = true;
            });
          });
        });
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve({ server, port: address.port });
      else reject(new Error('server failed to bind to a port'));
    });
  });
}

describe('ssh2 real Server+Client — pause()/resume() SSH-window backpressure (gate B2)', () => {
  let activeServer: Server | null = null;
  let activeClientEnd: (() => void) | null = null;

  afterEach(() => {
    activeClientEnd?.();
    activeClientEnd = null;
    activeServer?.close();
    activeServer = null;
  });

  it('pause() freezes byte flow and resume() restores it — real SSH window, not local buffering', async () => {
    const { server, port } = await startFirehoseServer();
    activeServer = server;

    const client = createSshClient();
    const openedChannel = await new Promise<SshChannelLike>((resolve, reject) => {
      client.on('error', reject);
      client.on('ready', () => {
        client.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, ch) => {
          if (err || !ch) reject(err ?? new Error('shell() returned no channel'));
          else resolve(ch);
        });
      });
      client.connect({
        host: '127.0.0.1',
        port,
        username: 'test-user',
        hostVerifier: (_key, verify) => verify(true), // TOFU is out of scope here — only backpressure is under test
        authHandler: (_authsLeft, _partialSuccess, next) =>
          next({ type: 'password', username: 'test-user', password: 'test-password' }),
      });
    });
    activeClientEnd = () => client.end();

    let received = 0;
    openedChannel.on('data', (data: Buffer) => {
      received += data.length;
    });

    // The firehose is really flowing.
    await waitUntil(() => received > 256 * 1024, 10_000, 'initial firehose flow');

    // pause() — let any bytes already in flight (socket buffers) settle, then
    // assert the byte count is FROZEN over a sustained window.
    openedChannel.pause();
    await sleep(300);
    const afterSettle = received;
    await sleep(1_500);
    expect(received).toBe(afterSettle); // real backpressure: zero growth while paused

    // resume() restores the flow — the other half of the contract.
    openedChannel.resume();
    await waitUntil(() => received > afterSettle, 10_000, 'flow resuming after resume()');
    expect(received).toBeGreaterThan(afterSettle);

    openedChannel.close();
  }, 30_000);
});
