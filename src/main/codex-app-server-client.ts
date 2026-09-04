import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import crossSpawn from 'cross-spawn';

import { sanitizeProviderDiagnostic } from './provider-process-security';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_CONFIGURABLE_LINE_BYTES = 16 * 1024 * 1024;

export type CodexJsonRpcId = string | number;

interface JsonRpcErrorObject {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly data?: unknown;
}

interface JsonRpcMessage {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: JsonRpcErrorObject;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal?: AbortSignal;
  abort?: () => void;
}

export interface CodexRpcRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface CodexServerRequestContext {
  readonly id: CodexJsonRpcId;
  readonly method: string;
}

export type CodexNotificationHandler = (params: unknown, method: string) => void | Promise<void>;
export type CodexServerRequestHandler = (
  params: unknown,
  context: CodexServerRequestContext,
) => unknown | Promise<unknown>;

export interface CodexConnectionClose {
  readonly expected: boolean;
  readonly message: string;
}

export interface CodexProcessGuardian {
  createGroup(groupId: string, pid: number, parentGroupId?: string): Promise<void>;
  terminateGroup(groupId: string): Promise<void>;
}

export interface CodexAppServerClientOptions {
  readonly command?: string;
  readonly argv?: readonly string[];
  readonly requestTimeoutMs?: number;
  readonly maxLineBytes?: number;
  readonly processGroupId?: string;
  readonly parentProcessGroupId?: string;
  readonly processGuardian?: CodexProcessGuardian;
  readonly environment?: NodeJS.ProcessEnv;
  /** Revalidates the reviewed executable immediately before every respawn. */
  readonly beforeSpawn?: (signal?: AbortSignal) => Promise<void>;
  readonly spawnProcess?: (
    command: string,
    argv: readonly string[],
    environment?: NodeJS.ProcessEnv,
  ) => ChildProcessWithoutNullStreams;
  readonly reportError?: (message: string) => void;
}

/** Minimal compatibility surface retained for the history provider. */
export interface CodexAppServerRequester {
  request(method: string, params?: unknown, options?: CodexRpcRequestOptions): Promise<unknown>;
  dispose(): Promise<void>;
}

export interface CodexAppServerConnection extends CodexAppServerRequester {
  notify(method: string, params?: unknown): Promise<void>;
  onNotification(method: string, handler: CodexNotificationHandler): () => void;
  onServerRequest(method: string, handler: CodexServerRequestHandler): () => void;
  onClose(listener: (event: CodexConnectionClose) => void): () => void;
}

export class CodexJsonRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
    readonly data?: unknown,
  ) {
    super(sanitizeProviderDiagnostic(message).text);
    this.name = 'CodexJsonRpcError';
  }
}

function abortError(method: string): Error {
  const error = new Error(`Codex app-server request ${method} was cancelled.`);
  error.name = 'AbortError';
  return error;
}

function positiveBoundedInteger(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return resolved;
}

function rpcId(value: unknown): CodexJsonRpcId | undefined {
  return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))
    ? value
    : undefined;
}

/**
 * Bidirectional newline-delimited JSON-RPC transport for `codex app-server`.
 *
 * Codex 0.152.1 uses stdio by default. The launcher deliberately omits the
 * redundant `--stdio` switch so the reviewed argv remains `app-server` only.
 */
export class CodexAppServerClient implements CodexAppServerConnection {
  private process: ChildProcessWithoutNullStreams | undefined;
  private startPromise: Promise<void> | undefined;
  private nextId = 1;
  private readonly pending = new Map<CodexJsonRpcId, PendingRequest>();
  private readonly notificationHandlers = new Map<string, Set<CodexNotificationHandler>>();
  private readonly serverRequestHandlers = new Map<string, CodexServerRequestHandler>();
  private readonly closeListeners = new Set<(event: CodexConnectionClose) => void>();
  private readonly requestTimeoutMs: number;
  private readonly maxLineBytes: number;
  private readonly processGroupId: string;
  private readonly reportError: (message: string) => void;
  private inputBuffer = '';
  private disposed = false;
  private expectedExit = false;
  private guardianEnrolled = false;

  constructor(private readonly options: CodexAppServerClientOptions = {}) {
    this.requestTimeoutMs = positiveBoundedInteger(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      10 * 60 * 1_000,
      'requestTimeoutMs',
    );
    this.maxLineBytes = positiveBoundedInteger(
      options.maxLineBytes,
      DEFAULT_MAX_LINE_BYTES,
      MAX_CONFIGURABLE_LINE_BYTES,
      'maxLineBytes',
    );
    this.processGroupId = options.processGroupId ?? `codex-app-server:${randomUUID()}`;
    const reportError = options.reportError ?? (() => undefined);
    this.reportError = (message) => reportError(sanitizeProviderDiagnostic(message, { maxLength: 8_192 }).text);
  }

  async request(method: string, params: unknown = {}, options: CodexRpcRequestOptions = {}): Promise<unknown> {
    if (!method.trim()) throw new Error('Codex app-server method must not be empty.');
    if (this.disposed) throw new Error('Codex app-server client is disposed.');
    if (options.signal?.aborted) throw abortError(method);
    await this.waitForStart(method, options.signal);
    return this.sendRequest(this.requireProcess(), method, params, options);
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (!method.trim()) throw new Error('Codex app-server notification method must not be empty.');
    if (this.disposed) throw new Error('Codex app-server client is disposed.');
    await this.start();
    const message = params === undefined
      ? { jsonrpc: '2.0', method }
      : { jsonrpc: '2.0', method, params };
    await this.writeMessage(this.requireProcess(), message);
  }

  onNotification(method: string, handler: CodexNotificationHandler): () => void {
    if (!method.trim()) throw new Error('Codex notification method must not be empty.');
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.notificationHandlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers?.delete(handler);
      if (handlers?.size === 0) this.notificationHandlers.delete(method);
    };
  }

  onServerRequest(method: string, handler: CodexServerRequestHandler): () => void {
    if (!method.trim()) throw new Error('Codex server request method must not be empty.');
    if (this.serverRequestHandlers.has(method)) {
      throw new Error(`A handler is already registered for Codex server request ${method}.`);
    }
    this.serverRequestHandlers.set(method, handler);
    return () => {
      if (this.serverRequestHandlers.get(method) === handler) this.serverRequestHandlers.delete(method);
    };
  }

  onClose(listener: (event: CodexConnectionClose) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.expectedExit = true;
    this.rejectAll(new Error('Codex app-server client stopped.'));
    const child = this.process;
    this.process = undefined;
    this.startPromise = undefined;
    this.inputBuffer = '';
    if (child) {
      child.stdout.removeAllListeners('data');
      child.removeAllListeners('error');
      child.removeAllListeners('exit');
      if (child.stdin.writable) child.stdin.end();
    }
    if (this.guardianEnrolled && this.options.processGuardian) {
      try {
        await this.options.processGuardian.terminateGroup(this.processGroupId);
      } catch (error) {
        this.reportError(`Codex process guardian could not terminate the group: ${String(error)}`);
        if (child && !child.killed) child.kill();
      }
    } else if (child && !child.killed) {
      child.kill();
    }
    this.guardianEnrolled = false;
    this.emitClose({ expected: true, message: 'Codex app-server client stopped.' });
    this.notificationHandlers.clear();
    this.serverRequestHandlers.clear();
    this.closeListeners.clear();
  }

  private async waitForStart(method: string, signal?: AbortSignal): Promise<void> {
    if (!signal) return this.start();
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(abortError(method));
      signal.addEventListener('abort', onAbort, { once: true });
      void this.start(signal).then(
        () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  private async start(signal?: AbortSignal): Promise<void> {
    if (this.disposed) throw new Error('Codex app-server client is disposed.');
    if (this.startPromise) return this.startPromise;
    if (this.process) return;
    this.startPromise = this.spawnAndInitialize(signal);
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  private async spawnAndInitialize(signal?: AbortSignal): Promise<void> {
    const command = this.options.command ?? 'codex';
    const argv = [...(this.options.argv ?? ['app-server'])];
    await this.options.beforeSpawn?.(signal);
    if (signal?.aborted) throw abortError('initialize');
    const child: ChildProcessWithoutNullStreams = (
      this.options.spawnProcess
        ? this.options.environment
          ? this.options.spawnProcess(command, argv, this.options.environment)
          : this.options.spawnProcess(command, argv)
        : undefined
    ) ?? crossSpawn(
      command,
      argv,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        ...(this.options.environment ? { env: this.options.environment } : {}),
      },
    ) as ChildProcessWithoutNullStreams;
    this.expectedExit = false;
    this.inputBuffer = '';
    this.process = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.handleChunk(child, chunk));
    child.stderr.on('data', (chunk: string) => {
      const detail = chunk.trim().slice(-8_192);
      if (detail) this.reportError(`[codex-app-server] ${detail}`);
    });
    child.once('error', (error) => this.handleExit(child, `Codex app-server failed: ${error.message}`));
    child.once('exit', (code, signal) => this.handleExit(
      child,
      `Codex app-server exited (code=${String(code)}, signal=${String(signal)}).`,
    ));

    try {
      if (this.options.processGuardian) {
        if (typeof child.pid !== 'number' || child.pid < 1) throw new Error('Codex app-server process has no pid.');
        await this.options.processGuardian.createGroup(
          this.processGroupId,
          child.pid,
          this.options.parentProcessGroupId,
        );
        this.guardianEnrolled = true;
      }
      await this.sendRequest(child, 'initialize', {
        clientInfo: { name: 'ezterminal', title: 'EZTerminal', version: '2' },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      }, { timeoutMs: this.requestTimeoutMs, signal });
      await this.writeMessage(child, { jsonrpc: '2.0', method: 'initialized' });
    } catch (error) {
      if (this.process === child) this.process = undefined;
      this.rejectAll(error instanceof Error ? error : new Error(String(error)));
      if (this.guardianEnrolled && this.options.processGuardian) {
        try {
          await this.options.processGuardian.terminateGroup(this.processGroupId);
        } catch (guardianError) {
          this.reportError(`Codex process guardian cleanup failed: ${String(guardianError)}`);
        }
        this.guardianEnrolled = false;
      }
      if (!child.killed) child.kill();
      throw error;
    }
  }

  private requireProcess(): ChildProcessWithoutNullStreams {
    const child = this.process;
    if (!child || child.killed || !child.stdin.writable) throw new Error('Codex app-server is unavailable.');
    return child;
  }

  private sendRequest(
    child: ChildProcessWithoutNullStreams,
    method: string,
    params: unknown,
    options: CodexRpcRequestOptions,
  ): Promise<unknown> {
    if (options.signal?.aborted) return Promise.reject(abortError(method));
    const id = this.nextId++;
    const timeoutMs = positiveBoundedInteger(
      options.timeoutMs,
      this.requestTimeoutMs,
      10 * 60 * 1_000,
      'timeoutMs',
    );
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        this.removeAbortListener(pending);
        reject(new Error(`Codex app-server request ${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      timer.unref?.();
      const pending: PendingRequest = {
        method,
        resolve,
        reject,
        timer,
        ...(options.signal ? { signal: options.signal } : {}),
      };
      if (options.signal) {
        pending.abort = () => {
          if (!this.pending.delete(id)) return;
          clearTimeout(timer);
          reject(abortError(method));
        };
        options.signal.addEventListener('abort', pending.abort, { once: true });
      }
      this.pending.set(id, pending);
      this.writeMessage(child, { jsonrpc: '2.0', id, method, params }).catch((error: unknown) => {
        const live = this.pending.get(id);
        if (!live) return;
        this.pending.delete(id);
        clearTimeout(live.timer);
        this.removeAbortListener(live);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private writeMessage(child: ChildProcessWithoutNullStreams, message: Readonly<Record<string, unknown>>): Promise<void> {
    if (this.process !== child || child.killed || !child.stdin.writable) {
      return Promise.reject(new Error('Codex app-server is unavailable.'));
    }
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
      return Promise.reject(new Error(`Codex app-server frame exceeds ${this.maxLineBytes} bytes.`));
    }
    return new Promise<void>((resolve, reject) => {
      child.stdin.write(line, (error) => error ? reject(error) : resolve());
    });
  }

  private handleChunk(child: ChildProcessWithoutNullStreams, chunk: string): void {
    if (this.process !== child) return;
    this.inputBuffer += chunk;
    for (;;) {
      const newline = this.inputBuffer.indexOf('\n');
      if (newline < 0) break;
      let line = this.inputBuffer.slice(0, newline);
      this.inputBuffer = this.inputBuffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
        this.failProtocol(child, `Codex app-server frame exceeds ${this.maxLineBytes} bytes.`);
        return;
      }
      if (line.length > 0) this.handleLine(child, line);
      if (this.process !== child) return;
    }
    if (Buffer.byteLength(this.inputBuffer, 'utf8') > this.maxLineBytes) {
      this.failProtocol(child, `Codex app-server frame exceeds ${this.maxLineBytes} bytes.`);
    }
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
    let message: JsonRpcMessage;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('frame is not an object');
      message = parsed as JsonRpcMessage;
    } catch (error) {
      this.reportError(`[codex-app-server] ignored malformed JSON-RPC frame: ${String(error)}`);
      return;
    }
    if (typeof message.method === 'string') {
      const id = rpcId(message.id);
      if (id === undefined) this.dispatchNotification(message.method, message.params);
      else this.dispatchServerRequest(child, id, message.method, message.params);
      return;
    }
    const id = rpcId(message.id);
    if (id === undefined) {
      this.reportError('[codex-app-server] ignored JSON-RPC frame without a method or valid id.');
      return;
    }
    this.handleResponse(id, message);
  }

  private handleResponse(id: CodexJsonRpcId, response: JsonRpcMessage): void {
    const pending = this.pending.get(id);
    if (!pending) {
      this.reportError(`[codex-app-server] ignored response for unknown id ${String(id)}.`);
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    this.removeAbortListener(pending);
    if (response.error) {
      pending.reject(new CodexJsonRpcError(
        pending.method,
        typeof response.error.code === 'number' ? response.error.code : undefined,
        typeof response.error.message === 'string' ? response.error.message : `Codex request ${pending.method} failed.`,
        response.error.data,
      ));
      return;
    }
    pending.resolve(response.result);
  }

  private dispatchNotification(method: string, params: unknown): void {
    const handlers = [
      ...(this.notificationHandlers.get(method) ?? []),
      ...(this.notificationHandlers.get('*') ?? []),
    ];
    for (const handler of handlers) {
      Promise.resolve().then(() => handler(params, method)).catch((error: unknown) => {
        this.reportError(`[codex-app-server] notification handler ${method} failed: ${String(error)}`);
      });
    }
  }

  private dispatchServerRequest(
    child: ChildProcessWithoutNullStreams,
    id: CodexJsonRpcId,
    method: string,
    params: unknown,
  ): void {
    const handler = this.serverRequestHandlers.get(method);
    if (!handler) {
      void this.writeMessage(child, {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `No EZTerminal handler is registered for ${method}.` },
      }).catch((error: unknown) => this.reportError(`[codex-app-server] failed to reject server request: ${String(error)}`));
      return;
    }
    Promise.resolve().then(() => handler(params, { id, method })).then(
      (result) => this.writeMessage(child, { jsonrpc: '2.0', id, result }),
      (error: unknown) => this.writeMessage(child, {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message.slice(0, 1_000) : 'EZTerminal could not handle this request.',
        },
      }),
    ).catch((error: unknown) => {
      this.reportError(`[codex-app-server] failed to answer server request ${method}: ${String(error)}`);
    });
  }

  private failProtocol(child: ChildProcessWithoutNullStreams, message: string): void {
    this.reportError(`[codex-app-server] ${message}`);
    this.handleExit(child, message);
    if (!child.killed) child.kill();
  }

  private handleExit(child: ChildProcessWithoutNullStreams, message: string): void {
    if (this.process !== child) return;
    this.process = undefined;
    this.inputBuffer = '';
    this.guardianEnrolled = false;
    this.rejectAll(new Error(message));
    this.emitClose({ expected: this.expectedExit || this.disposed, message });
  }

  private emitClose(event: CodexConnectionClose): void {
    for (const listener of [...this.closeListeners]) {
      try {
        listener(event);
      } catch (error) {
        this.reportError(`[codex-app-server] close listener failed: ${String(error)}`);
      }
    }
  }

  private removeAbortListener(pending: PendingRequest): void {
    if (pending.signal && pending.abort) pending.signal.removeEventListener('abort', pending.abort);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      this.removeAbortListener(pending);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
