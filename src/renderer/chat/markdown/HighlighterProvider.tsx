import type { ReactNode } from 'react';

import { CodeHighlighterContext } from './highlight-context';
import { codeHighlighter } from './highlighter';

/**
 * Opt-in syntax highlighting for every `ChatMarkdown` below it. shiki and each
 * grammar load lazily on the first code block that needs them.
 */
export function HighlighterProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  return <CodeHighlighterContext.Provider value={codeHighlighter}>{children}</CodeHighlighterContext.Provider>;
}
