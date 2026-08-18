import { randomUUID } from 'node:crypto';

import type { InterpreterFrame, ResultRow } from '../shared/ipc';
import type { InterpreterBroker, RemotePort } from './interpreter-broker';

export const MAX_VALIDATION_OUTPUT_BYTES = 1024 * 1024;

function utf8Tail(bytes: Buffer, maxBytes: number): string {
  let start = Math.max(0, bytes.byteLength - maxBytes);
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}

export interface AgentValidationRunResult {
  readonly exitCode: number;
  readonly durationMs: number;
  readonly outputTail: string;
  readonly outputTruncated: boolean;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
}

function rowText(row: ResultRow): string {
  const values = Object.values(row);
  if (values.length === 1 && typeof values[0] === 'string') return values[0];
  return values.map((value) => (
    typeof value === 'string' ? value : JSON.stringify(value)
  )).join('\t');
}

class BoundedOutput {
  private value = '';
  private bytes = 0;
  private truncated = false;

  append(text: string): void {
    if (!text) return;
    const next = Buffer.from(text, 'utf8');
    if (next.byteLength >= MAX_VALIDATION_OUTPUT_BYTES) {
      this.value = utf8Tail(next, MAX_VALIDATION_OUTPUT_BYTES);
      this.bytes = Buffer.byteLength(this.value, 'utf8');
      this.truncated = true;
      return;
    }
    this.value += text;
    this.bytes += next.byteLength;
    if (this.bytes <= MAX_VALIDATION_OUTPUT_BYTES) return;
    const encoded = Buffer.from(this.value, 'utf8');
    this.value = utf8Tail(encoded, MAX_VALIDATION_OUTPUT_BYTES);
    this.bytes = Buffer.byteLength(this.value, 'utf8');
    this.truncated = true;
  }

  snapshot(): { readonly outputTail: string; readonly outputTruncated: boolean } {
    return { outputTail: this.value, outputTruncated: this.truncated };
  }
}

/** Runs validation commands inside the guardian-owned interpreter process tree. */
export class AgentValidationRunner {
  constructor(
    private readonly broker: Pick<
      InterpreterBroker,
      'createSession' | 'destroySession' | 'runPrivateCommand' | 'setPrivateSessionEnvironment'
    >,
  ) {}

  async run(
    cwd: string,
    command: string,
    timeoutMs: number,
    signal?: AbortSignal,
    onOutput?: (snapshot: { readonly outputTail: string; readonly outputTruncated: boolean }) => void,
  ): Promise<AgentValidationRunResult> {
    const startedAt = Date.now();
    const session = await this.broker.createSession(cwd);
    this.broker.setPrivateSessionEnvironment(session.sessionId, {
      CI: '1',
      GIT_TERMINAL_PROMPT: '0',
      EZTERMINAL_AGENT_HOOK_DESCRIPTOR: '',
      EZTERMINAL_AGENT_CONTROL_DESCRIPTOR: '',
    });
    const runId = randomUUID();
    const port = this.broker.runPrivateCommand(
      session.sessionId,
      runId,
      command,
      '[managed merge validation]',
      'desktop',
    );
    if (!port) {
      this.broker.destroySession(session.sessionId);
      return {
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        outputTail: 'Validation could not start.',
        outputTruncated: false,
        timedOut: false,
        cancelled: false,
      };
    }
    return this.consume(port, session.sessionId, startedAt, timeoutMs, signal, onOutput);
  }

  private consume(
    port: RemotePort,
    sessionId: string,
    startedAt: number,
    timeoutMs: number,
    signal?: AbortSignal,
    onOutput?: (snapshot: { readonly outputTail: string; readonly outputTruncated: boolean }) => void,
  ): Promise<AgentValidationRunResult> {
    const output = new BoundedOutput();
    const decoder = new TextDecoder();
    let requestedRows = 0;
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    return new Promise((resolve) => {
      const finish = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        output.append(decoder.decode());
        try {
          port.postMessage({ type: 'close' });
          port.close();
        } catch {
          // The interpreter may already have closed the port.
        }
        this.broker.destroySession(sessionId);
        resolve({
          exitCode,
          durationMs: Date.now() - startedAt,
          ...output.snapshot(),
          timedOut,
          cancelled,
        });
      };
      const stop = (reason: 'timeout' | 'cancel'): void => {
        if (settled) return;
        timedOut = reason === 'timeout';
        cancelled = reason === 'cancel';
        try {
          port.postMessage({ type: 'cancel' });
        } catch {
          finish(1);
          return;
        }
        const fallback = setTimeout(() => finish(1), 2_000);
        fallback.unref?.();
      };
      const abort = (): void => stop('cancel');
      const timer = setTimeout(() => stop('timeout'), Math.max(1_000, Math.min(30 * 60_000, timeoutMs)));
      timer.unref?.();
      signal?.addEventListener('abort', abort, { once: true });
      port.on('message', (event) => {
        const frame = event.data as InterpreterFrame;
        if (frame.type === 'pty-data') {
          output.append(decoder.decode(frame.data, { stream: true }));
          onOutput?.(output.snapshot());
        } else if (frame.type === 'progress' && frame.count > requestedRows) {
          const count = Math.min(1_000, frame.count - requestedRows);
          port.postMessage({ type: 'requestRows', start: requestedRows, count });
          requestedRows += count;
        } else if (frame.type === 'chunk') {
          output.append(`${frame.rows.map(rowText).join('\n')}\n`);
          onOutput?.(output.snapshot());
        } else if (frame.type === 'error') {
          output.append(`${frame.message}\n`);
          finish(1);
        } else if (frame.type === 'cancelled') {
          finish(1);
        } else if (frame.type === 'end') {
          finish(frame.exitCode ?? 0);
        }
      });
      port.on('close', () => finish(1));
      port.start();
      if (signal?.aborted) abort();
    });
  }
}
