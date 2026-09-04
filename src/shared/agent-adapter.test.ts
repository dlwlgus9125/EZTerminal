import { describe, expect, it } from 'vitest';

import {
  AgentAdapterManifestSchema,
  canonicalizeAdapterManifest,
  isSafeAdapterAssetPath,
} from './agent-adapter';

const manifest = {
  schemaVersion: 1,
  id: 'example.adapter',
  version: '1.2.3',
  name: 'Example adapter',
  description: 'A test ACP adapter.',
  publisher: { name: 'Example', keyId: 'a'.repeat(64), publicKeySpki: 'MCowBQYDK2VwAyEA' },
  protocol: { name: 'acp', version: 1 },
  platforms: { 'win32-x64': { entrypoint: 'bin/adapter.exe', args: [] } },
  assets: [{ path: 'bin/adapter.exe', sha256: 'b'.repeat(64), size: 42 }],
  capabilities: ['worker', 'read'],
  profiles: [{
    id: 'reader', name: 'Reader', description: 'Read-only worker', permissionMode: 'read-only',
    capabilities: ['worker', 'read'],
  }],
} as const;

describe('agent adapter manifest', () => {
  it('accepts safe assets and rejects traversal, alternate streams, links-by-name, and device names', () => {
    expect(isSafeAdapterAssetPath('bin/adapter.exe')).toBe(true);
    for (const candidate of [
      '../escape.exe', '/root.exe', 'C:/drive.exe', 'bin\\file.exe', 'bin/file.exe:ads',
      'bin/CON', 'bin/line\nbreak.exe',
    ]) {
      expect(isSafeAdapterAssetPath(candidate), candidate).toBe(false);
    }
  });

  it('canonicalizes object keys deterministically while preserving array order', () => {
    const parsed = AgentAdapterManifestSchema.parse(manifest);
    const reordered = {
      ...parsed,
      publisher: {
        publicKeySpki: parsed.publisher.publicKeySpki,
        keyId: parsed.publisher.keyId,
        name: parsed.publisher.name,
      },
    };
    expect(canonicalizeAdapterManifest(parsed)).toBe(canonicalizeAdapterManifest(reordered));
  });

  it('rejects undeclared protocol versions and unsafe paths at the schema boundary', () => {
    expect(AgentAdapterManifestSchema.safeParse(manifest).success).toBe(true);
    expect(AgentAdapterManifestSchema.safeParse({ ...manifest, protocol: { name: 'acp', version: 2 } }).success).toBe(false);
    expect(AgentAdapterManifestSchema.safeParse({
      ...manifest,
      assets: [{ ...manifest.assets[0], path: '../adapter.exe' }],
    }).success).toBe(false);
  });
});
