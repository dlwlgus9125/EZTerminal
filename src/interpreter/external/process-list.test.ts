/**
 * AC#4-B / E6 — `ps` process source. Proves the Windows `tasklist /fo csv /nh`
 * parsing (quoting: names with spaces / commas / doubled quotes, memory cells)
 * against a known sample, that the REAL lister returns ≥1 row on Windows, AND the
 * POSIX `ps -eo pid=,rss=,tty=,comm=` parser (exercised via the injectable runner +
 * a `platform` override, since real POSIX execution can't run on this box).
 */

import { describe, expect, it } from 'vitest';

import { createProcessLister, parsePosixPs, parseTasklistCsv } from './process-list';

// A representative `tasklist /fo csv /nh` sample (no header line). Includes a name
// with spaces, one with an embedded comma, and one with a doubled (escaped) quote.
const SAMPLE = [
  '"System Idle Process","0","Services","0","8 K"',
  '"node.exe","1234","Console","1","45,678 K"',
  '"weird,name.exe","5678","Console","1","1,024 K"',
  '"a""b.exe","9","Console","1","2 K"',
  '',
].join('\r\n');

describe('parseTasklistCsv', () => {
  it('parses CSV rows with correct pid / name / memory', () => {
    const rows = parseTasklistCsv(SAMPLE);
    expect(rows).toEqual([
      { pid: 0, name: 'System Idle Process', sessionName: 'Services', memoryKb: 8 },
      { pid: 1234, name: 'node.exe', sessionName: 'Console', memoryKb: 45678 },
      { pid: 5678, name: 'weird,name.exe', sessionName: 'Console', memoryKb: 1024 },
      { pid: 9, name: 'a"b.exe', sessionName: 'Console', memoryKb: 2 },
    ]);
  });

  it('handles a quoted name containing a comma without splitting it', () => {
    const rows = parseTasklistCsv('"my, app.exe","42","Console","1","16 K"');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('my, app.exe');
    expect(rows[0].pid).toBe(42);
  });

  it('skips blank or PID-less lines defensively', () => {
    const rows = parseTasklistCsv('\r\n"INFO: no tasks"\r\n"good.exe","7","Console","1","4 K"\r\n');
    expect(rows.map((r) => r.name)).toEqual(['good.exe']);
  });
});

describe('createProcessLister (injectable runner)', () => {
  it('parses whatever the injected runner returns', async () => {
    const lister = createProcessLister(async () => SAMPLE);
    const rows = await lister();
    expect(rows.map((r) => r.name)).toContain('node.exe');
    expect(rows.find((r) => r.name === 'node.exe')?.pid).toBe(1234);
  });

  it('dispatches to the POSIX parser when platform is darwin/linux, even on Windows', async () => {
    const lister = createProcessLister(async () => POSIX_SAMPLE, 'linux');
    const rows = await lister();
    expect(rows.map((r) => r.name)).toEqual(['launchd', 'node', 'Google Chrome Helper']);
  });

  it('still uses the tasklist parser when platform is explicitly win32', async () => {
    const lister = createProcessLister(async () => SAMPLE, 'win32');
    const rows = await lister();
    expect(rows.map((r) => r.name)).toContain('node.exe');
  });
});

// A representative `ps -eo pid=,rss=,tty=,comm=` sample: numeric pid/rss columns,
// a `tty` column (`?` for no controlling terminal), and a `comm` name containing
// spaces as the final (unbounded) column.
const POSIX_SAMPLE = [
  '    1      512 ?        launchd',
  ' 1234    45678 pts/0     node',
  ' 4321     2048 ttys000   Google Chrome Helper',
  '',
].join('\n');

describe('parsePosixPs', () => {
  it('parses rows with correct pid / name / memory / sessionName(tty)', () => {
    const rows = parsePosixPs(POSIX_SAMPLE);
    expect(rows).toEqual([
      { pid: 1, name: 'launchd', sessionName: '?', memoryKb: 512 },
      { pid: 1234, name: 'node', sessionName: 'pts/0', memoryKb: 45678 },
      { pid: 4321, name: 'Google Chrome Helper', sessionName: 'ttys000', memoryKb: 2048 },
    ]);
  });

  it('reconstructs a name containing spaces from the trailing whitespace-split tokens', () => {
    const rows = parsePosixPs('  99    1024 pts/1    My Cool App');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('My Cool App');
    expect(rows[0].pid).toBe(99);
    expect(rows[0].memoryKb).toBe(1024);
  });

  it('returns no rows for headerless/empty output', () => {
    expect(parsePosixPs('')).toEqual([]);
    expect(parsePosixPs('\n\n')).toEqual([]);
  });

  it('skips malformed lines (non-numeric pid/rss, too few columns)', () => {
    const text = [
      'not a valid line at all',
      '  50   pts/0   bash', // only 3 tokens — missing a column
      '  abc  1024  pts/0  bash', // non-numeric pid
      '  50   abc   pts/0  bash', // non-numeric rss
      '  7      64  ?       good.exe',
      '',
    ].join('\n');
    const rows = parsePosixPs(text);
    expect(rows.map((r) => r.name)).toEqual(['good.exe']);
  });
});
