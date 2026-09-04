import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CLAUDE_PROVIDER_ENABLEMENT,
  type ClaudeProviderEnablement,
} from '../shared/daemon-provider';
import {
  CLAUDE_PROVIDER_ENABLEMENT_FILE_NAME,
  UserDataClaudeProviderEnablementStore,
} from './claude-provider-enablement-store';

function makeDirectory(): string {
  return mkdtempSync(path.join(tmpdir(), 'ezterminal-claude-enablement-'));
}

const enabledPolicy = {
  enabled: true,
  termsAccepted: true,
  commercialUseApproved: true,
  authenticationPath: 'api-key-environment' as const,
  anthropicThirdPartyApproval: false,
};

describe('UserDataClaudeProviderEnablementStore', () => {
  it('is disabled by default and atomically round-trips only non-secret consent', async () => {
    const store = new UserDataClaudeProviderEnablementStore(makeDirectory());

    await expect(store.load()).resolves.toEqual(DEFAULT_CLAUDE_PROVIDER_ENABLEMENT);
    await store.save(enabledPolicy);

    expect(await store.load()).toEqual(enabledPolicy);
    expect(existsSync(`${store.path}.tmp`)).toBe(false);
    const raw = readFileSync(store.path, 'utf8');
    expect(JSON.parse(raw)).toEqual({ schemaVersion: 1, enablement: enabledPolicy });
    expect(raw).not.toMatch(/apiKey|token|cookie|credential/iu);
  });

  it('quarantines malformed JSON and returns the fail-closed default', async () => {
    const directory = makeDirectory();
    const file = path.join(directory, CLAUDE_PROVIDER_ENABLEMENT_FILE_NAME);
    writeFileSync(file, '{ incomplete', 'utf8');
    const store = new UserDataClaudeProviderEnablementStore(directory);

    await expect(store.load()).resolves.toEqual(DEFAULT_CLAUDE_PROVIDER_ENABLEMENT);

    expect(existsSync(file)).toBe(false);
    expect(readFileSync(`${file}.corrupt`, 'utf8')).toBe('{ incomplete');
  });

  it('quarantines an unknown persisted schema instead of treating it as active settings', async () => {
    const directory = makeDirectory();
    const file = path.join(directory, CLAUDE_PROVIDER_ENABLEMENT_FILE_NAME);
    const unsafe = {
      schemaVersion: 1,
      enablement: { ...enabledPolicy, unexpected: true },
    };
    writeFileSync(file, JSON.stringify(unsafe), 'utf8');
    const store = new UserDataClaudeProviderEnablementStore(directory);

    await expect(store.load()).resolves.toEqual(DEFAULT_CLAUDE_PROVIDER_ENABLEMENT);

    expect(existsSync(file)).toBe(false);
    expect(JSON.parse(readFileSync(`${file}.corrupt`, 'utf8'))).toEqual(unsafe);
  });

  it('refuses to write credential-shaped or other unknown fields', async () => {
    const store = new UserDataClaudeProviderEnablementStore(makeDirectory());
    const unsafe = {
      ...enabledPolicy,
      apiKey: 'must-not-be-written',
    } as unknown as ClaudeProviderEnablement;

    await expect(store.save(unsafe)).rejects.toThrow('enablement is invalid');

    expect(existsSync(store.path)).toBe(false);
    expect(existsSync(`${store.path}.tmp`)).toBe(false);
  });

  it('rejects a gate-incomplete enable request without replacing prior state', async () => {
    const store = new UserDataClaudeProviderEnablementStore(makeDirectory());
    await store.save(enabledPolicy);
    const original = readFileSync(store.path, 'utf8');

    await expect(store.save({
      ...enabledPolicy,
      commercialUseApproved: false,
    })).rejects.toThrow('commercial-use approval');

    expect(readFileSync(store.path, 'utf8')).toBe(original);
    expect(await store.load()).toEqual(enabledPolicy);
  });

  it('serializes concurrent writes and leaves one complete final envelope', async () => {
    const store = new UserDataClaudeProviderEnablementStore(makeDirectory());
    const disabled = { ...DEFAULT_CLAUDE_PROVIDER_ENABLEMENT, termsAccepted: true };

    await Promise.all([store.save(enabledPolicy), store.save(disabled)]);

    expect(await store.load()).toEqual(disabled);
    expect(JSON.parse(readFileSync(store.path, 'utf8'))).toEqual({
      schemaVersion: 1,
      enablement: disabled,
    });
    expect(existsSync(`${store.path}.tmp`)).toBe(false);
  });
});
