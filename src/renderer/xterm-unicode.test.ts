import { describe, expect, it } from 'vitest';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { Terminal } from '@xterm/xterm';

function write(term: Terminal, value: string): Promise<void> {
  return new Promise((resolve) => term.write(value, resolve));
}

describe('xterm Unicode 11 integration', () => {
  it('uses Unicode 11 width data for newer emoji while preserving CJK width', async () => {
    const unicode6 = new Terminal({ allowProposedApi: true });
    await write(unicode6, '🧐');
    expect(unicode6.buffer.active.getLine(0)?.getCell(0)?.getWidth()).toBe(1);
    unicode6.dispose();

    const unicode11 = new Terminal({ allowProposedApi: true });
    unicode11.loadAddon(new Unicode11Addon());
    unicode11.unicode.activeVersion = '11';
    await write(unicode11, 'A가🧐');
    const line = unicode11.buffer.active.getLine(0);

    expect(unicode11.unicode.versions).toContain('11');
    expect(line?.getCell(0)?.getWidth()).toBe(1);
    expect(line?.getCell(1)?.getWidth()).toBe(2);
    expect(line?.getCell(3)?.getWidth()).toBe(2);
    unicode11.dispose();
  });
});
