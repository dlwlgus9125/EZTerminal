import { z } from 'zod';

import type { AgentProfile, AgentProfileCapability, AgentProviderRef } from './agent-orchestration';

export const AGENT_ADAPTER_SCHEMA_VERSION = 1 as const;
export const MAX_AGENT_ADAPTER_ARCHIVE_BYTES = 256 * 1024 * 1024;
export const MAX_AGENT_ADAPTER_EXPANDED_BYTES = 512 * 1024 * 1024;
export const MAX_AGENT_ADAPTER_ENTRIES = 256;
export const MAX_AGENT_ADAPTER_MANIFEST_BYTES = 64 * 1024;
export const MAX_AGENT_ADAPTER_COMPRESSION_RATIO = 200;

const Id = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/u);
const Version = z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u).max(80);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const SafeText = (max: number) => z.string().trim().min(1).max(max)
  .refine((value) => !hasControlCharacter(value), 'control characters are not allowed');
const RelativeAssetPath = z.string().min(1).max(240).refine(isSafeAdapterAssetPath, 'unsafe asset path');
const Capability = z.enum([
  'lead', 'worker', 'read', 'write', 'verify', 'permission-events', 'parent-events',
]);

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

export const AgentAdapterManifestSchema = z.strictObject({
  schemaVersion: z.literal(AGENT_ADAPTER_SCHEMA_VERSION),
  id: Id,
  version: Version,
  name: SafeText(120),
  description: SafeText(500),
  publisher: z.strictObject({
    name: SafeText(120),
    keyId: Sha256,
    publicKeySpki: z.string().min(1).max(512),
  }),
  protocol: z.strictObject({
    name: z.literal('acp'),
    version: z.literal(1),
  }),
  platforms: z.strictObject({
    'win32-x64': z.strictObject({
      entrypoint: RelativeAssetPath,
      args: z.array(SafeText(512)).max(32).default([]),
    }),
  }),
  assets: z.array(z.strictObject({
    path: RelativeAssetPath,
    sha256: Sha256,
    size: z.number().int().nonnegative().max(MAX_AGENT_ADAPTER_EXPANDED_BYTES),
  })).min(1).max(MAX_AGENT_ADAPTER_ENTRIES - 2),
  capabilities: z.array(Capability).min(1).max(7),
  profiles: z.array(z.strictObject({
    id: Id,
    name: SafeText(120),
    description: SafeText(500),
    model: SafeText(128).optional(),
    effort: SafeText(64).optional(),
    permissionMode: SafeText(64),
    capabilities: z.array(Capability).min(1).max(7),
  })).min(1).max(32),
});

export type AgentAdapterManifest = z.infer<typeof AgentAdapterManifestSchema>;

export interface InstalledAgentAdapter {
  readonly adapterId: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly publisherName: string;
  readonly publisherKeyId: string;
  readonly capabilities: readonly AgentProfileCapability[];
  readonly enabled: boolean;
  readonly health: 'healthy' | 'missing' | 'failed';
  readonly healthMessage?: string;
  readonly installedAt: number;
  readonly updatedAt: number;
}

export interface AgentAdapterPublisherTrust {
  readonly keyId: string;
  readonly publisherName: string;
  readonly publicKeySpki: string;
  readonly trustedAt: number;
}

export interface AgentAdapterSnapshot {
  readonly revision: number;
  readonly adapters: readonly InstalledAgentAdapter[];
  readonly trustedPublishers: readonly AgentAdapterPublisherTrust[];
}

export interface AgentAdapterInstallPreview {
  readonly token: string;
  readonly adapterId: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly publisherName: string;
  readonly publisherKeyId: string;
  readonly capabilities: readonly AgentProfileCapability[];
  readonly profiles: readonly { readonly name: string; readonly permissionMode: string }[];
  readonly trustRequired: boolean;
  readonly update: boolean;
  readonly capabilityExpansion: readonly AgentProfileCapability[];
  readonly expiresAt: number;
}

export interface InstallAgentAdapterInput {
  readonly token: string;
  readonly trustPublisher: boolean;
  readonly approveCapabilityExpansion: boolean;
}

export type AgentAdapterMutationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: 'invalid' | 'not-found' | 'expired' | 'trust-required' | 'capability-expansion' | 'io-error' | 'health-failed'; readonly message: string };

export function isSafeAdapterAssetPath(value: string): boolean {
  if (!value || value.length > 240 || value.includes('\\') || value.includes(':') || hasControlCharacter(value)) return false;
  if (value.startsWith('/') || value.endsWith('/') || value !== value.trim()) return false;
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.endsWith('.') || segment.endsWith(' '))) {
    return false;
  }
  return !segments.some((segment) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment));
}

export function canonicalizeAdapterManifest(manifest: AgentAdapterManifest): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
        .map(([key, child]) => [key, sort(child)]));
    }
    return value;
  };
  return JSON.stringify(sort(manifest));
}

export function adapterProvider(manifest: AgentAdapterManifest): AgentProviderRef {
  return { providerId: `adapter:${manifest.id}`, kind: 'acp', displayName: manifest.name };
}

export function adapterProfiles(manifest: AgentAdapterManifest, available: boolean): readonly AgentProfile[] {
  return manifest.profiles.map((profile) => ({
    profileId: `adapter:${manifest.id}:${profile.id}`,
    providerId: `adapter:${manifest.id}`,
    launcherId: `adapter:${manifest.id}`,
    name: profile.name,
    description: profile.description,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.effort ? { effort: profile.effort } : {}),
    permissionMode: profile.permissionMode,
    capabilities: profile.capabilities,
    available,
    revision: 1,
  }));
}
