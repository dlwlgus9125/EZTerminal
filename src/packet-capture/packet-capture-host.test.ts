/**
 * packet-capture-host.ts's npcap-missing path only (B5). The rest of the host
 * (real `cap` capture loop) is a forked-utilityProcess entry that requires an
 * actual Electron ABI + Npcap device — not reproducible in a plain-Node vitest
 * run (see the module's own header comment). `cap` is mocked so its
 * `require('cap')` throws, exactly like a machine without Npcap/wpcap.dll.
 *
 * The module also reads `process.parentPort` (an Electron utilityProcess-only
 * global) at import time, which doesn't exist under plain Node — so a minimal
 * fake is installed before importing, mirroring how the real `init` message
 * hands the host its half of the port.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cap', () => {
  throw new Error("Cannot find module 'cap'");
});

type MessageHandler = (event: { data: unknown; ports: readonly unknown[] }) => void;

describe('packet-capture-host: npcap-missing path', () => {
  let messageHandler: MessageHandler | undefined;

  beforeEach(async () => {
    vi.resetModules();
    messageHandler = undefined;
    (process as unknown as { parentPort: { once: (event: string, cb: MessageHandler) => void } }).parentPort =
      {
        once: (_event, cb) => {
          messageHandler = cb;
        },
      };
    await import('./packet-capture-host');
  });

  it('sends status:npcap-missing over the port when `cap` fails to load', () => {
    expect(messageHandler).toBeDefined();

    const postMessage = vi.fn();
    const fakePort = { postMessage, on: vi.fn(), close: vi.fn() };
    messageHandler!({ data: undefined, ports: [fakePort] });

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ type: 'status', status: 'npcap-missing' });
  });
});
