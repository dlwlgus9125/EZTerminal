import type { IDockviewPanelProps } from 'dockview-react';
import { useEffect, useMemo } from 'react';

import { EmptyState, LoadingState } from '../ui';
import { ArtifactFrame, type ArtifactPreviewAccess } from './ArtifactFrame';
import { ConversationResults } from './ConversationResults';
import { useResultsCopy } from './copy';
import { useResultsNavigation, useResultsSource } from './results-source-store';
import type { ResultsServices } from './results-services';

function hostServices(): ResultsServices {
  const api = typeof window === 'undefined' ? undefined : window.ezterminal;
  if (!api) return {};
  return {
    ...(typeof api.getGitStatus === 'function' ? { getGitStatus: (directory: string) => api.getGitStatus(directory) } : {}),
    ...(typeof api.getGitDiff === 'function' ? { getGitDiff: (directory: string) => api.getGitDiff(directory) } : {}),
    ...(typeof api.readFilePreview === 'function' ? { readFilePreview: (path: string) => api.readFilePreview(path) } : {}),
    ...(typeof api.openFileInApp === 'function' ? { openFileInApp: (path: string) => api.openFileInApp(path) } : {}),
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
    />
  );
}
