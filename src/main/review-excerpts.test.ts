import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { REVIEW_LIMITS, relocateExcerpt, type ReviewFinding } from '../shared/review-findings';
import { excerptAt, withExcerpts } from './review-excerpts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function folder(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ezterminal-review-excerpts-'));
  directories.push(root);
  return root;
}

function finding(file: string, line?: number, endLine?: number): ReviewFinding {
  return { id: `f-${file}-${String(line)}`, file, title: 'Problem', body: 'Body', ...(line !== undefined ? { line } : {}), ...(endLine !== undefined ? { endLine } : {}) };
}

describe('review excerpts', () => {
  it('keeps the anchor lines exactly, at most three, and ends at a line too long to keep whole', () => {
    const lines = ['a', 'b', 'c', 'd', 'x'.repeat(REVIEW_LIMITS.excerptLineChars + 1), 'f'];
    expect(excerptAt(lines, 2)).toEqual({ startLine: 2, lines: ['b'] });
    expect(excerptAt(lines, 1, 6)).toEqual({ startLine: 1, lines: ['a', 'b', 'c'] });
    expect(excerptAt(lines, 4, 6)).toEqual({ startLine: 4, lines: ['d'] });
    expect(excerptAt(lines, 5)).toBeUndefined();
    expect(excerptAt(lines, 40)).toBeUndefined();
    // What it keeps relocates with the shared rule the clients use.
    expect(relocateExcerpt(excerptAt(lines, 2, 3)!, ['new', ...lines])).toEqual({ state: 'moved', line: 3 });
  });

  it('reads each file once under the working folder, without line endings, and leaves the rest alone', async () => {
    const root = folder();
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'format.ts'), 'one\r\ntwo\r\nthree\r\n');
    writeFileSync(path.join(root, 'src', 'image.bin'), Buffer.from([1, 0, 2]));
    const outside = folder();
    writeFileSync(path.join(outside, 'secret.ts'), 'secret\n');
    let linked = true;
    try {
      symlinkSync(path.join(outside, 'secret.ts'), path.join(root, 'src', 'link.ts'));
    } catch {
      linked = false; // Windows without the symlink privilege.
    }
    const findings = await withExcerpts(root, [
      finding('src/format.ts', 2, 3),
      finding('src/format.ts'),
      finding('src/image.bin', 1),
      finding('src/missing.ts', 1),
      ...(linked ? [finding('src/link.ts', 1)] : []),
    ]);
    expect(findings[0]!.excerpt).toEqual({ startLine: 2, lines: ['two', 'three'] });
    expect(findings.slice(1).every((entry) => entry.excerpt === undefined)).toBe(true);
  });
});
