import {
  ArrowDown,
  ArrowUp,
  FileSearch,
  Hash,
  RefreshCw,
  ShieldAlert,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type * as Monaco from 'monaco-editor';

import type {
  ProjectDocumentLens,
  ProjectDocumentSnapshot,
  ProjectRecordedChangeSection,
} from '../shared/project-workspace';
import { useAppTranslation } from './i18n';
import type { ProjectEditorDocument } from './project-editor-model';
import {
  flushProjectCodeFocus,
  flushProjectCodeReveal,
  subscribeProjectCodeFocus,
  subscribeProjectCodeReveal,
  type ProjectCodeLocation,
} from './project-code-navigation';

interface SelectedLines {
  readonly start: number;
  readonly end: number;
}

function isLens(value: unknown): value is ProjectDocumentLens {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const lens = value as Partial<ProjectDocumentLens>;
  if (lens.kind === 'current') return true;
  return lens.kind === 'agent-turn'
    && typeof lens.historyId === 'string'
    && lens.historyId.length > 0
    && typeof lens.turnId === 'string'
    && lens.turnId.length > 0;
}

function isDocument(value: unknown): value is ProjectEditorDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<ProjectEditorDocument>;
  return typeof candidate.projectId === 'string'
    && candidate.projectId.length > 0
    && typeof candidate.rootId === 'string'
    && candidate.rootId.length > 0
    && typeof candidate.workspaceId === 'string'
    && candidate.workspaceId.length > 0
    && typeof candidate.relativePath === 'string'
    && candidate.relativePath.length > 0
    && (candidate.documentKey === undefined || typeof candidate.documentKey === 'string')
    && (candidate.lens === undefined || isLens(candidate.lens));
}

function editorTheme(): 'vs' | 'vs-dark' | 'hc-black' {
  const theme = document.documentElement.dataset.theme;
  if (theme === 'light') return 'vs';
  if (theme === 'high-contrast') return 'hc-black';
  return 'vs-dark';
}

function recordedLinePrefix(kind: 'meta' | 'context' | 'added' | 'removed'): string {
  if (kind === 'added') return '+';
  if (kind === 'removed') return '-';
  return kind === 'context' ? ' ' : '·';
}

function recordedSectionNode(
  section: ProjectRecordedChangeSection,
  labels: { readonly anchored: string; readonly unplaced: string },
): HTMLElement {
  const container = document.createElement('section');
  container.className = 'project-editor__recorded-zone';
  container.dataset.placement = section.anchorLine === undefined ? 'unplaced' : 'anchored';
  container.setAttribute('aria-hidden', 'true');
  const header = document.createElement('div');
  header.className = 'project-editor__recorded-zone-header';
  header.textContent = section.anchorLine === undefined ? labels.unplaced : labels.anchored;
  container.append(header);
  const lines = document.createElement('pre');
  lines.className = 'project-editor__recorded-lines';
  for (const line of section.lines) {
    const row = document.createElement('span');
    row.dataset.kind = line.kind;
    const prefix = document.createElement('b');
    prefix.textContent = recordedLinePrefix(line.kind);
    const text = document.createElement('span');
    text.textContent = line.text || ' ';
    row.append(prefix, text);
    lines.append(row);
  }
  container.append(lines);
  return container;
}

function RecordedSections({
  sections,
  recorded,
  anchored,
  unplaced,
  hidden = false,
}: {
  readonly sections: readonly ProjectRecordedChangeSection[];
  readonly recorded: string;
  readonly anchored: string;
  readonly unplaced: string;
  readonly hidden?: boolean;
}): JSX.Element {
  return (
    <div className={hidden ? 'project-editor__recorded-accessibility' : 'project-editor__record-only'}>
      {sections.map((section, sectionIndex) => (
        <section
          className={hidden ? undefined : 'project-editor__recorded-zone'}
          data-placement={section.anchorLine === undefined ? 'unplaced' : 'anchored'}
          aria-label={`${recorded} ${String(sectionIndex + 1)}`}
          key={`${section.anchorLine ?? 'unplaced'}:${String(sectionIndex)}`}
          role="region"
          tabIndex={hidden ? undefined : 0}
        >
          <h3 className={hidden ? undefined : 'project-editor__recorded-zone-header'}>
            {section.anchorLine === undefined ? unplaced : anchored}
          </h3>
          <pre className={hidden ? undefined : 'project-editor__recorded-lines'}>
            {section.lines.map((line, lineIndex) => (
              <span data-kind={line.kind} key={`${line.kind}:${String(lineIndex)}`}>
                <b aria-hidden="true">{recordedLinePrefix(line.kind)}</b>
                <span>{line.text || ' '}</span>
              </span>
            ))}
          </pre>
        </section>
      ))}
    </div>
  );
}

export function ProjectEditorPanel(props: IDockviewPanelProps): JSX.Element {
  const { t } = useAppTranslation();
  const [document, setDocument] = useState<ProjectEditorDocument | null>(() => (
    isDocument(props.params) ? props.params : null
  ));
  const [snapshot, setSnapshot] = useState<ProjectDocumentSnapshot | null>(null);
  const [selection, setSelection] = useState<SelectedLines>({ start: 1, end: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(document ? null : 'invalid-request');
  const [notice, setNotice] = useState<string | null>(null);
  const snapshotRef = useRef<ProjectDocumentSnapshot | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const diffRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null);
  const modelsRef = useRef<readonly Monaco.editor.ITextModel[]>([]);
  const generation = useRef(0);

  useEffect(() => {
    const disposable = props.api.onDidParametersChange((params) => {
      if (isDocument(params)) setDocument(params);
      else setError('invalid-request');
    });
    return () => disposable.dispose();
  }, [props.api]);

  const load = useCallback(async (): Promise<void> => {
    const desktop = window.ezterminalDesktop;
    if (!desktop || !document) {
      setLoading(false);
      setError('invalid-request');
      return;
    }
    const currentGeneration = ++generation.current;
    setLoading(true);
    setError(null);
    setNotice(null);
    props.api.setTitle(document.relativePath.split('/').pop() ?? document.relativePath);
    const result = await desktop.readProjectDocument({
      document: {
        projectId: document.projectId,
        rootId: document.rootId,
        workspaceId: document.workspaceId,
        relativePath: document.relativePath,
      },
      lens: document.lens ?? { kind: 'current' },
    }).catch(() => null);
    if (currentGeneration !== generation.current) return;
    if (!result?.ok) {
      const nextError = result?.error ?? 'io-error';
      if (snapshotRef.current) {
        setNotice(t('projectWorkbench.fileUnavailable', { error: nextError }));
      } else {
        setError(nextError);
      }
      setLoading(false);
      return;
    }
    snapshotRef.current = result.snapshot;
    setSnapshot(result.snapshot);
    const nextNotice = result.snapshot.comparisonError
      ? t('projectWorkbench.comparisonUnavailable', { error: result.snapshot.comparisonError })
      : result.snapshot.coverageNotice ?? result.snapshot.comparison?.coverageNotice ?? null;
    setNotice(nextNotice);
    setLoading(false);

    if (document.documentKey !== result.snapshot.document.key
      || document.projectId !== result.snapshot.document.id.projectId
      || document.rootId !== result.snapshot.document.id.rootId
      || document.workspaceId !== result.snapshot.document.id.workspaceId
      || document.relativePath !== result.snapshot.document.id.relativePath) {
      props.api.updateParameters({
        ...result.snapshot.document.id,
        documentKey: result.snapshot.document.key,
        lens: result.snapshot.lens,
      });
    }
  }, [document, props.api, t]);

  useEffect(() => {
    void load();
    return () => { generation.current += 1; };
  }, [load]);

  useEffect(() => {
    if (!document) return undefined;
    return subscribeProjectCodeReveal(document, (location: ProjectCodeLocation) => {
      const editor = editorRef.current ?? diffRef.current?.getModifiedEditor();
      const model = editor?.getModel();
      if (!editor || !model) return false;
      const lineNumber = Math.min(location.line, model.getLineCount());
      const column = Math.min(location.column ?? 1, model.getLineMaxColumn(lineNumber));
      editor.setPosition({ lineNumber, column });
      editor.revealPositionInCenter({ lineNumber, column });
      return true;
    });
  }, [document]);

  useEffect(() => {
    if (!document) return undefined;
    return subscribeProjectCodeFocus(document, () => {
      const editor = editorRef.current ?? diffRef.current?.getModifiedEditor();
      if (editor) {
        editor.focus();
        return Boolean(panelRef.current?.contains(globalThis.document.activeElement));
      }
      panelRef.current?.focus({ preventScroll: true });
      return false;
    });
  }, [document]);

  const review = snapshot?.comparison?.view ?? null;
  useEffect(() => {
    const host = hostRef.current;
    const current = snapshot?.current ?? null;
    if (!host || (!current && !review) || review?.kind === 'record-only') return undefined;
    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;
    let themeObserver: MutationObserver | undefined;
    let cursorDisposable: { dispose(): void } | undefined;
    void import('./monaco-runtime').then(({ monaco }) => {
      if (disposed || !hostRef.current || !document) return;
      const unique = `panel=${encodeURIComponent(props.api.id)}&generation=${String(generation.current)}`;
      let layout: () => void;
      const trackSelection = (editor: Monaco.editor.ICodeEditor): void => {
        cursorDisposable = editor.onDidChangeCursorSelection((event) => setSelection({
          start: Math.min(event.selection.startLineNumber, event.selection.endLineNumber),
          end: Math.max(event.selection.startLineNumber, event.selection.endLineNumber),
        }));
      };

      if (review?.kind === 'full-diff' && snapshot?.comparison) {
        const language = snapshot.comparison.language;
        const original = monaco.editor.createModel(
          review.original,
          language,
          monaco.Uri.from({
            scheme: 'ezdiff-before',
            authority: 'review',
            path: `/${snapshot.comparison.originalPath}`,
            query: unique,
          }),
        );
        const modified = monaco.editor.createModel(
          review.modified,
          language,
          monaco.Uri.from({
            scheme: 'ezproject',
            authority: document.projectId,
            path: `/${document.rootId}/${document.workspaceId}/${document.relativePath}`,
            query: unique,
          }),
        );
        modelsRef.current = [original, modified];
        const editor = monaco.editor.createDiffEditor(hostRef.current, {
          readOnly: true,
          originalEditable: false,
          theme: editorTheme(),
          automaticLayout: false,
          renderSideBySide: false,
          hideUnchangedRegions: { enabled: false },
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fixedOverflowWidgets: true,
          accessibilitySupport: 'auto',
          ariaLabel: t('projectWorkbench.readOnlyDiffAria', { path: document.relativePath }),
          originalAriaLabel: t('projectWorkbench.readOnlyOriginalAria', { path: document.relativePath }),
          modifiedAriaLabel: t('projectWorkbench.readOnlyCurrentAria', { path: document.relativePath }),
        });
        editor.setModel({ original, modified });
        editor.getOriginalEditor().updateOptions({
          ariaLabel: t('projectWorkbench.readOnlyOriginalAria', { path: document.relativePath }),
        });
        editor.getModifiedEditor().updateOptions({
          ariaLabel: t('projectWorkbench.readOnlyCurrentAria', { path: document.relativePath }),
        });
        diffRef.current = editor;
        trackSelection(editor.getModifiedEditor());
        layout = () => editor.layout();
      } else {
        const content = review?.kind === 'current-with-record' ? review.current : current?.content;
        const language = current?.language ?? snapshot?.comparison?.language;
        if (content === undefined || !language) return;
        const model = monaco.editor.createModel(
          content,
          language,
          monaco.Uri.from({
            scheme: 'ezproject',
            authority: document.projectId,
            path: `/${document.rootId}/${document.workspaceId}/${document.relativePath}`,
            query: unique,
          }),
        );
        modelsRef.current = [model];
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
          fixedOverflowWidgets: true,
          accessibilitySupport: 'auto',
          ariaLabel: review?.kind === 'current-with-record'
            ? t('projectWorkbench.readOnlyRecordedAria', { path: document.relativePath })
            : t('projectWorkbench.readOnlyCodeAria', { path: document.relativePath }),
        });
        editorRef.current = editor;
        trackSelection(editor);
        if (review?.kind === 'current-with-record') {
          const labels = {
            anchored: t('projectWorkbench.recordedChangeAnchored'),
            unplaced: t('projectWorkbench.recordedChangeUnplaced'),
          };
          editor.changeViewZones((accessor) => {
            for (const section of review.sections) {
              accessor.addZone({
                afterLineNumber: section.anchorLine === undefined ? 0 : Math.max(0, section.anchorLine - 1),
                heightInPx: Math.min(260, 34 + Math.max(1, section.lines.length) * 19),
                domNode: recordedSectionNode(section, labels),
                suppressMouseDown: false,
              });
            }
          });
        }
        layout = () => editor.layout();
      }
      resizeObserver = new ResizeObserver(layout);
      resizeObserver.observe(hostRef.current);
      themeObserver = new MutationObserver(() => monaco.editor.setTheme(editorTheme()));
      themeObserver.observe(globalThis.document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
      });
      layout();
      flushProjectCodeFocus(document);
      flushProjectCodeReveal(document);
    }).catch(() => {
      if (!disposed) setError('editor-load-failed');
    });
    return () => {
      disposed = true;
      cursorDisposable?.dispose();
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      editorRef.current?.dispose();
      diffRef.current?.dispose();
      for (const model of modelsRef.current) model.dispose();
      editorRef.current = null;
      diffRef.current = null;
      modelsRef.current = [];
      host.replaceChildren();
    };
  }, [document, props.api, review, snapshot, t]);

  const relativePath = document?.relativePath ?? '';
  const breadcrumbs = relativePath ? relativePath.split('/') : [];
  const recordedLabels = useMemo(() => ({
    recorded: t('projectWorkbench.recordedChange'),
    anchored: t('projectWorkbench.recordedChangeAnchored'),
    unplaced: t('projectWorkbench.recordedChangeUnplaced'),
  }), [t]);
  const currentWithRecord = review?.kind === 'current-with-record' ? review : null;
  const recordOnly = review?.kind === 'record-only' ? review : null;
  const hasText = Boolean(snapshot?.current || review);
  const agentLens = snapshot?.lens.kind === 'agent-turn' ? snapshot.lens : null;

  return (
    <section
      ref={panelRef}
      className="project-editor"
      tabIndex={-1}
      data-testid="project-editor-panel"
      data-path={document?.relativePath}
      data-document-key={snapshot?.document.key ?? document?.documentKey}
      data-comparison={snapshot?.lens.kind ?? document?.lens?.kind ?? 'current'}
      data-document-state={snapshot?.state}
    >
      <header className="project-editor__toolbar">
        <nav aria-label={t('projectWorkbench.fileBreadcrumb')} className="project-editor__breadcrumb">
          {breadcrumbs.map((segment, index) => (
            <span key={`${segment}:${String(index)}`}>
              {index > 0 && <span aria-hidden="true">/</span>}{segment}
            </span>
          ))}
        </nav>
        {agentLens && document && (
          <button
            type="button"
            className="project-editor__source project-editor__source--dismissible"
            aria-label={`${t('projectWorkbench.agentTurn')}: ${t('common.close')}`}
            onClick={() => props.api.updateParameters({ ...document, lens: { kind: 'current' } })}
          >
            {t('projectWorkbench.agentTurn')}
            <X aria-hidden="true" size={13} />
          </button>
        )}
        {snapshot?.comparison?.repositoryName && (
          <span className="project-editor__repository" title={snapshot.comparison.title}>
            {snapshot.comparison.repositoryName}
          </span>
        )}
        <span className="project-editor__readonly">{t('projectWorkbench.readOnly')}</span>
        {snapshot?.current?.sensitive && (
          <ShieldAlert aria-label={t('projectWorkbench.sensitiveFile')} size={16} />
        )}
        <div className="project-editor__actions">
          <button
            type="button"
            onClick={() => (editorRef.current ?? diffRef.current?.getModifiedEditor())
              ?.getAction('actions.find')?.run()}
            disabled={!hasText}
          >
            <FileSearch aria-hidden="true" size={15} /> {t('projectWorkbench.find')}
          </button>
          <button
            type="button"
            onClick={() => (editorRef.current ?? diffRef.current?.getModifiedEditor())
              ?.getAction('editor.action.gotoLine')?.run()}
            disabled={!hasText}
          >
            <Hash aria-hidden="true" size={15} /> {t('projectWorkbench.goToLine')}
          </button>
          {review?.kind === 'full-diff' && (
            <>
              <button
                type="button"
                aria-label={t('projectWorkbench.previousHunk')}
                onClick={() => diffRef.current?.goToDiff('previous')}
              >
                <ArrowUp aria-hidden="true" size={15} />
              </button>
              <button
                type="button"
                aria-label={t('projectWorkbench.nextHunk')}
                onClick={() => diffRef.current?.goToDiff('next')}
              >
                <ArrowDown aria-hidden="true" size={15} />
              </button>
            </>
          )}
          <button type="button" onClick={() => void load()} disabled={loading}>
            <RefreshCw aria-hidden="true" size={15} /> {t('projectWorkbench.refresh')}
          </button>
        </div>
      </header>
      <div className="project-editor__status" role="status" aria-live="polite">
        {loading
          ? t('projectWorkbench.loadingFile')
          : error
            ? t('projectWorkbench.fileUnavailable', { error })
            : review?.kind === 'current-with-record'
              ? t('projectWorkbench.currentWithRecord')
              : review?.kind === 'record-only'
                ? t('projectWorkbench.recordOnly')
                : review?.kind === 'full-diff' && review.coverage === 'current-context'
                  ? t('projectWorkbench.currentContext')
                  : review?.kind === 'full-diff'
                    ? t('projectWorkbench.inline')
                    : selection.start === selection.end
                      ? t('projectWorkbench.line', { start: selection.start })
                      : t('projectWorkbench.lines', { start: selection.start, end: selection.end })}
        {notice ? ` · ${notice}` : ''}
      </div>
      <div className="project-editor__body">
        {error
          ? <div className="project-editor__empty" role="alert">{t('projectWorkbench.fileUnavailable', { error })}</div>
          : recordOnly
            ? <RecordedSections sections={recordOnly.sections} {...recordedLabels} />
            : (
              <>
                <div ref={hostRef} className="project-editor__monaco" aria-busy={loading} />
                {currentWithRecord && (
                  <RecordedSections sections={currentWithRecord.sections} {...recordedLabels} hidden />
                )}
              </>
            )}
      </div>
    </section>
  );
}
