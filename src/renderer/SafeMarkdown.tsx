import { memo, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { normalizeExternalHttpUrl } from '../shared/external-url';

export interface SafeMarkdownProps {
  readonly markdown: string;
  readonly className?: string;
  readonly openExternalHttpUrl?: (url: string) => void;
  readonly blockedImageLabel?: (label: string) => string;
  readonly testId?: string;
}

const REMARK_PLUGINS = [remarkGfm];
const defaultBlockedImageLabel = (label: string): string => `Image not loaded: ${label}`;

/** Shared transcript/file-preview policy: GFM text, no raw HTML or remote media. */
export const SafeMarkdown = memo(function SafeMarkdown({
  blockedImageLabel = defaultBlockedImageLabel,
  className,
  markdown,
  openExternalHttpUrl,
  testId,
}: SafeMarkdownProps): JSX.Element {
  const components = useMemo<Components>(() => ({
    img: ({ alt, src }) => (
      <span className="safe-markdown__blocked-image">
        {blockedImageLabel(alt || src || '—')}
      </span>
    ),
    a: ({ href, children }) => {
      const safe = href ? normalizeExternalHttpUrl(href) : null;
      if (!safe || !openExternalHttpUrl) return <span>{children}</span>;
      return (
        <a
          href={safe}
          title={safe}
          rel="noreferrer"
          onClick={(event) => {
            event.preventDefault();
            openExternalHttpUrl(safe);
          }}
        >
          {children}
        </a>
      );
    },
  }), [blockedImageLabel, openExternalHttpUrl]);

  return (
    <div className={className} data-testid={testId}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} skipHtml components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
});
