import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { ConversationFileChange } from '../../shared/conversation-changes';
import type { CleanedFolderState } from '../../shared/run-retention';
import { Tab, TabList, TabPanel, Tabs } from '../ui';
import { deriveResults } from './derive-results';
import { backfillConversationChanges } from './history-backfill';
import { ResultsChanges } from './ResultsChanges';
import { ResultsFiles } from './ResultsFiles';
import { ResultsSummary } from './ResultsSummary';
import { useResultsCopy } from './copy';
import type { ResultsNavigation, ResultsSection, ResultsSource } from './results-source-store';
import { useResultsViewState, type ResultsFolderAccess, type ResultsServices } from './results-services';
import { useResultsWidth } from '../shell/results-width';
import '../chat/chat.css';
import './agent-results.css';

export interface BackfillState {
  readonly phase: 'idle' | 'loading' | 'done' | 'error';
  readonly loaded: number;
  readonly total: number;
  readonly changes: readonly ConversationFileChange[];
}

const IDLE: BackfillState = { phase: 'idle', loaded: 0, total: 0, changes: [] };

/**
 * A conversation's results beside it: what changed, the files themselves,
 * and the plan and work in progress. Reads only what the conversation
 * published; viewing never changes the conversation, and comments go to the
 * message draft, never straight to the AI.
 */
export function ConversationResults({ source, services, navigation, renderHtml, renderPdf, allowWiden = false }: {
  readonly source: ResultsSource & { readonly sessionId: string };
  readonly services: ResultsServices;
  readonly navigation?: ResultsNavigation;
  readonly renderHtml?: (path: string) => ReactNode;
  readonly renderPdf?: (path: string) => ReactNode;
  /** The Results tab sits in the main window, where widening can fold the work list. */
  readonly allowWiden?: boolean;
}): JSX.Element {
  const copy = useResultsCopy();
  const widthContext = useResultsWidth();
  const width = allowWiden ? widthContext : null;
  const sessionId = source.sessionId;
  const [section, setSection] = useResultsViewState<ResultsSection>(`agent-results:section:${source.ownerPanelId}`, 'changes');
  const [backfill, setBackfill] = useState<BackfillState>(IDLE);
  const backfillAbort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => backfillAbort.current?.abort(), []);
  useEffect(() => { backfillAbort.current?.abort(); setBackfill(IDLE); }, [sessionId]);

  const derived = useMemo(() => deriveResults({
    sessionId,
    items: source.items ?? [],
    ...(source.model ? { model: source.model } : {}),
    earlierChanges: backfill.changes,
  }), [backfill.changes, sessionId, source.items, source.model]);

  const floor = source.transcriptFloor ?? 0;
  const loadEarlier = useCallback(() => {
    const readPage = source.readTranscriptPage;
    if (!readPage || floor <= 0) return;
    backfillAbort.current?.abort();
    const controller = new AbortController();
    backfillAbort.current = controller;
    setBackfill({ phase: 'loading', loaded: 0, total: floor, changes: [] });
    void backfillConversationChanges({
      sessionId,
      floor,
      readPage,
      signal: controller.signal,
      onProgress: ({ loaded, total }) => { if (!controller.signal.aborted) setBackfill((current) => ({ ...current, loaded, total })); },
    }).then((changes) => {
      if (!controller.signal.aborted) setBackfill({ phase: 'done', loaded: floor, total: floor, changes });
    }).catch(() => {
      if (!controller.signal.aborted) setBackfill((current) => ({ ...current, phase: 'error' }));
    });
  }, [floor, sessionId, source.readTranscriptPage]);
  const cancelEarlier = useCallback(() => { backfillAbort.current?.abort(); setBackfill(IDLE); }, []);

  // Navigation from the conversation: a section, and a turn or file in it.
  const [changesTarget, setChangesTarget] = useState<{ sequence: number; turnId?: string; path?: string }>();
  const [filesTarget, setFilesTarget] = useState<{ sequence: number; path?: string; line?: number }>();
  const handled = useRef(0);
  useEffect(() => {
    if (!navigation || navigation.sequence === handled.current) return;
    handled.current = navigation.sequence;
    setSection(navigation.section);
    if (navigation.section === 'changes') setChangesTarget({ sequence: navigation.sequence, ...(navigation.turnId ? { turnId: navigation.turnId } : {}), ...(navigation.path ? { path: navigation.path } : {}) });
    if (navigation.section === 'files' && navigation.path) setFilesTarget({ sequence: navigation.sequence, path: navigation.path, ...(navigation.line ? { line: navigation.line } : {}) });
  }, [navigation, setSection]);
  const localSequence = useRef(1_000_000_000);
  const showChanges = useCallback((path: string) => {
    localSequence.current += 1;
    setChangesTarget({ sequence: localSequence.current, path });
    setSection('changes');
  }, [setSection]);
  const showFile = useCallback((path: string) => {
    localSequence.current += 1;
    setFilesTarget({ sequence: localSequence.current, path });
    setSection('files');
  }, [setSection]);

  // 작업 폴더 정리: the folder is read only once the host says it is live. A cleaned-up one's files come from the run's
  // kept result. Asked again when the conversation becomes history (the cleanup archives it), on refresh, and every
  // couple of seconds while a cleanup is removing it.
  const root = source.workspaceRoot;
  const [folderState, setFolderState] = useState<{ readonly root: string; readonly state: CleanedFolderState | 'asking' | 'error' }>();
  const [asked, setAsked] = useState(0);
  const recheck = useCallback(() => {
    setFolderState((current) => (current ? { root: current.root, state: 'asking' } : current));
    setAsked((value) => value + 1);
  }, []);
  useEffect(() => {
    if (!root || !services.cleanedFolder) return undefined;
    let alive = true;
    setFolderState({ root, state: 'asking' });
    void services.cleanedFolder(root).then((state) => { if (alive) setFolderState({ root, state }); }, () => { if (alive) setFolderState({ root, state: 'error' }); });
    return () => { alive = false; };
  }, [root, services, source.historyOnly, asked]);
  // Any change to the host's cleanup record: this folder may be going, so nothing more is read from it until asked again.
  useEffect(() => (root && services.onFolderChanged ? services.onFolderChanged(recheck) : undefined), [root, services, recheck]);
  const retiring = !!folderState && folderState.root === root && typeof folderState.state === 'object' && folderState.state.state === 'retiring';
  useEffect(() => {
    if (!retiring) return undefined;
    const timer = window.setTimeout(() => setAsked((value) => value + 1), 2_000);
    return () => window.clearTimeout(timer);
  }, [retiring, folderState]);
  const folder: ResultsFolderAccess = !root || !services.cleanedFolder ? { kind: 'live' }
    : folderState?.root !== root || folderState.state === 'asking' ? { kind: 'checking' }
      : folderState.state === 'error' ? { kind: 'error', retry: recheck }
        : folderState.state.state === 'live' ? { kind: 'live' }
          : folderState.state.state === 'retiring' ? { kind: 'checking' }
            : { kind: 'cleaned', root: folderState.state.root, result: folderState.state.result };

  const changeCount = derived.files.length;
  const todoLeft = derived.todo?.filter((item) => item.status !== 'completed').length ?? 0;
  return (
    <div className="conversation-results" data-testid="conversation-results">
      <Tabs value={section} onValueChange={(value) => setSection(value as ResultsSection)} className={width ? 'conversation-results__tabs conversation-results__tabs--widen' : 'conversation-results__tabs'}>
        {width && (
          <button type="button" className="conversation-results__widen" aria-pressed={width.wide} onClick={() => width.toggle(source.ownerPanelId)}
            data-testid="results-widen">{width.wide ? copy.narrow : copy.widen}</button>
        )}
        <TabList label={copy.sections} className="conversation-results__tablist">
          <Tab value="changes" data-testid="results-tab-changes">{copy.changes}{changeCount > 0 && <span className="conversation-results__count">{changeCount}</span>}</Tab>
          <Tab value="files" data-testid="results-tab-files">{copy.files}</Tab>
          <Tab value="summary" data-testid="results-tab-summary">
            {copy.summary}
            {(derived.running.length > 0 || todoLeft > 0) && <span className="conversation-results__count">{derived.running.length || todoLeft}</span>}
            {derived.pendingDecisions > 0 && <span className="conversation-results__attention" aria-label={copy.decisions(derived.pendingDecisions)} />}
          </Tab>
        </TabList>
        <TabPanel value="changes" className="conversation-results__panel">
          {section === 'changes' && (
            <ResultsChanges
              sessionId={sessionId}
              {...(source.workspaceRoot ? { workspaceRoot: source.workspaceRoot } : {})}
              derived={derived}
              transcriptFloor={floor}
              backfill={backfill}
              {...(source.readTranscriptPage ? { onLoadEarlier: loadEarlier, onCancelEarlier: cancelEarlier } : {})}
              services={services}
              {...(source.insertIntoDraft ? { insertIntoDraft: source.insertIntoDraft } : {})}
              {...(source.draftUnavailable ? { draftUnavailable: source.draftUnavailable } : {})}
              {...(changesTarget ? { target: changesTarget } : {})}
              turnActive={source.turnActive ?? false}
              folderReadable={folder.kind === 'live'}
              onViewFile={showFile}
            />
          )}
        </TabPanel>
        <TabPanel value="files" className="conversation-results__panel">
          {section === 'files' && (
            <ResultsFiles
              sessionId={sessionId}
              {...(source.workspaceRoot ? { workspaceRoot: source.workspaceRoot } : {})}
              derived={derived}
              services={services}
              {...(filesTarget ? { target: filesTarget } : {})}
              {...(source.openProjectFiles && folder.kind === 'live' ? { onOpenProjectFiles: source.openProjectFiles } : {})}
              folder={folder}
              {...(services.cleanedFolder && root ? { onRefreshFolder: recheck } : {})}
              onViewChanges={showChanges}
              {...(renderHtml ? { renderHtml } : {})}
              {...(renderPdf ? { renderPdf } : {})}
            />
          )}
        </TabPanel>
        <TabPanel value="summary" className="conversation-results__panel">
          {section === 'summary' && (
            <ResultsSummary
              derived={derived}
              subagents={source.children ?? []}
              {...(source.workspaceRoot ? { workspaceRoot: source.workspaceRoot } : {})}
              {...(source.openRelatedSession ? { onOpenSubagent: source.openRelatedSession } : {})}
              {...(source.focusDecision ? { onFocusDecision: source.focusDecision } : {})}
              onOpenChanges={showChanges}
              onOpenFile={showFile}
              {...(services.openExternalHttpUrl ? { onOpenLink: services.openExternalHttpUrl } : {})}
            />
          )}
        </TabPanel>
      </Tabs>
    </div>
  );
}
