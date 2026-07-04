/**
 * known_hosts persistence schema (E5 §3) — TOFU host-key trust, main-owned.
 *
 * Versioned Zod envelope, same pattern as `layout-schema.ts`. One record per
 * `host:port`, keyed by a literal string (not nested) so a corrupt/foreign key
 * cannot collide with object-prototype machinery.
 */
import { z } from 'zod';

export const KNOWN_HOSTS_SCHEMA_VERSION = 1 as const;

const HostKeyEntrySchema = z.object({
  keyType: z.string().min(1),
  fingerprintSha256: z.string().min(1),
});

export const KnownHostsFileSchema = z.object({
  schemaVersion: z.literal(KNOWN_HOSTS_SCHEMA_VERSION),
  hosts: z.record(z.string(), HostKeyEntrySchema),
});

export type HostKeyEntry = z.infer<typeof HostKeyEntrySchema>;
export type KnownHostsFile = z.infer<typeof KnownHostsFileSchema>;

export function emptyKnownHostsFile(): KnownHostsFile {
  return { schemaVersion: KNOWN_HOSTS_SCHEMA_VERSION, hosts: {} };
}

/** Validates a raw parsed-JSON value; null routes callers to the corrupt path. */
export function validateKnownHostsFile(data: unknown): KnownHostsFile | null {
  const parsed = KnownHostsFileSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/** The record key for one `host:port` pair. */
export function hostRecordKey(host: string, port: number): string {
  return `${host}:${port}`;
}
