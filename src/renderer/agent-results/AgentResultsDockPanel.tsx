import type { IDockviewPanelProps } from 'dockview-react';
import { useEffect, useMemo, useState } from 'react';

import type { FilePreviewResult } from '../../shared/file-preview';
import type { CleanedFolderState } from '../../shared/run-retention';
import { EmptyState, LoadingState } from '../ui';
import { ArtifactFrame, type ArtifactPreviewAccess } from './ArtifactFrame';
import { ConversationResults } from './ConversationResults';
import { useResultsCopy } from './copy';
import { useResultsNavigation, useResultsSource } from './results-source-store';
import { useResultsWidth } from '../shell/results-width';
import type { ResultsServices } from './results-services';

function hostServices(): ResultsServices {
  const api = typeof window === 'undefined' ? undefined : window.ezterminal;
  if (!api) return {};
  return {
    ...(typeof api.getGitStatus === 'function' ? { getGitStatus: (directory: string) => api.getGitStatus(directory) } : {}),
    ...(typeof api.getGitDiff === 'function' ? { getGitDiff: (directory: string) => api.getGitDiff(directory) } : {}),
    ...(typeof api.readFilePreview === 'function' ? { readFilePreview: (path: string) => api.readFilePreview(path) } : {}),
    ...(typeof api.openFileInApp === 'function' ? { openFileInApp: (path: string) => api.openFileInApp(path) } : {}),
    ...(api.runRetention ? {
      // A record the host cannot read is not 'live': the tab reads nothing until it can tell.
      cleanedFolder: (root: string) => api.runRetention!.folderState(root).then((result): CleanedFolderState => {
        if (!result.ok) throw new Error(result.message);
        return result.value;
      }),
      readCleanedFile: (path: string) => api.runRetention!.readFile(path).then((result): FilePreviewResult => (result.ok ? result.value : { ok: false, error: result.message })),
    } : {}),
    ...(typeof window.ezterminalDesktop?.openExternalHttpUrl === 'function'
      ? { openExternalHttpUrl: (url: string) => { if (/^https?:/iu.test(url)) void window.ezterminalDesktop?.openExternalHttpUrl(url); } }
      : {}),
  };
}

function previewAccess(): ArtifactPreviewAccess | undefined {
  const desktop = typeof window === 'undefined' ? undefined : window.ezterminalDesktop;
  const grant = desktop?.grantArtifactPreview;
  const revoke = desktop?.revokeArtifactPreview;
  return grant && revoke ? { grant: (path, kind) => grant(path, kind), revoke: (token) => revoke(token) } : undefined;
}

/** The Results tab in the workbench: reads what its conversation tab publishes. */
export function AgentResultsDockPanel(props: IDockviewPanelProps): JSX.Element {
  const copy = useResultsCopy();
  const ownerPanelId = typeof props.params?.ownerPanelId === 'string' ? props.params.ownerPanelId : '';
  const source = useResultsSource(ownerPanelId);
  const navigation = useResultsNavigation(ownerPanelId);
  const services = useMemo(hostServices, []);
  const previews = useMemo(previewAccess, []);
  const renderHtml = useMemo(() => (previews
    ? (path: string) => <ArtifactFrame path={path} kind="html" title={path} access={previews} />
    : undefined), [previews]);
  const renderPdf = useMemo(() => (previews
    ? (path: string) => <ArtifactFrame path={path} kind="pdf" title={path} access={previews} />
    : undefined), [previews]);
  const title = copy.tabTitle(source?.title ?? '');
  // Widening measures the main window's dock, so it is offered only there.
  const [inMainWindow, setInMainWindow] = useState(props.api.location.type === 'grid');
  useEffect(() => {
    const disposable = props.api.onDidLocationChange((event) => setInMainWindow(event.location.type === 'grid'));
    return () => disposable.dispose();
  }, [props.api]);
  // Moved out of the main window while widened: the main window's list comes back.
  const resultsWidth = useResultsWidth();
  useEffect(() => { if (!inMainWindow && resultsWidth?.wide) resultsWidth.reset(); }, [inMainWindow, resultsWidth]);
  useEffect(() => {
    if (props.api.title !== title) props.api.setTitle(title);
  }, [props.api, title]);

  if (!source?.sessionId) {
    return (
      <div className="conversation-results" data-testid="conversation-results-waiting">
        {source ? <LoadingState label={copy.waitingSource} /> : <EmptyState title={copy.noSource} />}
      </div>
    );
  }
  return (
    <ConversationResults
      source={source as typeof source & { sessionId: string }}
      services={services}
      {...(navigation ? { navigation } : {})}
      {...(renderHtml ? { renderHtml } : {})}
      {...(renderPdf ? { renderPdf } : {})}
      allowWiden={inMainWindow}
    />
  );
}
