import { useState } from 'react';

import { FileExplorerPanel } from './FileExplorerPanel';
import { ProjectExplorerPanel } from './ProjectExplorerPanel';
import type { CapabilityAccess } from './capability-access';
import { useAppTranslation } from './i18n';
import type { ProjectCodeLocation } from './project-code-navigation';

interface ExplorerWorkbenchProps {
  readonly activePanelId: string | null | undefined;
  readonly onOpenTerminalAt: (dirPath: string) => void;
  readonly onOpenProjectFile: (
    projectId: string,
    rootId: string,
    relativePath: string,
    location?: ProjectCodeLocation,
  ) => void;
  readonly onOpenProjectReview: (projectId: string, rootId: string) => void;
  readonly capabilities?: CapabilityAccess;
}

export function ExplorerWorkbench(props: ExplorerWorkbenchProps): JSX.Element {
  const { t } = useAppTranslation();
  const [mode, setMode] = useState<'files' | 'project'>(() =>
    localStorage.getItem('ezterminal.explorer.mode') === 'project' ? 'project' : 'files');
  const chooseMode = (next: 'files' | 'project'): void => {
    localStorage.setItem('ezterminal.explorer.mode', next);
    setMode(next);
  };
  return (
    <div className="explorer-workbench">
      <div className="explorer-workbench__modes" role="tablist" aria-label={t('projectWorkbench.explorerMode')}>
        <button type="button" role="tab" aria-selected={mode === 'project'} onClick={() => chooseMode('project')}>{t('projectWorkbench.projectMode')}</button>
        <button type="button" role="tab" aria-selected={mode === 'files'} onClick={() => chooseMode('files')}>{t('projectWorkbench.fileSystemMode')}</button>
      </div>
      <div role="tabpanel">
        {mode === 'project' ? (
          <ProjectExplorerPanel
            onOpenFile={props.onOpenProjectFile}
            onOpenReview={props.onOpenProjectReview}
          />
        ) : (
          <FileExplorerPanel
            activePanelId={props.activePanelId}
            onOpenTerminalAt={props.onOpenTerminalAt}
            capabilities={props.capabilities}
          />
        )}
      </div>
    </div>
  );
}
