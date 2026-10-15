import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DaemonTranscriptItem } from '../../../shared/daemon-protocol';
import { buildChatModel } from './build-chat-model';
import { findRows, rowSearchText } from './find';

function rows(name: string) {
  const golden = JSON.parse(readFileSync(path.resolve(process.cwd(), 'src/renderer/chat/fixtures', `${name}.json`), 'utf8')) as {
    items: DaemonTranscriptItem[];
  };
  return buildChatModel({ items: golden.items }).rows;
}

describe('findRows', () => {
  it('matches prose rows case-insensitively, in transcript order', () => {
    const all = rows('claude-markdown');
    const found = findRows(all, 'UNION');
    expect(found.length).toBeGreaterThanOrEqual(2);
    expect(found).toEqual(all.filter((row) => found.includes(row.id)).map((row) => row.id));
    expect(all.find((row) => row.id === found[0])?.kind).toBe('user');
  });

  it('finds tool targets shown on activity lines, and nothing for a blank query', () => {
    const all = rows('claude-read-search');
    const activity = all.find((row) => row.kind === 'activity')!;
    expect(rowSearchText(activity)).toMatch(/README\.md/u);
    expect(findRows(all, 'readme.md')).toContain(activity.id);
    expect(findRows(all, '   ')).toEqual([]);
  });
});
