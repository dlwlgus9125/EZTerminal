export const LARGE_PASTE_BYTES = 5 * 1024;

export interface TerminalClipboardSnapshot {
  readonly hasImage: boolean;
  readonly text: string;
}

export interface TerminalPastePreferences {
  readonly warnOnMultiline: boolean;
  readonly warnOnLarge: boolean;
}

export const DEFAULT_TERMINAL_PASTE_PREFERENCES: TerminalPastePreferences = Object.freeze({
  warnOnMultiline: true,
  warnOnLarge: true,
});

export function isTerminalPastePreferences(value: unknown): value is TerminalPastePreferences {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<TerminalPastePreferences>;
  return typeof candidate.warnOnMultiline === 'boolean'
    && typeof candidate.warnOnLarge === 'boolean';
}

export type TerminalPasteMode = 'default' | 'text';

export type TerminalPasteDecision =
  | { readonly kind: 'codex-image' }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'no-text' };

export interface TerminalPasteRisk {
  readonly multiline: boolean;
  readonly large: boolean;
  readonly lineCount: number;
  readonly byteLength: number;
  readonly shouldWarn: boolean;
}

export function resolveTerminalPaste(
  snapshot: TerminalClipboardSnapshot,
  isCodex: boolean,
  mode: TerminalPasteMode,
): TerminalPasteDecision {
  if (mode === 'default' && isCodex && snapshot.hasImage) return { kind: 'codex-image' };
  if (snapshot.text) return { kind: 'text', text: snapshot.text };
  if (snapshot.hasImage) return { kind: 'no-text' };
  return { kind: 'empty' };
}

export function assessTerminalPasteRisk(
  text: string,
  preferences: TerminalPastePreferences,
): TerminalPasteRisk {
  const lineCount = text.length === 0 ? 0 : text.split(/\r\n|\r|\n/u).length;
  const byteLength = new TextEncoder().encode(text).byteLength;
  const multiline = preferences.warnOnMultiline && /[\r\n]/u.test(text);
  const large = preferences.warnOnLarge && byteLength > LARGE_PASTE_BYTES;
  return { multiline, large, lineCount, byteLength, shouldWarn: multiline || large };
}
