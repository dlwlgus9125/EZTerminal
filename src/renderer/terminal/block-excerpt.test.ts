import { describe, expect, it } from 'vitest';

import { validateChatMessageContext } from '../../shared/chat-message';
import { BlockController } from '../block-controller';
import {
  EXCERPT_HEAD_LINES, EXCERPT_MAX_CHARS, EXCERPT_TAIL_LINES, buildBlockExcerpt, excerptFromController, htmlToText,
  isTerminalAttachment, looksSensitive, readBlockOutput, stripTerminalControls, tableToText, terminalOutputAttachment,
} from './block-excerpt';

const base = { command: 'git status --short', cwd: 'C:\\Working\\EZTerminal', status: 'done' as const, exitCode: 0 };

describe('stripTerminalControls', () => {
  it('drops colour, cursor and title sequences', () => {
    expect(stripTerminalControls('\x1b[32mok\x1b[0m \x1b]0;title\x07done\x1b[2K')).toBe('ok done');
  });

  it('lays out carriage returns and backspaces the way the terminal shows them', () => {
    expect(stripTerminalControls('progress 10%\rprogress 100%\r\nnext')).toBe('progress 100%\nnext');
    expect(stripTerminalControls('abc\rX')).toBe('Xbc');
    expect(stripTerminalControls('ab\bc')).toBe('ac');
  });

  it('keeps tabs and Korean text', () => {
    expect(stripTerminalControls('이름\t값\x07')).toBe('이름\t값');
  });
});

describe('htmlToText', () => {
  it('removes ansi_up spans and decodes entities', () => {
    expect(htmlToText('<span style="color:rgb(0,187,0)">a &lt;b&gt; &amp; &#x27;c&#39;</span>')).toBe("a <b> & 'c'");
  });
});

describe('buildBlockExcerpt', () => {
  it('starts with the command, folder and how it ended', () => {
    const excerpt = buildBlockExcerpt({ ...base, output: ' M src/a.ts\n' });
    expect(excerpt.text).toBe('$ git status --short\ncwd: C:\\Working\\EZTerminal\nexit 0 · done\n M src/a.ts');
    expect(excerpt.omittedLines).toBe(0);
  });

  it('says error or cancelled without an exit code, and running while it runs', () => {
    expect(buildBlockExcerpt({ ...base, status: 'cancelled', exitCode: null, output: '' }).text.split('\n')[2]).toBe('cancelled');
    expect(buildBlockExcerpt({ ...base, status: 'running', exitCode: null, cwd: null, output: 'x' }).text)
      .toBe('$ git status --short\nrunning\nx');
  });

  it('keeps the first and last lines of long output and says how many were left out', () => {
    const lines = Array.from({ length: 500 }, (_, index) => `line ${index}`);
    const excerpt = buildBlockExcerpt({ ...base, output: lines.join('\n') });
    const body = excerpt.text.split('\n').slice(3);
    expect(excerpt.omittedLines).toBe(500 - EXCERPT_HEAD_LINES - EXCERPT_TAIL_LINES);
    expect(body[0]).toBe('line 0');
    expect(body[EXCERPT_HEAD_LINES]).toBe(`… (${excerpt.omittedLines}줄 생략) …`);
    expect(body.at(-1)).toBe('line 499');
  });

  it('caps a very long command and folder too, so the whole excerpt stays under the limit', () => {
    const output = Array.from({ length: 50 }, () => 'y'.repeat(1_500)).join('\n');
    const excerpt = buildBlockExcerpt({ ...base, command: `echo ${'x'.repeat(20_000)}`, cwd: `C:\\${'d'.repeat(5_000)}`, output });
    expect(excerpt.text.length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS);
    expect(excerpt.text.split('\n')[0]!.length).toBeLessThanOrEqual(1_003);
    expect(excerpt.text.endsWith('y')).toBe(true);
  });

  it('caps the size and keeps the end of the output', () => {
    const lines = Array.from({ length: 150 }, (_, index) => `${index}`.padEnd(1_500, 'x'));
    const excerpt = buildBlockExcerpt({ ...base, output: lines.join('\n') });
    expect(excerpt.clipped).toBe(true);
    expect(excerpt.text.length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS);
    expect(excerpt.text.startsWith('$ git status --short\n')).toBe(true);
    expect(excerpt.text.endsWith(lines.at(-1)!)).toBe(true);
  });
});

describe('tableToText', () => {
  it('writes the header and first rows and says when rows are left out', () => {
    const columns = [{ name: 'name', type: 'string' }, { name: 'size', type: 'number' }] as const;
    const text = tableToText(columns as never, { start: 0, rows: [{ name: 'a.ts', size: 10 }, { name: 'b\tc', size: null }] }, 5);
    expect(text).toBe('name\tsize\na.ts\t10\nb c\t\n(총 5행 중 2행)');
  });

  it('does not quote rows from the middle of a table as if they were its start', () => {
    expect(tableToText([{ name: 'n', type: 'string' }] as never, { start: 400, rows: [{ n: 'x' }] }, 900))
      .toBe('n\n(총 900행 중 0행)');
  });
});

describe('terminalOutputAttachment', () => {
  it('is a valid text attachment the conversation can send', () => {
    const excerpt = buildBlockExcerpt({ ...base, output: 'ok' });
    const attachment = terminalOutputAttachment('run-1', 'git log --oneline -3', excerpt, '터미널');
    expect(attachment).toMatchObject({ id: 'terminal-output-run-1', name: '터미널 · git log --oneline -3', kind: 'text', mimeType: 'text/plain' });
    expect(attachment.data).toBe(excerpt.text);
    expect(isTerminalAttachment(attachment)).toBe(true);
    expect(validateChatMessageContext({ attachments: [attachment, attachment, attachment].map((item, index) => ({ ...item, id: `${item.id}-${index}` })) })).toBeNull();
  });

  it('shortens a long command in the name', () => {
    const attachment = terminalOutputAttachment('r', 'x'.repeat(100), buildBlockExcerpt({ ...base, output: '' }));
    expect(attachment.name).toBe(`Terminal · ${'x'.repeat(60)}…`);
  });

  it('four full excerpts still fit the message size limit', () => {
    const lines = Array.from({ length: 400 }, () => '가'.repeat(1_000));
    const excerpt = buildBlockExcerpt({ ...base, output: lines.join('\n') });
    const attachments = [0, 1, 2, 3].map((index) => terminalOutputAttachment(`run-${index}`, 'cmd', excerpt));
    expect(validateChatMessageContext({ attachments })).toBeNull();
  });
});

describe('looksSensitive', () => {
  it('notices common credential shapes', () => {
    expect(looksSensitive('API_KEY=abc')).toBe(true);
    expect(looksSensitive('token: x')).toBe(true);
    expect(looksSensitive('ghp_abcdefghijklmnopqrstuvwxyz0123')).toBe(true);
    expect(looksSensitive('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe(true);
    expect(looksSensitive(' M src/token-store.ts')).toBe(false);
    expect(looksSensitive('3 files changed')).toBe(false);
  });
});

describe('readBlockOutput / excerptFromController', () => {
  class Port {
    listener: ((event: { data: unknown }) => void) | null = null;
    addEventListener(_type: string, listener: (event: { data: unknown }) => void): void { this.listener = listener; }
    start(): void {}
    postMessage(): void {}
    close(): void {}
    deliver(frame: unknown): void { this.listener?.({ data: frame }); }
  }
  const make = (command = 'cmd') => {
    const port = new Port();
    return { port, controller: new BlockController(command, port as unknown as MessagePort) };
  };

  it('reads html text output as plain text', () => {
    const { port, controller } = make('git log --oneline -1');
    port.deliver({ type: 'start', commandText: 'git log', cwd: 'C:\\p' });
    port.deliver({ type: 'schema', shape: 'text', columns: [{ name: 'value', type: 'html' }] });
    port.deliver({ type: 'progress', count: 2, done: true });
    port.deliver({ type: 'chunk', start: 0, rows: [{ value: '<span style="color:red">abc1 fix</span>\n' }, { value: 'x &amp; y' }] });
    port.deliver({ type: 'end', exitCode: 0, cwd: 'C:\\p' });
    expect(readBlockOutput(controller)).toBe('abc1 fix\nx & y');
    expect(excerptFromController(controller).text).toBe('$ git log --oneline -1\ncwd: C:\\p\nexit 0 · done\nabc1 fix\nx & y');
  });

  it('reads plain PTY output from retained bytes and an xterm block through its view', () => {
    const plain = make();
    plain.port.deliver({ type: 'schema', shape: 'pty', columns: [] });
    plain.port.deliver({ type: 'pty-data', data: new TextEncoder().encode('\x1b[1mbuild\x1b[0m ok\r\n') });
    expect(readBlockOutput(plain.controller)).toBe('build ok\n');

    const xterm = make();
    xterm.port.deliver({ type: 'schema', shape: 'pty', columns: [] });
    xterm.port.deliver({ type: 'pty-render-upgrade' });
    xterm.controller.setTextReader(() => 'vim screen');
    expect(readBlockOutput(xterm.controller)).toBe('vim screen');
  });

  it('quotes the error message of a failed block', () => {
    const { port, controller } = make();
    port.deliver({ type: 'error', message: 'not found: foo' });
    expect(readBlockOutput(controller)).toBe('not found: foo');
  });
});
