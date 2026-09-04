import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';

import type { AgentDecision, AgentState } from '../shared/agent';
import type {
  CollaborationPermissionMode,
  CollaborationTask,
  WorkerReportInput,
} from '../shared/agent-orchestration';
import type { AgentAdapterRuntimeDescriptor } from './agent-adapter-service';

const MAX_TRANSCRIPT_CHARS = 64 * 1024;
const RPC_LINE_LIMIT = 1024 * 1024;
const TURN_TIMEOUT_MS = 2 * 60 * 60_000;

type JsonRpcId = string | number;

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface RuntimeRecord {
  readonly sessionId: string;
  readonly runId: string;
  readonly descriptor: AgentAdapterRuntimeDescriptor;
  readonly task: CollaborationTask;
  readonly permissionMode: CollaborationPermissionMode;
  readonly verificationHead?: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly pending: Map<string, PendingRequest>;
  readonly pendingPermissions: Map<string, JsonRpcId>;
  readonly transcript: string[];
  acpSessionId: string;
  activityId?: string;
  requestId: number;
  closed: boolean;
  taskStarted: boolean;
}

export interface PreparedAcpWorker {
  readonly sessionId: string;
  readonly runId: string;
  readonly start: (prompt: string) => void;
}

export interface AcpWorkerRuntimeHooks {
  readonly setActivityState: (activityId: string, state: AgentState) => void;
  readonly endActivity: (activityId: string, error: boolean) => void;
  readonly requestApproval: (
    activityId: string,
    toolName: string,
    command?: string,
  ) => Promise<AgentDecision | null>;
  readonly report: (
    activityId: string,
    taskId: string,
    report: WorkerReportInput,
  ) => Promise<{ readonly ok: boolean; readonly message?: string }>;
}

function rpcKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : 'ACP adapter failed.';
}

function boundedTranscript(record: RuntimeRecord): string {
  const joined = record.transcript.join('\n').trim();
  return joined.length <= 8_000 ? joined : joined.slice(joined.length - 8_000);
}

export class AcpWorkerRuntime {
  private readonly bySession = new Map<string, RuntimeRecord>();
  private readonly byActivity = new Map<string, RuntimeRecord>();

  constructor(private readonly hooks: AcpWorkerRuntimeHooks) {}

  async prepare(
    descriptor: AgentAdapterRuntimeDescriptor,
    cwd: string,
    task: CollaborationTask,
    permissionMode: CollaborationPermissionMode,
    verificationHead?: string,
  ): Promise<PreparedAcpWorker> {
    const sessionId = `acp-${randomUUID()}`;
    const runId = `acp-run-${randomUUID()}`;
    const child = spawn(descriptor.executable, [...descriptor.args], {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: {
        ...process.env,
        EZTERMINAL_ORCHESTRATION_ROLE: 'worker',
        EZTERMINAL_ORCHESTRATION_TASK_ID: task.taskId,
      },
    });
    const record: RuntimeRecord = {
      sessionId,
      runId,
      descriptor,
      task,
      permissionMode,
      ...(verificationHead ? { verificationHead } : {}),
      child,
      pending: new Map(),
      pendingPermissions: new Map(),
      transcript: [],
      acpSessionId: '',
      requestId: 0,
      closed: false,
      taskStarted: false,
    };
    this.bySession.set(sessionId, record);
    this.attach(record);
    try {
      const initialized = await this.request(record, 'initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'ezterminal', title: 'EZTerminal', version: '1' },
      }, 10_000) as { readonly protocolVersion?: unknown; readonly authMethods?: readonly unknown[] };
      if (initialized?.protocolVersion !== 1) throw new Error('ACP adapter negotiated an unsupported protocol version.');
      if (Array.isArray(initialized.authMethods) && initialized.authMethods.length > 0) {
        throw new Error('This ACP adapter requires authentication that EZTerminal cannot complete yet.');
      }
      const session = await this.request(record, 'session/new', { cwd, mcpServers: [] }, 20_000) as {
        readonly sessionId?: unknown;
      };
      if (typeof session?.sessionId !== 'string' || session.sessionId.length < 1 || session.sessionId.length > 512) {
        throw new Error('ACP adapter returned an invalid session id.');
      }
      record.acpSessionId = session.sessionId;
      return {
        sessionId,
        runId,
        start: (prompt) => { this.startTask(record, prompt); },
      };
    } catch (error) {
      this.stop(sessionId);
      throw error;
    }
  }

  bindActivity(sessionId: string, activityId: string): boolean {
    const record = this.bySession.get(sessionId);
    if (!record || record.closed || this.byActivity.has(activityId)) return false;
    record.activityId = activityId;
    this.byActivity.set(activityId, record);
    return true;
  }

  ownsSession(sessionId: string): boolean {
    return this.bySession.has(sessionId);
  }

  ownsActivity(activityId: string): boolean {
    return this.byActivity.has(activityId);
  }

  prompt(activityId: string, text: string): Promise<{ readonly ok: boolean }> {
    const record = this.byActivity.get(activityId);
    if (!record || record.closed || !record.acpSessionId || !text.trim()) return Promise.resolve({ ok: false });
    this.hooks.setActivityState(activityId, 'working');
    void this.request(record, 'session/prompt', {
      sessionId: record.acpSessionId,
      prompt: [{ type: 'text', text }],
    }, TURN_TIMEOUT_MS).then(
      () => this.hooks.setActivityState(activityId, 'done'),
      () => this.hooks.setActivityState(activityId, 'error'),
    );
    return Promise.resolve({ ok: true });
  }

  readActivity(activityId: string): string | null {
    const record = this.byActivity.get(activityId);
    return record ? boundedTranscript(record) : null;
  }

  stop(sessionId: string): boolean {
    const record = this.bySession.get(sessionId);
    if (!record || record.closed) return false;
    if (record.acpSessionId) this.notify(record, 'session/cancel', { sessionId: record.acpSessionId });
    for (const id of record.pendingPermissions.values()) {
      this.write(record, {
        jsonrpc: '2.0',
        id,
        result: { outcome: { outcome: 'cancelled' } },
      });
    }
    record.pendingPermissions.clear();
    this.close(record, false);
    return true;
  }

  dispose(): void {
    for (const sessionId of [...this.bySession.keys()]) this.stop(sessionId);
  }

  private startTask(record: RuntimeRecord, prompt: string): void {
    if (record.closed || record.taskStarted || !record.activityId) throw new Error('ACP worker is not ready for task delivery.');
    record.taskStarted = true;
    this.hooks.setActivityState(record.activityId, 'working');
    void this.request(record, 'session/prompt', {
      sessionId: record.acpSessionId,
      prompt: [{ type: 'text', text: prompt }],
    }, TURN_TIMEOUT_MS).then(async (raw) => {
      if (record.closed || !record.activityId) return;
      const response = raw as { readonly stopReason?: unknown };
      const succeeded = response?.stopReason === 'end_turn';
      const summary = boundedTranscript(record)
        || (succeeded ? 'ACP worker completed the assigned task.' : `ACP worker stopped: ${String(response?.stopReason ?? 'unknown')}`);
      const report: WorkerReportInput = {
        outcome: succeeded ? 'succeeded' : 'failed',
        summary,
        ...(record.task.mode === 'verify' && record.task.verifiesTaskId ? {
          verifiesTaskId: record.task.verifiesTaskId,
          ...(record.verificationHead ? { verifiesHead: record.verificationHead } : {}),
        } : {}),
      };
      const result = await this.hooks.report(record.activityId, record.task.taskId, report);
      this.hooks.setActivityState(record.activityId, result.ok ? 'done' : 'blocked');
      if (!result.ok && result.message) this.append(record, result.message);
    }).catch((error) => {
      if (record.closed || !record.activityId) return;
      this.append(record, safeMessage(error));
      void this.hooks.report(record.activityId, record.task.taskId, {
        outcome: 'failed',
        summary: safeMessage(error),
      });
      this.hooks.setActivityState(record.activityId, 'error');
    });
  }

  private attach(record: RuntimeRecord): void {
    const lines = readline.createInterface({ input: record.child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (line.length > RPC_LINE_LIMIT) {
        this.close(record, true, new Error('ACP message exceeded 1 MiB.'));
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch {
        this.close(record, true, new Error('ACP adapter emitted invalid JSON.'));
        return;
      }
      void this.handleMessage(record, message).catch((error) => {
        this.close(record, true, error instanceof Error ? error : new Error('ACP message handling failed.'));
      });
    });
    record.child.stderr.on('data', (chunk: Buffer) => this.append(record, chunk.toString('utf8')));
    record.child.once('error', (error) => this.close(record, true, error));
    record.child.once('exit', (code) => {
      if (!record.closed) this.close(record, code !== 0, new Error(`ACP adapter exited (${code ?? 'signal'}).`));
    });
  }

  private async handleMessage(record: RuntimeRecord, raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const message = raw as Record<string, unknown>;
    if (message.jsonrpc !== '2.0') return;
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.takePending(record, message.id as JsonRpcId);
      if (!pending) return;
      if (message.error !== undefined) pending.reject(new Error(`ACP request failed: ${JSON.stringify(message.error).slice(0, 400)}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === 'session/update') {
      const sessionId = message.params && typeof message.params === 'object'
        ? (message.params as { readonly sessionId?: unknown }).sessionId
        : undefined;
      if (sessionId === record.acpSessionId) this.captureUpdate(record, message.params);
      return;
    }
    if (message.id !== undefined && message.method === 'session/request_permission') {
      await this.handlePermission(record, message.id as JsonRpcId, message.params);
      return;
    }
    if (message.id !== undefined) {
      this.write(record, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not supported' } });
    }
  }

  private captureUpdate(record: RuntimeRecord, raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const update = (raw as { readonly update?: unknown }).update;
    if (!update || typeof update !== 'object') return;
    const value = update as Record<string, unknown>;
    const content = value.content;
    if (content && typeof content === 'object' && (content as { readonly type?: unknown }).type === 'text') {
      const text = (content as { readonly text?: unknown }).text;
      if (typeof text === 'string') this.append(record, text);
    } else if (typeof value.title === 'string') {
      this.append(record, value.title);
    }
  }

  private async handlePermission(record: RuntimeRecord, id: JsonRpcId, raw: unknown): Promise<void> {
    const params = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    if (params.sessionId !== record.acpSessionId || record.pendingPermissions.has(rpcKey(id))) {
      this.write(record, {
        jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } },
      });
      return;
    }
    record.pendingPermissions.set(rpcKey(id), id);
    const toolCall = params.toolCall && typeof params.toolCall === 'object'
      ? params.toolCall as Record<string, unknown>
      : {};
    const options = Array.isArray(params.options) ? params.options.filter((option): option is Record<string, unknown> => (
      Boolean(option) && typeof option === 'object' && !Array.isArray(option)
      && typeof (option as Record<string, unknown>).optionId === 'string'
      && typeof (option as Record<string, unknown>).kind === 'string'
    )) : [];
    const title = typeof toolCall.title === 'string' ? toolCall.title : 'ACP tool request';
    const kind = typeof toolCall.kind === 'string' ? toolCall.kind : 'other';
    const rawInput = toolCall.rawInput;
    const command = typeof rawInput === 'string'
      ? rawInput.slice(0, 4_096)
      : rawInput === undefined ? undefined : JSON.stringify(rawInput).slice(0, 4_096);
    const readSafe = ['read', 'search', 'think', 'fetch'].includes(kind);
    // ACP permission kinds are cooperative declarations, not an OS sandbox.
    // Safe-auto may streamline bounded edits in a dedicated writer worktree,
    // but shell execution and unknown kinds always return to the user. Custom
    // is deliberately narrower: it auto-allows reads and asks for mutations.
    const boundedWrite = record.task.mode === 'write' && ['edit', 'move'].includes(kind);
    const autoAllowed = record.permissionMode !== 'ask'
      && (readSafe || (record.permissionMode === 'safe-auto' && boundedWrite));
    let decision: AgentDecision | null = autoAllowed ? 'allow' : null;
    if (!autoAllowed && record.activityId) {
      decision = await this.hooks.requestApproval(record.activityId, title, command);
    }
    if (record.closed || !record.pendingPermissions.delete(rpcKey(id))) return;
    const preferredKinds = decision === 'allow'
      ? ['allow_once', 'allow_always']
      : decision === 'deny' ? ['reject_once', 'reject_always'] : [];
    const selected = preferredKinds
      .map((preferred) => options.find((option) => option.kind === preferred))
      .find(Boolean);
    this.write(record, {
      jsonrpc: '2.0',
      id,
      result: {
        outcome: selected
          ? { outcome: 'selected', optionId: selected.optionId }
          : { outcome: 'cancelled' },
      },
    });
  }

  private request(record: RuntimeRecord, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (record.closed) return Promise.reject(new Error('ACP adapter is closed.'));
    const id = ++record.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        record.pending.delete(rpcKey(id));
        reject(new Error(`${method} timed out.`));
      }, timeoutMs);
      timer.unref?.();
      record.pending.set(rpcKey(id), { resolve, reject, timer });
      try {
        this.write(record, { jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        record.pending.delete(rpcKey(id));
        reject(error);
      }
    });
  }

  private notify(record: RuntimeRecord, method: string, params: unknown): void {
    if (!record.closed) this.write(record, { jsonrpc: '2.0', method, params });
  }

  private write(record: RuntimeRecord, message: unknown): void {
    if (record.closed || !record.child.stdin.writable) throw new Error('ACP adapter input is closed.');
    record.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private takePending(record: RuntimeRecord, id: JsonRpcId): PendingRequest | undefined {
    const key = rpcKey(id);
    const pending = record.pending.get(key);
    if (!pending) return undefined;
    record.pending.delete(key);
    clearTimeout(pending.timer);
    return pending;
  }

  private append(record: RuntimeRecord, text: string): void {
    const value = text.trim();
    if (!value) return;
    record.transcript.push(value);
    let length = record.transcript.reduce((total, entry) => total + entry.length + 1, 0);
    while (length > MAX_TRANSCRIPT_CHARS && record.transcript.length > 1) {
      length -= record.transcript.shift()!.length + 1;
    }
  }

  private close(record: RuntimeRecord, error: boolean, reason?: Error): void {
    if (record.closed) return;
    record.closed = true;
    this.bySession.delete(record.sessionId);
    if (record.activityId) this.byActivity.delete(record.activityId);
    for (const pending of record.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason ?? new Error('ACP adapter stopped.'));
    }
    record.pending.clear();
    record.pendingPermissions.clear();
    record.child.kill();
    if (record.activityId) this.hooks.endActivity(record.activityId, error);
  }
}
