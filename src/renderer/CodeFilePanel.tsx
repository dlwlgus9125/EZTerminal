import { FileSearch, MessageSquarePlus, RefreshCw, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type * as Monaco from 'monaco-editor';

import {
  PROJECT_REFERENCE_MAX_LINES,
  PROJECT_REFERENCE_MAX_SNIPPET_BYTES,
  type ProjectTextSnapshot,
} from '../shared/project-workspace';
import { addProjectQuestionReference } from './ProjectQuestionComposer';
import { useAppTranslation } from './i18n';
import { subscribeProjectCodeReveal, type ProjectCodeLocation } from './project-code-navigation';

interface CodeFilePanelParams {
  readonly projectId: string;
  readonly rootId: string;
  readonly relativePath: string;
}

interface SelectedLines {
  readonly start: number;
  readonly end: number;
}

function paramsFrom(props: IDockviewPanelProps): CodeFilePanelParams | null {
  const params = props.params as Partial<CodeFilePanelParams> | undefined;
  return typeof params?.projectId === 'string'
    && typeof params.rootId === 'string'
    && typeof params.relativePath === 'string'
    && params.relativePath.length > 0
    ? params as CodeFilePanelParams
    : null;
}

function editorTheme(): 'vs' | 'vs-dark' | 'hc-black' {
  const theme = document.documentElement.dataset.theme;
  if (theme === 'light') return 'vs';
  if (theme === 'high-contrast') return 'hc-black';
  return 'vs-dark';
}

function boundedSnippet(content: string, selection: SelectedLines): { text: string; end: number } {
  const lines = content.split(/\r\n|\r|\n/u);
  const end = Math.min(selection.end, selection.start + PROJECT_REFERENCE_MAX_LINES - 1);
  const selected = lines.slice(selection.start - 1, end);
  while (selected.length > 0
    && new TextEncoder().encode(selected.join('\n')).length > PROJECT_REFERENCE_MAX_SNIPPET_BYTES) {
    selected.pop();
  }
  if (selected.length === 0 && lines[selection.start - 1] !== undefined) {
    let text = '';
    let bytes = 0;
    const encoder = new TextEncoder();
    for (const character of lines[selection.start - 1]!) {
      const characterBytes = encoder.encode(character).length;
      if (bytes + characterBytes > PROJECT_REFERENCE_MAX_SNIPPET_BYTES) break;
      text += character;
      bytes += characterBytes;
    }
    selected.push(text);
  }
  return { text: selected.join('\n'), end: selection.start + Math.max(0, selected.length - 1) };
}

export function CodeFilePanel(props: IDockviewPanelProps): JSX.Element {
  const { t } = useAppTranslation();
  const params = paramsFrom(props);
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<Monaco.editor.ITextModel | null>(null);
  const [file, setFile] = useState<ProjectTextSnapshot | null>(null);
  const [selection, setSelection] = useState<SelectedLines>({ start: 1, end: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(params ? null : 'Invalid code panel descriptor.');
  const [referenceNotice, setReferenceNotice] = useState<string | null>(null);
  const loadGeneration = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    if (!params || !window.ezterminalDesktop) return;
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError(null);
    const result = await window.ezterminalDesktop.readProjectText(params).catch(() => null);
    if (generation !== loadGeneration.current) return;
    setLoading(false);
    if (!result?.ok) {
      setFile(null);
      setError(result?.error ?? 'io-error');
      return;
    }
    setFile(result.file);
    setSelection({ start: 1, end: 1 });
    setReferenceNotice(null);
    props.api.setTitle(result.file.relativePath.split('/').pop() ?? result.file.relativePath);
  }, [params, props.api]);

  useEffect(() => {
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !file || !params) return undefined;
    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;
    let themeObserver: MutationObserver | undefined;
    let unsubscribeReveal: (() => void) | undefined;
    void import('./monaco-runtime').then(({ monaco }) => {
      if (disposed || !hostRef.current) return;
      const uri = monaco.Uri.from({
        scheme: 'ezproject',
        authority: params.projectId,
        path: `/${params.rootId}/${file.relativePath}`,
        query: `panel=${encodeURIComponent(props.api.id)}`,
      });
      const model = monaco.editor.createModel(file.content, file.language, uri);
      modelRef.current = model;
      const editor = monaco.editor.create(hostRef.current, {
        model,
        readOnly: true,
        domReadOnly: true,
        theme: editorTheme(),
        automaticLayout: false,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        lineNumbersMinChars: 3,
        renderWhitespace: 'selection',
        renderControlCharacters: true,
        selectionClipboard: false,
        fixedOverflowWidgets: true,
        accessibilitySupport: 'auto',
        ariaLabel: `Read-only code: ${file.relativePath}`,
      });
      editorRef.current = editor;
      const reveal = (location: ProjectCodeLocation): void => {
        const lineNumber = Math.min(location.line, model.getLineCount());
        const column = Math.min(location.column ?? 1, model.getLineMaxColumn(lineNumber));
        editor.setPosition({ lineNumber, column });
        editor.revealPositionInCenter({ lineNumber, column });
      };
      unsubscribeReveal = subscribeProjectCodeReveal(params, reveal);
      const selectionDisposable = editor.onDidChangeCursorSelection((event) => {
        setSelection({
          start: Math.min(event.selection.startLineNumber, event.selection.endLineNumber),
          end: Math.max(event.selection.startLineNumber, event.selection.endLineNumber),
        });
      });
      resizeObserver = new ResizeObserver(() => editor.layout());
      resizeObserver.observe(hostRef.current);
      themeObserver = new MutationObserver(() => monaco.editor.setTheme(editorTheme()));
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      const panelVisibility = props.api.onDidVisibilityChange((event) => {
        if (event.isVisible) requestAnimationFrame(() => editor.layout());
      });
      const previousDispose = (): void => {
        panelVisibility.dispose();
        selectionDisposable.dispose();
      };
      host.dataset.monacoDispose = 'ready';
      (host as HTMLDivElement & { disposeEditor?: () => void }).disposeEditor = previousDispose;
    }).catch(() => {
      if (disposed) return;
      editorRef.current?.dispose();
      modelRef.current?.dispose();
      editorRef.current = null;
      modelRef.current = null;
      setError('editor-load-failed');
    });
    return () => {
      disposed = true;
      unsubscribeReveal?.();
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      (host as HTMLDivElement & { disposeEditor?: () => void }).disposeEditor?.();
      editorRef.current?.dispose();
      modelRef.current?.dispose();
      editorRef.current = null;
      modelRef.current = null;
      host.replaceChildren();
    };
  }, [file, params, props.api]);

  const addReference = (includeSnippet: boolean): void => {
    if (!file || !params) return;
    const snippet = includeSnippet ? boundedSnippet(file.content, selection) : null;
    const accepted = addProjectQuestionReference({
      ...params,
      version: file.version,
      startLine: selection.start,
      endLine: snippet?.end ?? selection.end,
      ...(snippet?.text ? { snippet: snippet.text } : {}),
      sensitive: file.sensitive,
    });
    setReferenceNotice(accepted
      ? t('projectWorkbench.referenceAdded', {
        path: file.relativePath,
        start: selection.start,
        range: selection.end === selection.start ? '' : `-L${String(snippet?.end ?? selection.end)}`,
      })
      : t('projectWorkbench.referenceLimit'));
  };

  const breadcrumbs = file?.relativePath.split('/') ?? params?.relativePath.split('/') ?? [];
  return (
    <section className="code-panel" data-testid="code-file-panel">
      <header className="code-panel__toolbar">
        <nav aria-label="File breadcrumb" className="code-panel__breadcrumb">
          {breadcrumbs.map((segment, index) => (
            <span key={`${segment}:${String(index)}`}>
              {index > 0 && <span aria-hidden="true">/</span>}{segment}
            </span>
          ))}
        </nav>
        <div className="code-panel__actions">
          {file?.sensitive && <ShieldAlert aria-label={t('projectWorkbench.sensitiveFile')} size={16} />}
          <button type="button" onClick={() => editorRef.current?.getAction('actions.find')?.run()} disabled={!file}>
            <FileSearch aria-hidden="true" size={15} /> {t('projectWorkbench.find')}
          </button>
          <button type="button" onClick={() => void load()} disabled={loading}>
            <RefreshCw aria-hidden="true" size={15} /> {t('projectWorkbench.refresh')}
          </button>
          <button type="button" onClick={() => addReference(false)} disabled={!file}>
            <MessageSquarePlus aria-hidden="true" size={15} /> {t('projectWorkbench.addLines')}
          </button>
          <button type="button" onClick={() => addReference(true)} disabled={!file}>
            {t('projectWorkbench.addSnippet')}
          </button>
        </div>
      </header>
      <div className="code-panel__status" role="status" aria-live="polite">
        {loading
          ? t('projectWorkbench.loadingFile')
          : error
            ? `Unavailable: ${error}`
            : `${selection.start === selection.end
              ? t('projectWorkbench.line', { start: selection.start })
              : t('projectWorkbench.lines', { start: selection.start, end: selection.end })} · ${t('projectWorkbench.readOnly')}`}
        {referenceNotice ? ` · ${referenceNotice}` : ''}
      </div>
      {error
        ? <div className="code-panel__empty" role="alert">{t('projectWorkbench.fileUnavailable', { error })}</div>
        : <div ref={hostRef} className="code-panel__editor" aria-busy={loading} />}
    </section>
  );
}
