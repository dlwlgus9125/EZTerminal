import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { REVIEW_LIMITS, type ReviewExcerpt, type ReviewFinding } from '../shared/review-findings';

/** Files larger than this are not read for an excerpt; the finding keeps its line number. */
const MAX_EXCERPT_FILE_BYTES = 2 * 1024 * 1024;

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * The file's lines as the review read them, or undefined when it cannot be read safely: outside
 * the working folder (also through a link), not a regular file, too large, binary or not UTF-8.
 */
async function readLines(root: string, file: string): Promise<readonly string[] | undefined> {
  try {
    const realRoot = await fs.realpath(root);
    const absolute = path.resolve(realRoot, ...file.split('/'));
    if (!inside(realRoot, absolute)) return undefined;
    const real = await fs.realpath(absolute);
    if (!inside(realRoot, real)) return undefined;
    const handle = await fs.open(real, 'r');
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > MAX_EXCERPT_FILE_BYTES) return undefined;
      const buffer = Buffer.alloc(stats.size);
      const { bytesRead } = await handle.read(buffer, 0, stats.size, 0);
      const body = buffer.subarray(0, bytesRead);
      if (body.includes(0)) return undefined;
      return new TextDecoder('utf-8', { fatal: true }).decode(body).split('\n').map((line) => line.replace(/\r$/u, ''));
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    return undefined;
  }
}

/**
 * The anchor lines of a finding (its line to its end line, at most REVIEW_LIMITS.excerptLines) exactly as
 * they are: `relocateExcerpt` compares them line for line, so a line too long to keep whole ends the
 * excerpt instead of being cut, and a first line too long means no excerpt at all.
 */
export function excerptAt(lines: readonly string[], line: number, endLine?: number): ReviewExcerpt | undefined {
  const last = Math.min(endLine !== undefined && endLine >= line ? endLine : line, line + REVIEW_LIMITS.excerptLines - 1);
  const kept: string[] = [];
  for (let number = line; number <= last; number += 1) {
    const text = lines[number - 1];
    if (text === undefined || text.length > REVIEW_LIMITS.excerptLineChars) break;
    kept.push(text);
  }
  return kept.length ? { startLine: line, lines: kept } : undefined;
}

/**
 * Adds each anchored finding's excerpt, read once per file under the working folder. Unreadable
 * files (deleted, outside, binary, too large) leave their findings as they were.
 */
export async function withExcerpts(workspaceRoot: string, findings: readonly ReviewFinding[]): Promise<ReviewFinding[]> {
  const files = new Map<string, Promise<readonly string[] | undefined>>();
  return Promise.all(findings.map(async (finding) => {
    if (finding.line === undefined) return finding;
    let lines = files.get(finding.file);
    if (!lines) {
      lines = readLines(workspaceRoot, finding.file);
      files.set(finding.file, lines);
    }
    const read = await lines;
    const excerpt = read ? excerptAt(read, finding.line, finding.endLine) : undefined;
    return excerpt ? { ...finding, excerpt } : finding;
  }));
}
