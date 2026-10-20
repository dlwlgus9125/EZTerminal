import type { IDockviewPanelProps } from 'dockview-react';
import { useEffect, useMemo } from 'react';

import { EmptyState, LoadingState } from '../ui';
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

/** The Results tab in the workbench: reads what its conversation tab publishes. */
export function AgentResultsDockPanel(props: IDockviewPanelProps): JSX.Element {
  const copy = useResultsCopy();
  const ownerPanelId = typeof props.params?.ownerPanelId === 'string' ? props.params.ownerPanelId : '';
  const source = useResultsSource(ownerPanelId);
  const navigation = useResultsNavigation(ownerPanelId);
  const services = useMemo(hostServices, []);
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
    />
  );
}
