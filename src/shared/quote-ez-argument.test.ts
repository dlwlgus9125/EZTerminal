import { describe, expect, it } from 'vitest';

import { parse } from '../interpreter/core/parser';
import type { StringLiteral } from '../interpreter/core/ast';
import { quoteEzArgument } from './quote-ez-argument';

function parseArgument(encoded: string): string {
  const statement = parse(`open ${encoded}`);
  if (statement.type !== 'pipeline') throw new Error('expected pipeline');
  const arg = statement.commands[0].args[0];
  if (!arg || arg.kind !== 'positional' || arg.expr.type !== 'string') {
    throw new Error('expected one string argument');
  }
  return (arg.expr as StringLiteral).value;
}

describe('quoteEzArgument', () => {
  it.each([
    '',
    'plain.txt',
    'C:\\Program Files\\EZTerminal\\read me.txt',
    "C:\\Users\\O'Brien\\notes.txt",
    'C:\\작업 폴더\\보고서 최종.txt',
    '/tmp/a path/한글/quote\'s.txt',
    'line one\nline two',
    'tab\tname',
  ])('round-trips through the real EZ parser: %j', (value) => {
    expect(parseArgument(quoteEzArgument(value))).toBe(value);
  });

  it('always emits one quoted argument and doubles Windows separators', () => {
    expect(quoteEzArgument('C:\\one two\\file.txt')).toBe("'C:\\\\one two\\\\file.txt'");
  });
});

