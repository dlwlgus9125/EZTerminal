import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';

import type { AgentHookEvent, AgentIntegrationProvider } from '../shared/agent';

const MAX_HOOK_BODY_BYTES = 64 * 1024;
const RATE_WINDOW_MS = 10_000;
const MAX_REQUESTS_PER_WINDOW = 120;
const RELAY_PATH = '/agent-hook/v1';
const RELAY_SCRIPT = 'agent-hook-relay.ps1';

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
  if (turnId === null || toolName === null || notificationType === null) return null;
  return {
    provider,
    ezSessionId,
    providerSessionId,
    cwd,
    event,
    ...(turnId ? { turnId } : {}),
    ...(toolName ? { toolName } : {}),
    ...(notificationType ? { notificationType } : {}),
  };
}

function bearerMatches(candidate: string | undefined, token: string): boolean {
  if (!candidate?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(candidate.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/**
 * PowerShell performs the first and most important privacy boundary: it reads
 * provider stdin, constructs a new allowlisted object, and sends only that
 * object to main. It is deliberately silent and non-blocking on every failure;
 * exit 0 with no output never approves or denies a provider action.
 */
export function buildPowerShellRelayScript(): string {
  return String.raw`param(
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

try {
  $descriptorText = $env:EZTERMINAL_AGENT_HOOK_DESCRIPTOR
  $ezSessionId = $env:EZTERMINAL_SESSION_ID
  if ([string]::IsNullOrWhiteSpace($descriptorText) -or [string]::IsNullOrWhiteSpace($ezSessionId)) { exit 0 }

  $descriptor = $descriptorText | ConvertFrom-Json
  if ([string]::IsNullOrWhiteSpace([string]$descriptor.url) -or [string]::IsNullOrWhiteSpace([string]$descriptor.token)) { exit 0 }

  $inputText = [Console]::In.ReadToEnd()
  if ([Text.Encoding]::UTF8.GetByteCount($inputText) -gt 65536) { exit 0 }
  $inputObject = $inputText | ConvertFrom-Json

  $sanitized = [ordered]@{
    provider = $Provider
    ezSessionId = [string]$ezSessionId
    providerSessionId = Read-StringField $inputObject 'session_id'
    cwd = Read-StringField $inputObject 'cwd'
    event = Read-StringField $inputObject 'hook_event_name'
    turnId = Read-StringField $inputObject 'turn_id'
    toolName = Read-StringField $inputObject 'tool_name'
    notificationType = Read-StringField $inputObject 'notification_type'
  }

  $body = $sanitized | ConvertTo-Json -Compress
  $headers = @{ Authorization = "Bearer $([string]$descriptor.token)" }
  $null = Invoke-WebRequest -UseBasicParsing -Method Post -Uri ([string]$descriptor.url) -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 2
} catch {
  # Observability must never break or decide an agent lifecycle hook.
}

exit 0
`;
}

export interface AgentHookRelayDescriptor {
  readonly url: string;
  readonly token: string;
}

export class AgentHookRelay {
  private readonly token = randomBytes(32).toString('base64url');
  private readonly scriptPathValue: string;
  private readonly onEvent: (event: AgentHookEvent) => void;
  private server: Server | null = null;
  private descriptor: AgentHookRelayDescriptor | null = null;
  private windowStartedAt = 0;
  private requestsInWindow = 0;

  constructor(dataDir: string, onEvent: (event: AgentHookEvent) => void) {
    this.scriptPathValue = path.join(dataDir, 'agent-hooks', RELAY_SCRIPT);
    this.onEvent = onEvent;
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
      // Ack first. Provider hook latency never waits for UI/event consumers.
      this.reply(res, 204);
      setImmediate(() => this.onEvent(event));
    });
    req.on('error', () => {
      if (!res.headersSent) this.reply(res, 400);
    });
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
