import { FileExplorerPanel } from './FileExplorerPanel';
import type { CapabilityAccess } from './capability-access';

interface ExplorerWorkbenchProps {
  readonly activePanelId: string | null | undefined;
  readonly onOpenTerminalAt: (dirPath: string) => void;
  readonly capabilities?: CapabilityAccess;
}

export function ExplorerWorkbench(props: ExplorerWorkbenchProps): JSX.Element {
  return (
    <div className="explorer-workbench">
      <div className="explorer-workbench__filesystem">
        <FileExplorerPanel
          activePanelId={props.activePanelId}
          onOpenTerminalAt={props.onOpenTerminalAt}
          capabilities={props.capabilities}
        />
      </div>
    </div>
  );
}
