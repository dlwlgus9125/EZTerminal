import type { Locator } from '@playwright/test';

interface ExposedXterm {
  readonly rows: number;
  readonly buffer: {
    readonly active: {
      readonly type: 'normal' | 'alternate';
      readonly viewportY: number;
      readonly length: number;
      getLine(index: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
  scrollToTop(): void;
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

/** Read every retained line in xterm's active buffer, including scrollback. */
export function readXtermAllBuffer(ptyBlock: Locator): Promise<string> {
  return ptyBlock.evaluate((element) => {
    const terminal = (element as HTMLElement & { __ezTerm?: ExposedXterm }).__ezTerm;
    if (!terminal) return '';

    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
    }
    return lines.join('\n');
  });
}

export function readXtermBufferType(ptyBlock: Locator): Promise<'normal' | 'alternate' | null> {
  return ptyBlock.evaluate((element) => {
    const terminal = (element as HTMLElement & { __ezTerm?: ExposedXterm }).__ezTerm;
    return terminal?.buffer.active.type ?? null;
  });
}

export function scrollXtermToTop(ptyBlock: Locator): Promise<void> {
  return ptyBlock.evaluate((element) => {
    const terminal = (element as HTMLElement & { __ezTerm?: ExposedXterm }).__ezTerm;
    terminal?.scrollToTop();
  });
}
