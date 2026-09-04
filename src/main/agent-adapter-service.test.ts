import { createHash, generateKeyPairSync, sign as signPayload, type KeyObject } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentAdapterManifestSchema,
  canonicalizeAdapterManifest,
  type AgentAdapterManifest,
} from '../shared/agent-adapter';
import { AgentAdapterService } from './agent-adapter-service';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true,
  })));
});

function crc32(payload: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries: readonly { readonly name: string; readonly payload: Buffer }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const checksum = crc32(entry.payload);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.payload.byteLength, 18);
    local.writeUInt32LE(entry.payload.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    localParts.push(local, name, entry.payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.payload.byteLength, 20);
    central.writeUInt32LE(entry.payload.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.byteLength + name.byteLength + entry.payload.byteLength;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function manifestFor(
  publicKey: KeyObject,
  version: string,
  capabilities: AgentAdapterManifest['capabilities'],
  executable: Buffer,
): AgentAdapterManifest {
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return AgentAdapterManifestSchema.parse({
    schemaVersion: 1,
    id: 'example.adapter',
    version,
    name: 'Example adapter',
    description: 'Signed ACP adapter used by the service integration test.',
    publisher: {
      name: 'Example publisher',
      keyId: createHash('sha256').update(publicKeyDer).digest('hex'),
      publicKeySpki: publicKeyDer.toString('base64'),
    },
    protocol: { name: 'acp', version: 1 },
    platforms: { 'win32-x64': { entrypoint: 'bin/worker.exe', args: ['--acp'] } },
    assets: [{
      path: 'bin/worker.exe',
      sha256: createHash('sha256').update(executable).digest('hex'),
      size: executable.byteLength,
    }],
    capabilities,
    profiles: [{
      id: 'worker',
      name: 'Example worker',
      description: 'Runs bounded delegated tasks.',
      permissionMode: 'read-only',
      capabilities,
    }],
  });
}

async function writeBundle(
  archivePath: string,
  keyPair: { readonly publicKey: KeyObject; readonly privateKey: KeyObject },
  version: string,
  capabilities: AgentAdapterManifest['capabilities'],
): Promise<void> {
  const executable = Buffer.from(`fake-windows-executable-${version}`, 'utf8');
  const manifest = manifestFor(keyPair.publicKey, version, capabilities, executable);
  const canonical = canonicalizeAdapterManifest(manifest);
  const signature = signPayload(null, Buffer.from(canonical, 'utf8'), keyPair.privateKey);
  await fs.writeFile(archivePath, storedZip([
    { name: 'manifest.json', payload: Buffer.from(JSON.stringify(manifest), 'utf8') },
    { name: 'signature.ed25519', payload: signature },
    { name: 'bin/worker.exe', payload: executable },
  ]));
}

async function makeFixture(): Promise<{
  readonly directory: string;
  readonly archivePath: string;
  readonly keyPair: { readonly publicKey: KeyObject; readonly privateKey: KeyObject };
}> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ez-agent-adapter-'));
  temporaryDirectories.push(directory);
  return {
    directory,
    archivePath: path.join(directory, 'example.ezadapter'),
    keyPair: generateKeyPairSync('ed25519'),
  };
}

describe('AgentAdapterService', () => {
  it('reviews publisher trust, installs a signed bundle, and separately approves update capability expansion', async () => {
    const fixture = await makeFixture();
    const healthCheck = vi.fn(async (descriptor: { readonly executable: string }) => {
      await fs.access(descriptor.executable);
      return { ok: true, message: 'ACP v1 initialize succeeded.' };
    });
    let clock = 1_000;
    const service = new AgentAdapterService(fixture.directory, { healthCheck, now: () => clock });
    await service.init();
    await writeBundle(fixture.archivePath, fixture.keyPair, '1.0.0', ['worker', 'read']);

    const firstReview = await service.inspect(fixture.archivePath);
    expect(firstReview).toMatchObject({
      ok: true,
      value: { trustRequired: true, update: false, capabilityExpansion: [] },
    });
    if (!firstReview.ok) throw new Error(firstReview.message);
    await expect(service.install({
      token: firstReview.value.token,
      trustPublisher: false,
      approveCapabilityExpansion: false,
    })).resolves.toMatchObject({ ok: false, error: 'trust-required' });

    const trustedReview = await service.inspect(fixture.archivePath);
    if (!trustedReview.ok) throw new Error(trustedReview.message);
    const installed = await service.install({
      token: trustedReview.value.token,
      trustPublisher: true,
      approveCapabilityExpansion: false,
    });
    expect(installed).toMatchObject({ ok: true, value: { version: '1.0.0', health: 'healthy' } });
    expect(service.getSnapshot()).toMatchObject({
      revision: 1,
      adapters: [{ adapterId: 'example.adapter', version: '1.0.0', enabled: true }],
      trustedPublishers: [{ publisherName: 'Example publisher' }],
    });
    expect(service.runtimeDescriptor('adapter:example.adapter:worker')?.executable).toMatch(/worker\.exe$/u);

    clock = 2_000;
    await writeBundle(fixture.archivePath, fixture.keyPair, '1.1.0', ['worker', 'read', 'write']);
    const updateReview = await service.inspect(fixture.archivePath);
    expect(updateReview).toMatchObject({
      ok: true,
      value: { trustRequired: false, update: true, capabilityExpansion: ['write'] },
    });
    if (!updateReview.ok) throw new Error(updateReview.message);
    await expect(service.install({
      token: updateReview.value.token,
      trustPublisher: false,
      approveCapabilityExpansion: false,
    })).resolves.toMatchObject({ ok: false, error: 'capability-expansion' });

    const approvedReview = await service.inspect(fixture.archivePath);
    if (!approvedReview.ok) throw new Error(approvedReview.message);
    await expect(service.install({
      token: approvedReview.value.token,
      trustPublisher: false,
      approveCapabilityExpansion: true,
    })).resolves.toMatchObject({ ok: true, value: { version: '1.1.0' } });
    expect(service.getSnapshot().adapters[0]).toMatchObject({
      capabilities: ['worker', 'read', 'write'],
      installedAt: 1_000,
      updatedAt: 2_000,
    });
    expect(healthCheck).toHaveBeenCalledTimes(2);
  });

  it('rejects an archive that changes after the signed review', async () => {
    const fixture = await makeFixture();
    const healthCheck = vi.fn(async () => ({ ok: true, message: 'healthy' }));
    const service = new AgentAdapterService(fixture.directory, { healthCheck });
    await service.init();
    await writeBundle(fixture.archivePath, fixture.keyPair, '1.0.0', ['worker', 'read']);
    const review = await service.inspect(fixture.archivePath);
    if (!review.ok) throw new Error(review.message);

    await writeBundle(fixture.archivePath, fixture.keyPair, '1.0.1', ['worker', 'read']);
    await expect(service.install({
      token: review.value.token,
      trustPublisher: true,
      approveCapabilityExpansion: false,
    })).resolves.toMatchObject({
      ok: false,
      error: 'io-error',
      message: 'The selected bundle changed after review.',
    });
    expect(service.getSnapshot().adapters).toEqual([]);
    expect(healthCheck).not.toHaveBeenCalled();
  });
});
