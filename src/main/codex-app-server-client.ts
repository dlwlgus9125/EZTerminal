import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

interface JsonRpcResponse {
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly message?: unknown };
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface CodexAppServerClientOptions {
  readonly command?: string;
  readonly requestTimeoutMs?: number;
  readonly spawnProcess?: () => ChildProcessWithoutNullStreams;
}

export interface CodexAppServerRequester {
  request(method: string, params?: unknown): Promise<unknown>;
  dispose(): Promise<void>;
}

export class CodexAppServerClient implements CodexAppServerRequester {
  private process: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: CodexAppServerClientOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  async request(method: string, params: unknown = {}): Promise<unknown> {
    await this.start();
    const child = this.process;
    if (!child || !child.stdin.writable) throw new Error('Codex history is unavailable');
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex history request timed out'));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Codex history is unavailable'));
      }
    });
  }

  async dispose(): Promise<void> {
    const child = this.process;
    this.process = null;
    this.startPromise = null;
    this.rejectAll('Codex history service stopped');
    if (!child) return;
    child.stdin.end();
    if (!child.killed) child.kill();
  }

  private async start(): Promise<void> {
    if (this.process) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.spawnAndInitialize();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async spawnAndInitialize(): Promise<void> {
    const child = this.options.spawnProcess?.() ?? spawn(
      this.options.command ?? 'codex',
      ['app-server', '--stdio'],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    this.process = child;
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.handleLine(line));
    child.once('error', () => this.handleExit(child));
    child.once('exit', () => this.handleExit(child));

    await this.requestDirect(child, 'initialize', {
      clientInfo: { name: 'ezterminal', title: 'EZTerminal', version: '1' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
  }

  private requestDirect(
    child: ChildProcessWithoutNullStreams,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex history initialization timed out'));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private handleLine(line: string): void {
    if (line.length === 0 || line.length > 8 * 1024 * 1024) return;
    let response: JsonRpcResponse;
    try {
      response = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    if (typeof response.id !== 'number') return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.error) {
      pending.reject(new Error(
        typeof response.error.message === 'string'
          ? response.error.message
          : 'Codex history request failed',
      ));
    } else {
      pending.resolve(response.result);
    }
  }

  private handleExit(child: ChildProcessWithoutNullStreams): void {
    if (this.process !== child) return;
    this.process = null;
    this.rejectAll('Codex history service exited');
  }

  private rejectAll(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }
}
