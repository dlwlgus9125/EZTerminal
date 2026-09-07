import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDaemonCommand,
  type DaemonCommandEnvelope,
} from '../../src/shared/daemon-protocol';
import {
  MOBILE_AGENT_CREATE_RECOVERY_MAX_BYTES,
  MobileAgentCreateRecoveryStore,
  mobileAgentCreateAuthorityFingerprint,
  type SecureStorageLike,
  type UncertainAgentCreate,
} from './mobile-agent-create-recovery-store';

const AUTHORITY = `sha256:${'a'.repeat(64)}`;
const OTHER_AUTHORITY = `sha256:${'b'.repeat(64)}`;
const SECURE_KEY = `ezterminal-mobile-agent-create-recovery-v2:${'a'.repeat(64)}`;

class FakeSecureStorage implements SecureStorageLike {
  readonly values = new Map<string, string>();
  platform = 'android';
  platformFailure = false;
  keysFailure = false;
  malformedKeys = false;
  getFailure = false;
  setFailure = false;
  setAccepted = true;
  removeFailure = false;
  retainOnRemove = false;
  readTransform: (value: string) => string = (value) => value;
  getCalls = 0;
  setCalls = 0;
  removeCalls = 0;
  keysCalls = 0;
  platformCalls = 0;

  async get({ key }: { key: string }): Promise<{ value: string }> {
    this.getCalls += 1;
    if (this.getFailure) throw new Error('keystore read failed');
    const value = this.values.get(key);
    if (value === undefined) throw new Error('missing');
    return { value: this.readTransform(value) };
  }

  async set({ key, value }: { key: string; value: string }): Promise<{ value: boolean }> {
    this.setCalls += 1;
    if (this.setFailure) throw new Error('keystore write failed');
    if (this.setAccepted) this.values.set(key, value);
    return { value: this.setAccepted };
  }

  async remove({ key }: { key: string }): Promise<{ value: boolean }> {
    this.removeCalls += 1;
    if (this.removeFailure) throw new Error('keystore removal failed');
    if (this.retainOnRemove) return { value: false };
    return { value: this.values.delete(key) };
  }

  async keys(): Promise<{ value: string[] }> {
    this.keysCalls += 1;
    if (this.keysFailure) throw new Error('keystore key listing failed');
    if (this.malformedKeys) return { value: null as unknown as string[] };
    return { value: [...this.values.keys()] };
  }

  async getPlatform(): Promise<{ value: string }> {
    this.platformCalls += 1;
    if (this.platformFailure) throw new Error('platform lookup failed');
    return { value: this.platform };
  }
}

function agentCreateCommand(
  overrides: Partial<DaemonCommandEnvelope<'agent.create'>> = {},
): DaemonCommandEnvelope<'agent.create'> {
  const base = createDaemonCommand({
    commandId: 'command-mobile-create-1',
    idempotencyKey: 'command-mobile-create-1',
    expectedRevision: 41,
    issuedAt: '2026-09-06T06:00:00.000Z',
    principal: { kind: 'android', id: 'mobile-agent-ui' },
    type: 'agent.create',
    payload: {
      sessionId: 'agent-mobile-create-1',
      workspaceId: 'workspace-main',
      title: 'Recover this exact session',
      providerId: 'codex',
      model: 'gpt-5.6-codex',
      permissionPreset: 'standard',
      initialPrompt: 'Recover this exact session.',
    },
  });
  return {
    ...base,
    ...overrides,
    principal: overrides.principal ?? base.principal,
    payload: overrides.payload ?? base.payload,
  };
}

function recoveryFrom(
  command = agentCreateCommand(),
  overrides: Partial<UncertainAgentCreate> = {},
): UncertainAgentCreate {
  return {
    input: {
      providerId: command.payload.providerId,
      ...(command.payload.model ? { model: command.payload.model } : {}),
      workspaceId: command.payload.workspaceId,
      permissionPreset: command.payload.permissionPreset,
      initialPrompt: command.payload.initialPrompt,
    },
    outcome: {
      kind: 'delivery-uncertain',
      sessionId: command.payload.sessionId,
      title: command.payload.title,
      command,
      receipt: {
        ok: false,
        status: 'delivery-uncertain',
        commandId: command.commandId,
        revision: command.expectedRevision,
        error: {
          code: 'delivery-uncertain',
          message: 'Connection closed before acknowledgement.',
          retryable: true,
        },
      },
      message: 'Connection closed before acknowledgement.',
    },
    ...overrides,
  };
}

function rawRecord(
  command: unknown = agentCreateCommand(),
  authorityFingerprint = AUTHORITY,
): string {
  return JSON.stringify({ schemaVersion: 2, authorityFingerprint, command });
}

function storedRecord(recovery: UncertainAgentCreate): string {
  return JSON.stringify({
    schemaVersion: 2,
    authorityFingerprint: AUTHORITY,
    command: recovery.outcome.command,
  });
}

describe('MobileAgentCreateRecoveryStore', () => {
  let secure: FakeSecureStorage;
  let store: MobileAgentCreateRecoveryStore;

  beforeEach(() => {
    secure = new FakeSecureStorage();
    store = new MobileAgentCreateRecoveryStore(secure);
  });

  it('round-trips an empty Agent create through secure storage', async () => {
    const command = JSON.parse(JSON.stringify(agentCreateCommand()));
    delete command.payload.initialPrompt;
    secure.values.set(SECURE_KEY, rawRecord(command));
    const result = await store.load(AUTHORITY);
    expect(result.available).toBe(true);
    if (!result.available || !result.recovery) throw new Error('Expected empty Agent recovery');
    expect(result.recovery.outcome.command).toEqual(command);
    expect(result.recovery.input.initialPrompt).toBeUndefined();
    await store.save(result.recovery, AUTHORITY);
    expect(JSON.parse(secure.values.get(SECURE_KEY)!)).toEqual(JSON.parse(rawRecord(command)));
  });

  it('stores the authority binding and exact command, then reconstructs the draft and uncertain outcome', async () => {
    const recovery = recoveryFrom();
    await store.save(recovery, AUTHORITY);

    expect(secure.values.size).toBe(1);
    const serialized = secure.values.get(SECURE_KEY)!;
    const record = JSON.parse(serialized) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(['authorityFingerprint', 'command', 'schemaVersion']);
    expect(record.schemaVersion).toBe(2);
    expect(record.authorityFingerprint).toBe(AUTHORITY);
    expect(record.command).toEqual(recovery.outcome.command);
    expect(record).not.toHaveProperty('input');
    expect(record).not.toHaveProperty('outcome');
    expect(record).not.toHaveProperty('savedAt');
    expect(serialized).not.toContain('Connection closed before acknowledgement.');

    const loaded = await store.load(AUTHORITY);
    expect(loaded).toEqual({
      available: true,
      recovery: {
        input: {
          providerId: 'codex',
          model: 'gpt-5.6-codex',
          workspaceId: 'workspace-main',
          permissionPreset: 'standard',
          initialPrompt: 'Recover this exact session.',
        },
        outcome: {
          kind: 'delivery-uncertain',
          sessionId: 'agent-mobile-create-1',
          title: 'Recover this exact session',
          command: recovery.outcome.command,
          message: 'The Agent command delivery could not be confirmed.',
        },
      },
    });
    expect(loaded.recovery?.outcome.command).toEqual(recovery.outcome.command);
    expect(Object.isFrozen(loaded.recovery?.outcome.command)).toBe(true);
  });

  it('reports an available empty store without reading a missing value', async () => {
    await expect(store.load(AUTHORITY)).resolves.toEqual({ available: true, recovery: null });
    expect(secure.getCalls).toBe(0);
  });

  it('reports unavailable off Android and never touches storage values', async () => {
    secure.platform = 'web';

    await expect(store.load(AUTHORITY)).resolves.toEqual({
      available: false,
      recovery: null,
      reason: 'storage-unavailable',
    });
    await expect(store.save(recoveryFrom(), AUTHORITY)).rejects.toThrow(/Android secure storage is unavailable/u);
    await expect(store.clear(AUTHORITY)).rejects.toThrow(/Android secure storage is unavailable/u);
    expect(secure.keysCalls).toBe(0);
    expect(secure.getCalls).toBe(0);
    expect(secure.setCalls).toBe(0);
    expect(secure.removeCalls).toBe(0);
  });

  it('reports unavailable when the platform or key-list boundary fails', async () => {
    secure.platformFailure = true;
    await expect(store.load(AUTHORITY)).resolves.toEqual({
      available: false,
      recovery: null,
      reason: 'storage-unavailable',
    });

    secure.platformFailure = false;
    secure.keysFailure = true;
    await expect(store.load(AUTHORITY)).resolves.toEqual({
      available: false,
      recovery: null,
      reason: 'storage-unavailable',
    });

    secure.keysFailure = false;
    secure.malformedKeys = true;
    await expect(store.load(AUTHORITY)).resolves.toEqual({
      available: false,
      recovery: null,
      reason: 'storage-unavailable',
    });

  });

  it('marks a listed but unreadable record invalid and permits raw-key discard', async () => {
    secure.malformedKeys = false;
    secure.values.set(SECURE_KEY, rawRecord());
    secure.getFailure = true;
    await expect(store.load(AUTHORITY)).resolves.toEqual({
      available: false,
      recovery: null,
      reason: 'invalid-record',
    });

    await expect(store.clear(AUTHORITY)).resolves.toBeUndefined();
    expect(secure.values.has(SECURE_KEY)).toBe(false);
    expect(secure.removeCalls).toBe(1);
  });

  it.each([
    ['invalid JSON', '{'],
    ['oversized bytes', '한'.repeat(MOBILE_AGENT_CREATE_RECOVERY_MAX_BYTES)],
    ['array record', JSON.stringify([])],
    ['legacy unbound schema', JSON.stringify({ schemaVersion: 1, command: agentCreateCommand() })],
    ['unknown record field', JSON.stringify({
      schemaVersion: 2,
      authorityFingerprint: AUTHORITY,
      command: agentCreateCommand(),
      prompt: 'plaintext',
    })],
    ['mismatched authority', rawRecord(agentCreateCommand(), OTHER_AUTHORITY)],
    ['non-Agent command', rawRecord(createDaemonCommand({
      commandId: 'terminal-create', idempotencyKey: 'terminal-create', expectedRevision: 1,
      issuedAt: '2026-09-06T06:00:00.000Z', principal: { kind: 'android', id: 'mobile-agent-ui' },
      type: 'session.create',
      payload: { sessionId: 'terminal-1', workspaceId: 'workspace-main', kind: 'terminal', title: 'Terminal' },
    }))],
    ['desktop principal', rawRecord(agentCreateCommand({ principal: { kind: 'desktop', id: 'mobile-agent-ui' } }))],
    ['wrong Android principal', rawRecord(agentCreateCommand({ principal: { kind: 'android', id: 'another-ui' } }))],
    ['session-scoped principal', rawRecord(agentCreateCommand({
      principal: { kind: 'android', id: 'mobile-agent-ui', sessionId: 'parent-agent' },
    }))],
    ['different idempotency key', rawRecord(agentCreateCommand({ idempotencyKey: 'another-key' }))],
    ['managed child create', rawRecord(agentCreateCommand({
      payload: { ...agentCreateCommand().payload, parentSessionId: 'parent-agent' },
    }))],
    ['non-canonical trimmed identifier', rawRecord(agentCreateCommand({
      commandId: ' command-mobile-create-1 ',
      idempotencyKey: ' command-mobile-create-1 ',
    }))],
    ['invalid payload', rawRecord({
      ...agentCreateCommand(),
      payload: { ...agentCreateCommand().payload, providerId: '' },
    })],
  ])('fails closed for a stored %s by marking recovery unavailable', async (_name, value) => {
    secure.values.set(SECURE_KEY, value);

    await expect(store.load(AUTHORITY)).resolves.toEqual({
      available: false,
      recovery: null,
      reason: 'invalid-record',
    });
    expect(secure.values.get(SECURE_KEY)).toBe(value);
  });

  it('derives stable non-secret authority fingerprints and namespaces records per authenticated host', async () => {
    const first = await mobileAgentCreateAuthorityFingerprint('desktop-a-bearer');
    const same = await mobileAgentCreateAuthorityFingerprint('desktop-a-bearer');
    const other = await mobileAgentCreateAuthorityFingerprint('desktop-b-bearer');
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(first).toBe(same);
    expect(first).not.toBe(other);
    expect(first).not.toContain('desktop-a-bearer');

    await store.save(recoveryFrom(), AUTHORITY);
    await expect(store.load(OTHER_AUTHORITY)).resolves.toEqual({ available: true, recovery: null });
    await store.clear(OTHER_AUTHORITY);
    await expect(store.load(AUTHORITY)).resolves.toMatchObject({ available: true, recovery: {} });
  });

  it('rejects every draft/outcome field that disagrees with the exact command', async () => {
    const base = recoveryFrom();
    const invalid: readonly UncertainAgentCreate[] = [
      { ...base, input: { ...base.input, providerId: 'claude' } },
      { ...base, input: { ...base.input, model: 'different-model' } },
      { ...base, input: { ...base.input, workspaceId: 'workspace-other' } },
      { ...base, input: { ...base.input, permissionPreset: 'plan' } },
      { ...base, input: { ...base.input, initialPrompt: 'Different prompt.' } },
      { ...base, outcome: { ...base.outcome, sessionId: 'agent-other' } },
      { ...base, outcome: { ...base.outcome, title: 'Different title' } },
      {
        ...base,
        outcome: {
          ...base.outcome,
          receipt: { ...base.outcome.receipt!, commandId: 'different-command' },
        },
      },
    ];

    for (const candidate of invalid) {
      const candidateSecure = new FakeSecureStorage();
      await expect(new MobileAgentCreateRecoveryStore(candidateSecure).save(candidate, AUTHORITY))
        .rejects.toThrow(/Inconsistent/u);
      expect(candidateSecure.setCalls).toBe(0);
      expect(candidateSecure.values.size).toBe(0);
    }
  });

  it('rejects invalid command identity and a non-uncertain outcome before storage access', async () => {
    const wrongIdentity = recoveryFrom(agentCreateCommand({ idempotencyKey: 'different-key' }));
    await expect(store.save(wrongIdentity, AUTHORITY)).rejects.toThrow(/Invalid/u);

    const wrongKind = {
      ...recoveryFrom(),
      outcome: { ...recoveryFrom().outcome, kind: 'created' },
    } as unknown as UncertainAgentCreate;
    await expect(store.save(wrongKind, AUTHORITY)).rejects.toThrow(/Invalid/u);
    expect(secure.platformCalls).toBe(0);
    expect(secure.setCalls).toBe(0);
  });

  it('enforces the 512 KiB limit in UTF-8 bytes before writing', async () => {
    const command = agentCreateCommand({
      payload: { ...agentCreateCommand().payload, initialPrompt: '한'.repeat(180_000) },
    });

    await expect(store.save(recoveryFrom(command), AUTHORITY)).rejects.toThrow(/512 KiB/u);
    expect(secure.platformCalls).toBe(0);
    expect(secure.setCalls).toBe(0);
  });

  it('accepts the textarea maximum even under worst-case JSON escaping', async () => {
    const command = agentCreateCommand({
      payload: { ...agentCreateCommand().payload, initialPrompt: '\0'.repeat(65_536) },
    });

    await expect(store.save(recoveryFrom(command), AUTHORITY)).resolves.toBeUndefined();
    expect(new TextEncoder().encode(secure.values.get(SECURE_KEY)!).byteLength)
      .toBeLessThanOrEqual(MOBILE_AGENT_CREATE_RECOVERY_MAX_BYTES);
  });

  it('accepts a serialized recovery exactly at the byte limit and rejects the next byte', async () => {
    const emptyPromptCommand = agentCreateCommand({
      payload: { ...agentCreateCommand().payload, initialPrompt: '' },
    });
    const fixedBytes = new TextEncoder().encode(rawRecord(emptyPromptCommand)).byteLength;
    const exactPrompt = 'x'.repeat(MOBILE_AGENT_CREATE_RECOVERY_MAX_BYTES - fixedBytes);
    const exactCommand = agentCreateCommand({
      payload: { ...agentCreateCommand().payload, initialPrompt: exactPrompt },
    });
    const exactRecovery = recoveryFrom(exactCommand);
    expect(new TextEncoder().encode(storedRecord(exactRecovery)).byteLength)
      .toBe(MOBILE_AGENT_CREATE_RECOVERY_MAX_BYTES);
    await expect(store.save(exactRecovery, AUTHORITY)).resolves.toBeUndefined();

    const tooLargeCommand = agentCreateCommand({
      payload: { ...exactCommand.payload, initialPrompt: `${exactPrompt}x` },
    });
    await expect(store.save(recoveryFrom(tooLargeCommand), AUTHORITY)).rejects.toThrow(/512 KiB/u);
  });

  it('fails save when secure write or exact read-back verification fails', async () => {
    secure.setFailure = true;
    await expect(store.save(recoveryFrom(), AUTHORITY)).rejects.toThrow(/rejected/u);

    secure.setFailure = false;
    secure.setAccepted = false;
    await expect(store.save(recoveryFrom(), AUTHORITY)).rejects.toThrow(/rejected/u);

    secure.setAccepted = true;
    secure.getFailure = true;
    await expect(store.save(recoveryFrom(), AUTHORITY)).rejects.toThrow(/verify/u);

    secure.getFailure = false;
    secure.readTransform = (value) => `${value} `;
    await expect(store.save(recoveryFrom(), AUTHORITY)).rejects.toThrow(/read-back/u);
  });

  it('clears the key and verifies absence, including an already-empty store', async () => {
    secure.values.set(SECURE_KEY, rawRecord());
    await expect(store.clear(AUTHORITY)).resolves.toBeUndefined();
    expect(secure.values.has(SECURE_KEY)).toBe(false);
    expect(secure.removeCalls).toBe(1);

    await expect(store.clear(AUTHORITY)).resolves.toBeUndefined();
    expect(secure.removeCalls).toBe(2);
  });

  it('fails clear when removal or absence verification cannot be trusted', async () => {
    secure.values.set(SECURE_KEY, rawRecord());
    secure.removeFailure = true;
    await expect(store.clear(AUTHORITY)).rejects.toThrow(/could not clear/u);

    secure.removeFailure = false;
    secure.retainOnRemove = true;
    await expect(store.clear(AUTHORITY)).rejects.toThrow(/could not clear/u);

    secure.retainOnRemove = false;
    secure.keysFailure = true;
    await expect(store.clear(AUTHORITY)).rejects.toThrow(/could not clear/u);
  });

  it('never reads or writes a plaintext localStorage fallback', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');

    await store.save(recoveryFrom(), AUTHORITY);
    await store.load(AUTHORITY);
    await store.clear(AUTHORITY);

    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });
});
