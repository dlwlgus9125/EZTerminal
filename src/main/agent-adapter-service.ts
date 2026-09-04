import { spawn } from 'node:child_process';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, Writable } from 'node:stream';
import { open as openZip, type Entry, type ZipFile } from 'yauzl';

import {
  AgentAdapterManifestSchema,
  MAX_AGENT_ADAPTER_ARCHIVE_BYTES,
  MAX_AGENT_ADAPTER_COMPRESSION_RATIO,
  MAX_AGENT_ADAPTER_ENTRIES,
  MAX_AGENT_ADAPTER_EXPANDED_BYTES,
  MAX_AGENT_ADAPTER_MANIFEST_BYTES,
  adapterProfiles,
  adapterProvider,
  canonicalizeAdapterManifest,
  isSafeAdapterAssetPath,
  type AgentAdapterInstallPreview,
  type AgentAdapterManifest,
  type AgentAdapterMutationResult,
  type AgentAdapterPublisherTrust,
  type AgentAdapterSnapshot,
  type InstallAgentAdapterInput,
  type InstalledAgentAdapter,
} from '../shared/agent-adapter';
import type { AgentProfile, AgentProviderRef } from '../shared/agent-orchestration';
import { JsonFile } from './json-file';

const ADAPTER_STATE_FILE = 'agent-adapters.json';
const PREVIEW_LIFETIME_MS = 10 * 60_000;
const MANIFEST_ENTRY = 'manifest.json';
const SIGNATURE_ENTRY = 'signature.ed25519';
const MAX_SIGNATURE_BYTES = 4 * 1024;

interface AdapterRecord {
  readonly manifest: AgentAdapterManifest;
  readonly contentDigest: string;
  readonly enabled: boolean;
  readonly installedAt: number;
  readonly updatedAt: number;
}

interface AdapterState {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly adapters: readonly AdapterRecord[];
  readonly trustedPublishers: readonly AgentAdapterPublisherTrust[];
}

interface InspectedBundle {
  readonly manifest: AgentAdapterManifest;
  readonly contentDigest: string;
}

interface PreviewRecord extends InspectedBundle {
  readonly archivePath: string;
  readonly expiresAt: number;
}

export interface AgentAdapterRuntimeDescriptor {
  readonly adapterId: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly manifest: AgentAdapterManifest;
}

export interface AgentAdapterServiceDependencies {
  readonly healthCheck?: (descriptor: AgentAdapterRuntimeDescriptor) => Promise<{
    readonly ok: boolean;
    readonly message: string;
  }>;
  readonly now?: () => number;
  readonly createId?: () => string;
}

function emptyState(): AdapterState {
  return { schemaVersion: 1, revision: 0, adapters: [], trustedPublishers: [] };
}

function unique(values: readonly string[]): boolean {
  return new Set(values.map((value) => value.toLocaleLowerCase('en-US'))).size === values.length;
}

function validateState(raw: unknown): AdapterState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== 1 || !Number.isInteger(value.revision) || (value.revision as number) < 0) return null;
  if (!Array.isArray(value.adapters) || value.adapters.length > 128
    || !Array.isArray(value.trustedPublishers) || value.trustedPublishers.length > 128) return null;
  const adapters: AdapterRecord[] = [];
  for (const rawRecord of value.adapters) {
    if (!rawRecord || typeof rawRecord !== 'object' || Array.isArray(rawRecord)) return null;
    const record = rawRecord as Record<string, unknown>;
    const manifest = AgentAdapterManifestSchema.safeParse(record.manifest);
    if (!manifest.success || typeof record.contentDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(record.contentDigest)
      || typeof record.enabled !== 'boolean' || typeof record.installedAt !== 'number'
      || typeof record.updatedAt !== 'number') return null;
    adapters.push({
      manifest: manifest.data,
      contentDigest: record.contentDigest,
      enabled: record.enabled,
      installedAt: record.installedAt,
      updatedAt: record.updatedAt,
    });
  }
  const trustedPublishers: AgentAdapterPublisherTrust[] = [];
  for (const rawTrust of value.trustedPublishers) {
    if (!rawTrust || typeof rawTrust !== 'object' || Array.isArray(rawTrust)) return null;
    const trust = rawTrust as Record<string, unknown>;
    if (typeof trust.keyId !== 'string' || !/^[0-9a-f]{64}$/u.test(trust.keyId)
      || typeof trust.publisherName !== 'string' || trust.publisherName.trim().length < 1
      || typeof trust.publicKeySpki !== 'string' || trust.publicKeySpki.length < 1
      || typeof trust.trustedAt !== 'number') return null;
    trustedPublishers.push({
      keyId: trust.keyId,
      publisherName: trust.publisherName,
      publicKeySpki: trust.publicKeySpki,
      trustedAt: trust.trustedAt,
    });
  }
  if (!unique(adapters.map((record) => record.manifest.id))
    || !unique(trustedPublishers.map((trust) => trust.keyId))) return null;
  return {
    schemaVersion: 1,
    revision: value.revision as number,
    adapters,
    trustedPublishers,
  };
}

function fail<T>(
  error: 'invalid' | 'not-found' | 'expired' | 'trust-required' | 'capability-expansion' | 'io-error' | 'health-failed',
  message: string,
): AgentAdapterMutationResult<T> {
  return { ok: false, error, message };
}

function decodeSignature(buffer: Buffer): Buffer | null {
  if (buffer.byteLength === 64) return buffer;
  const text = buffer.toString('utf8').trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(text)) return null;
  const decoded = Buffer.from(text, 'base64');
  return decoded.byteLength === 64 ? decoded : null;
}

function openArchive(archivePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    openZip(archivePath, { lazyEntries: true, autoClose: true, decodeStrings: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error('Could not open adapter archive.'));
      else resolve(zip);
    });
  });
}

function openEntry(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error(`Could not read ${entry.fileName}.`));
      else resolve(stream);
    });
  });
}

function validateZipEntry(entry: Entry, names: Set<string>): void {
  if (!isSafeAdapterAssetPath(entry.fileName) && entry.fileName !== MANIFEST_ENTRY && entry.fileName !== SIGNATURE_ENTRY) {
    throw new Error(`Unsafe archive entry: ${entry.fileName}`);
  }
  if (entry.fileName.endsWith('/') || (entry.externalFileAttributes & 0x10) !== 0
    || (entry.externalFileAttributes & 0x400) !== 0) {
    throw new Error(`Directories and reparse points are not allowed: ${entry.fileName}`);
  }
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const unixType = unixMode & 0o170000;
  if (unixType !== 0 && unixType !== 0o100000) throw new Error(`Links are not allowed: ${entry.fileName}`);
  if ((entry.generalPurposeBitFlag & 1) !== 0) throw new Error(`Encrypted entries are not allowed: ${entry.fileName}`);
  const key = entry.fileName.toLocaleLowerCase('en-US');
  if (names.has(key)) throw new Error(`Duplicate archive entry: ${entry.fileName}`);
  names.add(key);
  const ratio = entry.uncompressedSize / Math.max(1, entry.compressedSize);
  if (ratio > MAX_AGENT_ADAPTER_COMPRESSION_RATIO) throw new Error(`Unsafe compression ratio: ${entry.fileName}`);
}

async function readSmallEntry(zip: ZipFile, entry: Entry, limit: number): Promise<Buffer> {
  if (entry.uncompressedSize > limit) throw new Error(`${entry.fileName} is too large.`);
  const chunks: Buffer[] = [];
  let length = 0;
  await pipeline(await openEntry(zip, entry), new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += buffer.byteLength;
      if (length > limit) callback(new Error(`${entry.fileName} is too large.`));
      else {
        chunks.push(buffer);
        callback();
      }
    },
  }));
  return Buffer.concat(chunks, length);
}

async function hashOrExtractEntry(
  zip: ZipFile,
  entry: Entry,
  extractRoot: string | undefined,
): Promise<{ readonly sha256: string; readonly size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.byteLength;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const stream = await openEntry(zip, entry);
  if (extractRoot) {
    const destination = path.join(extractRoot, ...entry.fileName.split('/'));
    const relative = path.relative(extractRoot, destination);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Archive path escaped staging.');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await pipeline(stream, meter, createWriteStream(destination, { flags: 'wx', mode: 0o700 }));
  } else {
    await pipeline(stream, meter, new Transform({ transform(_chunk, _encoding, callback) { callback(); } }));
  }
  if (size !== entry.uncompressedSize) throw new Error(`Entry size changed while reading: ${entry.fileName}`);
  return { sha256: hash.digest('hex'), size };
}

async function inspectArchive(archivePath: string, extractRoot?: string): Promise<InspectedBundle> {
  const stat = await fs.stat(archivePath);
  if (!stat.isFile() || stat.size > MAX_AGENT_ADAPTER_ARCHIVE_BYTES) throw new Error('Adapter bundle exceeds the 256 MiB archive limit.');
  const zip = await openArchive(archivePath);
  const names = new Set<string>();
  const files = new Map<string, { readonly sha256: string; readonly size: number }>();
  let manifestBytes: Buffer | undefined;
  let signatureBytes: Buffer | undefined;
  let entries = 0;
  let expanded = 0;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const abort = (error: unknown): void => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error);
    };
    zip.once('error', abort);
    zip.once('end', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zip.on('entry', (entry) => {
      void (async () => {
        entries += 1;
        if (entries > MAX_AGENT_ADAPTER_ENTRIES) throw new Error('Adapter bundle has too many entries.');
        validateZipEntry(entry, names);
        expanded += entry.uncompressedSize;
        if (expanded > MAX_AGENT_ADAPTER_EXPANDED_BYTES
          || expanded / Math.max(1, stat.size) > MAX_AGENT_ADAPTER_COMPRESSION_RATIO) {
          throw new Error('Adapter bundle exceeds the expanded-size safety limit.');
        }
        if (entry.fileName === MANIFEST_ENTRY) {
          manifestBytes = await readSmallEntry(zip, entry, MAX_AGENT_ADAPTER_MANIFEST_BYTES);
        } else if (entry.fileName === SIGNATURE_ENTRY) {
          signatureBytes = await readSmallEntry(zip, entry, MAX_SIGNATURE_BYTES);
        } else {
          files.set(entry.fileName, await hashOrExtractEntry(zip, entry, extractRoot));
        }
        zip.readEntry();
      })().catch(abort);
    });
    zip.readEntry();
  });

  if (!manifestBytes || !signatureBytes) throw new Error('Adapter bundle must contain manifest.json and signature.ed25519.');
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(manifestBytes.toString('utf8')) as unknown;
  } catch {
    throw new Error('Adapter manifest is not valid UTF-8 JSON.');
  }
  const parsed = AgentAdapterManifestSchema.safeParse(rawManifest);
  if (!parsed.success) throw new Error(`Adapter manifest is invalid: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`);
  const manifest = parsed.data;
  if (!manifest.platforms['win32-x64'].entrypoint.toLocaleLowerCase('en-US').endsWith('.exe')) {
    throw new Error('The win32-x64 adapter entrypoint must be a bundled .exe file.');
  }
  if (!unique(manifest.assets.map((asset) => asset.path)) || !unique(manifest.profiles.map((profile) => profile.id))
    || !unique(manifest.capabilities)) throw new Error('Adapter manifest contains duplicate ids, assets, or capabilities.');
  const declaredCapabilities = new Set(manifest.capabilities);
  if (manifest.profiles.some((profile) => !unique(profile.capabilities)
    || profile.capabilities.some((capability) => !declaredCapabilities.has(capability)))) {
    throw new Error('A profile declares duplicate or undeclared capabilities.');
  }
  const declared = new Set(manifest.assets.map((asset) => asset.path));
  if (!declared.has(manifest.platforms['win32-x64'].entrypoint)
    || files.size !== declared.size || [...files.keys()].some((name) => !declared.has(name))) {
    throw new Error('Archive files do not exactly match the manifest asset list.');
  }
  for (const asset of manifest.assets) {
    const actual = files.get(asset.path);
    if (!actual || actual.sha256 !== asset.sha256 || actual.size !== asset.size) {
      throw new Error(`Asset integrity check failed: ${asset.path}`);
    }
  }
  const publicKeyDer = Buffer.from(manifest.publisher.publicKeySpki, 'base64');
  if (publicKeyDer.byteLength === 0 || publicKeyDer.toString('base64').replace(/=+$/u, '')
    !== manifest.publisher.publicKeySpki.replace(/=+$/u, '')) throw new Error('Publisher public key is not valid base64.');
  const keyId = createHash('sha256').update(publicKeyDer).digest('hex');
  if (keyId !== manifest.publisher.keyId) throw new Error('Publisher key id does not match the public key.');
  const publicKey = createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Publisher key must be Ed25519.');
  const signature = decodeSignature(signatureBytes);
  const canonical = canonicalizeAdapterManifest(manifest);
  if (!signature || !verify(null, Buffer.from(canonical, 'utf8'), publicKey, signature)) {
    throw new Error('Adapter publisher signature is invalid.');
  }
  return {
    manifest,
    contentDigest: createHash('sha256').update(canonical).update(signature).digest('hex'),
  };
}

async function acpHealthCheck(descriptor: AgentAdapterRuntimeDescriptor): Promise<{ readonly ok: boolean; readonly message: string }> {
  return new Promise((resolve) => {
    const child = spawn(descriptor.executable, [...descriptor.args], {
      cwd: path.dirname(descriptor.executable),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: { ...process.env, EZTERMINAL_ADAPTER_HEALTH_CHECK: '1' },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (ok: boolean, message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve({ ok, message });
    };
    const timer = setTimeout(() => finish(false, 'ACP initialize timed out.'), 8_000);
    timer.unref?.();
    child.once('error', (error) => finish(false, error.message));
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4_096) stderr += chunk.toString('utf8').slice(0, 4_096 - stderr.length);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdout += chunk.toString('utf8');
      if (stdout.length > 64 * 1024) return finish(false, 'ACP initialize response exceeded 64 KiB.');
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(stdout.slice(0, newline).trim()) as {
          readonly jsonrpc?: unknown;
          readonly id?: unknown;
          readonly result?: { readonly protocolVersion?: unknown };
          readonly error?: unknown;
        };
        if (response.jsonrpc !== '2.0' || response.id !== 1 || response.error
          || response.result?.protocolVersion !== descriptor.manifest.protocol.version) {
          finish(false, 'ACP initialize returned an incompatible response.');
        } else {
          finish(true, 'ACP v1 initialize succeeded.');
        }
      } catch {
        finish(false, 'ACP initialize returned invalid JSON.');
      }
    });
    child.once('exit', (code) => {
      if (!settled) finish(false, stderr.trim() || `Adapter exited during ACP initialize (${code ?? 'signal'}).`);
    });
    child.stdin.end(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: descriptor.manifest.protocol.version,
        clientCapabilities: {},
        clientInfo: { name: 'ezterminal', title: 'EZTerminal', version: '1' },
      },
    })}\n`);
  });
}

export class AgentAdapterService {
  private readonly file: JsonFile;
  private readonly bundlesDir: string;
  private readonly previews = new Map<string, PreviewRecord>();
  private readonly health = new Map<string, { readonly state: 'healthy' | 'missing' | 'failed'; readonly message?: string }>();
  private readonly listeners = new Set<(snapshot: AgentAdapterSnapshot) => void>();
  private readonly healthCheck: NonNullable<AgentAdapterServiceDependencies['healthCheck']>;
  private readonly now: NonNullable<AgentAdapterServiceDependencies['now']>;
  private readonly createId: NonNullable<AgentAdapterServiceDependencies['createId']>;
  private mutationTail: Promise<void> = Promise.resolve();
  private state: AdapterState = emptyState();

  constructor(userDataDir: string, dependencies: AgentAdapterServiceDependencies = {}) {
    this.file = new JsonFile(userDataDir, ADAPTER_STATE_FILE);
    this.bundlesDir = path.join(userDataDir, 'agent-adapters', 'bundles');
    this.healthCheck = dependencies.healthCheck ?? acpHealthCheck;
    this.now = dependencies.now ?? (() => Date.now());
    this.createId = dependencies.createId ?? (() => randomUUID());
  }

  async init(): Promise<void> {
    await this.file.init();
    this.state = await this.file.readValidated(validateState, emptyState());
    await fs.mkdir(this.bundlesDir, { recursive: true });
    for (const record of this.state.adapters) {
      if (!record.enabled) continue;
      const descriptor = this.descriptorForRecord(record);
      try {
        await fs.access(descriptor.executable);
        const checked = await this.healthCheck(descriptor);
        this.health.set(record.manifest.id, checked.ok
          ? { state: 'healthy', message: checked.message }
          : { state: 'failed', message: checked.message });
      } catch {
        this.health.set(record.manifest.id, { state: 'missing', message: 'Installed adapter files are missing.' });
      }
    }
  }

  getSnapshot(): AgentAdapterSnapshot {
    return {
      revision: this.state.revision,
      adapters: this.state.adapters.map((record) => this.publicRecord(record)),
      trustedPublishers: this.state.trustedPublishers,
    };
  }

  onSnapshot(listener: (snapshot: AgentAdapterSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  providers(): readonly AgentProviderRef[] {
    return this.state.adapters.map((record) => adapterProvider(record.manifest));
  }

  profiles(): readonly AgentProfile[] {
    return this.state.adapters.flatMap((record) => adapterProfiles(
      record.manifest,
      record.enabled && this.health.get(record.manifest.id)?.state === 'healthy',
    ));
  }

  runtimeDescriptor(profileId: string): AgentAdapterRuntimeDescriptor | null {
    const record = this.state.adapters.find((candidate) => adapterProfiles(candidate.manifest, true)
      .some((profile) => profile.profileId === profileId));
    if (!record || !record.enabled || this.health.get(record.manifest.id)?.state !== 'healthy') return null;
    return this.descriptorForRecord(record);
  }

  async inspect(archivePath: string): Promise<AgentAdapterMutationResult<AgentAdapterInstallPreview>> {
    this.prunePreviews();
    try {
      const inspected = await inspectArchive(archivePath);
      const existing = this.state.adapters.find((record) => record.manifest.id === inspected.manifest.id);
      if (existing && existing.manifest.publisher.keyId !== inspected.manifest.publisher.keyId) {
        return fail('invalid', 'An adapter update cannot change its publisher key.');
      }
      const trust = this.state.trustedPublishers.find((candidate) => candidate.keyId === inspected.manifest.publisher.keyId);
      if (trust && trust.publicKeySpki !== inspected.manifest.publisher.publicKeySpki) {
        return fail('invalid', 'The publisher key conflicts with the trusted key record.');
      }
      const previousCapabilities = new Set(existing?.manifest.capabilities ?? []);
      const capabilityExpansion = existing
        ? inspected.manifest.capabilities.filter((capability) => !previousCapabilities.has(capability))
        : [];
      const token = this.createId();
      const expiresAt = this.now() + PREVIEW_LIFETIME_MS;
      this.previews.set(token, { ...inspected, archivePath, expiresAt });
      return {
        ok: true,
        value: {
          token,
          adapterId: inspected.manifest.id,
          version: inspected.manifest.version,
          name: inspected.manifest.name,
          description: inspected.manifest.description,
          publisherName: inspected.manifest.publisher.name,
          publisherKeyId: inspected.manifest.publisher.keyId,
          capabilities: inspected.manifest.capabilities,
          profiles: inspected.manifest.profiles.map((profile) => ({ name: profile.name, permissionMode: profile.permissionMode })),
          trustRequired: !trust,
          update: Boolean(existing),
          capabilityExpansion,
          expiresAt,
        },
      };
    } catch (error) {
      return fail('invalid', error instanceof Error ? error.message : 'Adapter bundle inspection failed.');
    }
  }

  install(input: InstallAgentAdapterInput): Promise<AgentAdapterMutationResult<InstalledAgentAdapter>> {
    return this.enqueueMutation(() => this.installLocked(input));
  }

  private async installLocked(input: InstallAgentAdapterInput): Promise<AgentAdapterMutationResult<InstalledAgentAdapter>> {
    this.prunePreviews();
    const preview = typeof input?.token === 'string' ? this.previews.get(input.token) : undefined;
    if (!preview) return fail('expired', 'Adapter review expired; choose the bundle again.');
    this.previews.delete(input.token);
    const existing = this.state.adapters.find((record) => record.manifest.id === preview.manifest.id);
    const trust = this.state.trustedPublishers.find((candidate) => candidate.keyId === preview.manifest.publisher.keyId);
    if (!trust && input.trustPublisher !== true) return fail('trust-required', 'Trust this publisher key before installation.');
    const previousCapabilities = new Set(existing?.manifest.capabilities ?? []);
    const expanded = preview.manifest.capabilities.filter((capability) => !previousCapabilities.has(capability));
    if (existing && expanded.length > 0 && input.approveCapabilityExpansion !== true) {
      return fail('capability-expansion', 'Approve the adapter update\'s new capabilities before installation.');
    }
    const finalDir = this.bundlePath(preview.manifest.id, preview.contentDigest);
    const stagingDir = path.join(this.bundlesDir, `.staging-${this.createId()}`);
    try {
      const rechecked = await inspectArchive(preview.archivePath, stagingDir);
      if (rechecked.contentDigest !== preview.contentDigest) throw new Error('The selected bundle changed after review.');
      const descriptor = this.descriptor(preview.manifest, stagingDir);
      const checked = await this.healthCheck(descriptor);
      if (!checked.ok) {
        await fs.rm(stagingDir, { recursive: true, force: true });
        return fail('health-failed', checked.message);
      }
      await fs.mkdir(path.dirname(finalDir), { recursive: true });
      try {
        await fs.rename(stagingDir, finalDir);
      } catch (error) {
        const present = await fs.stat(finalDir).then((stat) => stat.isDirectory()).catch(() => false);
        if (!present) throw error;
        await fs.rm(stagingDir, { recursive: true, force: true });
      }
      const now = this.now();
      const record: AdapterRecord = {
        manifest: preview.manifest,
        contentDigest: preview.contentDigest,
        enabled: true,
        installedAt: existing?.installedAt ?? now,
        updatedAt: now,
      };
      const trustedPublishers = trust ? this.state.trustedPublishers : [
        ...this.state.trustedPublishers,
        {
          keyId: preview.manifest.publisher.keyId,
          publisherName: preview.manifest.publisher.name,
          publicKeySpki: preview.manifest.publisher.publicKeySpki,
          trustedAt: now,
        },
      ];
      await this.replaceState({
        schemaVersion: 1,
        revision: this.state.revision + 1,
        adapters: [...this.state.adapters.filter((candidate) => candidate.manifest.id !== record.manifest.id), record],
        trustedPublishers,
      });
      this.health.set(record.manifest.id, { state: 'healthy', message: checked.message });
      this.publish();
      return { ok: true, value: this.publicRecord(record) };
    } catch (error) {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      return fail('io-error', error instanceof Error ? error.message : 'Adapter installation failed.');
    }
  }

  setEnabled(adapterId: string, enabled: boolean): Promise<AgentAdapterMutationResult<InstalledAgentAdapter>> {
    return this.enqueueMutation(() => this.setEnabledLocked(adapterId, enabled));
  }

  private async setEnabledLocked(adapterId: string, enabled: boolean): Promise<AgentAdapterMutationResult<InstalledAgentAdapter>> {
    const record = this.state.adapters.find((candidate) => candidate.manifest.id === adapterId);
    if (!record) return fail('not-found', 'Adapter not found.');
    let health = this.health.get(adapterId);
    if (enabled) {
      try {
        const checked = await this.healthCheck(this.descriptorForRecord(record));
        health = checked.ok ? { state: 'healthy', message: checked.message } : { state: 'failed', message: checked.message };
      } catch (error) {
        health = { state: 'failed', message: error instanceof Error ? error.message : 'Adapter health check failed.' };
      }
      this.health.set(adapterId, health);
      if (health.state !== 'healthy') return fail('health-failed', health.message ?? 'Adapter health check failed.');
    }
    const next = { ...record, enabled, updatedAt: this.now() };
    await this.replaceState({
      ...this.state,
      revision: this.state.revision + 1,
      adapters: this.state.adapters.map((candidate) => candidate.manifest.id === adapterId ? next : candidate),
    });
    this.publish();
    return { ok: true, value: this.publicRecord(next) };
  }

  remove(adapterId: string): Promise<AgentAdapterMutationResult<true>> {
    return this.enqueueMutation(() => this.removeLocked(adapterId));
  }

  private async removeLocked(adapterId: string): Promise<AgentAdapterMutationResult<true>> {
    const record = this.state.adapters.find((candidate) => candidate.manifest.id === adapterId);
    if (!record) return fail('not-found', 'Adapter not found.');
    await this.replaceState({
      ...this.state,
      revision: this.state.revision + 1,
      adapters: this.state.adapters.filter((candidate) => candidate.manifest.id !== adapterId),
    });
    this.health.delete(adapterId);
    await fs.rm(this.bundlePath(record.manifest.id, record.contentDigest), { recursive: true, force: true }).catch(() => undefined);
    this.publish();
    return { ok: true, value: true };
  }

  async flush(): Promise<void> {
    await this.mutationTail;
    await this.file.flush();
  }

  private bundlePath(adapterId: string, digest: string): string {
    return path.join(this.bundlesDir, adapterId, digest);
  }

  private descriptor(manifest: AgentAdapterManifest, root: string): AgentAdapterRuntimeDescriptor {
    const platform = manifest.platforms['win32-x64'];
    return {
      adapterId: manifest.id,
      executable: path.join(root, ...platform.entrypoint.split('/')),
      args: platform.args,
      manifest,
    };
  }

  private descriptorForRecord(record: AdapterRecord): AgentAdapterRuntimeDescriptor {
    return this.descriptor(record.manifest, this.bundlePath(record.manifest.id, record.contentDigest));
  }

  private publicRecord(record: AdapterRecord): InstalledAgentAdapter {
    const health = record.enabled ? this.health.get(record.manifest.id) : undefined;
    return {
      adapterId: record.manifest.id,
      version: record.manifest.version,
      name: record.manifest.name,
      description: record.manifest.description,
      publisherName: record.manifest.publisher.name,
      publisherKeyId: record.manifest.publisher.keyId,
      capabilities: record.manifest.capabilities,
      enabled: record.enabled,
      health: record.enabled ? health?.state ?? 'missing' : 'missing',
      ...(health?.message ? { healthMessage: health.message } : {}),
      installedAt: record.installedAt,
      updatedAt: record.updatedAt,
    };
  }

  private async replaceState(next: AdapterState): Promise<void> {
    await this.file.enqueue(async () => this.file.writeAtomic(JSON.stringify(next)));
    this.state = next;
  }

  private enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(mutation, mutation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private prunePreviews(): void {
    const now = this.now();
    for (const [token, preview] of this.previews) if (preview.expiresAt <= now) this.previews.delete(token);
  }

  private publish(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
