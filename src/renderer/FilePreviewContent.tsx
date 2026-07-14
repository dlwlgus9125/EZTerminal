import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { FilePreviewResult } from '../shared/file-preview';
import { normalizeExternalHttpUrl } from '../shared/external-url';

export interface FilePreviewContentProps {
  readonly result: FilePreviewResult;
  readonly openExternalHttpUrl?: (url: string) => void;
  readonly line?: number;
  readonly column?: number;
  readonly labels?: Partial<FilePreviewLabels>;
}

export interface FilePreviewLabels {
  readonly imageTooLarge: string;
  readonly imageDimensions: string;
  readonly invalidImage: string;
  readonly binaryUnsupported: string;
  readonly pdfDocument: string;
  readonly pdfDisabled: string;
  readonly imageNotLoaded: (source: string) => string;
}

const DEFAULT_LABELS: FilePreviewLabels = {
  imageTooLarge: 'Image exceeds the 20 MiB preview limit.',
  imageDimensions: 'Image dimensions exceed the safe preview limit.',
  invalidImage: 'The image header is incomplete or invalid.',
  binaryUnsupported: 'This binary file cannot be previewed safely.',
  pdfDocument: 'PDF document',
  pdfDisabled: 'Preview embedding is disabled. Use the explicit open or download action.',
  imageNotLoaded: (source) => `Image not loaded: ${source}`,
};

function unsupportedMessage(
  reason: Extract<FilePreviewResult, { kind: 'unsupported' }>['reason'],
  labels: FilePreviewLabels,
): string {
  switch (reason) {
    case 'image-too-large': return labels.imageTooLarge;
    case 'image-dimensions': return labels.imageDimensions;
    case 'invalid-image': return labels.invalidImage;
    default: return labels.binaryUnsupported;
  }
}

function ImagePreview({ result }: { result: Extract<FilePreviewResult, { kind: 'image' }> }): JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    // Structured-cloned Uint8Arrays may be backed by SharedArrayBuffer. Blob's
    // DOM typing only accepts an owned ArrayBuffer, so make that ownership
    // boundary explicit before creating the object URL.
    const ownedBytes = new Uint8Array(result.bytes.byteLength);
    ownedBytes.set(result.bytes);
    const objectUrl = URL.createObjectURL(new Blob([ownedBytes.buffer], { type: result.mime }));
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [result]);
  return (
    <div className="file-preview-image-wrap">
      {url && <img className="file-preview-image" src={url} alt={result.name} />}
      <span className="file-preview-meta">{result.width}×{result.height} · {result.mime}</span>
    </div>
  );
}

function LocatedTextPreview({ content, line, column }: { content: string; line: number; column?: number }): JSX.Element {
  const targetRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    targetRef.current?.scrollIntoView?.({ block: 'center' });
  }, [line, column]);
  const lines = content.split('\n');
  return (
    <pre className="file-viewer-content file-viewer-content--located" data-testid="viewer-content">
      {lines.map((value, index) => {
        const number = index + 1;
        const selected = number === line;
        const position = selected && column !== undefined ? Math.min(Math.max(column - 1, 0), value.length) : -1;
        return (
          <span
            // Source text can repeat; the stable line number is the identity.
            key={number}
            ref={selected ? targetRef : undefined}
            className={selected ? 'file-source-line file-source-line--selected' : 'file-source-line'}
            data-line={number}
          >
            {position >= 0 ? (
              <>{value.slice(0, position)}<mark>{value[position] ?? ' '}</mark>{value.slice(position + 1)}</>
            ) : value}
            {index < lines.length - 1 ? '\n' : ''}
          </span>
        );
      })}
    </pre>
  );
}

export function FilePreviewContent({ result, openExternalHttpUrl, line, column, labels }: FilePreviewContentProps): JSX.Element {
  const text = { ...DEFAULT_LABELS, ...labels };
  if (!result.ok) {
    return <div className="file-preview-state file-preview-state--error" role="alert">{result.error}</div>;
  }
  if (result.kind === 'unsupported') {
    return <div className="file-preview-state">{unsupportedMessage(result.reason, text)}</div>;
  }
  if (result.kind === 'pdf') {
    return (
      <div className="file-preview-state">
        <strong>{text.pdfDocument}</strong>
        <span>{text.pdfDisabled}</span>
      </div>
    );
  }
  if (result.kind === 'image') return <ImagePreview result={result} />;
  if (result.kind === 'text' && line !== undefined) {
    return <LocatedTextPreview content={result.content} line={line} column={column} />;
  }
  if (result.mime === 'text/plain') {
    return <pre className="file-viewer-content" data-testid="viewer-content">{result.content}</pre>;
  }
  return (
    <div className="file-preview-markdown" data-testid="viewer-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          img: ({ alt, src }) => (
            <span className="file-preview-blocked-image">
              {text.imageNotLoaded(alt || src || '—')}
            </span>
          ),
          a: ({ href, children }) => {
            const safe = href ? normalizeExternalHttpUrl(href) : null;
            if (!safe || !openExternalHttpUrl) return <span>{children}</span>;
            return (
              <a
                href={safe}
                title={safe}
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
        {result.content}
      </ReactMarkdown>
    </div>
  );
}
