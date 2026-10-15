import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { z } from 'zod';
import { AsyncMutationGate } from './async-mutation-gate';

const leaseSchema = z.object({
  version: z.literal(1), runId: z.string(), taskId: z.string(), attemptId: z.string(), sessionId: z.string(),
  workspaceId: z.string(), workspaceRoot: z.string(), namespace: z.string(),
  mode: z.enum(['serial', 'namespaced']),
  ports: z.array(z.number().int().min(1).max(65535)), environment: z.record(z.string(), z.string()),
  status: z.enum(['reserved', 'active', 'released', 'orphaned']), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
export type PlanningEnvironmentLease = z.infer<typeof leaseSchema>;

/** Owns reservations and temporary namespaces. Provider process trees retain their existing guardian ownership. */
export class PlanningEnvironmentService {
  private readonly directory: string;
  private readonly leases = new Map<string, PlanningEnvironmentLease>();
  private readonly reservations = new Map<string, Server[]>();
  private readonly gate = new AsyncMutationGate();
  private validating = false;
  private readonly validationWaiters: (() => void)[] = [];
  constructor(userDataDir: string, private readonly onAvailabilityChanged: () => void = () => undefined) {
    this.directory = path.join(userDataDir, 'planning-environments-v1');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    for (const name of await fs.readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
      const bytes = await fs.readFile(path.join(this.directory, name), 'utf8');
      if (Buffer.byteLength(bytes) > 128 * 1024) throw new Error('Execution environment metadata exceeds its limit.');
      const lease = leaseSchema.parse(JSON.parse(bytes));
      if (this.key(lease.sessionId) + '.json' !== name) throw new Error('Execution environment identity is corrupt.');
      const recovered: PlanningEnvironmentLease = ['active', 'reserved'].includes(lease.status)
        ? { ...lease, status: 'orphaned', updatedAt: new Date().toISOString() } : lease;
      this.leases.set(lease.sessionId, recovered);
      if (recovered !== lease) await this.save(recovered);
    }
  }
  private key(sessionId: string) { return createHash('sha256').update(sessionId).digest('hex'); }
  private async save(lease: PlanningEnvironmentLease): Promise<void> {
    const file = path.join(this.directory, `${this.key(lease.sessionId)}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(lease)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, file);
    this.leases.set(lease.sessionId, lease);
  }
  private async port(preferred?: number): Promise<Server> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(preferred ?? 0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    server.unref();
    return server;
  }
  private async closeReservations(sessionId: string): Promise<void> {
    const servers = this.reservations.get(sessionId) ?? [];
    this.reservations.delete(sessionId);
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
  read(sessionId: string): PlanningEnvironmentLease | undefined { return this.leases.get(sessionId); }
  list(): readonly PlanningEnvironmentLease[] { return [...this.leases.values()]; }
  canActivate(sessionId: string): boolean {
    const lease = this.leases.get(sessionId);
    if (!lease || this.validating || this.validationWaiters.length) return false;
    return [...this.leases.values()].every((other) => other.sessionId === sessionId
      || !['active', 'orphaned'].includes(other.status) || (lease.mode === 'namespaced' && other.mode === 'namespaced'));
  }

  async runValidation<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await new Promise<void>((resolve, reject) => {
      const enter = () => { signal?.removeEventListener('abort', abort); resolve(); };
      const abort = () => {
        const index = this.validationWaiters.indexOf(enter);
        if (index >= 0) this.validationWaiters.splice(index, 1);
        reject(signal?.reason ?? new Error('Validation cancelled.'));
      };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      this.validationWaiters.push(enter);
      this.admitValidation();
    });
    try { return await operation(); }
    finally { this.validating = false; this.admitValidation(); this.onAvailabilityChanged(); }
  }
  private admitValidation(): void {
    if (this.validating || [...this.leases.values()].some((lease) => ['active', 'orphaned'].includes(lease.status))) return;
    const next = this.validationWaiters.shift();
    if (next) { this.validating = true; next(); }
  }

  reserve(input: Pick<PlanningEnvironmentLease, 'runId' | 'taskId' | 'attemptId' | 'sessionId' | 'workspaceId' | 'workspaceRoot'>,
    portCount: number, mode: 'serial' | 'namespaced' = 'serial'): Promise<PlanningEnvironmentLease> {
    return this.gate.runExclusive(async () => {
      const existing = this.leases.get(input.sessionId);
      if (existing) {
        if (Object.entries(input).some(([key, value]) => existing[key as keyof typeof input] !== value)) throw new Error('The environment belongs to a different execution.');
        if (existing.status === 'released') {
          const reserved: PlanningEnvironmentLease = { ...existing, status: 'reserved', updatedAt: new Date().toISOString() };
          await this.save(reserved);
          return reserved;
        }
        return existing;
      }
      if (!Number.isInteger(portCount) || portCount < 0 || portCount > 4) throw new Error('Invalid port reservation count.');
      const namespace = `ezt_${this.key(input.sessionId).slice(0, 24)}`;
      const directory = path.join(this.directory, namespace);
      const temporary = path.join(directory, 'tmp');
      const output = path.join(directory, 'output');
      await fs.mkdir(temporary, { recursive: true });
      await fs.mkdir(output, { recursive: true });
      const servers: Server[] = [];
      try {
        for (let i = 0; i < portCount; i++) servers.push(await this.port());
        this.reservations.set(input.sessionId, servers);
        const ports = servers.map((server) => (server.address() as { port: number }).port);
        const now = new Date().toISOString();
        const environment: Record<string, string> = { EZTERMINAL_RUN_ID: input.runId, EZTERMINAL_TASK_ID: input.taskId,
          EZTERMINAL_ATTEMPT_ID: input.attemptId, EZTERMINAL_TEST_NAMESPACE: namespace, EZTERMINAL_OUTPUT_DIR: output,
          TMP: temporary, TEMP: temporary, TMPDIR: temporary,
          ...(ports.length ? { PORT: String(ports[0]), EZTERMINAL_PREVIEW_ORIGIN: `http://127.0.0.1:${ports[0]}` } : {}),
        };
        ports.forEach((port, index) => { environment[`EZTERMINAL_PORT_${index + 1}`] = String(port); });
        const lease: PlanningEnvironmentLease = { version: 1, ...input, mode, namespace, ports, environment, status: 'reserved', createdAt: now, updatedAt: now };
        await this.save(lease);
        return lease;
      } catch (error) {
        await this.closeReservations(input.sessionId);
        throw error;
      }
    });
  }
  activate(sessionId: string): Promise<void> {
    return this.gate.runExclusive(async () => {
      const lease = this.leases.get(sessionId);
      if (!lease) throw new Error('The execution environment has not been prepared.');
      if (!this.canActivate(sessionId)) throw new Error('A shared execution environment is occupied.');
      if (lease.status === 'active') return;
      if (lease.status === 'released') throw new Error('This execution environment has ended.');
      // An orphan may belong to a still-running process after a host crash. Never kill it or guess ownership.
      if (!this.reservations.has(sessionId)) {
        const servers: Server[] = [];
        this.reservations.set(sessionId, servers);
        try { for (const port of lease.ports) servers.push(await this.port(port)); }
        catch { await this.closeReservations(sessionId); throw new Error('A recovered port is still occupied. Reconcile its process before dispatch.'); }
      }
      await this.save({ ...lease, status: 'active', updatedAt: new Date().toISOString() });
      await this.closeReservations(sessionId);
    });
  }
  suspend(sessionId: string): Promise<void> {
    return this.gate.runExclusive(async () => {
      const lease = this.leases.get(sessionId);
      if (lease && ['active', 'orphaned'].includes(lease.status)) await this.save({ ...lease, status: 'reserved', updatedAt: new Date().toISOString() });
      this.admitValidation();
      this.onAvailabilityChanged();
    });
  }
  release(sessionId: string): Promise<void> {
    return this.gate.runExclusive(async () => {
      await this.closeReservations(sessionId);
      const lease = this.leases.get(sessionId);
      if (lease && lease.status !== 'released') await this.save({ ...lease, status: 'released', updatedAt: new Date().toISOString() });
      this.admitValidation();
      this.onAvailabilityChanged();
      // Worktree, logs, and temporary outputs remain available for explicit cleanup and backup.
    });
  }
  async dispose(): Promise<void> { await this.gate.runExclusive(async () => { for (const id of this.reservations.keys()) await this.closeReservations(id); }); }
}
