import { describe, expect, it } from 'vitest';

import {
  compareForSort,
  compareValues,
  datetimeValue,
  filesizeValue,
  inferColumns,
  numberValue,
  parseFilesize,
  recordToJson,
  recordValue,
  stringValue,
} from './value';

describe('filesize literals', () => {
  it('parses 100mb to 1024-based bytes', () => {
    expect(parseFilesize('100mb')).toBe(100 * 1024 * 1024);
  });

  it('parses fractional 1.5gb', () => {
    expect(parseFilesize('1.5gb')).toBe(Math.round(1.5 * 1024 ** 3));
  });

  it('is case-insensitive and supports kb', () => {
    expect(parseFilesize('2KB')).toBe(2048);
  });

  it('returns null for non-filesize text', () => {
    expect(parseFilesize('100')).toBeNull();
    expect(parseFilesize('100xb')).toBeNull();
    expect(parseFilesize('mb')).toBeNull();
  });
});

describe('compareValues', () => {
  it('compares filesizes by bytes', () => {
    expect(compareValues(filesizeValue(200 * 1024 * 1024), filesizeValue(100 * 1024 * 1024), '>')).toBe(true);
    expect(compareValues(filesizeValue(100), filesizeValue(100), '==')).toBe(true);
    expect(compareValues(filesizeValue(100), filesizeValue(200), '>=')).toBe(false);
  });

  it('compares numbers', () => {
    expect(compareValues(numberValue(3), numberValue(2), '>')).toBe(true);
    expect(compareValues(numberValue(3), numberValue(3), '>=')).toBe(true);
    expect(compareValues(numberValue(2), numberValue(3), '<')).toBe(true);
  });

  it('handles string equality', () => {
    expect(compareValues(stringValue('x'), stringValue('x'), '==')).toBe(true);
    expect(compareValues(stringValue('x'), stringValue('y'), '!=')).toBe(true);
  });

  it('treats mixed-kind equality as false', () => {
    expect(compareValues(stringValue('1'), numberValue(1), '==')).toBe(false);
    expect(compareValues(stringValue('1'), numberValue(1), '!=')).toBe(true);
  });

  it('throws when ordering incompatible kinds', () => {
    expect(() => compareValues(stringValue('x'), numberValue(2), '>')).toThrow();
  });
});

describe('compareForSort', () => {
  it('orders strings lexicographically', () => {
    expect(compareForSort(stringValue('a'), stringValue('b'))).toBeLessThan(0);
    expect(compareForSort(stringValue('b'), stringValue('a'))).toBeGreaterThan(0);
  });

  it('orders filesizes by bytes', () => {
    expect(compareForSort(filesizeValue(2000), filesizeValue(1000))).toBeGreaterThan(0);
  });
});

describe('serialization + column inference', () => {
  it('serializes a record (filesize -> bytes, datetime -> ISO)', () => {
    const rec = recordValue({
      name: stringValue('a'),
      size: filesizeValue(2048),
      when: datetimeValue(0),
    });
    expect(recordToJson(rec)).toEqual({
      name: 'a',
      size: 2048,
      when: new Date(0).toISOString(),
    });
  });

  it('infers columns with value kinds, preserving order', () => {
    const rec = recordValue({ n: numberValue(1), name: stringValue('x') });
    expect(inferColumns(rec)).toEqual([
      { name: 'n', type: 'number' },
      { name: 'name', type: 'string' },
    ]);
  });
});
