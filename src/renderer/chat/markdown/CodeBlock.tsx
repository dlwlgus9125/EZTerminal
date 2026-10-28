import { glyphIcon } from '../../ui/Glyph';
import { memo, useContext, useEffect, useState, type ReactNode } from 'react';

import { IconButton, VisuallyHidden } from '../../ui';
import { CodeHighlighterContext, DeferHighlightContext } from './highlight-context';

export interface CodeBlockLabels {
  readonly copyCode: string;
  readonly copied: string;
  readonly copyFailed: string;
  readonly wrapLines: string;
}

export interface CodeBlockProps {
  readonly code: string;
  /** The fence info string; blocks without one get no header. */
  readonly language?: string;
  readonly labels: CodeBlockLabels;
}

const WRAP_STORAGE_PREFIX = 'ezterminal.chat-code-wrap:';
const COPY_FEEDBACK_MS = 2_000;

/**
 * Stable while a block streams: the language plus its first line. Identical
 * blocks in different messages share one wrap preference, which is harmless.
 */
export function codeBlockId(code: string, language: string | undefined): string {
  const newline = code.indexOf('\n');
  const seed = `${language ?? ''}\n${newline === -1 ? code : code.slice(0, newline)}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function readWrap(id: string): boolean {
  try {
    return window.sessionStorage.getItem(WRAP_STORAGE_PREFIX + id) === '1';
  } catch {
    return false;
  }
}

function writeWrap(id: string, wrap: boolean): void {
  try {
    if (wrap) window.sessionStorage.setItem(WRAP_STORAGE_PREFIX + id, '1');
    else window.sessionStorage.removeItem(WRAP_STORAGE_PREFIX + id);
  } catch {
    // Storage is a convenience; the toggle still works for this mount.
  }
}

function useHighlightedCode(code: string, language: string | undefined): ReactNode | undefined {
  const highlighter = useContext(CodeHighlighterContext);
  const deferred = useContext(DeferHighlightContext);
  const enabled = Boolean(highlighter && language && !deferred);
  const cached = enabled ? highlighter!.peek(code, language!) : undefined;
  const [resolved, setResolved] = useState<{ readonly code: string; readonly node: ReactNode }>();

  useEffect(() => {
    if (!enabled || cached !== undefined) return undefined;
    let active = true;
    void highlighter!.highlight(code, language!).then((node) => {
      if (active && node) setResolved({ code, node });
    });
    return () => { active = false; };
  }, [cached, code, enabled, highlighter, language]);

  if (!enabled) return undefined;
  return cached ?? (resolved?.code === code ? resolved.node : undefined);
}

/**
 * Plain text paints first with the same font, size and line height the
 * highlighted tokens use, so resolving the highlight never moves the layout.
 */
export const CodeBlock = memo(function CodeBlock({ code, language, labels }: CodeBlockProps): JSX.Element {
  const id = codeBlockId(code, language);
  const [wrap, setWrap] = useState(() => readWrap(id));
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const highlighted = useHighlightedCode(code, language);

  useEffect(() => {
    if (copyState === 'idle') return undefined;
    const timer = window.setTimeout(() => setCopyState('idle'), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  const copy = (): void => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard?.writeText) {
      setCopyState('failed');
      return;
    }
    clipboard.writeText(code).then(() => setCopyState('copied'), () => setCopyState('failed'));
  };

  const toggleWrap = (): void => {
    const next = !wrap;
    setWrap(next);
    writeWrap(id, next);
  };

  const copyButton = (
    <IconButton
      className={language ? 'chat-md-code__action' : 'chat-md-code__action chat-md-code__float'}
      size="sm"
      icon={copyState === 'copied' ? glyphIcon('check') : glyphIcon('copy')}
      aria-label={labels.copyCode}
      onClick={copy}
    />
  );

  return (
    <div
      className={language ? 'chat-md-code' : 'chat-md-code chat-md-code--bare'}
      data-wrap={wrap ? 'true' : 'false'}
      data-highlighted={highlighted === undefined ? undefined : 'true'}
    >
      {language ? (
        <div className="chat-md-code__header">
          <span className="chat-md-code__language">{language}</span>
          <span className="chat-md-code__actions">
            <IconButton
              className="chat-md-code__action"
              size="sm"
              icon={glyphIcon('wrap')}
              aria-label={labels.wrapLines}
              aria-pressed={wrap}
              onClick={toggleWrap}
            />
            {copyButton}
          </span>
        </div>
      ) : copyButton}
      {/* Focusable so keyboard users can scroll long lines. */}
      <pre className="chat-md-code__pre" tabIndex={0}>
        <code>{highlighted ?? code}</code>
      </pre>
      <VisuallyHidden role="status">
        {copyState === 'copied' ? labels.copied : copyState === 'failed' ? labels.copyFailed : ''}
      </VisuallyHidden>
    </div>
  );
});
