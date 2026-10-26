/** The part of xterm's buffer API this reader needs (kept narrow for tests). */
export interface XtermTextBuffer {
  readonly length: number;
  getLine(index: number): { translateToString(trimRight?: boolean): string; readonly isWrapped?: boolean } | undefined;
}

/** The last `maxLines` rows of an xterm buffer as text; soft-wrapped rows join their line. */
export function readXtermText(buffer: XtermTextBuffer, maxLines = 2_000): string {
  const lines: string[] = [];
  const start = Math.max(0, buffer.length - maxLines);
  for (let index = start; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}
