import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';

import type { AgentDecision, AgentHookEvent, AgentIntegrationProvider } from '../shared/agent';

const MAX_HOOK_BODY_BYTES = 64 * 1024;
const MAX_COMMAND_CHARS = 4096;
const RATE_WINDOW_MS = 10_000;
const MAX_REQUESTS_PER_WINDOW = 120;
const RELAY_PATH = '/agent-hook/v1';
const RELAY_SCRIPT = 'agent-hook-relay.ps1';

/** The provider hook event this relay is allowed to hold open. */
export const APPROVAL_HOOK_EVENT = 'PermissionRequest';

/** How long a human gets before the gate lets go and the provider asks in the
 * terminal itself. Long enough to walk back to the machine, short enough that
 * a forgotten window does not wedge an agent. */
export const APPROVAL_GATE_WINDOW_MS = 120_000;

/** Sockets held open at once. Past this the gate fails open immediately rather
 * than letting a stuck consumer exhaust the loopback server. */
const MAX_HELD_REQUESTS = 16;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, min: number, max: number): string | null {
  return typeof value === 'string' && value.length >= min && value.length <= max ? value : null;
}

/** Validate only the relay allowlist. Unknown input keys are discarded rather
 * than retained, which keeps prompt/transcript/tool payloads out of memory. */
export function parseAgentHookEvent(raw: unknown): AgentHookEvent | null {
  if (!isRecord(raw)) return null;
  const provider = raw.provider;
  if (provider !== 'codex' && provider !== 'claude') return null;
  const ezSessionId = boundedString(raw.ezSessionId, 1, 256);
  const providerSessionId = boundedString(raw.providerSessionId, 1, 256);
  const cwd = boundedString(raw.cwd, 0, 4096);
  const event = boundedString(raw.event, 1, 80);
  if (ezSessionId === null || providerSessionId === null || cwd === null || event === null) return null;

  const optional = (value: unknown, max: number): string | undefined | null => {
    if (value === undefined || value === '') return undefined;
    return boundedString(value, 1, max);
  };
  const turnId = optional(raw.turnId, 256);
  const toolName = optional(raw.toolName, 256);
  const notificationType = optional(raw.notificationType, 128);
  const command = optional(raw.command, MAX_COMMAND_CHARS);
  if (turnId === null || toolName === null || notificationType === null || command === null) return null;
  return {
    provider,
    ezSessionId,
    providerSessionId,
    cwd,
    event,
    ...(turnId ? { turnId } : {}),
    ...(toolName ? { toolName } : {}),
    ...(notificationType ? { notificationType } : {}),
    // Only the event that can be decided is allowed to carry tool text.
    ...(command && event === APPROVAL_HOOK_EVENT ? { command } : {}),
  };
}

/**
 * The provider-shaped reply that actually decides the call.
 *
 * Claude Code's `PermissionRequest` hook reads `hookSpecificOutput.decision.
 * behavior` from stdout on exit 0 — note this is *not* the `permissionDecision`
 * shape `PreToolUse` uses; the two events take different schemas.
 *
 * Returns null for any provider whose decision grammar we have not verified.
 * Codex is that case today: it accepts the same hook registration, but nothing
 * we can check documents what it reads back, and a guessed schema would either
 * be ignored silently or — worse — read as something we did not intend. A null
 * here means the relay answers 204, the script prints nothing, and the provider
 * falls back to asking in the terminal. That is the honest failure.
 */
export function buildDecisionPayload(
  provider: AgentIntegrationProvider,
  decision: AgentDecision,
): string | null {
  if (provider !== 'claude') return null;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: APPROVAL_HOOK_EVENT,
      decision: { behavior: decision },
    },
  });
}

/** Whether the gate can drive this provider at all. */
export function canGateProvider(provider: AgentIntegrationProvider): boolean {
  return buildDecisionPayload(provider, 'allow') !== null;
}

function bearerMatches(candidate: string | undefined, token: string): boolean {
  if (!candidate?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(candidate.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** Script-side ceiling for a held approval request. Must outlast the gate
 * window, or the script would give up before the human did. */
export const RELAY_APPROVAL_TIMEOUT_SEC = Math.ceil(APPROVAL_GATE_WINDOW_MS / 1000) + 10;

/**
 * PowerShell performs the first and most important privacy boundary: it reads
 * provider stdin, constructs a new allowlisted object, and sends only that
 * object to main. It stays silent and non-blocking on every failure; exit 0
 * with no output never approves or denies a provider action.
 *
 * The one event it will wait on is the approval hook, and only because the
 * whole point of that hook is to be decided. Everything else keeps the old
 * two-second fire-and-forget budget so ordinary lifecycle observability can
 * never slow an agent down.
 */
export function buildPowerShellRelayScript(): string {
  return RELAY_SCRIPT_TEMPLATE.replaceAll('__APPROVAL_EVENT__', APPROVAL_HOOK_EVENT).replaceAll(
    '__APPROVAL_TIMEOUT_SEC__',
    String(RELAY_APPROVAL_TIMEOUT_SEC),
  );
}

const RELAY_SCRIPT_TEMPLATE = String.raw`param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('codex', 'claude')]
  [string]$Provider
)

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'

function Read-StringField($Object, [string]$Name) {
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) { return '' }
  return [string]$property.Value
}

# One string out of tool_input, never the object. Whichever of these names is
# present is the thing a human would read on the approval card.
function Read-ToolInputText($Object) {
  $container = $Object.PSObject.Properties['tool_input']
  if ($null -eq $container -or $null -eq $container.Value) { return '' }
  foreach ($name in @('command', 'file_path', 'path', 'pattern', 'url')) {
    $property = $container.Value.PSObject.Properties[$name]
    if ($null -ne $property -and $null -ne $property.Value) {
      $text = [string]$property.Value
      if ($text.Length -gt 4096) { $text = $text.Substring(0, 4096) }
      return $text
    }
  }
  return ''
}

try {
  $descriptorText = $env:EZTERMINAL_AGENT_HOOK_DESCRIPTOR
  $ezSessionId = $env:EZTERMINAL_SESSION_ID
  if ([string]::IsNullOrWhiteSpace($descriptorText) -or [string]::IsNullOrWhiteSpace($ezSessionId)) { exit 0 }

  $descriptor = $descriptorText | ConvertFrom-Json
  if ([string]::IsNullOrWhiteSpace([string]$descriptor.url) -or [string]::IsNullOrWhiteSpace([string]$descriptor.token)) { exit 0 }

  $inputText = [Console]::In.ReadToEnd()
  if ([Text.Encoding]::UTF8.GetByteCount($inputText) -gt 65536) { exit 0 }
  $inputObject = $inputText | ConvertFrom-Json

  $eventName = Read-StringField $inputObject 'hook_event_name'
  $isApproval = $eventName -eq '__APPROVAL_EVENT__'

  $sanitized = [ordered]@{
    provider = $Provider
    ezSessionId = [string]$ezSessionId
    providerSessionId = Read-StringField $inputObject 'session_id'
    cwd = Read-StringField $inputObject 'cwd'
    event = $eventName
    turnId = Read-StringField $inputObject 'turn_id'
    toolName = Read-StringField $inputObject 'tool_name'
    notificationType = Read-StringField $inputObject 'notification_type'
    command = ''
  }
  if ($isApproval) { $sanitized['command'] = Read-ToolInputText $inputObject }

  $timeoutSec = 2
  if ($isApproval) { $timeoutSec = __APPROVAL_TIMEOUT_SEC__ }

  $body = $sanitized | ConvertTo-Json -Compress
  $headers = @{ Authorization = "Bearer $([string]$descriptor.token)" }
  $response = Invoke-WebRequest -UseBasicParsing -Method Post -Uri ([string]$descriptor.url) -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec $timeoutSec

  # A body comes back only when a human decided. Anything else — 204, a
  # timeout, a dead app — prints nothing, which is the provider's own prompt.
  if ($isApproval -and $null -ne $response -and $response.StatusCode -eq 200) {
    $content = [string]$response.Content
    if (-not [string]::IsNullOrWhiteSpace($content)) { [Console]::Out.Write($content) }
  }
} catch {
  # Observability must never break or decide an agent lifecycle hook.
}

exit 0
`;

export interface AgentHookRelayDescriptor {
  readonly url: string;
  readonly token: string;
}

/** Resolves to the human's decision, or to null to fail open. */
export type AgentApprovalResolver = (event: AgentHookEvent) => Promise<AgentDecision | null>;

export class AgentHookRelay {
  private readonly token = randomBytes(32).toString('base64url');
  private readonly scriptPathValue: string;
  private readonly onEvent: (event: AgentHookEvent) => void;
  private readonly resolveApproval: AgentApprovalResolver | null;
  private server: Server | null = null;
  private descriptor: AgentHookRelayDescriptor | null = null;
  private windowStartedAt = 0;
  private requestsInWindow = 0;
  private heldRequests = 0;

  constructor(
    dataDir: string,
    onEvent: (event: AgentHookEvent) => void,
    resolveApproval?: AgentApprovalResolver,
  ) {
    this.scriptPathValue = path.join(dataDir, 'agent-hooks', RELAY_SCRIPT);
    this.onEvent = onEvent;
    this.resolveApproval = resolveApproval ?? null;
  }

  get scriptPath(): string {
    return this.scriptPathValue;
  }

  /** JSON is used so one inherited variable carries a coherent endpoint/token
   * pair. The value is injected into the interpreter only, never IPC/WS. */
  get environmentDescriptor(): string {
    if (!this.descriptor) throw new Error('agent hook relay not started');
    return JSON.stringify(this.descriptor);
  }

  async start(): Promise<void> {
    if (this.server) return;
    await fs.mkdir(path.dirname(this.scriptPathValue), { recursive: true });
    const tmp = `${this.scriptPathValue}.tmp`;
    await fs.writeFile(tmp, buildPowerShellRelayScript(), 'utf8');
    await fs.rename(tmp, this.scriptPathValue);

    const server = createServer((req, res) => this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('agent hook relay has no TCP address');
    this.descriptor = { url: `http://127.0.0.1:${address.port}${RELAY_PATH}`, token: this.token };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.descriptor = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'POST' || req.url !== RELAY_PATH) {
      this.reply(res, 404);
      req.resume();
      return;
    }
    if (!this.consumeRateSlot()) {
      this.reply(res, 429);
      req.resume();
      return;
    }
    const authorization = Array.isArray(req.headers.authorization)
      ? req.headers.authorization[0]
      : req.headers.authorization;
    if (!bearerMatches(authorization, this.token)) {
      this.reply(res, 401);
      req.resume();
      return;
    }
    const advertised = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(advertised) && advertised > MAX_HOOK_BODY_BYTES) {
      this.reply(res, 413);
      req.resume();
      return;
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer | string) => {
      if (rejected) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > MAX_HOOK_BODY_BYTES) {
        rejected = true;
        chunks.length = 0;
        this.reply(res, 413);
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (rejected) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      } catch {
        this.reply(res, 400);
        return;
      }
      const event = parseAgentHookEvent(parsed);
      if (!event) {
        this.reply(res, 400);
        return;
      }
      if (this.shouldGate(event)) {
        // The consumer needs the event on record before it can be asked to
        // decide it, so this one is delivered synchronously.
        this.onEvent(event);
        void this.awaitDecision(event, res);
        return;
      }
      // Ack first. Provider hook latency never waits for UI/event consumers.
      this.reply(res, 204);
      setImmediate(() => this.onEvent(event));
    });
    req.on('error', () => {
      if (!res.headersSent) this.reply(res, 400);
    });
  }

  private shouldGate(event: AgentHookEvent): boolean {
    return (
      this.resolveApproval !== null &&
      event.event === APPROVAL_HOOK_EVENT &&
      canGateProvider(event.provider) &&
      this.heldRequests < MAX_HELD_REQUESTS
    );
  }

  /** Holds the provider's hook open until a human answers. Every path out of
   * here that is not an explicit decision replies 204, which the script turns
   * into no output at all — the provider then prompts in the terminal. */
  private async awaitDecision(event: AgentHookEvent, res: ServerResponse): Promise<void> {
    this.heldRequests += 1;
    let closed = false;
    const onClose = (): void => {
      closed = true;
    };
    res.on('close', onClose);
    try {
      const decision = await this.resolveApproval?.(event);
      if (closed || res.writableEnded) return;
      const payload = decision ? buildDecisionPayload(event.provider, decision) : null;
      if (!payload) {
        this.reply(res, 204);
        return;
      }
      res.statusCode = 200;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json');
      res.end(payload);
    } catch {
      this.reply(res, 204);
    } finally {
      res.off('close', onClose);
      this.heldRequests -= 1;
    }
  }

  private consumeRateSlot(): boolean {
    const now = Date.now();
    if (now - this.windowStartedAt >= RATE_WINDOW_MS) {
      this.windowStartedAt = now;
      this.requestsInWindow = 0;
    }
    this.requestsInWindow += 1;
    return this.requestsInWindow <= MAX_REQUESTS_PER_WINDOW;
  }

  private reply(res: ServerResponse, status: number): void {
    if (res.headersSent) return;
    res.statusCode = status;
    res.setHeader('Cache-Control', 'no-store');
    res.end();
  }
}

export function isAgentIntegrationProvider(value: unknown): value is AgentIntegrationProvider {
  return value === 'codex' || value === 'claude';
}
