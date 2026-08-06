import { RefreshCw, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type * as Monaco from 'monaco-editor';

import type {
  ProjectReviewChange,
  ProjectReviewFileResult,
  ProjectReviewIndexResult,
  ProjectReviewRequest,
  ProjectReviewScope,
  ProjectRecordedChangeSection,
} from '../shared/project-workspace';
import { useAppTranslation } from './i18n';
import { subscribeProjectDiffReveal } from './project-diff-navigation';

interface CodeDiffPanelParams extends ProjectReviewRequest {
  readonly repositoryName?: string;
}

function paramsFrom(props: IDockviewPanelProps): CodeDiffPanelParams | null {
  const params = props.params as Partial<CodeDiffPanelParams> | undefined;
  return typeof params?.projectId === 'string'
    && typeof params.rootId === 'string'
    && ['last-turn', 'working-tree', 'staged', 'branch'].includes(params.scope ?? '')
    ? params as CodeDiffPanelParams
    : null;
}

function editorTheme(): 'vs' | 'vs-dark' | 'hc-black' {
  const theme = document.documentElement.dataset.theme;
  if (theme === 'light') return 'vs';
  if (theme === 'high-contrast') return 'hc-black';
  return 'vs-dark';
}

function kindLabel(change: ProjectReviewChange): string {
  switch (change.kind) {
    case 'added': return 'A';
    case 'deleted': return 'D';
    case 'renamed': return 'R';
    default: return 'M';
  }
}

function recordedLinePrefix(kind: 'meta' | 'context' | 'added' | 'removed'): string {
  if (kind === 'added') return '+';
  if (kind === 'removed') return '−';
  return kind === 'context' ? ' ' : '·';
}

function recordedSectionNode(
  section: ProjectRecordedChangeSection,
  labels: { readonly anchored: string; readonly unplaced: string },
): HTMLElement {
  const container = document.createElement('section');
  container.className = 'diff-panel__recorded-zone';
  container.dataset.placement = section.anchorLine === undefined ? 'unplaced' : 'anchored';
  // Monaco owns view zones under an aria-hidden container. The matching
  // semantic content is rendered outside Monaco by RecordedChangeAccessibility.
  container.setAttribute('aria-hidden', 'true');
  const header = document.createElement('div');
  header.className = 'diff-panel__recorded-zone-header';
  header.textContent = section.anchorLine === undefined ? labels.unplaced : labels.anchored;
  container.append(header);
  const lines = document.createElement('pre');
  lines.className = 'diff-panel__recorded-lines';
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

function RecordedChangeAccessibility({
  sections,
  labels,
}: {
  readonly sections: readonly ProjectRecordedChangeSection[];
  readonly labels: { readonly recorded: string; readonly anchored: string; readonly unplaced: string };
}): JSX.Element {
  return (
    <div className="diff-panel__recorded-accessibility">
      {sections.map((section, sectionIndex) => (
        <section
          aria-label={`${labels.recorded} ${String(sectionIndex + 1)}`}
          key={`${section.anchorLine ?? 'unplaced'}:${String(sectionIndex)}`}
        >
          <h3>{section.anchorLine === undefined ? labels.unplaced : labels.anchored}</h3>
          <pre>
            {section.lines.map((line) => `${recordedLinePrefix(line.kind)}${line.text}\n`).join('')}
          </pre>
        </section>
      ))}
    </div>
  );
}

function RecordedChangeSections({
  sections,
  labels,
}: {
  readonly sections: readonly ProjectRecordedChangeSection[];
  readonly labels: { readonly recorded: string; readonly anchored: string; readonly unplaced: string };
}): JSX.Element {
  return (
    <div className="diff-panel__record-only" aria-label={labels.recorded}>
      {sections.map((section, sectionIndex) => (
        <section
          className="diff-panel__recorded-zone"
          data-placement={section.anchorLine === undefined ? 'unplaced' : 'anchored'}
          aria-label={`${labels.recorded} ${String(sectionIndex + 1)}`}
          key={`${section.anchorLine ?? 'unplaced'}:${String(sectionIndex)}`}
          role="region"
          tabIndex={0}
        >
          <div className="diff-panel__recorded-zone-header">
            {section.anchorLine === undefined ? labels.unplaced : labels.anchored}
          </div>
          <pre className="diff-panel__recorded-lines">
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

export function CodeDiffPanel(props: IDockviewPanelProps): JSX.Element {
  const { t } = useAppTranslation();
  const initial = paramsFrom(props);
  const [request, setRequest] = useState<CodeDiffPanelParams | null>(initial);
  const [index, setIndex] = useState<ProjectReviewIndexResult | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [file, setFile] = useState<ProjectReviewFileResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [navigationNotice, setNavigationNotice] = useState<string | null>(null);
  const [requestedPath, setRequestedPath] = useState<string | null>(null);
  const [panelWidth, setPanelWidth] = useState(props.api.width);
  const hostRef = useRef<HTMLDivElement>(null);
  const fileButtonsRef = useRef(new Map<string, HTMLButtonElement>());
  const diffRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null);
  const codeRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelsRef = useRef<readonly Monaco.editor.ITextModel[]>([]);
  const generation = useRef(0);

  const updateRequest = useCallback((patch: Partial<CodeDiffPanelParams>): void => {
    setRequest((current) => {
      if (!current) return current;
      const next = { ...current, ...patch };
      props.api.updateParameters(next);
      return next;
    });
  }, [props.api]);

  const loadIndex = useCallback(async (): Promise<void> => {
    if (!request || !window.ezterminalDesktop) return;
    const currentGeneration = ++generation.current;
    setLoading(true);
    setNotice(null);
    setNavigationNotice(null);
    const result = await window.ezterminalDesktop.getProjectReview(request).catch(() => null);
    if (currentGeneration !== generation.current) return;
    if (!result) {
      setIndex({ ok: false, error: 'io-error' });
      setLoading(false);
      return;
    }
    if (!result.ok && result.fallbackScope === 'working-tree' && request.scope === 'last-turn') {
      setNotice(result.coverageNotice ?? 'Last turn is unavailable; showing the working tree.');
      updateRequest({ scope: 'working-tree', historyId: undefined, reviewTurnId: undefined });
      return;
    }
    setIndex(result);
    setLoading(false);
    if (result.ok) {
      setNotice(result.coverageNotice ?? null);
      setSelectedPath((current) => result.changes.some((change) => change.relativePath === current)
        ? current
        : result.changes[0]?.relativePath ?? null);
      const scopeTitle = result.scope === 'last-turn'
        ? t('projectWorkbench.lastTurn')
        : result.scope === 'working-tree'
          ? t('projectWorkbench.workingTree')
          : result.scope === 'staged'
            ? t('projectWorkbench.staged')
            : t('projectWorkbench.branch');
      props.api.setTitle(request.repositoryRelativePath && result.repositoryName
        ? `${result.repositoryName} · ${scopeTitle}`
        : scopeTitle);
    } else {
      setSelectedPath(null);
      setFile(null);
    }
  }, [props.api, request, t, updateRequest]);

  useEffect(() => {
    void loadIndex();
    return () => { generation.current += 1; };
  }, [loadIndex]);

  useEffect(() => {
    const disposable = props.api.onDidDimensionsChange(({ width }) => setPanelWidth(width));
    return () => disposable.dispose();
  }, [props.api]);

  useEffect(() => {
    if (!request) return undefined;
    return subscribeProjectDiffReveal({
      projectId: request.projectId,
      rootId: request.rootId,
      ...(request.repositoryRelativePath ? { repositoryRelativePath: request.repositoryRelativePath } : {}),
      scope: request.scope,
      ...(request.historyId ? { historyId: request.historyId } : {}),
      ...(request.reviewTurnId ? { reviewTurnId: request.reviewTurnId } : {}),
    }, setRequestedPath);
  }, [request]);

  useEffect(() => {
    if (!requestedPath || !index?.ok) return;
    if (index.changes.some((change) => change.relativePath === requestedPath)) {
      setSelectedPath(requestedPath);
      setNavigationNotice(null);
    } else {
      setNavigationNotice(t('projectWorkbench.changeNotInScope', { path: requestedPath }));
    }
    setRequestedPath(null);
  }, [index, requestedPath, t]);

  useEffect(() => {
    diffRef.current?.updateOptions({ renderSideBySide: panelWidth >= 960 });
    diffRef.current?.layout();
    codeRef.current?.layout();
  }, [panelWidth]);

  useEffect(() => {
    if (!request || !index?.ok || !selectedPath || !window.ezterminalDesktop) {
      setFile(null);
      return undefined;
    }
    let alive = true;
    setFile(null);
    void window.ezterminalDesktop.getProjectReviewFile({
      ...request,
      relativePath: selectedPath,
      revision: index.revision,
    }).then((result) => {
      if (alive) setFile(result);
    }).catch(() => {
      if (alive) setFile({ ok: false, error: 'io-error' });
    });
    return () => { alive = false; };
  }, [index, request, selectedPath]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !file?.ok || file.binary || file.view.kind === 'record-only') return undefined;
    const view = file.view;
    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;
    let themeObserver: MutationObserver | undefined;
    void import('./monaco-runtime').then(({ monaco }) => {
      if (disposed || !hostRef.current) return;
      const unique = `panel=${encodeURIComponent(props.api.id)}&revision=${index?.ok ? index.revision : ''}`;
      let layout: () => void;
      if (view.kind === 'full-diff') {
        const original = monaco.editor.createModel(
          view.original,
          file.language,
          monaco.Uri.from({ scheme: 'ezdiff-before', authority: 'review', path: `/${file.originalPath}`, query: unique }),
        );
        const modified = monaco.editor.createModel(
          view.modified,
          file.language,
          monaco.Uri.from({ scheme: 'ezdiff-after', authority: 'review', path: `/${file.modifiedPath}`, query: unique }),
        );
        modelsRef.current = [original, modified];
        const editor = monaco.editor.createDiffEditor(hostRef.current, {
          readOnly: true,
          originalEditable: false,
          theme: editorTheme(),
          automaticLayout: false,
          renderSideBySide: props.api.width >= 960,
          renderSideBySideInlineBreakpoint: 960,
          hideUnchangedRegions: { enabled: false },
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fixedOverflowWidgets: true,
          accessibilitySupport: 'auto',
          ariaLabel: `Read-only diff: ${file.relativePath}`,
        });
        editor.setModel({ original, modified });
        diffRef.current = editor;
        layout = () => editor.layout();
      } else {
        const current = monaco.editor.createModel(
          view.current,
          file.language,
          monaco.Uri.from({ scheme: 'ezdiff-current', authority: 'review', path: `/${file.modifiedPath}`, query: unique }),
        );
        modelsRef.current = [current];
        const editor = monaco.editor.create(hostRef.current, {
          model: current,
          readOnly: true,
          theme: editorTheme(),
          automaticLayout: false,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fixedOverflowWidgets: true,
          accessibilitySupport: 'auto',
          ariaLabel: `Read-only file with recorded changes: ${file.relativePath}`,
        });
        const labels = {
          recorded: t('projectWorkbench.recordedChange'),
          anchored: t('projectWorkbench.recordedChangeAnchored'),
          unplaced: t('projectWorkbench.recordedChangeUnplaced'),
        };
        editor.changeViewZones((accessor) => {
          view.sections.forEach((section) => {
            const heightInPx = Math.min(260, 34 + Math.max(1, section.lines.length) * 19);
            accessor.addZone({
              afterLineNumber: section.anchorLine === undefined ? 0 : Math.max(0, section.anchorLine - 1),
              heightInPx,
              domNode: recordedSectionNode(section, labels),
              suppressMouseDown: false,
            });
          });
        });
        const firstAnchor = view.sections.find((section) => section.anchorLine !== undefined)?.anchorLine;
        editor.revealLineInCenter(firstAnchor ?? 1);
        codeRef.current = editor;
        layout = () => editor.layout();
      }
      resizeObserver = new ResizeObserver(layout);
      resizeObserver.observe(hostRef.current);
      themeObserver = new MutationObserver(() => monaco.editor.setTheme(editorTheme()));
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }).catch(() => {
      if (disposed) return;
      diffRef.current?.dispose();
      codeRef.current?.dispose();
      for (const model of modelsRef.current) model.dispose();
      diffRef.current = null;
      codeRef.current = null;
      modelsRef.current = [];
      setNotice(t('projectWorkbench.editorUnavailable'));
    });
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      diffRef.current?.dispose();
      codeRef.current?.dispose();
      for (const model of modelsRef.current) model.dispose();
      diffRef.current = null;
      codeRef.current = null;
      modelsRef.current = [];
      host.replaceChildren();
    };
  }, [file, index, props.api, t]);

  const changeScope = (scope: ProjectReviewScope): void => {
    updateRequest({ scope });
  };

  const changes = index?.ok ? index.changes : [];
  const isCurrentContext = file?.ok
    && !file.binary
    && file.view.kind === 'full-diff'
    && file.view.coverage === 'current-context';
  const isCurrentWithRecord = file?.ok
    && !file.binary
    && file.view.kind === 'current-with-record';
  const isRecordOnly = file?.ok
    && !file.binary
    && file.view.kind === 'record-only';
  const recordedLabels = {
    recorded: t('projectWorkbench.recordedChange'),
    anchored: t('projectWorkbench.recordedChangeAnchored'),
    unplaced: t('projectWorkbench.recordedChangeUnplaced'),
  };
  const viewMode = isCurrentWithRecord
    ? t('projectWorkbench.inlineRecord')
    : isRecordOnly
      ? t('projectWorkbench.recordOnly')
      : panelWidth >= 960
        ? t('projectWorkbench.sideBySide')
        : t('projectWorkbench.inline');
  return (
    <section className="diff-panel" data-testid="code-diff-panel">
      <header className="diff-panel__toolbar">
        <label>
          {t('projectWorkbench.reviewScope')}
          <select value={request?.scope ?? 'working-tree'} onChange={(event) => changeScope(event.target.value as ProjectReviewScope)}>
            <option value="last-turn" disabled={!request?.historyId}>{t('projectWorkbench.lastTurn')}</option>
            <option value="working-tree">{t('projectWorkbench.workingTree')}</option>
            <option value="staged">{t('projectWorkbench.staged')}</option>
            <option value="branch">{t('projectWorkbench.branch')}</option>
          </select>
        </label>
        {request?.scope === 'branch' && (
          <input
            aria-label={t('projectWorkbench.localBase')}
            value={request.baseRef ?? 'main'}
            onChange={(event) => updateRequest({ baseRef: event.target.value })}
          />
        )}
        <button type="button" onClick={() => void loadIndex()} disabled={loading}>
          <RefreshCw aria-hidden="true" size={15} /> {t('projectWorkbench.refresh')}
        </button>
        {index?.ok && index.repositoryName && (
          <span className="diff-panel__repository">
            {t('projectWorkbench.repositoryContext', { name: index.repositoryName })}
          </span>
        )}
        <span>{viewMode} · {t('projectWorkbench.readOnly')}</span>
        {request?.scope === 'last-turn' && request.reviewTurnId && (
          <span className="diff-panel__selected-turn-status" role="status">
            {t('projectWorkbench.selectedTurn')}
          </span>
        )}
        {isCurrentContext && (
          <span
            className="diff-panel__current-context-status"
            role="status"
            title={t('projectWorkbench.currentContextDescription')}
          >
            {t('projectWorkbench.currentContext')}
          </span>
        )}
        {isCurrentWithRecord && (
          <span
            className="diff-panel__current-record-status"
            role="status"
            title={t('projectWorkbench.currentWithRecordDescription')}
          >
            {t('projectWorkbench.currentWithRecord')}
          </span>
        )}
        {isRecordOnly && (
          <span
            className="diff-panel__record-only-status"
            role="status"
            title={t('projectWorkbench.recordOnlyDescription')}
          >
            {t('projectWorkbench.recordOnly')}
          </span>
        )}
        {file?.ok && file.sensitive && (
          <span className="diff-panel__sensitive">
            <ShieldAlert aria-hidden="true" size={15} /> {t('projectWorkbench.sensitiveFile')}
          </span>
        )}
      </header>
      {(navigationNotice || notice || (!index?.ok && index)) && (
        <div className="diff-panel__notice" role={index && !index.ok ? 'alert' : 'status'}>
          {navigationNotice ?? notice ?? (index && !index.ok ? `Review unavailable: ${index.error}` : '')}
        </div>
      )}
      <div className="diff-panel__body">
        <div className="diff-panel__files" role="listbox" aria-label={t('projectWorkbench.changedFiles')}>
          {loading && <div className="diff-panel__empty">{t('projectWorkbench.loadingChanges')}</div>}
          {!loading && index?.ok && changes.length === 0 && (
            <div className="diff-panel__empty">{t('projectWorkbench.noChanges')}</div>
          )}
          {changes.map((change, changeIndex) => (
            <button
              type="button"
              role="option"
              aria-selected={selectedPath === change.relativePath}
              tabIndex={selectedPath === change.relativePath ? 0 : -1}
              ref={(element) => {
                if (element) fileButtonsRef.current.set(change.relativePath, element);
                else fileButtonsRef.current.delete(change.relativePath);
              }}
              key={change.relativePath}
              onClick={() => {
                setNavigationNotice(null);
                setSelectedPath(change.relativePath);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
                event.preventDefault();
                const direction = event.key === 'ArrowDown' ? 1 : -1;
                const next = changes[(changeIndex + direction + changes.length) % changes.length];
                if (next) {
                  setNavigationNotice(null);
                  setSelectedPath(next.relativePath);
                  requestAnimationFrame(() => fileButtonsRef.current.get(next.relativePath)?.focus());
                }
              }}
            >
              <span data-kind={change.kind}>{kindLabel(change)}</span>
              <span title={change.relativePath}>{change.relativePath}</span>
              {!change.binary && <small>+{change.additions} −{change.deletions}</small>}
            </button>
          ))}
        </div>
        <div className="diff-panel__review">
          {file?.ok && file.binary
            ? <div className="diff-panel__empty">{t('projectWorkbench.binary')}</div>
            : file && !file.ok
              ? <div className="diff-panel__empty" role="alert">{t('projectWorkbench.reviewFileFailed', { error: file.error })}</div>
              : file?.ok && !file.binary && file.view.kind === 'record-only'
                ? <RecordedChangeSections sections={file.view.sections} labels={recordedLabels} />
                : file?.ok && !file.binary && file.view.kind === 'current-with-record'
                  ? (
                    <>
                      <div ref={hostRef} className="diff-panel__editor" />
                      <RecordedChangeAccessibility sections={file.view.sections} labels={recordedLabels} />
                    </>
                  )
                  : <div ref={hostRef} className="diff-panel__editor" aria-busy={Boolean(selectedPath && !file)} />}
        </div>
      </div>
    </section>
  );
}
