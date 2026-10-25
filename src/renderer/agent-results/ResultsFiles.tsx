import { ExternalLink, FileCode2, FileImage, FileText, FolderOpen, Globe, RefreshCw } from 'lucide-react';
import { Fragment, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { FilePreviewResult } from '../../shared/file-preview';
import { useChatCopy } from '../chat/copy';
import { ChatMarkdown, type ChatMarkdownLabels } from '../chat/markdown/ChatMarkdown';
import { CodeHighlighterContext } from '../chat/markdown/highlight-context';
import { workspacePath } from '../chat/model/summary';
import { FilePreviewContent } from '../FilePreviewContent';
import { Button, EmptyState, IconButton, LoadingState, Status } from '../ui';
import type { DerivedResults } from './derive-results';
import { PathLabel } from './PathLabel';
import { useResultsCopy } from './copy';
import { fileLanguage, fileViewKind, isInsideWorkspace, resolveWorkspacePath, samePath, type FileViewKind } from './results-format';
import { useResultsViewState, type ResultsFolderAccess, type ResultsServices } from './results-services';

const LIVE: ResultsFolderAccess = { kind: 'live' };

/** Above these the source shows plain, without syntax colors. */
const HIGHLIGHT_MAX_CHARS = 200_000;
const HIGHLIGHT_MAX_LINES = 5_000;

const KIND_ICON: Record<FileViewKind, typeof FileText> = { markdown: FileText, html: Globe, pdf: FileText, image: FileImage, code: FileCode2 };

interface FilesState {
  /** Paths opened from chat links or the other sections, most recent first. */
  readonly opened: readonly string[];
  readonly selected?: string;
  readonly line?: number;
  /** Rendered or source, per path. */
  readonly modes: Readonly<Record<string, 'rendered' | 'source'>>;
}

/** Numbered source, colored by the chat's highlighter when it is available and the file is small enough. */
export function CodeFileView({ content, language, line }: { readonly content: string; readonly language?: string; readonly line?: number }): JSX.Element {
  const highlighter = useContext(CodeHighlighterContext);
  // One line per file line: a final newline ends the last line rather than adding an empty one.
  const source = useMemo(() => content.replace(/\r\n/gu, '\n').replace(/\n$/u, ''), [content]);
  const lines = useMemo(() => source.split('\n'), [source]);
  const eligible = Boolean(highlighter && language && source.length <= HIGHLIGHT_MAX_CHARS && lines.length <= HIGHLIGHT_MAX_LINES);
  const [highlighted, setHighlighted] = useState<{ readonly source: string; readonly node: ReactNode }>();
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!eligible) return undefined;
    let alive = true;
    const cached = highlighter!.peek(source, language!);
    if (cached) { setHighlighted({ source, node: cached }); return undefined; }
    void highlighter!.highlight(source, language!).then((node) => { if (alive && node) setHighlighted({ source, node }); });
    return () => { alive = false; };
  }, [source, eligible, highlighter, language]);
  const node = highlighted?.source === source ? highlighted.node : undefined;
  useEffect(() => {
    if (!line) return;
    const target = ref.current?.querySelectorAll('.line')[line - 1];
    target?.setAttribute('data-target', 'true');
    target?.scrollIntoView?.({ block: 'center' });
  }, [line, node]);
  return (
    <pre ref={ref} className="results-code" tabIndex={0} data-highlighted={node ? 'true' : undefined}>
      <code>
        {node ?? lines.map((text, index) => (
          <span key={index}><span className="line">{text}</span>{index < lines.length - 1 ? '\n' : ''}</span>
        ))}
      </code>
    </pre>
  );
}

function isMissing(result: FilePreviewResult): boolean {
  return !result.ok && /ENOENT|not found|no such file|does not exist/iu.test(result.error);
}

export function ResultsFiles({ sessionId, workspaceRoot, derived, services, target, onOpenProjectFiles, onViewChanges, renderHtml, renderPdf, folder = LIVE, onRefreshFolder }: {
  readonly sessionId: string;
  readonly workspaceRoot?: string;
  readonly derived: DerivedResults;
  readonly services: ResultsServices;
  readonly target?: { readonly sequence: number; readonly path?: string; readonly line?: number };
  readonly onOpenProjectFiles?: () => void;
  readonly onViewChanges?: (path: string) => void;
  /** Isolated HTML preview; without it HTML shows as source. */
  readonly renderHtml?: (path: string) => ReactNode;
  readonly renderPdf?: (path: string) => ReactNode;
  /** What may be read of the work folder (작업 폴더 정리): a cleaned-up one's files come from the run's kept result, never the old path. */
  readonly folder?: ResultsFolderAccess;
  /** Asks the host again about the folder (Refresh). */
  readonly onRefreshFolder?: () => void;
}): JSX.Element {
  const copy = useResultsCopy();
  const chatCopy = useChatCopy();
  const [view, setView] = useResultsViewState<FilesState>(`agent-results:files:${sessionId}`, { opened: [], modes: {} });
  const handled = useRef(0);
  useEffect(() => {
    if (!target?.path || target.sequence === handled.current) return;
    handled.current = target.sequence;
    const path = target.path;
    setView((current) => ({
      ...current,
      opened: [path, ...current.opened.filter((entry) => !samePath(entry, path))].slice(0, 50),
      selected: path,
      ...(target.line ? { line: target.line } : { line: undefined }),
    }));
  }, [setView, target]);

  const files = useMemo(() => {
    const list: { path: string; kind?: 'add' | 'update'; opened: boolean }[] = [];
    for (const path of view.opened) list.push({ path, opened: true });
    for (const file of derived.files) {
      if (file.kind === 'delete') continue;
      const existing = list.find((entry) => samePath(entry.path, file.path));
      if (existing) existing.kind = file.kind === 'add' ? 'add' : 'update';
      else list.push({ path: file.path, kind: file.kind === 'add' ? 'add' : 'update', opened: false });
    }
    return list;
  }, [derived.files, view.opened]);
  const selected = files.find((entry) => view.selected && samePath(entry.path, view.selected)) ?? files[0];
  const absolute = selected ? resolveWorkspacePath(selected.path, workspaceRoot) : undefined;
  const kind = selected ? fileViewKind(selected.path) : 'code';
  const mode = selected ? view.modes[selected.path] ?? 'rendered' : 'rendered';

  const cleaned = folder.kind === 'cleaned' ? folder : undefined;
  // Nothing is read while the host is asked about the folder or could not tell.
  const blocked = folder.kind === 'checking' || folder.kind === 'error';
  const inCleaned = Boolean(cleaned && absolute && isInsideWorkspace(absolute, cleaned.root));
  const read = blocked ? undefined : inCleaned ? (cleaned?.result ? services.readCleanedFile : undefined) : services.readFilePreview;
  // HTML and PDF show in their own isolated views when the host offers them (those read the file's path, so not for a cleaned folder).
  const isolated = Boolean((kind === 'html' && renderHtml && mode === 'rendered') || (kind === 'pdf' && renderPdf));
  const pathOpen = !blocked && !inCleaned;
  const [result, setResult] = useState<{ readonly path: string; readonly value?: FilePreviewResult; readonly loading: boolean }>();
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!absolute || !read || isolated) return undefined;
    let alive = true;
    setResult({ path: absolute, loading: true });
    void read(absolute)
      .then((value) => { if (alive) setResult({ path: absolute, value, loading: false }); })
      .catch((error: unknown) => { if (alive) setResult({ path: absolute, value: { ok: false, error: error instanceof Error ? error.message : String(error) }, loading: false }); });
    return () => { alive = false; };
  }, [absolute, isolated, read, reload]);

  const labels = useMemo<Partial<ChatMarkdownLabels>>(() => ({
    copyCode: chatCopy.copyCode, copied: chatCopy.copied, copyFailed: chatCopy.copyFailed,
    wrapLines: chatCopy.wrapLines, task: chatCopy.task, blockedImage: chatCopy.blockedImage,
  }), [chatCopy]);

  if (!files.length || !selected) {
    return (
      <div className="results-files" data-testid="results-files">
        <EmptyState title={copy.noFiles} description={copy.noFilesHint} />
        {onOpenProjectFiles && <Button variant="ghost" size="sm" leadingIcon={<FolderOpen />} onClick={onOpenProjectFiles}>{copy.openProjectFiles}</Button>}
      </div>
    );
  }

  const current = result && result.path === absolute ? result : undefined;
  const value = current?.value;
  const loading = current ? current.loading : Boolean(absolute && read);
  const display = (path: string): string => workspacePath(path, workspaceRoot);
  const setMode = (next: 'rendered' | 'source'): void => setView((current) => ({ ...current, modes: { ...current.modes, [selected.path]: next } }));
  const hasChanges = derived.files.some((file) => samePath(file.path, selected.path));
  const toggleable = kind === 'markdown' || (kind === 'html' && Boolean(renderHtml));

  let body: ReactNode;
  if (!absolute) body = <Status variant="neutral">{copy.fileUnavailable}</Status>;
  else if (folder.kind === 'checking') body = <LoadingState label={copy.folderChecking} />;
  else if (folder.kind === 'error') body = <div className="results-preview"><Status variant="warning">{copy.folderCheckFailed}</Status> <Button variant="ghost" size="sm" onClick={folder.retry}>{copy.folderCheckAgain}</Button></div>;
  else if (isolated && inCleaned) body = <Status variant="neutral">{copy.cleanedNoPreview}</Status>;
  else if (inCleaned && !cleaned?.result) body = <Status variant="neutral">{copy.cleanedNoResult}</Status>;
  // Refresh asks main for a new preview of the file as it is now.
  else if (kind === 'html' && renderHtml && mode === 'rendered') body = <Fragment key={`html:${String(reload)}`}>{renderHtml(absolute)}</Fragment>;
  else if (kind === 'pdf' && renderPdf) body = <Fragment key={`pdf:${String(reload)}`}>{renderPdf(absolute)}</Fragment>;
  else if (loading && !value) body = <LoadingState label={copy.fileLoading} />;
  else if (!value) body = <Status variant="neutral">{copy.fileUnavailable}</Status>;
  else if (isMissing(value)) body = <Status variant="warning">{inCleaned ? copy.cleanedFileGone : copy.fileGone}</Status>;
  else if (!value.ok || value.kind !== 'text') body = <div className="results-preview"><FilePreviewContent result={value} {...(services.openExternalHttpUrl ? { openExternalHttpUrl: services.openExternalHttpUrl } : {})} /></div>;
  else if (kind === 'markdown' && mode === 'rendered') {
    body = <div className="results-markdown"><ChatMarkdown markdown={value.content} variant="prose" labels={labels} {...(services.openExternalHttpUrl ? { onOpenLink: services.openExternalHttpUrl } : {})} /></div>;
  } else {
    body = (
      <>
        {kind === 'html' && !renderHtml && <p className="results-note">{copy.htmlPending}</p>}
        <CodeFileView content={value.content} language={fileLanguage(selected.path)} {...(view.line ? { line: view.line } : {})} />
      </>
    );
  }

  return (
    <div className="results-files" data-testid="results-files">
      <ul className="results-file-list" aria-label={copy.openedFiles}>
        {files.map((entry) => {
          const Icon = KIND_ICON[fileViewKind(entry.path)];
          return (
            <li key={entry.path}>
              <button type="button" className="results-file" aria-pressed={entry === selected}
                onClick={() => setView((current) => ({ ...current, selected: entry.path, line: undefined }))}>
                <Icon className="results-file__icon" aria-hidden="true" />
                <PathLabel path={display(entry.path)} />
                {entry.kind && <span className="results-file__kind">{entry.kind === 'add' ? copy.created : copy.modified}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      <section className="results-viewer" aria-label={display(selected.path)}>
        <header className="results-diff__header">
          <PathLabel path={display(selected.path)} className="results-diff__path" />
          <span className="results-diff__actions">
            {toggleable && (
              <span className="results-segmented" role="group" aria-label={`${copy.rendered} / ${copy.source}`}>
                <button type="button" aria-pressed={mode === 'rendered'} onClick={() => setMode('rendered')}>{copy.rendered}</button>
                <button type="button" aria-pressed={mode === 'source'} onClick={() => setMode('source')}>{copy.source}</button>
              </span>
            )}
            {hasChanges && onViewChanges && <Button variant="ghost" size="sm" onClick={() => onViewChanges(selected.path)}>{copy.viewChanges}</Button>}
            <IconButton size="sm" icon={RefreshCw} aria-label={copy.refresh} onClick={() => { onRefreshFolder?.(); setReload((value) => value + 1); }} />
            {absolute && services.openFileInApp && pathOpen && (kind === 'html'
              // Interactive pages run in the person's browser, by their own click (the preview is static).
              ? <Button variant="ghost" size="sm" leadingIcon={<ExternalLink />} onClick={() => void services.openFileInApp!(absolute)} data-testid="results-open-browser">{copy.openInBrowser}</Button>
              : <IconButton size="sm" icon={ExternalLink} aria-label={copy.openInApp} onClick={() => void services.openFileInApp!(absolute)} />)}
            {onOpenProjectFiles && <IconButton size="sm" icon={FolderOpen} aria-label={copy.openProjectFiles} onClick={onOpenProjectFiles} />}
          </span>
        </header>
        {inCleaned && cleaned?.result && <p className="results-note" data-testid="results-files-cleaned">{copy.cleanedFromResult}</p>}
        {body}
      </section>
    </div>
  );
}
