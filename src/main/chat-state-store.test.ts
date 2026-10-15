import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonCommand } from '../shared/daemon-protocol';
import type { ChatSessionState, ChatStateScope } from '../shared/chat-state';
import { ChatStateStore, type ChatStateStoreOptions } from './chat-state-store';

const NOW = '2026-10-13T08:00:00.000Z';
const scope = { projectId: 'project-1', sessionId: 'session-1' };
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function encryptedProtector(): ChatStateStoreOptions['protector'] {
  const key = randomBytes(32);
  return {
    available: () => true,
    encrypt: (plaintext) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decrypt: (bytes) => {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

async function fixture(overrides: Partial<ChatStateStoreOptions> = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ez-chat-state-'));
  roots.push(directory);
  const options: ChatStateStoreOptions = {
    directory, protector: encryptedProtector(), resolveScope: (candidate) => candidate.projectId === scope.projectId,
    now: () => new Date(NOW), windowsAcl: async () => undefined, ...overrides,
  };
  return { directory, options, store: new ChatStateStore(options) };
}
function filename(directory: string, identity: ChatStateScope = scope): string {
  return path.join(directory, `${createHash('sha256').update(JSON.stringify([identity.projectId, identity.sessionId])).digest('hex')}.bin`);
}
function state(text = 'private next draft'): ChatSessionState { return { draft: { text, selectionStart: 1, selectionEnd: 3 } }; }
function pendingState(): ChatSessionState {
  return {
    draft: { text: 'New unsent text', selectionStart: 2, selectionEnd: 8,
      skills: [{ providerId: 'codex', id: 'C:/skills/private-review/SKILL.md', name: 'private-review', invocation: '$private-review' }],
      attachments: [{ id: 'attachment-1', name: 'notes.txt', kind: 'text', mimeType: 'text/plain', data: 'private notes' }],
      replyTo: { messageId: 'message-1', text: 'Quoted private answer' } },
    pendingSubmit: {
      mode: 'send', recordedAt: NOW,
      command: createDaemonCommand({ commandId: 'exact-command-1', idempotencyKey: 'exact-idempotency-1',
        expectedRevision: 7, issuedAt: NOW, principal: { kind: 'desktop', id: 'desktop-user' }, type: 'agent.submit',
        payload: { sessionId: scope.sessionId, prompt: 'private pending message', context: {
          attachments: [{ id: 'attachment-2', name: 'image.png', kind: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }],
          replyTo: { messageId: 'message-2', text: 'Original answer' },
          skills: [{ providerId: 'codex', id: 'C:/skills/private-review/SKILL.md', name: 'private-review', invocation: '$private-review' }],
        } } }),
    },
  };
}

describe('encrypted device-local chat state', () => {
  it('returns an empty first revision without creating a state file', async () => {
    const { store, directory } = await fixture();
    expect(await store.read(scope)).toEqual({ ok: true, snapshot: { version: 1, scope, revision: 0, state: { draft: { text: '' } }, updatedAt: null } });
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('persists encrypted draft, selection, context and the exact pending envelope across restart', async () => {
    const { store, options, directory } = await fixture();
    const value = pendingState();
    const result = await store.write(scope, { expectedRevision: 0, state: value });
    expect(result).toMatchObject({ ok: true, snapshot: { revision: 1, state: value } });
    const bytes = await fs.readFile(filename(directory), 'utf8');
    for (const sensitive of ['private', 'New unsent text', 'exact-command-1', 'session-1', 'notes.txt']) expect(bytes).not.toContain(sensitive);
    expect(await new ChatStateStore(options).read(scope)).toEqual(result);
    expect(await fs.readdir(directory)).toEqual([path.basename(filename(directory))]);
  });

  it('serializes windows with compare-and-swap instead of losing a concurrent draft', async () => {
    const { store } = await fixture();
    const results = await Promise.all([
      store.write(scope, { expectedRevision: 0, state: state('first draft') }),
      store.write(scope, { expectedRevision: 0, state: state('second draft') }),
    ]);
    expect(results[0]).toMatchObject({ ok: true, snapshot: { revision: 1 } });
    expect(results[1]).toMatchObject({ ok: false, error: 'stale', revision: 1 });
    expect(await store.read(scope)).toMatchObject({ ok: true, snapshot: { state: state('first draft') } });
  });

  it('clears only when explicitly written and does not replay pending submissions on read', async () => {
    const { store } = await fixture();
    await store.write(scope, { expectedRevision: 0, state: pendingState() });
    expect(await store.read(scope)).toMatchObject({ ok: true, snapshot: { state: pendingState() } });
    expect(await store.write(scope, { expectedRevision: 1, state: { draft: { text: '' } } })).toMatchObject({ ok: true, snapshot: { revision: 2, state: { draft: { text: '' } } } });
    const result = await store.read(scope);
    expect(result.ok && result.snapshot.state.pendingSubmit).toBeUndefined();
  });

  it('denies unknown project/session scopes before encryption or disk access', async () => {
    const resolveScope = vi.fn(() => false);
    const { store, directory, options } = await fixture({ resolveScope });
    const encrypt = vi.spyOn(options.protector, 'encrypt');
    expect(await store.write(scope, { expectedRevision: 0, state: state() })).toMatchObject({ ok: false, error: 'forbidden' });
    expect(encrypt).not.toHaveBeenCalled();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('fails closed when OS encryption is unavailable and preserves the existing ciphertext', async () => {
    const protector = encryptedProtector();
    const available = vi.spyOn(protector, 'available');
    const { store, directory } = await fixture({ protector });
    available.mockReturnValue(false);
    expect(await store.write(scope, { expectedRevision: 0, state: state() })).toMatchObject({ ok: false, error: 'unavailable' });
    expect(await fs.readdir(directory)).toEqual([]);
    available.mockReturnValue(true);
    await store.write(scope, { expectedRevision: 0, state: state() });
    const before = await fs.readFile(filename(directory));
    available.mockReturnValue(false);
    expect(await store.write(scope, { expectedRevision: 1, state: state('new draft') })).toMatchObject({ ok: false, error: 'unavailable' });
    expect(await fs.readFile(filename(directory))).toEqual(before);
  });

  it('preserves the prior draft when atomic commit fails and permits the same revision retry', async () => {
    const { store, directory } = await fixture();
    await store.write(scope, { expectedRevision: 0, state: state() });
    const before = await fs.readFile(filename(directory));
    const rename = vi.spyOn(fs, 'rename').mockRejectedValue(new Error('disk failure private content'));
    const failed = await store.write(scope, { expectedRevision: 1, state: state('replacement') });
    expect(failed).toMatchObject({ ok: false, error: 'unavailable' });
    expect(JSON.stringify(failed)).not.toContain('disk failure private content');
    expect(await fs.readFile(filename(directory))).toEqual(before);
    rename.mockRestore();
    expect(await store.write(scope, { expectedRevision: 1, state: state('replacement') })).toMatchObject({ ok: true, snapshot: { revision: 2 } });
  });

  it('rejects a pending envelope for a different conversation without persisting it', async () => {
    const { store, directory } = await fixture();
    const value = pendingState();
    const command = value.pendingSubmit!.command;
    expect(await store.write(scope, { expectedRevision: 0, state: { ...value, pendingSubmit: { ...value.pendingSubmit, command: { ...command, payload: { ...command.payload, sessionId: 'different-session' } } } } })).toMatchObject({ ok: false, error: 'invalid' });
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('rejects non-submit, remote, extra credential fields and mismatched mode commands', async () => {
    const { store } = await fixture();
    const value = pendingState();
    const pending = value.pendingSubmit!;
    const invalid = [
      { ...pending, command: { ...pending.command, type: 'agent.interrupt', payload: { sessionId: scope.sessionId } } },
      { ...pending, command: { ...pending.command, principal: { kind: 'remote', id: 'spoofed' } } },
      { ...pending, command: { ...pending.command, token: 'secret-credential' } },
      { ...pending, mode: 'interrupt' },
    ];
    for (const pendingSubmit of invalid) expect(await store.write(scope, { expectedRevision: 0, state: { ...value, pendingSubmit } })).toMatchObject({ ok: false, error: 'invalid' });
  });

  it('rejects invalid selection and attachment limits without creating state', async () => {
    const { store } = await fixture();
    const drafts = [
      { text: 'a', selectionStart: 2 },
      { text: 'abc', selectionStart: 2, selectionEnd: 1 },
      { text: 'a', attachments: [{ id: 'a', name: 'huge.txt', kind: 'text', mimeType: 'text/plain', data: 'x'.repeat(481 * 1024) }] },
      { text: 'a', credential: 'do not store' },
    ];
    for (const draft of drafts) expect(await store.write(scope, { expectedRevision: 0, state: { draft } })).toMatchObject({ ok: false, error: 'invalid' });
  });

  it('retains a corrupt ciphertext and refuses to overwrite it', async () => {
    const { store, directory } = await fixture();
    await store.write(scope, { expectedRevision: 0, state: state() });
    const corrupted = JSON.stringify({ version: 1, protectedState: randomBytes(64).toString('base64') });
    await fs.writeFile(filename(directory), corrupted);
    expect(await store.read(scope)).toMatchObject({ ok: false, error: 'corrupt' });
    expect(await store.write(scope, { expectedRevision: 0, state: state('new draft') })).toMatchObject({ ok: false, error: 'corrupt' });
    expect(await fs.readFile(filename(directory), 'utf8')).toBe(corrupted);
  });

  it('binds decrypted data to both project and session even if the encrypted file is copied', async () => {
    const { store, directory } = await fixture();
    await store.write(scope, { expectedRevision: 0, state: state() });
    const other = { ...scope, sessionId: 'session-2' };
    await fs.copyFile(filename(directory), filename(directory, other));
    expect(await store.read(other)).toMatchObject({ ok: false, error: 'corrupt' });
    expect(await store.read(scope)).toMatchObject({ ok: true, snapshot: { state: state() } });
  });

  it('flush waits for an already admitted encrypted write', async () => {
    const protector = encryptedProtector();
    const encryptOriginal = protector.encrypt;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const encrypt = vi.spyOn(protector, 'encrypt').mockImplementation(async (value) => { await gate; return encryptOriginal(value); });
    const { store } = await fixture({ protector });
    const write = store.write(scope, { expectedRevision: 0, state: state() });
    await vi.waitFor(() => expect(encrypt).toHaveBeenCalledOnce());
    let flushed = false;
    const flush = store.flush().then(() => { flushed = true; });
    await Promise.resolve();
    expect(flushed).toBe(false);
    release();
    expect(await write).toMatchObject({ ok: true });
    await flush;
    expect(flushed).toBe(true);
  });
});
