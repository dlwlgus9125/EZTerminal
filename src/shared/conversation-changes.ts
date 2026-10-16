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

/** Above this many line pairs a replacement is shown whole rather than diffed. */
const MAX_DIFF_CELLS = 160_000;

/**
 * Display lines for replacing `before` with `after`: unchanged lines as context (" "),
 * each changed run as its removals ("-") then additions ("+"). Edit inputs carry
 * surrounding context, so showing it as context keeps a one-line change one line.
 */
export function replacementLines(before: string, after: string): string[] {
  const a = before ? bodyLines(before) : [];
  const b = after ? bodyLines(after) : [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const middleA = a.slice(start, endA);
  const middleB = b.slice(start, endB);
  const middle = middleA.length * middleB.length > MAX_DIFF_CELLS
    ? [...middleA.map((line) => `-${line}`), ...middleB.map((line) => `+${line}`)]
    : diffRuns(middleA, middleB);
  return [...a.slice(0, start).map((line) => ` ${line}`), ...middle, ...a.slice(endA).map((line) => ` ${line}`)];
}

/** Longest-common-subsequence line diff. */
function diffRuns(a: readonly string[], b: readonly string[]): string[] {
  const width = b.length + 1;
  const common = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      common[i * width + j] = a[i] === b[j]
        ? common[(i + 1) * width + j + 1] + 1
        : Math.max(common[(i + 1) * width + j], common[i * width + j + 1]);
    }
  }
  const lines: string[] = [];
  let removed: string[] = [];
  let added: string[] = [];
  const flush = (): void => { lines.push(...removed, ...added); removed = []; added = []; };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      lines.push(` ${a[i]}`);
      i += 1; j += 1;
    } else if (j >= b.length || (i < a.length && common[(i + 1) * width + j] >= common[i * width + j + 1])) {
      removed.push(`-${a[i]}`); i += 1;
    } else {
      added.push(`+${b[j]}`); j += 1;
    }
  }
  flush();
  return lines;
}

export function claudeFileChange(name: string, input: unknown): RecordedFileChange | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const data = input as Record<string, unknown>;
  if (typeof data.file_path !== 'string') return undefined;
  if (name === 'Edit' && typeof data.old_string === 'string' && typeof data.new_string === 'string') {
    return { path: data.file_path, coverage: 'fragment', patch: replacementLines(data.old_string, data.new_string).join('\n') };
  }
  if (name === 'MultiEdit' && Array.isArray(data.edits)) {
    const hunks = data.edits.flatMap((edit: unknown) => {
      const entry = edit && typeof edit === 'object' ? edit as Record<string, unknown> : undefined;
      return typeof entry?.old_string === 'string' && typeof entry.new_string === 'string'
        ? [replacementLines(entry.old_string, entry.new_string).join('\n')]
        : [];
    });
    return hunks.length ? { path: data.file_path, coverage: 'fragment', patch: hunks.join('\n') } : undefined;
  }
  if (name === 'Write' && typeof data.content === 'string') {
    return { path: data.file_path, coverage: 'fragment', patch: bodyLines(data.content).map(line => `+${line}`).join('\n') };
  }
  return undefined;
}

const GIT_FILE_HEADER = /^(?:index |--- |\+\+\+ |new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to )/u;

/**
 * One numbered change per file of a multi-file `git diff`, without its header lines (the path
 * is shown separately). Header lines are only recognized before a file's first hunk, so a
 * removed line that starts with dashes stays content. Text that is not a git diff yields none.
 */
export function gitDiffFileChanges(text: string): RecordedFileChange[] {
  const changes: RecordedFileChange[] = [];
  let path: string | undefined;
  let lines: string[] = [];
  let inHunk = false;
  const flush = (): void => {
    if (path !== undefined) changes.push({ path, coverage: 'patch', patch: lines.join('\n').replace(/\n+$/u, '') });
  };
  for (const line of text.replace(/\r\n?/gu, '\n').split('\n')) {
    const start = line.match(/^diff --git a\/(.+?) b\/(.+)$/u);
    if (start) {
      flush();
      path = start[2];
      lines = [];
      inHunk = false;
      continue;
    }
    if (path === undefined) continue;
    if (!inHunk && GIT_FILE_HEADER.test(line)) continue;
    if (line.startsWith('@@')) inHunk = true;
    lines.push(line);
  }
  flush();
  return changes;
}

export interface ReviewLine { readonly text: string; readonly kind: 'add' | 'remove' | 'context' | 'header'; readonly before?: number; readonly after?: number }
export function reviewLines(change: RecordedFileChange): ReviewLine[] {
  let before: number | undefined; let after: number | undefined;
  // File headers only precede the first hunk; inside one, "--- x" is a removed "-- x".
  let inHunk = false;
  return change.patch.split('\n').map(text => {
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk && change.coverage === 'patch') { inHunk = true; before = Number(hunk[1]); after = Number(hunk[2]); return { text, kind: 'header' }; }
    if (/^(?:\\ |@@)/.test(text)) { inHunk = true; return { text, kind: 'header' }; }
    if (change.coverage === 'patch' && !inHunk && /^(?:diff |index |--- |\+\+\+ )/.test(text)) return { text, kind: 'header' };
    if (text.startsWith('+')) { const line = { text, kind: 'add' as const, after }; if (after !== undefined) after++; return line; }
    if (text.startsWith('-')) { const line = { text, kind: 'remove' as const, before }; if (before !== undefined) before++; return line; }
    const line = { text, kind: 'context' as const, before, after };
    if (text.startsWith(' ')) { if (before !== undefined) before++; if (after !== undefined) after++; }
    else { before = undefined; after = undefined; }
    return line;
  });
}
