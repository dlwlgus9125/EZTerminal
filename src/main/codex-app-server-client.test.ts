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

  it('supports request cancellation and timeouts without accepting late responses', async () => {
    const child = new FakeCodexChild();
    initializationResponder(child, () => undefined);
    const reportError = vi.fn();
    const client = new CodexAppServerClient({
      spawnProcess: () => child.asChildProcess(),
      requestTimeoutMs: 20,
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
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledWith(expect.stringContaining('unknown id')));

    await expect(client.request('time-out')).rejects.toThrow(/timed out after 20ms/);
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
