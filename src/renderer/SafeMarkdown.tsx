import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { normalizeExternalHttpUrl } from '../shared/external-url';

export interface SafeMarkdownProps {
  readonly markdown: string;
  readonly className?: string;
  readonly openExternalHttpUrl?: (url: string) => void;
  readonly blockedImageLabel?: (label: string) => string;
  readonly testId?: string;
}

/** Shared transcript/file-preview policy: GFM text, no raw HTML or remote media. */
export function SafeMarkdown({
  blockedImageLabel = (label) => `Image not loaded: ${label}`,
  className,
  markdown,
  openExternalHttpUrl,
  testId,
}: SafeMarkdownProps): JSX.Element {
  return (
    <div className={className} data-testid={testId}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
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
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
