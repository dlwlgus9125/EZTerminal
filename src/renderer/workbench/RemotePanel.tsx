import { ConnectionInfoPanel } from '../ConnectionInfoPanel';
import { SshForwardSettings } from '../SshForwardSettings';
import { RemoteDesktopStatusCard } from '../RemoteDesktopStatusCard';

/** Pairing/remote access and SSH tunnels share one workbench destination. */
export function RemotePanel(): JSX.Element {
  return (
    <div className="remote-panel" data-testid="remote-panel">
      <RemoteDesktopStatusCard />
      <ConnectionInfoPanel />
      <SshForwardSettings />
    </div>
  );
}
