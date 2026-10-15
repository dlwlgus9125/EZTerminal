import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';
import { z } from 'zod';

import type { ChatComposerDraft } from '../../src/renderer/chat-view-state';
import { ChatMessageContextSchema } from '../../src/shared/chat-message';
import { safeParseDaemonCommand, type DaemonCommand } from '../../src/shared/daemon-protocol';
import type { SecureStorageLike } from './mobile-agent-create-recovery-store';

export interface MobileChatScope {
  readonly authorityFingerprint: string;
  readonly projectId: string;
  readonly sessionId: string;
}
export interface MobileChatRecord {
  readonly schemaVersion: 1;
  readonly scope: MobileChatScope;
  readonly draft: ChatComposerDraft;
  readonly pending?: DaemonCommand;
}
export interface MobileChatStateStoreLike {
  load(scope: MobileChatScope): Promise<MobileChatRecord | null>;
  save(record: MobileChatRecord): Promise<void>;
}

const ScopeSchema = z.object({
  authorityFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  projectId: z.string().min(1).max(256), sessionId: z.string().min(1).max(256),
}).strict();
const DraftSchema = z.object({
  text: z.string().max(65_536),
  selectionStart: z.number().int().min(0).max(65_536).optional(),
  selectionEnd: z.number().int().min(0).max(65_536).optional(),
  attachments: z.unknown().optional(), replyTo: z.unknown().optional(),
  skills: z.unknown().optional(),
}).strict();
const MAX_RECORD_BYTES = 3 * 1024 * 1024;

function storageKey(scope: MobileChatScope): string {
  ScopeSchema.parse(scope);
  return `ezterminal-chat-draft-v1:${scope.authorityFingerprint.slice(7)}:${encodeURIComponent(scope.projectId)}:${encodeURIComponent(scope.sessionId)}`;
}

export function validateMobileChatRecord(value: unknown, scope: MobileChatScope): MobileChatRecord {
  const record = z.object({schemaVersion:z.literal(1),scope:ScopeSchema,draft:DraftSchema,pending:z.unknown().optional()}).strict().parse(value);
  if (record.scope.authorityFingerprint !== scope.authorityFingerprint
    || record.scope.projectId !== scope.projectId || record.scope.sessionId !== scope.sessionId) throw new Error('Chat draft scope does not match this PC and session.');
  const context = ChatMessageContextSchema.parse({
    ...(record.draft.attachments === undefined ? {} : {attachments:record.draft.attachments}),
    ...(record.draft.replyTo === undefined ? {} : {replyTo:record.draft.replyTo}),
    ...(record.draft.skills === undefined ? {} : {skills:record.draft.skills}),
  });
  let pending: DaemonCommand | undefined;
  if (record.pending !== undefined) {
    const parsed = safeParseDaemonCommand(record.pending);
    if (!parsed.success || !['agent.submit','agent.interrupt-and-submit'].includes(parsed.data.type)
      || parsed.data.principal.kind !== 'android'
      || parsed.data.commandId !== parsed.data.idempotencyKey
      || !('sessionId' in parsed.data.payload) || parsed.data.payload.sessionId !== scope.sessionId) {
      throw new Error('Invalid pending chat command.');
    }
    pending=parsed.data;
  }
  return {...record,scope,draft:{text:record.draft.text,...context,
    ...(record.draft.selectionStart === undefined ? {} : {selectionStart:Math.min(record.draft.selectionStart,record.draft.text.length)}),
    ...(record.draft.selectionEnd === undefined ? {} : {selectionEnd:Math.min(record.draft.selectionEnd,record.draft.text.length)}),
  },...(pending ? {pending} : {})} as MobileChatRecord;
}

/** Chat content and exact uncertain envelopes never enter localStorage. */
export class MobileChatStateStore implements MobileChatStateStoreLike {
  constructor(private readonly secure: SecureStorageLike = SecureStoragePlugin) {}

  private async requireAndroid(): Promise<void> {
    if ((await this.secure.getPlatform()).value !== 'android') throw new Error('Android secure chat storage is unavailable.');
  }

  async load(scope: MobileChatScope): Promise<MobileChatRecord | null> {
    const key=storageKey(scope);
    await this.requireAndroid();
    const keys=(await this.secure.keys()).value;
    if (!Array.isArray(keys)) throw new Error('Cannot inspect secure chat storage.');
    if (!keys.includes(key)) return null;
    const value=(await this.secure.get({key})).value;
    if (new TextEncoder().encode(value).byteLength > MAX_RECORD_BYTES) throw new Error('Chat recovery record is too large.');
    return validateMobileChatRecord(JSON.parse(value),scope);
  }

  async save(value: MobileChatRecord): Promise<void> {
    const record=validateMobileChatRecord(value,value.scope);
    const key=storageKey(record.scope);
    const serialized=JSON.stringify(record);
    if (new TextEncoder().encode(serialized).byteLength > MAX_RECORD_BYTES) throw new Error('Chat recovery record is too large.');
    await this.requireAndroid();
    if (!(await this.secure.set({key,value:serialized})).value) throw new Error('Secure chat write was rejected.');
    if ((await this.secure.get({key})).value !== serialized) throw new Error('Secure chat write could not be verified.');
  }
}
