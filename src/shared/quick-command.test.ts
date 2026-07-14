import { describe, expect, it } from 'vitest';

import {
  MAX_QUICK_COMMAND_CHARS,
  MAX_QUICK_COMMAND_DESCRIPTION_CHARS,
  MAX_QUICK_COMMAND_NAME_CHARS,
  QuickCommandInputSchema,
  QuickCommandsFileSchema,
  quickCommandNameKey,
} from './quick-command';

describe('QuickCommandInputSchema', () => {
  it('normalizes display text without altering command bytes', () => {
    expect(
      QuickCommandInputSchema.parse({
        name: '  Build  ',
        command: '  pnpm build  ',
        description: '  Build everything  ',
      }),
    ).toEqual({
      name: 'Build',
      command: '  pnpm build  ',
      description: 'Build everything',
    });
    expect(QuickCommandInputSchema.parse({ name: 'Build', command: 'pnpm build', description: '   ' }))
      .toEqual({ name: 'Build', command: 'pnpm build' });
  });

  it.each([
    [{ name: '', command: 'pwd' }, 'name'],
    [{ name: 'x'.repeat(MAX_QUICK_COMMAND_NAME_CHARS + 1), command: 'pwd' }, 'name'],
    [{ name: 'Name', command: '' }, 'command'],
    [{ name: 'Name', command: 'x'.repeat(MAX_QUICK_COMMAND_CHARS + 1) }, 'command'],
    [{ name: 'Name', command: 'one\ntwo' }, 'command'],
    [{ name: 'Name', command: 'one\rtwo' }, 'command'],
    [{ name: 'Name', command: 'one\0two' }, 'command'],
    [
      { name: 'Name', command: 'pwd', description: 'x'.repeat(MAX_QUICK_COMMAND_DESCRIPTION_CHARS + 1) },
      'description',
    ],
  ])('rejects an invalid %s payload', (input, field) => {
    const parsed = QuickCommandInputSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0].path).toContain(field);
  });
});

describe('QuickCommandsFileSchema', () => {
  const command = (id: string, name: string) => ({
    id,
    name,
    command: 'pwd',
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
  });

  it('rejects duplicate ids and case-insensitive Unicode-normalized names', () => {
    const parsed = QuickCommandsFileSchema.safeParse({
      schemaVersion: 1,
      commands: [
        command('00000000-0000-4000-8000-000000000001', 'Build'),
        command('00000000-0000-4000-8000-000000000001', 'BUILD'),
      ],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.path.at(-1))).toEqual(expect.arrayContaining(['id', 'name']));
    }
  });

  it('uses a stable case-insensitive name key', () => {
    expect(quickCommandNameKey('CAF\u00c9')).toBe(quickCommandNameKey('cafe\u0301'));
  });
});
