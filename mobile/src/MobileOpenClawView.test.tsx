// No @testing-library/react in this repo — this exercises the component with
// a real React root + native DOM events instead, same pattern as
// src/renderer/TerminalContextMenu.test.tsx (root project's precedent).
// mobile/'s vitest config already runs the whole suite under jsdom (unlike
// the root project's node-by-default config), so no per-file pragma is
// needed here.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MobileOpenClawView } from './MobileOpenClawView';
import { WsEzTerminalTransport, type CreateSocket, type WsLike } from './transport/ws-ezterminal';

// Silences React's "not configured to support act()" warning for this file's
// synchronous createRoot().render() calls below.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom implements no layout, so `Element.prototype.scrollIntoView` doesn't
// exist — the Logs tab's follow-bottom effect calls it on every render while
// active, so every test needs the stub, not just the ones directly asserting
// on the logs tab.
Element.prototype.scrollIntoView = vi.fn();

/** A dropped-frame-to-microtask flush — request/reply methods
 * (`runOpenClawLifecycle`/`getOpenClawConfig`/`setOpenClawConfig`) resolve
 * their Promise from inside `handleServerMessage`, so the component's
 * `.then()` state update lands a microtask later than the synchronous
 * `triggerMessage` call; same precedent as ws-ezterminal.test.ts's own
 * `flush()` for chained continuations. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** React tracks whether an `<input>`'s `value` was set through its own
 * patched setter (from `onChange`) vs. a raw DOM assignment — a plain
 * `el.value = x` is silently ignored by the next render. Calling the
 * ORIGINAL (unpatched) `HTMLInputElement.prototype` setter directly bypasses
 * that tracking, so the subsequent `input` event is treated as genuine (same
 * fix noted in ws-ezterminal.ts's own module doc for the identical pitfall
 * on `HTMLTextAreaElement`). */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

// ── Fake socket (mirrors ws-ezterminal.test.ts's own fake — kept local/
// self-contained per this repo's convention of not sharing fakes across test
// files) ──────────────────────────────────────────────────────────────────
type Handler = (...args: never[]) => void;

class FakeSocket implements WsLike {
  readonly sent: string[] = [];
  closed = false;
  private readonly handlers: Record<'open' | 'message' | 'close' | 'error', Handler[]> = {
    open: [],
    message: [],
    close: [],
    error: [],
  };

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: never): void {
    this.handlers[type].push(listener as Handler);
  }

  triggerMessage(msg: unknown): void {
    const data = JSON.stringify(msg);
    for (const h of this.handlers.message) h({ data } as never);
  }

  sentKinds(): string[] {
    return this.sent.map((s) => (JSON.parse(s) as { kind: string }).kind);
  }
}

function makeAuthedTransport(): { transport: WsEzTerminalTransport; socket: FakeSocket } {
  let socket: FakeSocket;
  const createSocket: CreateSocket = () => {
    socket = new FakeSocket();
    return socket;
  };
  const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
  socket!.triggerMessage({ kind: 'auth-ok' });
  return { transport, socket: socket! };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function renderView(transport: WsEzTerminalTransport, onClose: () => void): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<MobileOpenClawView transport={transport} onClose={onClose} />);
  });
  return container;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe('MobileOpenClawView — status tab', () => {
  it('shows a loading state before the first status push arrives', () => {
    const { transport } = makeAuthedTransport();
    const el = renderView(transport, vi.fn());
    expect(el.querySelector('[data-testid="openclaw-status-section"]')?.textContent).toContain('확인 중');
  });

  it('subscribes to status on mount and unsubscribes on unmount', () => {
    const { transport, socket } = makeAuthedTransport();
    renderView(transport, vi.fn());
    expect(socket.sentKinds()).toContain('openclaw-status-subscribe');

    act(() => root!.unmount());
    root = null;
    expect(socket.sentKinds()).toContain('openclaw-status-unsubscribe');
  });

  it('renders state/version/port once a status push arrives', () => {
    const { transport, socket } = makeAuthedTransport();
    const el = renderView(transport, vi.fn());

    act(() => {
      socket.triggerMessage({ kind: 'openclaw-status', status: { state: 'running', port: 18789, version: '2026.6.11' } });
    });

    expect(el.querySelector('[data-testid="openclaw-status-dot"]')?.className).toContain('openclaw-status-dot--running');
    expect(el.querySelector('[data-testid="openclaw-status-version"]')?.textContent).toContain('2026.6.11');
    expect(el.querySelector('[data-testid="openclaw-status-port"]')?.textContent).toContain('18789');
  });

  it('shows install guidance and disables every lifecycle button when not-installed', () => {
    const { transport, socket } = makeAuthedTransport();
    const el = renderView(transport, vi.fn());

    act(() => {
      socket.triggerMessage({ kind: 'openclaw-status', status: { state: 'not-installed', port: 18789 } });
    });

    expect(el.querySelector('[data-testid="openclaw-guidance"]')).toBeTruthy();
    expect(el.querySelector<HTMLButtonElement>('[data-testid="openclaw-btn-start"]')!.disabled).toBe(true);
    expect(el.querySelector<HTMLButtonElement>('[data-testid="openclaw-btn-stop"]')!.disabled).toBe(true);
    expect(el.querySelector<HTMLButtonElement>('[data-testid="openclaw-btn-restart"]')!.disabled).toBe(true);
  });

  it('shows a start CTA when stopped: Start enabled, Stop/Restart disabled', () => {
    const { transport, socket } = makeAuthedTransport();
    const el = renderView(transport, vi.fn());

    act(() => {
      socket.triggerMessage({ kind: 'openclaw-status', status: { state: 'stopped', port: 18789 } });
    });

    expect(el.querySelector('[data-testid="openclaw-guidance"]')).toBeTruthy();
    expect(el.querySelector<HTMLButtonElement>('[data-testid="openclaw-btn-start"]')!.disabled).toBe(false);
    expect(el.querySelector<HTMLButtonElement>('[data-testid="openclaw-btn-stop"]')!.disabled).toBe(true);
    expect(el.querySelector<HTMLButtonElement>('[data-testid="openclaw-btn-restart"]')!.disabled).toBe(true);
  });

  it('when running: Start disabled, Stop/Restart enabled; clicking Stop sends openclaw-lifecycle', () => {
    const { transport, socket } = makeAuthedTransport();
    const el = renderView(transport, vi.fn());

    act(() => {
      socket.triggerMessage({ kind: 'openclaw-status', status: { state: 'running', port: 18789 } });
    });

    const startBtn = el.querySelector<HTMLButtonElement>('[data-testid="openclaw-btn-start"]')!;
    const stopBtn = el.querySelector<HTMLButtonElement>('[data-testid="openclaw-btn-stop"]')!;
    expect(startBtn.disabled).toBe(true);
    expect(stopBtn.disabled).toBe(false);

    act(() => stopBtn.click());

    const lastMsg = JSON.parse(socket.sent.at(-1)!) as { kind: string; action: string };
    expect(lastMsg.kind).toBe('openclaw-lifecycle');
    expect(lastMsg.action).toBe('stop');
    expect(stopBtn.disabled).toBe(true); // busy while the call is in flight
  });

  it('surfaces a lifecycle failure as inline guidance text, not a thrown error', async () => {
    const { transport, socket } = makeAuthedTransport();
    const el = renderView(transport, vi.fn());
    act(() => {
      socket.triggerMessage({ kind: 'openclaw-status', status: { state: 'running', port: 18789 } });
    });
    const stopBtn = el.querySelector<HTMLButtonElement>('[data-testid="openclaw-btn-stop"]')!;
    act(() => stopBtn.click());
    const requestId = (JSON.parse(socket.sent.at(-1)!) as { requestId: string }).requestId;

    await act(async () => {
      socket.triggerMessage({
        kind: 'openclaw-lifecycle-result',
        requestId,
        result: { ok: false, stderr: 'gateway busy' },
      });
      await flush();
    });

    expect(el.querySelector('[data-testid="openclaw-lifecycle-error"]')?.textContent).toContain('gateway busy');
  });

  it('close button fires onClose', () => {
    const { transport } = makeAuthedTransport();
    const onClose = vi.fn();
    const el = renderView(transport, onClose);
    act(() => el.querySelector<HTMLButtonElement>('[data-testid="mobile-openclaw-close"]')!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('MobileOpenClawView — logs tab', () => {
  it('subscribes only while the logs tab is active, and renders pushed lines', () => {
    const { transport, socket } = makeAuthedTransport();
    const el = renderView(transport, vi.fn());
    expect(socket.sentKinds()).not.toContain('openclaw-logs-subscribe');

    act(() => el.querySelector<HTMLButtonElement>('[data-testid="openclaw-tab-logs"]')!.click());
    expect(socket.sentKinds()).toContain('openclaw-logs-subscribe');

    act(() => {
      socket.triggerMessage({
        kind: 'openclaw-log-lines',
        lines: [{ time: 't1', level: 'WARN', message: 'careful' }],
      });
    });
    const line = el.querySelector('[data-testid="openclaw-log-line"]');
    expect(line?.textContent).toContain('careful');
    expect(line?.className).toContain('openclaw-log-line--warn');
  });

  it('unsubscribes when switching away from the logs tab', () => {
    const { transport, socket } = makeAuthedTransport();
    const el = renderView(transport, vi.fn());
    act(() => el.querySelector<HTMLButtonElement>('[data-testid="openclaw-tab-logs"]')!.click());
    expect(socket.sentKinds()).toContain('openclaw-logs-subscribe');

    act(() => el.querySelector<HTMLButtonElement>('[data-testid="openclaw-tab-status"]')!.click());
    expect(socket.sentKinds()).toContain('openclaw-logs-unsubscribe');
  });
});

describe('MobileOpenClawView — settings tab', () => {
  it('requests config on tab open and shows unset fields as empty', async () => {
    const { transport, socket } = makeAuthedTransport();
    const el = renderView(transport, vi.fn());

    act(() => el.querySelector<HTMLButtonElement>('[data-testid="openclaw-tab-settings"]')!.click());
    expect(socket.sentKinds()).toContain('openclaw-config-get');
    const requestId = (JSON.parse(socket.sent.find((s) => (JSON.parse(s) as { kind: string }).kind === 'openclaw-config-get')!) as {
      requestId: string;
    }).requestId;

    await act(async () => {
      socket.triggerMessage({
        kind: 'openclaw-config-reply',
        requestId,
        config: { 'agents.defaults.model': 'unset', 'gateway.port': 'unset' },
      });
      await flush();
    });

    expect(el.querySelector<HTMLInputElement>('[data-testid="openclaw-config-model"]')!.value).toBe('');
    expect(el.querySelector<HTMLInputElement>('[data-testid="openclaw-config-port"]')!.value).toBe('');
  });

  it('saving a config field sends openclaw-config-set and shows the restart banner on success', async () => {
    const { transport, socket } = makeAuthedTransport();
    const el = renderView(transport, vi.fn());
    act(() => el.querySelector<HTMLButtonElement>('[data-testid="openclaw-tab-settings"]')!.click());
    const getRequestId = (JSON.parse(socket.sent.at(-1)!) as { requestId: string }).requestId;
    await act(async () => {
      socket.triggerMessage({
        kind: 'openclaw-config-reply',
        requestId: getRequestId,
        config: { 'agents.defaults.model': 'openai/gpt-5.5', 'gateway.port': 'unset' },
      });
      await flush();
    });

    const modelInput = el.querySelector<HTMLInputElement>('[data-testid="openclaw-config-model"]')!;
    act(() => setInputValue(modelInput, 'openai/gpt-6'));
    act(() => el.querySelector<HTMLButtonElement>('[data-testid="openclaw-config-save-model"]')!.click());

    const setMsg = JSON.parse(socket.sent.at(-1)!) as { kind: string; key: string; value: string; requestId: string };
    expect(setMsg.kind).toBe('openclaw-config-set');
    expect(setMsg.key).toBe('agents.defaults.model');
    expect(setMsg.value).toBe('openai/gpt-6');

    await act(async () => {
      socket.triggerMessage({
        kind: 'openclaw-config-set-reply',
        requestId: setMsg.requestId,
        result: { ok: true, restartRequired: true },
      });
      await flush();
    });

    expect(el.querySelector('[data-testid="openclaw-restart-banner"]')).toBeTruthy();
  });
});

/** Every `openclaw-chat-ticket` request's `requestId`, in send order — used to
 * assert a reload/retry mints a BRAND NEW ticket rather than reusing one. */
function chatTicketRequestIds(socket: FakeSocket): string[] {
  return socket.sent
    .map((s) => JSON.parse(s) as { kind: string; requestId: string })
    .filter((m) => m.kind === 'openclaw-chat-ticket')
    .map((m) => m.requestId);
}

function replyToLastChatTicket(
  socket: FakeSocket,
  reply: { ticket: string | null; proxyPort: number; token: string | null },
): void {
  const requestId = chatTicketRequestIds(socket).at(-1)!;
  socket.triggerMessage({ kind: 'openclaw-chat-ticket-reply', requestId, ...reply });
}

describe('MobileOpenClawView — chat tab (M5)', () => {
  it('shows guidance + a Start CTA when the gateway is not running, without requesting a ticket', () => {
    const { transport, socket } = makeAuthedTransport();
    const el = renderView(transport, vi.fn());
    act(() => {
      socket.triggerMessage({ kind: 'openclaw-status', status: { state: 'stopped', port: 18789 } });
    });

    act(() => el.querySelector<HTMLButtonElement>('[data-testid="openclaw-tab-chat"]')!.click());

    expect(chatTicketRequestIds(socket)).toHaveLength(0);
    const guidance = el.querySelector('[data-testid="openclaw-chat-guidance"]');
    expect(guidance?.textContent).toContain('중지됨');

    act(() => el.querySelector<HTMLButtonElement>('[data-testid="openclaw-chat-start"]')!.click());
    const lastMsg = JSON.parse(socket.sent.at(-1)!) as { kind: string; action: string };
    expect(lastMsg.kind).toBe('openclaw-lifecycle');
    expect(lastMsg.action).toBe('start');
  });

  it('requests a ticket on activation while running, and assembles the iframe URL from the host, proxy port, ticket, and fragment token', async () => {
    const { transport, socket } = makeAuthedTransport();
    const el = renderView(transport, vi.fn());
    act(() => {
      socket.triggerMessage({ kind: 'openclaw-status', status: { state: 'running', port: 18789 } });
    });

    act(() => el.querySelector<HTMLButtonElement>('[data-testid="openclaw-tab-chat"]')!.click());
    expect(chatTicketRequestIds(socket)).toHaveLength(1);

    await act(async () => {
      replyToLastChatTicket(socket, { ticket: 'tick1', proxyPort: 7421, token: 'tok1' });
      await flush();
    });

    const frame = el.querySelector<HTMLIFrameElement>('[data-testid="openclaw-chat-frame"]');
    expect(frame?.src).toBe('http://x:7421/?t=tick1#token=tok1');
  });

  it('shows unavailable guidance on a {null,0,null} ticket reply, and retry mints a fresh ticket', async () => {
    const { transport, socket } = makeAuthedTransport();
    const el = renderView(transport, vi.fn());
    act(() => {
      socket.triggerMessage({ kind: 'openclaw-status', status: { state: 'running', port: 18789 } });
    });
    act(() => el.querySelector<HTMLButtonElement>('[data-testid="openclaw-tab-chat"]')!.click());

    await act(async () => {
      replyToLastChatTicket(socket, { ticket: null, proxyPort: 0, token: null });
      await flush();
    });
    expect(el.querySelector('[data-testid="openclaw-chat-unavailable"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="openclaw-chat-frame"]')).toBeFalsy();

    act(() => el.querySelector<HTMLButtonElement>('[data-testid="openclaw-chat-retry"]')!.click());
    const requestIds = chatTicketRequestIds(socket);
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).not.toBe(requestIds[1]);

    await act(async () => {
      replyToLastChatTicket(socket, { ticket: 'tick2', proxyPort: 7421, token: 'tok2' });
      await flush();
    });
    expect(el.querySelector<HTMLIFrameElement>('[data-testid="openclaw-chat-frame"]')?.src).toBe(
      'http://x:7421/?t=tick2#token=tok2',
    );
  });

  it('reload on a loaded chat mints a brand-new ticket and swaps the iframe to it, never reusing the old one', async () => {
    const { transport, socket } = makeAuthedTransport();
    const el = renderView(transport, vi.fn());
    act(() => {
      socket.triggerMessage({ kind: 'openclaw-status', status: { state: 'running', port: 18789 } });
    });
    act(() => el.querySelector<HTMLButtonElement>('[data-testid="openclaw-tab-chat"]')!.click());
    await act(async () => {
      replyToLastChatTicket(socket, { ticket: 'tick1', proxyPort: 7421, token: 'tok1' });
      await flush();
    });
    expect(el.querySelector<HTMLIFrameElement>('[data-testid="openclaw-chat-frame"]')?.src).toBe(
      'http://x:7421/?t=tick1#token=tok1',
    );

    act(() => el.querySelector<HTMLButtonElement>('[data-testid="openclaw-chat-reload"]')!.click());
    const requestIds = chatTicketRequestIds(socket);
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).not.toBe(requestIds[1]);

    await act(async () => {
      replyToLastChatTicket(socket, { ticket: 'tick2', proxyPort: 7421, token: 'tok2' });
      await flush();
    });
    expect(el.querySelector<HTMLIFrameElement>('[data-testid="openclaw-chat-frame"]')?.src).toBe(
      'http://x:7421/?t=tick2#token=tok2',
    );
  });

  it('"브라우저로 열기" mints its OWN fresh ticket rather than reusing the iframe\'s (a single-use ticket already redeemed by the iframe would come back "invalid" in a second, separate browser context)', async () => {
    const { transport, socket } = makeAuthedTransport();
    const el = renderView(transport, vi.fn());
    act(() => {
      socket.triggerMessage({ kind: 'openclaw-status', status: { state: 'running', port: 18789 } });
    });
    act(() => el.querySelector<HTMLButtonElement>('[data-testid="openclaw-tab-chat"]')!.click());
    await act(async () => {
      replyToLastChatTicket(socket, { ticket: 'tick1', proxyPort: 7421, token: 'tok1' });
      await flush();
    });

    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    act(() => el.querySelector<HTMLButtonElement>('[data-testid="openclaw-chat-open-browser"]')!.click());

    const requestIds = chatTicketRequestIds(socket);
    expect(requestIds).toHaveLength(2); // the iframe's ticket, then a separate one for this click
    expect(requestIds[0]).not.toBe(requestIds[1]);
    expect(openSpy).not.toHaveBeenCalled(); // the fresh ticket hasn't replied yet

    await act(async () => {
      replyToLastChatTicket(socket, { ticket: 'tick2', proxyPort: 7421, token: 'tok2' });
      await flush();
    });
    expect(openSpy).toHaveBeenCalledWith('http://x:7421/?t=tick2#token=tok2', '_blank');
    openSpy.mockRestore();
  });
});
