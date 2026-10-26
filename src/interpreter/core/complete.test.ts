import { describe, expect, it } from 'vitest';

import { completeLine, completionWord, encodeWord, type CompletionEntry, type CompletionSource } from './complete';

const TREE: Record<string, readonly CompletionEntry[]> = {
  'C:\\work': [
    { name: 'src', directory: true },
    { name: 'scripts', directory: true },
    { name: 'setup.cmd', directory: false },
    { name: 'Program Files', directory: true },
    { name: '.git', directory: true },
    { name: '.env', directory: false },
    { name: '보고서.md', directory: false },
    { name: 'null', directory: false },
  ],
  'C:\\work\\src': [
    { name: 'renderer', directory: true },
    { name: 'render.ts', directory: false },
    { name: 'main', directory: true },
  ],
  'C:\\work\\Program Files': [{ name: 'Tool', directory: true }],
  'C:\\': [{ name: 'Users', directory: true }, { name: 'Windows', directory: true }],
};

function source(overrides: Partial<CompletionSource> = {}): CompletionSource & { readonly listed: string[] } {
  const listed: string[] = [];
  return {
    listed,
    cwd: 'C:\\work',
    builtins: ['ls', 'cd', 'sort-by', 'where', 'ssh-connect'],
    executableExtensions: ['.exe', '.cmd', '.bat'],
    listDirectory: async (absolute) => { listed.push(absolute); return TREE[absolute] ?? null; },
    pathExecutables: async () => ['git', 'gh', 'code', 'cmd', 'Ls'],
    ...overrides,
  };
}

describe('completionWord', () => {
  it('finds the command position at the start, after a pipe and after the ! sigil', () => {
    expect(completionWord('gi', 2)).toMatchObject({ position: 'command', prefix: 'gi', start: 0 });
    expect(completionWord('ls | so', 7)).toMatchObject({ position: 'command', prefix: 'so', start: 5 });
    expect(completionWord('!cod', 4)).toMatchObject({ position: 'command', prefix: 'cod', start: 1 });
  });

  it('names the command for an argument and reads quoted words as the shell will', () => {
    expect(completionWord('cd src', 6)).toMatchObject({ position: 'argument', command: 'cd', prefix: 'src', start: 3 });
    expect(completionWord('cd "C:\\\\Program Fi', 18)).toMatchObject({ prefix: 'C:\\Program Fi', start: 3, quote: '"' });
    expect(completionWord('cd ', 3)).toMatchObject({ position: 'argument', prefix: '', start: 3 });
  });

  it('completes only up to the caret and leaves flags and variables alone', () => {
    expect(completionWord('cd src/re other', 9)).toMatchObject({ prefix: 'src/re', start: 3 });
    expect(completionWord('ls --al', 7)).toBeNull();
    expect(completionWord('echo $env.PA', 12)).toBeNull();
  });
});

describe('encodeWord', () => {
  it('keeps bare words bare and quotes what the lexer would split or misread', () => {
    expect(encodeWord('src\\renderer\\', { open: true })).toBe('src\\renderer\\');
    expect(encodeWord('Program Files\\', { open: true })).toBe('"Program Files\\\\');
    expect(encodeWord('보고서.md', { open: false })).toBe('"보고서.md"');
    expect(encodeWord('null', { open: false })).toBe('"null"');
    expect(encodeWord('2026.txt', { open: false })).toBe('"2026.txt"');
    expect(encodeWord('say "hi"', { open: false })).toBe('"say \\"hi\\""');
    expect(encodeWord('a b', { open: false, quote: "'" })).toBe("'a b'");
  });
});

describe('completeLine', () => {
  it('offers builtins first, then PATH executables, without duplicates', async () => {
    const result = await completeLine('l', 1, source());
    expect(result).toMatchObject({ ok: true, replaceStart: 0, replaceEnd: 1 });
    if (!result.ok) throw new Error('expected candidates');
    expect(result.candidates.map((candidate) => [candidate.label, candidate.kind])).toEqual([['ls', 'builtin']]);
    expect(result.commonText).toBe('ls ');
  });

  it('fills the shared part of several commands and lists them', async () => {
    const result = await completeLine('g', 1, source());
    if (!result.ok) throw new Error('expected candidates');
    expect(result.candidates.map((candidate) => candidate.label)).toEqual(['gh', 'git']);
    expect(result.commonText).toBe('g');
  });

  it('completes folders and files relative to the session folder, folders first', async () => {
    const result = await completeLine('cat s', 5, source());
    if (!result.ok) throw new Error('expected candidates');
    expect(result.candidates.map((candidate) => candidate.label)).toEqual(['scripts\\', 'src\\', 'setup.cmd']);
    expect(result.candidates.map((candidate) => candidate.insertText)).toEqual(['scripts\\', 'src\\', 'setup.cmd ']);
  });

  it('keeps the separator the person typed and goes into sub folders', async () => {
    const result = await completeLine('cat src/rend', 12, source());
    if (!result.ok) throw new Error('expected candidates');
    expect(result.candidates.map((candidate) => candidate.insertText)).toEqual(['src/renderer/', 'src/render.ts ']);
    expect(result.commonText).toBe('src/render');
  });

  it('offers only folders after cd', async () => {
    const result = await completeLine('cd s', 4, source());
    if (!result.ok) throw new Error('expected candidates');
    expect(result.candidates.map((candidate) => candidate.label)).toEqual(['scripts\\', 'src\\']);
  });

  it('quotes a folder with spaces, closed, with the caret left inside the closing quote', async () => {
    const result = await completeLine('cd Pro', 6, source());
    if (!result.ok) throw new Error('expected candidates');
    // The line runs as it stands; typing and Tab go on inside the quote.
    expect(result.commonText).toBe('"Program Files\\\\"');
    expect(result.commonCaretBack).toBe(1);
    expect(result.candidates[0]).toMatchObject({ insertText: '"Program Files\\\\"', caretBack: 1 });
    // Tab again from inside the quote: the closing quote right after the caret is replaced with the new word.
    const again = 'cd "Program Files\\\\"';
    const deeper = await completeLine(again, again.length - 1, source());
    if (!deeper.ok) throw new Error('expected candidates');
    expect(deeper.replaceStart).toBe(3);
    expect(deeper.replaceEnd).toBe(again.length);
    expect(deeper.commonText).toBe('"Program Files\\\\Tool\\\\"');
    expect(deeper.commonCaretBack).toBe(1);
    // In the middle of a quoted word the word goes in open and the existing quote closes it.
    const middle = await completeLine('ls "Program" | count', 7, source());
    if (!middle.ok) throw new Error('expected candidates');
    expect(middle).toMatchObject({ replaceEnd: 7, commonText: '"Program Files\\\\' });
    // A file before a closing quote ends with the quote and a space, the caret after them.
    const file = await completeLine('cat "보"', 6, source());
    expect(file).toMatchObject({ ok: true, replaceEnd: 7, commonText: '"보고서.md" ' });
    // A caret between an escape and what it escapes completes nothing.
    expect(await completeLine('ls "src\\\\\\"b" | count', 8, source())).toEqual({ ok: false, reason: 'none' });
    // A quote the person opened and did not close is closed.
    const typed = await completeLine('cd "Program Files\\\\T', 20, source());
    if (!typed.ok) throw new Error('expected candidates');
    expect(typed.replaceEnd).toBe(20);
    expect(typed.commonText).toBe('"Program Files\\\\Tool\\\\"');
    expect(typed.commonCaretBack).toBe(1);
  });

  it('writes words the shell parses back, wherever the caret is in the word', async () => {
    const { tokenize } = await import('./lexer');
    const apply = (line: string, start: number, end: number, text: string): string => `${line.slice(0, start)}${text}${line.slice(end)}`;
    for (const [line, caret] of [
      ['cd Pro', 6],
      ['cd "Pro', 7],
      ['cd "Pro"', 7],
      ['ls "Pro" | count', 7],
      ['ls "Program" | count', 7],
      ["ls 'Pro' | count", 7],
      ['cat "보" | count', 6],
    ] as const) {
      const result = await completeLine(line, caret, source());
      if (!result.ok) throw new Error(`expected candidates for ${line}`);
      const filled = apply(line, result.replaceStart, result.replaceEnd, result.commonText);
      expect(() => tokenize(filled), `${line} -> ${filled}`).not.toThrow();
      for (const candidate of result.candidates) {
        const chosen = apply(line, result.replaceStart, result.replaceEnd, candidate.insertText);
        expect(() => tokenize(chosen), `${line} -> ${chosen}`).not.toThrow();
      }
    }
  });

  it('quotes Korean names and closes the quote for a file', async () => {
    // Typed bare, it could not run as typed; the completed word comes back quoted.
    const result = await completeLine('cat 보', 5, source());
    if (!result.ok) throw new Error('expected candidates');
    expect(result.commonText).toBe('"보고서.md" ');
    const quoted = await completeLine('cat "보', 6, source());
    if (!quoted.ok) throw new Error('expected candidates');
    expect(quoted.commonText).toBe('"보고서.md" ');
  });

  it('shows dot files only when asked for and never mistakes a file named null for null', async () => {
    const plain = await completeLine('cat ', 4, source());
    if (!plain.ok) throw new Error('expected candidates');
    expect(plain.candidates.some((candidate) => candidate.label.startsWith('.'))).toBe(false);
    const dotted = await completeLine('cat .e', 6, source());
    if (!dotted.ok) throw new Error('expected candidates');
    expect(dotted.commonText).toBe('.env ');
    const nul = await completeLine('cat nu', 6, source());
    if (!nul.ok) throw new Error('expected candidates');
    expect(nul.commonText).toBe('"null" ');
  });

  it('completes a drive letter to its root and lists absolute folders', async () => {
    const drive = await completeLine('cd C:', 5, source());
    if (!drive.ok) throw new Error('expected candidates');
    expect(drive.commonText).toBe('C:\\');
    const root = await completeLine('cd C:\\U', 7, source());
    if (!root.ok) throw new Error('expected candidates');
    expect(root.commonText).toBe('C:\\Users\\');
  });

  it('offers runnable files and folders for a path in command position', async () => {
    const result = await completeLine('.\\s', 3, source());
    if (!result.ok) throw new Error('expected candidates');
    expect(result.candidates.map((candidate) => candidate.label)).toEqual(['scripts\\', 'src\\', 'setup.cmd']);
  });

  it('never lists a network share and says when nothing matches', async () => {
    const network = source();
    expect(await completeLine('cd \\\\server\\share\\x', 19, network)).toEqual({ ok: false, reason: 'none' });
    expect(network.listed).toEqual([]);
    expect(await completeLine('cd zzz', 6, source())).toEqual({ ok: false, reason: 'none' });
    expect(await completeLine('cd missing\\x', 12, source())).toEqual({ ok: false, reason: 'none' });
  });

  it('caps the candidates and says more matched', async () => {
    const many = Array.from({ length: 250 }, (_, index) => ({ name: `f${String(index).padStart(3, '0')}.txt`, directory: false }));
    const result = await completeLine('cat f', 5, source({ listDirectory: async () => many }));
    if (!result.ok) throw new Error('expected candidates');
    expect(result.candidates).toHaveLength(200);
    expect(result.truncated).toBe(true);
    expect(result.commonText).toBe('f');
  });
});
