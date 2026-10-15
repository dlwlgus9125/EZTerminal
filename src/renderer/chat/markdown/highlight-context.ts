import { createContext, type ReactNode } from 'react';

/**
 * The seam between code blocks and the syntax highlighter. Kept free of any
 * shiki import so surfaces without `HighlighterProvider` (Android) never
 * bundle it; their code blocks render plain.
 */
export interface CodeHighlighter {
  /** A cached result, so a remounted block paints highlighted immediately. */
  readonly peek: (code: string, language: string) => ReactNode | undefined;
  /** Highlighted line content for `<code>`, or null for unsupported input. */
  readonly highlight: (code: string, language: string) => Promise<ReactNode | null>;
}

export const CodeHighlighterContext = createContext<CodeHighlighter | null>(null);

/** True inside the block that is still streaming: its code stays plain until complete. */
export const DeferHighlightContext = createContext(false);
