import type { ProviderFileChangeRecord } from './agent-history-provider';
import type {
  ProjectRecordedChangeLine,
  ProjectRecordedChangeSection,
} from '../shared/project-workspace';

export type ProviderChangeRehydrationFailure =
  | 'ambiguous'
  | 'malformed-patch'
  | 'mismatch'
  | 'unsupported-newline'
  | 'unsupported-record'
  | 'verification-failed';

export type ProviderChangeRehydrationResult =
  | { readonly ok: true; readonly original: string; readonly modified: string }
  | { readonly ok: false; readonly reason: ProviderChangeRehydrationFailure };

type PatchLineKind = 'context' | 'added' | 'removed';

interface PatchLine {
  readonly kind: PatchLineKind;
  readonly text: string;
}

interface PatchHunk {
  readonly header: string;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: readonly PatchLine[];
}

type Attempt<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ProviderChangeRehydrationFailure };

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u;

function normalizeNewlines(value: string): string {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

function splitText(value: string): { lines: string[]; endsWithNewline: boolean } {
  const normalized = normalizeNewlines(value);
  const endsWithNewline = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (endsWithNewline) lines.pop();
  return { lines, endsWithNewline };
}

function joinText(lines: readonly string[], endsWithNewline: boolean): string {
  if (lines.length === 0) return '';
  return `${lines.join('\n')}${endsWithNewline ? '\n' : ''}`;
}

function parseCount(value: string | undefined): number {
  return value === undefined ? 1 : Number.parseInt(value, 10);
}

function parseUnifiedPatch(diff: string): Attempt<readonly PatchHunk[]> {
  const normalized = normalizeNewlines(diff);
  if (normalized.split('\n').some((line) => line === '\\ No newline at end of file')) {
    return { ok: false, reason: 'unsupported-newline' };
  }
  const hunks: PatchHunk[] = [];
  let active: {
    header: string;
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: PatchLine[];
  } | null = null;
  const finish = (): boolean => {
    if (!active) return true;
    const observedOld = active.lines.filter((line) => line.kind !== 'added').length;
    const observedNew = active.lines.filter((line) => line.kind !== 'removed').length;
    if (observedOld !== active.oldCount || observedNew !== active.newCount) return false;
    hunks.push(active);
    active = null;
    return true;
  };
  const lines = normalized.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith('@@')) {
      if (!finish()) return { ok: false, reason: 'malformed-patch' };
      const match = HUNK_HEADER.exec(line);
      if (!match) return { ok: false, reason: 'malformed-patch' };
      active = {
        header: line,
        oldStart: Number.parseInt(match[1]!, 10),
        oldCount: parseCount(match[2]),
        newStart: Number.parseInt(match[3]!, 10),
        newCount: parseCount(match[4]),
        lines: [],
      };
      continue;
    }
    if (!active) continue;
    if (line.startsWith(' ')) active.lines.push({ kind: 'context', text: line.slice(1) });
    else if (line.startsWith('+')) active.lines.push({ kind: 'added', text: line.slice(1) });
    else if (line.startsWith('-')) active.lines.push({ kind: 'removed', text: line.slice(1) });
    else if (line === '' && index === lines.length - 1 && normalized.endsWith('\n')) continue;
    else return { ok: false, reason: 'malformed-patch' };
  }
  if (!finish() || hunks.length === 0) return { ok: false, reason: 'malformed-patch' };
  for (let index = 1; index < hunks.length; index += 1) {
    const previous = hunks[index - 1]!;
    const current = hunks[index]!;
    const previousOldEnd = Math.max(0, previous.oldStart - 1) + previous.oldCount;
    const previousNewEnd = Math.max(0, previous.newStart - 1) + previous.newCount;
    if (Math.max(0, current.oldStart - 1) < previousOldEnd
      || Math.max(0, current.newStart - 1) < previousNewEnd) {
      return { ok: false, reason: 'malformed-patch' };
    }
  }
  return { ok: true, value: hunks };
}

function exactLineAnchor(
  currentLines: readonly string[],
  expected: readonly string[],
  declaredStart: number,
): number | undefined {
  if (expected.length === 0) return undefined;
  const matchesAt = (startIndex: number): boolean =>
    startIndex >= 0
    && startIndex + expected.length <= currentLines.length
    && expected.every((line, index) => currentLines[startIndex + index] === line);
  const declaredIndex = Math.max(0, declaredStart - 1);
  if (matchesAt(declaredIndex)) return declaredIndex + 1;
  let match = -1;
  for (let candidate = 0; candidate + expected.length <= currentLines.length; candidate += 1) {
    if (!matchesAt(candidate)) continue;
    if (match >= 0) return undefined;
    match = candidate;
  }
  return match >= 0 ? match + 1 : undefined;
}

function classifiedPatchLines(diff: string): readonly ProjectRecordedChangeLine[] {
  const normalized = normalizeNewlines(diff);
  const lines = normalized.split('\n');
  if (normalized.endsWith('\n')) lines.pop();
  return lines.map((line): ProjectRecordedChangeLine => {
    if (line.startsWith('+') && !line.startsWith('+++')) return { kind: 'added', text: line.slice(1) };
    if (line.startsWith('-') && !line.startsWith('---')) return { kind: 'removed', text: line.slice(1) };
    if (line.startsWith(' ')) return { kind: 'context', text: line.slice(1) };
    return { kind: 'meta', text: line };
  });
}

/**
 * Produces provider-authored hunk sections for the truthful fallback view.
 * Anchors are emitted only when the complete modified-side sequence matches
 * the current file at the declared line or at one unique exact location.
 */
export function recordedProviderSections(
  currentContent: string | undefined,
  records: readonly ProviderFileChangeRecord[],
): readonly ProjectRecordedChangeSection[] {
  const normalizedCurrent = currentContent === undefined ? undefined : normalizeNewlines(currentContent);
  const currentLines = normalizedCurrent === undefined ? undefined : splitText(normalizedCurrent).lines;
  return records.flatMap((record, recordIndex): ProjectRecordedChangeSection[] => {
    if (record.diff) {
      const parsed = parseUnifiedPatch(record.diff);
      if (parsed.ok) {
        return parsed.value.map((hunk) => {
          const modifiedSide = hunk.lines
            .filter((line) => line.kind !== 'removed')
            .map((line) => line.text);
          const anchorLine = currentLines
            ? exactLineAnchor(currentLines, modifiedSide, hunk.newStart)
            : undefined;
          return {
            lines: [
              { kind: 'meta', text: hunk.header },
              ...hunk.lines.map((line): ProjectRecordedChangeLine => ({ kind: line.kind, text: line.text })),
            ],
            ...(anchorLine === undefined ? {} : { anchorLine }),
          };
        });
      }
      const raw = normalizeNewlines(record.diff);
      const anchorLine = record.kind === 'added' && normalizedCurrent === raw ? 1 : undefined;
      return [{
        lines: classifiedPatchLines(record.diff),
        ...(anchorLine === undefined ? {} : { anchorLine }),
      }];
    }
    const original = normalizeNewlines(record.original ?? '');
    const modified = normalizeNewlines(record.modified ?? '');
    const located = normalizedCurrent !== undefined && modified
      ? uniqueIndex(normalizedCurrent, modified)
      : { ok: false as const, reason: 'mismatch' as const };
    const anchorLine = located.ok
      ? normalizedCurrent!.slice(0, located.value).split('\n').length
      : undefined;
    const originalLines = original ? original.split('\n') : [];
    const modifiedLines = modified ? modified.split('\n') : [];
    if (original.endsWith('\n')) originalLines.pop();
    if (modified.endsWith('\n')) modifiedLines.pop();
    return [{
      lines: [
        ...(records.length > 1
          ? [{ kind: 'meta' as const, text: `@@ recorded change ${String(recordIndex + 1)} @@` }]
          : []),
        ...originalLines.map((text): ProjectRecordedChangeLine => ({ kind: 'removed', text })),
        ...modifiedLines.map((text): ProjectRecordedChangeLine => ({ kind: 'added', text })),
      ],
      ...(anchorLine === undefined ? {} : { anchorLine }),
    }];
  });
}

function applyPatch(
  content: string,
  hunks: readonly PatchHunk[],
  direction: 'forward' | 'reverse',
): Attempt<string> {
  const split = splitText(content);
  const lines = [...split.lines];
  let endsWithNewline = split.endsWithNewline;
  const matchesAt = (startIndex: number, expected: readonly string[]): boolean =>
    startIndex >= 0
    && startIndex + expected.length <= lines.length
    && expected.every((line, index) => lines[startIndex + index] === line);
  const resolved: Array<{
    readonly hunk: PatchHunk;
    readonly startIndex: number;
    readonly expected: readonly string[];
    readonly replacement: readonly string[];
  }> = [];
  for (const hunk of hunks) {
    const start = direction === 'forward' ? hunk.oldStart : hunk.newStart;
    const expected = hunk.lines
      .filter((line) => direction === 'forward' ? line.kind !== 'added' : line.kind !== 'removed')
      .map((line) => line.text);
    const replacement = hunk.lines
      .filter((line) => direction === 'forward' ? line.kind !== 'removed' : line.kind !== 'added')
      .map((line) => line.text);
    if (expected.length === 0) return { ok: false, reason: 'ambiguous' };
    const declaredIndex = Math.max(0, start - 1);
    let startIndex = matchesAt(declaredIndex, expected) ? declaredIndex : -1;
    if (startIndex < 0) {
      for (let candidate = 0; candidate + expected.length <= lines.length; candidate += 1) {
        if (!matchesAt(candidate, expected)) continue;
        if (startIndex >= 0) return { ok: false, reason: 'ambiguous' };
        startIndex = candidate;
      }
    }
    if (startIndex < 0) return { ok: false, reason: 'mismatch' };
    resolved.push({ hunk, startIndex, expected, replacement });
  }
  const ascending = [...resolved].sort((left, right) => left.startIndex - right.startIndex);
  for (let index = 1; index < ascending.length; index += 1) {
    const previous = ascending[index - 1]!;
    const current = ascending[index]!;
    if (current.startIndex < previous.startIndex + previous.expected.length) {
      return { ok: false, reason: 'ambiguous' };
    }
  }
  for (const { startIndex, expected, replacement } of [...resolved]
    .sort((left, right) => right.startIndex - left.startIndex)) {
    const touchesEnd = startIndex + expected.length === lines.length;
    lines.splice(startIndex, expected.length, ...replacement);
    if (touchesEnd) endsWithNewline = lines.length > 0;
  }
  return { ok: true, value: joinText(lines, endsWithNewline) };
}

function uniqueIndex(content: string, expected: string): Attempt<number> {
  const first = content.indexOf(expected);
  if (first < 0) return { ok: false, reason: 'mismatch' };
  if (content.indexOf(expected, first + expected.length) >= 0) {
    return { ok: false, reason: 'ambiguous' };
  }
  return { ok: true, value: first };
}

function applyFragment(
  content: string,
  record: ProviderFileChangeRecord,
  direction: 'forward' | 'reverse',
): Attempt<string> {
  if (record.operation !== undefined && record.operation !== 'edit') {
    return { ok: false, reason: 'unsupported-record' };
  }
  if (record.replaceAll) return { ok: false, reason: 'ambiguous' };
  if (record.original === undefined || record.modified === undefined) {
    return { ok: false, reason: 'unsupported-record' };
  }
  const expected = normalizeNewlines(direction === 'forward' ? record.original : record.modified);
  const replacement = normalizeNewlines(direction === 'forward' ? record.modified : record.original);
  if (!expected) {
    if (record.kind === 'added' && content === '') return { ok: true, value: replacement };
    return { ok: false, reason: 'ambiguous' };
  }
  const located = uniqueIndex(content, expected);
  if (!located.ok) return located;
  return {
    ok: true,
    value: `${content.slice(0, located.value)}${replacement}${content.slice(located.value + expected.length)}`,
  };
}

function applyRecord(
  content: string,
  record: ProviderFileChangeRecord,
  direction: 'forward' | 'reverse',
): Attempt<string> {
  if (record.diff) {
    const parsed = parseUnifiedPatch(record.diff);
    if (!parsed.ok) {
      if (record.kind !== 'added' || record.diff.includes('@@')) return parsed;
      const expected = direction === 'forward' ? '' : normalizeNewlines(record.diff);
      const replacement = direction === 'forward' ? normalizeNewlines(record.diff) : '';
      if (content !== expected) return { ok: false, reason: 'mismatch' };
      return { ok: true, value: replacement };
    }
    return applyPatch(content, parsed.value, direction);
  }
  return applyFragment(content, record, direction);
}

/**
 * Rebuilds a full before model only when every provider record can be reversed
 * from the current file and replayed back to the same normalized content.
 */
export function rehydrateProviderChanges(
  currentContent: string,
  records: readonly ProviderFileChangeRecord[],
): ProviderChangeRehydrationResult {
  if (records.length === 0) return { ok: false, reason: 'unsupported-record' };
  const modified = normalizeNewlines(currentContent);
  let original = modified;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const reversed = applyRecord(original, records[index]!, 'reverse');
    if (!reversed.ok) return reversed;
    original = reversed.value;
  }
  let replayed = original;
  for (const record of records) {
    const forward = applyRecord(replayed, record, 'forward');
    if (!forward.ok) return { ok: false, reason: 'verification-failed' };
    replayed = forward.value;
  }
  if (replayed !== modified) return { ok: false, reason: 'verification-failed' };
  return { ok: true, original, modified };
}
