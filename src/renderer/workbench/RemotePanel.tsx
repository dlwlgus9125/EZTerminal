import { ConnectionInfoPanel } from '../ConnectionInfoPanel';
import { SshForwardSettings } from '../SshForwardSettings';

/** Pairing/remote access and SSH tunnels share one workbench destination. */
export function RemotePanel(): JSX.Element {
  return (
    <div className="remote-panel" data-testid="remote-panel">
      <ConnectionInfoPanel />
      <SshForwardSettings />
    </div>
  );
}
