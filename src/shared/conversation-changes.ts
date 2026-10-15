import { z } from 'zod';
import type { DaemonTranscriptItem } from './daemon-protocol';

const ChangeSchema = z.object({
  path: z.string().min(1).max(4096),
  patch: z.string().max(800_000),
  coverage: z.enum(['patch', 'fragment']),
}).strict();
const RecordSchema = z.object({ type: z.literal('ezterminal.file-changes.v1'), changes: z.array(ChangeSchema).max(200) }).strict();
export type RecordedFileChange = z.infer<typeof ChangeSchema>;
export interface ConversationFileChange extends RecordedFileChange {
  readonly id: string;
  readonly turnId?: string;
  readonly sequence: number;
}

/** Only provider adapters create these records, after a successful file operation. */
export function encodeFileChanges(changes: readonly RecordedFileChange[]): string | undefined {
  const parsed = RecordSchema.safeParse({ type: 'ezterminal.file-changes.v1', changes });
  if (!parsed.success || !changes.length) return undefined;
  const text = JSON.stringify(parsed.data);
  return text.length <= 900_000 ? text : undefined;
}
export function decodeFileChanges(text: string): readonly RecordedFileChange[] {
  if (text.length > 900_000 || !text.startsWith('{"type":"ezterminal.file-changes.v1"')) return [];
  try { const parsed = RecordSchema.safeParse(JSON.parse(text)); return parsed.success ? parsed.data.changes : []; }
  catch { return []; }
}
export function conversationFileChanges(items: readonly DaemonTranscriptItem[], sessionId: string): ConversationFileChange[] {
  const changes: ConversationFileChange[] = [];
  for (const item of items) {
    if (item.sessionId !== sessionId || item.kind !== 'tool-result' || item.isDelta || item.isSensitive) continue;
    decodeFileChanges(item.text).forEach((change, index) => changes.push({ ...change, id: `${item.id}:${index}`, turnId: item.turnId, sequence: item.sequence }));
  }
  return changes.sort((a, b) => a.sequence - b.sequence);
}

/** Lines of a text body; a final newline ends the last line rather than adding an empty one. */
function bodyLines(text: string): string[] {
  return text.replace(/\r?\n$/u, '').split('\n');
}

export function claudeFileChange(name: string, input: unknown): RecordedFileChange | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const data = input as Record<string, unknown>;
  if (typeof data.file_path !== 'string') return undefined;
  if (name === 'Edit' && typeof data.old_string === 'string' && typeof data.new_string === 'string') {
    return { path: data.file_path, coverage: 'fragment', patch: [
      ...bodyLines(data.old_string).map(line => `-${line}`), ...bodyLines(data.new_string).map(line => `+${line}`),
    ].join('\n') };
  }
  if (name === 'MultiEdit' && Array.isArray(data.edits)) {
    const hunks = data.edits.flatMap((edit: unknown) => {
      const entry = edit && typeof edit === 'object' ? edit as Record<string, unknown> : undefined;
      return typeof entry?.old_string === 'string' && typeof entry.new_string === 'string'
        ? [[...bodyLines(entry.old_string).map(line => `-${line}`), ...bodyLines(entry.new_string).map(line => `+${line}`)].join('\n')]
        : [];
    });
    return hunks.length ? { path: data.file_path, coverage: 'fragment', patch: hunks.join('\n') } : undefined;
  }
  if (name === 'Write' && typeof data.content === 'string') {
    return { path: data.file_path, coverage: 'fragment', patch: bodyLines(data.content).map(line => `+${line}`).join('\n') };
  }
  return undefined;
}

export interface ReviewLine { readonly text: string; readonly kind: 'add' | 'remove' | 'context' | 'header'; readonly before?: number; readonly after?: number }
export function reviewLines(change: RecordedFileChange): ReviewLine[] {
  let before: number | undefined; let after: number | undefined;
  return change.patch.split('\n').map(text => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk && change.coverage === 'patch') { before = Number(hunk[1]); after = Number(hunk[2]); return { text, kind: 'header' }; }
    if (/^(?:diff |index |--- |\+\+\+ |\\ |@@)/.test(text)) return { text, kind: 'header' };
    if (text.startsWith('+')) { const line = { text, kind: 'add' as const, after }; if (after !== undefined) after++; return line; }
    if (text.startsWith('-')) { const line = { text, kind: 'remove' as const, before }; if (before !== undefined) before++; return line; }
    const line = { text, kind: 'context' as const, before, after };
    if (text.startsWith(' ')) { if (before !== undefined) before++; if (after !== undefined) after++; }
    else { before = undefined; after = undefined; }
    return line;
  });
}
