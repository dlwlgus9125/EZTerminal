import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';

import {
  safeParseDaemonCommand,
  type DaemonCommandEnvelope,
} from '../../src/shared/daemon-protocol';
import type { StructuredAgentDraftInput } from '../../src/renderer/StructuredAgentSession';
import type { StructuredAgentCreateOutcome } from '../../src/renderer/structured-agent-create';

const SECURE_KEY_PREFIX = 'ezterminal-mobile-agent-create-recovery-v2:';
const SCHEMA_VERSION = 2 as const;
const RECOVERY_MESSAGE = 'The Agent command delivery could not be confirmed.';
const AUTHORITY_FINGERPRINT_RE = /^sha256:[0-9a-f]{64}$/u;

// A textarea may contain 65,536 UTF-16 code units. JSON escaping expands a
// control character to six ASCII bytes, so 64 KiB cannot represent every
// draft accepted by the UI. 512 KiB remains a strict allocation boundary and
// safely covers the worst-case prompt plus the bounded command envelope.
export const MOBILE_AGENT_CREATE_RECOVERY_MAX_BYTES = 512 * 1024;

const utf8Encoder = new TextEncoder();

export interface SecureStorageLike {
  get(options: { key: string }): Promise<{ value: string }>;
  set(options: { key: string; value: string }): Promise<{ value: boolean }>;
  remove(options: { key: string }): Promise<{ value: boolean }>;
  keys(): Promise<{ value: string[] }>;
  getPlatform(): Promise<{ value: string }>;
}

export interface UncertainAgentCreate {
  readonly input: StructuredAgentDraftInput;
  readonly outcome: Extract<StructuredAgentCreateOutcome, { readonly kind: 'delivery-uncertain' }>;
}

export type MobileAgentCreateRecoveryLoadResult =
  | { readonly available: true; readonly recovery: UncertainAgentCreate | null }
  | {
      readonly available: false;
      readonly recovery: null;
      readonly reason: 'storage-unavailable' | 'invalid-record';
    };

export type MobileAgentCreateRecoveryStatus = 'loading' | 'ready' | 'unavailable' | 'invalid';

export interface MobileAgentCreateRecoveryController {
  readonly status: MobileAgentCreateRecoveryStatus;
  readonly recovery: UncertainAgentCreate | null;
  /** Durably replaces the pending envelope before the caller may send it. */
  readonly prepare: (command: DaemonCommandEnvelope<'agent.create'>) => Promise<boolean>;
  /** Clears a definitively settled envelope; false means future creates must fail closed. */
  readonly clear: () => Promise<boolean>;
  /** Re-checks the authenticated authority and secure store after a transient failure. */
  readonly reload: () => Promise<boolean>;
  /** Explicitly removes an irrecoverable current-authority record after user confirmation. */
  readonly discard: () => Promise<boolean>;
}

export interface MobileAgentCreateRecoveryStoreLike {
  load(authorityFingerprint: string): Promise<MobileAgentCreateRecoveryLoadResult>;
  save(recovery: UncertainAgentCreate, authorityFingerprint: string): Promise<void>;
  clear(authorityFingerprint: string): Promise<void>;
}

interface SecureRecoveryRecord {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly authorityFingerprint: string;
  readonly command: DaemonCommandEnvelope<'agent.create'>;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameJsonValue(value, right[index]));
  }
  if (
    typeof left !== 'object'
    || left === null
    || typeof right !== 'object'
    || right === null
  ) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index] && sameJsonValue(leftRecord[key], rightRecord[key])
    ));
}

function validatedMobileCreateCommand(
  value: unknown,
): DaemonCommandEnvelope<'agent.create'> | null {
  const parsed = safeParseDaemonCommand(value);
  if (!parsed.success || parsed.data.type !== 'agent.create') return null;
  const command = parsed.data;
  if (
    !sameJsonValue(value, command)
    || command.principal.kind !== 'android'
    || command.principal.id !== 'mobile-agent-ui'
    || command.principal.sessionId !== undefined
    || command.commandId !== command.idempotencyKey
    || command.payload.parentSessionId !== undefined
  ) return null;
  return Object.freeze({
    ...command,
    principal: Object.freeze({ ...command.principal }),
    payload: Object.freeze({ ...command.payload }),
  });
}

export function mobileAgentCreateRecoveryFromCommand(
  command: DaemonCommandEnvelope<'agent.create'>,
): UncertainAgentCreate {
  const validated = validatedMobileCreateCommand(command);
  if (!validated) throw new Error('Invalid mobile Agent create recovery command.');
  const input: StructuredAgentDraftInput = Object.freeze({
    providerId: validated.payload.providerId,
    ...(validated.payload.model ? { model: validated.payload.model } : {}),
    workspaceId: validated.payload.workspaceId,
    permissionPreset: validated.payload.permissionPreset,
    initialPrompt: validated.payload.initialPrompt,
  });
  return Object.freeze({
    input,
    outcome: Object.freeze({
      kind: 'delivery-uncertain',
      sessionId: validated.payload.sessionId,
      title: validated.payload.title,
      command: validated,
      message: RECOVERY_MESSAGE,
    }),
  });
}

function validatedAuthorityFingerprint(value: unknown): string | null {
  return typeof value === 'string' && AUTHORITY_FINGERPRINT_RE.test(value) ? value : null;
}

function secureRecoveryKey(authorityFingerprint: string): string {
  const validated = validatedAuthorityFingerprint(authorityFingerprint);
  if (!validated) throw new Error('Invalid mobile Agent recovery authority fingerprint.');
  return `${SECURE_KEY_PREFIX}${validated.slice('sha256:'.length)}`;
}

/** A non-secret, domain-separated binding to the bearer that authenticated the host. */
export async function mobileAgentCreateAuthorityFingerprint(token: string): Promise<string> {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4 * 1024) {
    throw new Error('Invalid mobile Agent recovery authority token.');
  }
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto is unavailable for Agent recovery authority binding.');
  const digest = await subtle.digest(
    'SHA-256',
    utf8Encoder.encode(`EZTerminal mobile Agent recovery authority\0${token}`),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}

function recoveryRecordFromText(
  text: unknown,
  expectedAuthorityFingerprint: string,
): UncertainAgentCreate | null {
  if (typeof text !== 'string') return null;
  if (utf8Encoder.encode(text).byteLength > MOBILE_AGENT_CREATE_RECOVERY_MAX_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3
    || keys[0] !== 'authorityFingerprint'
    || keys[1] !== 'command'
    || keys[2] !== 'schemaVersion'
    || record.schemaVersion !== SCHEMA_VERSION
    || validatedAuthorityFingerprint(record.authorityFingerprint) !== expectedAuthorityFingerprint
  ) return null;
  const command = validatedMobileCreateCommand(record.command);
  return command ? mobileAgentCreateRecoveryFromCommand(command) : null;
}

function validatedRecoveryCommand(
  recovery: UncertainAgentCreate,
): DaemonCommandEnvelope<'agent.create'> {
  const command = validatedMobileCreateCommand(recovery?.outcome?.command);
  if (!command || recovery.outcome.kind !== 'delivery-uncertain') {
    throw new Error('Invalid mobile Agent create recovery command.');
  }
  const { input, outcome } = recovery;
  if (
    input.providerId !== command.payload.providerId
    || input.model !== command.payload.model
    || input.workspaceId !== command.payload.workspaceId
    || input.permissionPreset !== command.payload.permissionPreset
    || input.initialPrompt !== command.payload.initialPrompt
    || outcome.sessionId !== command.payload.sessionId
    || outcome.title !== command.payload.title
    || (outcome.receipt !== undefined && outcome.receipt.commandId !== command.commandId)
  ) {
    throw new Error('Inconsistent mobile Agent create recovery.');
  }
  return command;
}

/** Android Keystore-backed escrow for one exact, idempotently replayable create. */
export class MobileAgentCreateRecoveryStore implements MobileAgentCreateRecoveryStoreLike {
  constructor(private readonly secure: SecureStorageLike = SecureStoragePlugin) {}

  async load(authorityFingerprint: string): Promise<MobileAgentCreateRecoveryLoadResult> {
    let key: string;
    try {
      key = secureRecoveryKey(authorityFingerprint);
    } catch {
      return { available: false, recovery: null, reason: 'storage-unavailable' };
    }
    if (!(await this.isAndroid())) {
      return { available: false, recovery: null, reason: 'storage-unavailable' };
    }
    let keys: string[];
    try {
      const result = await this.secure.keys();
      if (!Array.isArray(result.value)) {
        return { available: false, recovery: null, reason: 'storage-unavailable' };
      }
      keys = result.value;
    } catch {
      return { available: false, recovery: null, reason: 'storage-unavailable' };
    }
    if (!keys.includes(key)) return { available: true, recovery: null };

    try {
      const stored = await this.secure.get({ key });
      const recovery = recoveryRecordFromText(stored.value, authorityFingerprint);
      return recovery
        ? { available: true, recovery }
        : { available: false, recovery: null, reason: 'invalid-record' };
    } catch {
      // The key listing already proved that this authority-scoped entry exists.
      // Treat an unreadable value as an invalid record so the user can explicitly
      // discard its raw secure-storage key after the duplicate-risk warning.
      return { available: false, recovery: null, reason: 'invalid-record' };
    }
  }

  async save(recovery: UncertainAgentCreate, authorityFingerprint: string): Promise<void> {
    const command = validatedRecoveryCommand(recovery);
    const key = secureRecoveryKey(authorityFingerprint);
    const record: SecureRecoveryRecord = { schemaVersion: SCHEMA_VERSION, authorityFingerprint, command };
    let serialized: string;
    try {
      serialized = JSON.stringify(record);
    } catch {
      throw new Error('Mobile Agent create recovery could not be serialized.');
    }
    if (utf8Encoder.encode(serialized).byteLength > MOBILE_AGENT_CREATE_RECOVERY_MAX_BYTES) {
      throw new Error('Mobile Agent create recovery exceeds the 512 KiB secure-storage limit.');
    }
    await this.requireAndroid();

    let written: { value: boolean };
    try {
      written = await this.secure.set({ key, value: serialized });
    } catch {
      throw new Error('Android secure storage rejected the Agent create recovery write.');
    }
    if (!written.value) throw new Error('Android secure storage rejected the Agent create recovery write.');

    let readBack: { value: string };
    try {
      readBack = await this.secure.get({ key });
    } catch {
      throw new Error('Android secure storage could not verify the Agent create recovery write.');
    }
    const verified = recoveryRecordFromText(readBack.value, authorityFingerprint);
    if (readBack.value !== serialized || !verified || !sameJsonValue(verified.outcome.command, command)) {
      throw new Error('Android secure storage read-back verification failed for the Agent create recovery.');
    }
  }

  async clear(authorityFingerprint: string): Promise<void> {
    const key = secureRecoveryKey(authorityFingerprint);
    await this.requireAndroid();
    try {
      await this.secure.remove({ key });
      const keys = (await this.secure.keys()).value;
      if (!Array.isArray(keys) || keys.includes(key)) {
        throw new Error('Agent create recovery key remains after removal.');
      }
    } catch {
      throw new Error('Android secure storage could not clear the Agent create recovery.');
    }
  }

  private async isAndroid(): Promise<boolean> {
    try {
      return (await this.secure.getPlatform()).value === 'android';
    } catch {
      return false;
    }
  }

  private async requireAndroid(): Promise<void> {
    if (!(await this.isAndroid())) {
      throw new Error('Android secure storage is unavailable for Agent create recovery.');
    }
  }
}
