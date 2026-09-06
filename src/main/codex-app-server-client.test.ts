import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  CodexAppServerClient,
  type CodexProcessGuardian,
} from './codex-app-server-client';

interface RpcFrame {
  readonly jsonrpc?: string;
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

class FakeCodexChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly frames: RpcFrame[] = [];
  readonly pid = 4242;
  killed = false;
  onFrame: (frame: RpcFrame) => void = () => undefined;

  constructor() {
    super();
    this.stdin.setEncoding('utf8');
    let buffer = '';
    this.stdin.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const frame = JSON.parse(line) as RpcFrame;
        this.frames.push(frame);
        this.onFrame(frame);
      }
    });
  }

  asChildProcess(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }

  send(frame: RpcFrame): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`);
  }

  sendRaw(value: string): void {
    this.stdout.write(value);
  }

  respondTo(frame: RpcFrame, result: unknown): void {
    if (frame.id === undefined) throw new Error('Cannot respond to a notification.');
    this.send({ jsonrpc: '2.0', id: frame.id, result });
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  crash(code = 1): void {
    this.killed = true;
    this.emit('exit', code, null);
  }
}

function initializationResponder(child: FakeCodexChild, next?: (frame: RpcFrame) => void): void {
  child.onFrame = (frame) => {
    if (frame.method === 'initialize') {
      child.respondTo(frame, {
        userAgent: 'codex-cli/0.152.1',
        codexHome: 'C:\\Users\\tester\\.codex',
        platformFamily: 'windows',
        platformOs: 'windows',
      });
      return;
    }
    next?.(frame);
  };
}

type RpcFrameFactory = (request: RpcFrame) => RpcFrame;

describe('CodexAppServerClient', () => {
  it('launches reviewed argv, enrolls the process, and performs initialize/initialized', async () => {
    const child = new FakeCodexChild();
    initializationResponder(child, (frame) => {
      if (frame.method === 'model/list') child.respondTo(frame, { data: [], nextCursor: null });
    });
    const spawnProcess = vi.fn(() => child.asChildProcess());
    const guardian: CodexProcessGuardian = {
      createGroup: vi.fn(async () => undefined),
      terminateGroup: vi.fn(async () => undefined),
    };
    const client = new CodexAppServerClient({
      command: 'C:\\Tools\\codex.exe',
      environment: { PATH: 'C:\\Tools', OPENAI_API_KEY: 'process-only' },
      spawnProcess,
      processGuardian: guardian,
      processGroupId: 'provider:codex',
    });

    await expect(client.request('model/list', { limit: 100 })).resolves.toEqual({ data: [], nextCursor: null });
    expect(spawnProcess).toHaveBeenCalledWith(
      'C:\\Tools\\codex.exe',
      ['app-server'],
      { PATH: 'C:\\Tools', OPENAI_API_KEY: 'process-only' },
    );
    expect(guardian.createGroup).toHaveBeenCalledWith('provider:codex', 4242, undefined);
    expect(child.frames[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        clientInfo: { name: 'ezterminal', title: 'EZTerminal', version: '2' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
    });
    expect(child.frames[1]).toEqual({ jsonrpc: '2.0', method: 'initialized' });
    expect(child.frames[2]).toMatchObject({ method: 'model/list', params: { limit: 100 } });

    await client.dispose();
    expect(guardian.terminateGroup).toHaveBeenCalledWith('provider:codex');
  });

  it('fails closed instead of accepting an initialize response without a result or error', async () => {
    const child = new FakeCodexChild();
    child.onFrame = (frame) => {
      if (frame.method === 'initialize') child.send({ id: frame.id });
    };
    const client = new CodexAppServerClient({ spawnProcess: () => child.asChildProcess() });

    try {
      await expect(client.notify('client/ready')).rejects.toThrow(/JSON-RPC response/u);
      expect(child.killed).toBe(true);
      expect(child.frames).not.toContainEqual({ jsonrpc: '2.0', method: 'initialized' });
    } finally {
      await client.dispose();
    }
  });

  it('accepts omitted JSON-RPC headers and the stable initialize result fields', async () => {
    const child = new FakeCodexChild();
    child.onFrame = (frame) => {
      if (frame.method === 'initialize') {
        child.send({
          id: frame.id,
          result: {
            userAgent: 'codex-cli/0.153.4',
            platformFamily: 'windows',
            platformOs: 'windows',
            futureField: { accepted: true },
          },
        });
        return;
      }
      if (frame.method === 'model/list') child.send({ id: frame.id, result: { data: [] } });
    };
    const client = new CodexAppServerClient({ spawnProcess: () => child.asChildProcess() });

    await expect(client.request('model/list')).resolves.toEqual({ data: [] });
    expect(child.frames).toContainEqual({ jsonrpc: '2.0', method: 'initialized' });
    await client.dispose();
  });

  it.each<readonly [string, RpcFrameFactory]>([
    ['a wrong JSON-RPC version', (request) => ({ jsonrpc: '1.0', id: request.id, result: {} })],
    ['both result and error', (request) => ({
      jsonrpc: '2.0',
      id: request.id,
      result: {},
      error: { code: -32_000, message: 'must not coexist with result' },
    })],
    ['neither result nor error', (request) => ({ jsonrpc: '2.0', id: request.id })],
    ['a string response id', (request) => ({ id: String(request.id), result: {} })],
    ['a fractional response id', () => ({ id: 1.5, result: {} })],
    ['an unsafe response id', () => ({ id: Number.MAX_SAFE_INTEGER + 1, result: {} })],
    ['a non-object error', (request) => ({ id: request.id, error: 'server error' })],
    ['a non-integer error code', (request) => ({
      id: request.id,
      error: { code: -32_000.5, message: 'server error' },
    })],
    ['a non-string error message', (request) => ({
      id: request.id,
      error: { code: -32_000, message: 42 },
    })],
  ])('fails closed on a response with %s', async (_label, malformedResponse) => {
    const child = new FakeCodexChild();
    initializationResponder(child, (frame) => {
      if (frame.method !== 'thread/start') return;
      child.send(malformedResponse(frame));
      child.respondTo(frame, { thread: { id: 'must-not-resolve' } });
    });
    const reportError = vi.fn();
    const client = new CodexAppServerClient({
      spawnProcess: () => child.asChildProcess(),
      reportError,
    });

    try {
      await expect(client.request('thread/start')).rejects.toThrow(/invalid JSON-RPC response/u);
      expect(child.killed).toBe(true);
      expect(reportError).toHaveBeenCalledWith(expect.stringContaining('invalid JSON-RPC response'));
    } finally {
      await client.dispose();
    }
  });

  it('fails closed on a valid response envelope with an unknown request id', async () => {
    const child = new FakeCodexChild();
    initializationResponder(child, (frame) => {
      if (frame.method !== 'thread/start') return;
      child.send({ id: 99_999, result: { thread: { id: 'unknown' } } });
      child.respondTo(frame, { thread: { id: 'must-not-resolve' } });
    });
    const client = new CodexAppServerClient({ spawnProcess: () => child.asChildProcess() });

    try {
      await expect(client.request('thread/start')).rejects.toThrow(/unknown JSON-RPC response id 99999/u);
      expect(child.killed).toBe(true);
    } finally {
      await client.dispose();
    }
  });

  it.each([
    ['a non-object result', null],
    ['a missing user agent', { platformFamily: 'windows', platformOs: 'windows' }],
    ['an empty user agent', { userAgent: ' ', platformFamily: 'windows', platformOs: 'windows' }],
    ['a missing platform family', { userAgent: 'codex-cli/0.153.4', platformOs: 'windows' }],
    ['a missing platform OS', { userAgent: 'codex-cli/0.153.4', platformFamily: 'windows' }],
  ])('rejects initialize with %s before sending initialized', async (_label, result) => {
    const child = new FakeCodexChild();
    child.onFrame = (frame) => {
      if (frame.method === 'initialize') child.send({ id: frame.id, result });
    };
    const client = new CodexAppServerClient({ spawnProcess: () => child.asChildProcess() });

    try {
      await expect(client.notify('client/ready')).rejects.toThrow(/invalid initialize result/u);
      expect(child.killed).toBe(true);
      expect(child.frames).not.toContainEqual({ jsonrpc: '2.0', method: 'initialized' });
      expect(child.frames.some((frame) => frame.method === 'client/ready')).toBe(false);
    } finally {
      await client.dispose();
    }
  });

  it('revalidates before spawn and does not launch after descriptor drift', async () => {
    const spawnProcess = vi.fn(() => new FakeCodexChild().asChildProcess());
    const beforeSpawn = vi.fn(async () => {
      throw new Error('Executable version changed after review.');
    });
    const client = new CodexAppServerClient({
      command: 'C:\\Tools\\codex.exe',
      argv: ['app-server'],
      environment: { PATH: 'C:\\Tools' },
      beforeSpawn,
      spawnProcess,
    });

    await expect(client.request('model/list')).rejects.toThrow(/changed after review/);
    expect(beforeSpawn).toHaveBeenCalledOnce();
    expect(spawnProcess).not.toHaveBeenCalled();
    await client.dispose();
  });

  it('revalidates a changed executable before respawn and blocks an incompatible second launch', async () => {
    const reviewedExecutable = {
      path: 'C:\\Tools\\codex.exe',
      version: '0.152.1',
    };
    let preflightResult = reviewedExecutable;
    const child = new FakeCodexChild();
    initializationResponder(child, (frame) => {
      if (frame.method === 'model/list') child.respondTo(frame, { data: [], nextCursor: null });
    });
    const beforeSpawn = vi.fn(async () => {
      if (
        preflightResult.path !== reviewedExecutable.path
        || preflightResult.version !== reviewedExecutable.version
      ) {
        throw new Error(
          `Codex ${preflightResult.version} at ${preflightResult.path} is incompatible with the reviewed executable.`,
        );
      }
    });
    const spawnProcess = vi.fn(() => child.asChildProcess());
    const client = new CodexAppServerClient({
      command: reviewedExecutable.path,
      beforeSpawn,
      spawnProcess,
    });

    await expect(client.request('model/list')).resolves.toEqual({ data: [], nextCursor: null });
    expect(beforeSpawn).toHaveBeenCalledOnce();
    expect(spawnProcess).toHaveBeenCalledOnce();

    child.crash(9);
    preflightResult = {
      path: 'D:\\Unreviewed\\codex.exe',
      version: '0.152.0',
    };

    await expect(client.request('model/list')).rejects.toThrow(
      /Codex 0\.152\.0 at D:\\Unreviewed\\codex\.exe is incompatible/u,
    );
    expect(beforeSpawn).toHaveBeenCalledTimes(2);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    await client.dispose();
  });

  it('forwards request cancellation into pre-spawn verification', async () => {
    const spawnProcess = vi.fn(() => new FakeCodexChild().asChildProcess());
    let observedSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const beforeSpawn = vi.fn(async (signal?: AbortSignal) => {
      observedSignal = signal;
      markStarted?.();
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('verification cancelled')), { once: true });
      });
    });
    const client = new CodexAppServerClient({ beforeSpawn, spawnProcess });
    const controller = new AbortController();

    const request = client.request('model/list', {}, { signal: controller.signal });
    await started;
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(observedSignal).toBe(controller.signal);
    expect(observedSignal?.aborted).toBe(true);
    expect(spawnProcess).not.toHaveBeenCalled();
    await client.dispose();
  });

  it('does not spawn a late child when dispose wins a pending pre-spawn check', async () => {
    const spawnProcess = vi.fn(() => new FakeCodexChild().asChildProcess());
    let releaseVerification: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const verificationStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const beforeSpawn = vi.fn(async () => {
      markStarted?.();
      await new Promise<void>((resolve) => { releaseVerification = resolve; });
    });
    const client = new CodexAppServerClient({ beforeSpawn, spawnProcess });

    const request = client.request('model/list');
    await verificationStarted;
    await client.dispose();
    releaseVerification?.();

    await expect(request).rejects.toThrow(/client is disposed/u);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('redacts stderr diagnostics before they reach the reporter', async () => {
    const child = new FakeCodexChild();
    initializationResponder(child, (frame) => {
      if (frame.method === 'model/list') child.respondTo(frame, { data: [] });
    });
    const reportError = vi.fn();
    const client = new CodexAppServerClient({
      spawnProcess: () => child.asChildProcess(),
      reportError,
    });
    await client.request('model/list');
    child.stderr.write('OPENAI_API_KEY=sk-proj-supersecretvalue Authorization: Bearer secret-bearer-value');

    await vi.waitFor(() => expect(reportError).toHaveBeenCalled());
    expect(JSON.stringify(reportError.mock.calls)).not.toMatch(/supersecretvalue|secret-bearer-value/u);
    await client.dispose();
  });

  it('dispatches notifications and answers bidirectional server requests', async () => {
    const child = new FakeCodexChild();
    initializationResponder(child, (frame) => {
      if (frame.method === 'thread/read') child.respondTo(frame, { thread: { id: 'thread-1' } });
    });
    const client = new CodexAppServerClient({ spawnProcess: () => child.asChildProcess() });
    const notification = vi.fn();
    client.onNotification('turn/started', notification);
    client.onServerRequest('item/commandExecution/requestApproval', async (params, context) => ({
      decision: (params as { allow: boolean }).allow ? 'accept' : 'decline',
      echoedId: context.id,
    }));
    await client.request('thread/read', { threadId: 'thread-1' });

    child.send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } });
    child.send({
      id: 'approval-7',
      method: 'item/commandExecution/requestApproval',
      params: { allow: true },
    });
    await vi.waitFor(() => {
      expect(notification).toHaveBeenCalledWith(
        { threadId: 'thread-1', turn: { id: 'turn-1' } },
        'turn/started',
      );
      expect(child.frames).toContainEqual({
        jsonrpc: '2.0',
        id: 'approval-7',
        result: { decision: 'accept', echoedId: 'approval-7' },
      });
    });
    await client.dispose();
  });

  it('returns method-not-found and handler errors to the server without corrupting the stream', async () => {
    const child = new FakeCodexChild();
    initializationResponder(child, (frame) => {
      if (frame.method === 'thread/list') child.respondTo(frame, { data: [] });
    });
    const client = new CodexAppServerClient({ spawnProcess: () => child.asChildProcess() });
    client.onServerRequest('throws', () => { throw new Error('approval handler failed'); });
    await client.request('thread/list');
    child.send({ id: 90, method: 'unknown/request', params: {} });
    child.send({ id: 91, method: 'throws', params: {} });
    await vi.waitFor(() => {
      expect(child.frames).toContainEqual(expect.objectContaining({
        id: 90,
        error: { code: -32601, message: expect.stringContaining('unknown/request') },
      }));
      expect(child.frames).toContainEqual(expect.objectContaining({
        id: 91,
        error: { code: -32000, message: 'approval handler failed' },
      }));
    });
    await client.dispose();
  });

  it('reports malformed frames, preserves framing across chunks, and decodes RPC errors', async () => {
    const child = new FakeCodexChild();
    initializationResponder(child, (frame) => {
      if (frame.method === 'fails') {
        child.send({
          id: frame.id,
          error: { code: -32042, message: 'model unavailable', data: { model: 'missing' } },
        });
      }
    });
    const reportError = vi.fn();
    const client = new CodexAppServerClient({ spawnProcess: () => child.asChildProcess(), reportError });
    const seen = vi.fn();
    client.onNotification('split', seen);
    const failure = client.request('fails');
    child.sendRaw('{not json}\n');
    child.sendRaw('{"method":"split","params":{"value":');
    child.sendRaw('42}}\n');
    await expect(failure).rejects.toMatchObject({
      name: 'CodexJsonRpcError',
      method: 'fails',
      code: -32042,
      message: 'model unavailable',
      data: { model: 'missing' },
    });
    await vi.waitFor(() => expect(seen).toHaveBeenCalledWith({ value: 42 }, 'split'));
    expect(reportError).toHaveBeenCalledWith(expect.stringContaining('malformed JSON-RPC'));
    await client.dispose();
  });

  it('fails closed on an oversized input frame', async () => {
    const child = new FakeCodexChild();
    initializationResponder(child, () => undefined);
    const reportError = vi.fn();
    const client = new CodexAppServerClient({
      spawnProcess: () => child.asChildProcess(),
      maxLineBytes: 512,
      reportError,
    });
    const pending = client.request('never-responds');
    await vi.waitFor(() => expect(child.frames.some((frame) => frame.method === 'never-responds')).toBe(true));
    child.sendRaw('x'.repeat(513));
    await expect(pending).rejects.toThrow(/exceeds 512 bytes/);
    expect(child.killed).toBe(true);
    expect(reportError).toHaveBeenCalledWith(expect.stringContaining('exceeds 512 bytes'));
    await client.dispose();
  });

  it('ignores a valid late response for a locally cancelled request without closing the connection', async () => {
    const child = new FakeCodexChild();
    initializationResponder(child, (frame) => {
      if (frame.method === 'after-late-response') child.respondTo(frame, { ok: true });
    });
    const reportError = vi.fn();
    const spawnProcess = vi.fn(() => child.asChildProcess());
    const client = new CodexAppServerClient({
      spawnProcess,
      reportError,
    });
    const controller = new AbortController();
    const cancelled = client.request('cancel-me', {}, { signal: controller.signal, timeoutMs: 1_000 });
    await vi.waitFor(() => expect(child.frames.some((frame) => frame.method === 'cancel-me')).toBe(true));
    const cancelledFrame = child.frames.find((frame) => frame.method === 'cancel-me');
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    if (!cancelledFrame) throw new Error('cancelled request was not written');
    child.respondTo(cancelledFrame, { too: 'late' });

    await vi.waitFor(() => expect(reportError).toHaveBeenCalledWith(expect.stringContaining('retired JSON-RPC request id')));
    expect(child.killed).toBe(false);
    await expect(client.request('after-late-response')).resolves.toEqual({ ok: true });
    expect(spawnProcess).toHaveBeenCalledOnce();
    await client.dispose();
  });

  it.each([
    ['notification', { jsonrpc: '1.0', method: 'turn/started', params: {} }],
    ['server request', {
      jsonrpc: '1.0',
      id: 'approval-invalid-version',
      method: 'item/commandExecution/requestApproval',
      params: {},
    }],
  ])('fails closed on a %s with a wrong JSON-RPC version', async (_label, frame) => {
    const child = new FakeCodexChild();
    initializationResponder(child, (request) => {
      if (request.method === 'thread/read') child.respondTo(request, { thread: { id: 'thread-1' } });
    });
    const reportError = vi.fn();
    const client = new CodexAppServerClient({
      spawnProcess: () => child.asChildProcess(),
      reportError,
    });
    await client.request('thread/read');

    child.send(frame);

    await vi.waitFor(() => expect(child.killed).toBe(true));
    expect(reportError).toHaveBeenCalledWith(expect.stringContaining('invalid JSON-RPC message'));
    await client.dispose();
  });

  it('ignores a valid late response for a timed-out request without closing the connection', async () => {
    const child = new FakeCodexChild();
    initializationResponder(child, (frame) => {
      if (frame.method === 'after-late-response') child.respondTo(frame, { ok: true });
    });
    const reportError = vi.fn();
    const spawnProcess = vi.fn(() => child.asChildProcess());
    const client = new CodexAppServerClient({
      spawnProcess,
      requestTimeoutMs: 20,
      reportError,
    });

    await expect(client.request('time-out')).rejects.toThrow(/timed out after 20ms/);
    const timedOutFrame = child.frames.find((frame) => frame.method === 'time-out');
    if (!timedOutFrame) throw new Error('timed-out request was not written');
    child.respondTo(timedOutFrame, { too: 'late' });

    await vi.waitFor(() => expect(reportError).toHaveBeenCalledWith(expect.stringContaining('retired JSON-RPC request id')));
    expect(child.killed).toBe(false);
    await expect(client.request('after-late-response')).resolves.toEqual({ ok: true });
    expect(spawnProcess).toHaveBeenCalledOnce();
    await client.dispose();
  });

  it('clears retired request IDs before a replacement process generation starts', async () => {
    const firstChild = new FakeCodexChild();
    const secondChild = new FakeCodexChild();
    initializationResponder(firstChild, () => undefined);
    const spawnProcess = vi.fn()
      .mockReturnValueOnce(firstChild.asChildProcess())
      .mockReturnValueOnce(secondChild.asChildProcess());
    const client = new CodexAppServerClient({ spawnProcess });
    const controller = new AbortController();
    const cancelled = client.request('cancel-before-respawn', {}, { signal: controller.signal });
    await vi.waitFor(() => expect(firstChild.frames.some((frame) => frame.method === 'cancel-before-respawn')).toBe(true));
    const cancelledFrame = firstChild.frames.find((frame) => frame.method === 'cancel-before-respawn');
    if (typeof cancelledFrame?.id !== 'number') throw new Error('cancelled request has no numeric id');
    const retiredId = cancelledFrame.id;
    initializationResponder(secondChild, (frame) => {
      if (frame.method !== 'after-respawn') return;
      secondChild.send({ id: retiredId, result: { stale: true } });
      secondChild.respondTo(frame, { mustNotResolve: true });
    });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    firstChild.crash(9);

    await expect(client.request('after-respawn')).rejects.toThrow(
      new RegExp(`unknown JSON-RPC response id ${retiredId}`, 'u'),
    );
    expect(secondChild.killed).toBe(true);
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    await client.dispose();
  });

  it('bounds retired request IDs by evicting the oldest entry', async () => {
    const child = new FakeCodexChild();
    initializationResponder(child, () => undefined);
    const client = new CodexAppServerClient({ spawnProcess: () => child.asChildProcess() });
    await client.notify('ready');
    const controllers = Array.from({ length: 257 }, () => new AbortController());
    const outcomes = controllers.map((controller, index) => (
      client.request(`cancel-${index}`, {}, { signal: controller.signal }).catch((error: unknown) => error)
    ));
    await vi.waitFor(() => {
      expect(child.frames.filter((frame) => frame.method?.startsWith('cancel-')).length).toBe(257);
    });
    const oldestFrame = child.frames.find((frame) => frame.method === 'cancel-0');
    controllers.forEach((controller) => controller.abort());
    await Promise.all(outcomes);
    if (!oldestFrame) throw new Error('oldest cancelled request was not written');

    child.respondTo(oldestFrame, { too: 'late' });

    await vi.waitFor(() => expect(child.killed).toBe(true));
    await client.dispose();
  });

  it('rejects pending calls on process crash and disposes idempotently', async () => {
    const child = new FakeCodexChild();
    initializationResponder(child, () => undefined);
    const client = new CodexAppServerClient({ spawnProcess: () => child.asChildProcess() });
    const closed = vi.fn();
    client.onClose(closed);
    const pending = client.request('in-flight');
    await vi.waitFor(() => expect(child.frames.some((frame) => frame.method === 'in-flight')).toBe(true));
    child.crash(9);
    await expect(pending).rejects.toThrow(/exited.*code=9/);
    expect(closed).toHaveBeenCalledWith({
      expected: false,
      message: expect.stringContaining('code=9'),
    });
    await client.dispose();
    await client.dispose();
    await expect(client.request('after-dispose')).rejects.toThrow(/disposed/);
  });
});
