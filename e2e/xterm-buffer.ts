import type { Locator } from '@playwright/test';

interface ExposedXterm {
  readonly rows: number;
  readonly buffer: {
    readonly active: {
      readonly viewportY: number;
      readonly length: number;
      getLine(index: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
}

/** Read the text in xterm's current viewport without depending on its renderer DOM. */
export function readXtermBuffer(ptyBlock: Locator): Promise<string> {
  return ptyBlock.evaluate((element) => {
    const terminal = (element as HTMLElement & { __ezTerm?: ExposedXterm }).__ezTerm;
    if (!terminal) return '';

    const buffer = terminal.buffer.active;
    const end = Math.min(buffer.length, buffer.viewportY + terminal.rows);
    const lines: string[] = [];
    for (let index = buffer.viewportY; index < end; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
    }
    return lines.join('\n');
  });
}
