import { ConnectionInfoPanel } from '../ConnectionInfoPanel';
import { SshForwardSettings } from '../SshForwardSettings';
import { RemoteDesktopStatusCard, useRemoteDesktopHostStatus } from '../RemoteDesktopStatusCard';
import { RemoteTopology } from './RemoteTopology';

/** Pairing/remote access and SSH tunnels share one workbench destination. */
export function RemotePanel(): JSX.Element {
  const status = useRemoteDesktopHostStatus();

  return (
    <div className="remote-panel" data-testid="remote-panel">
      {/* The link, drawn as a link, before the same facts appear as rows. */}
      <RemoteTopology status={status} />
      {/* QR pairing slot — DEFERRED, not forgotten.
       *
       * The handoff (§4.7) puts a `▦ QR 페어링` action card here that opens a
       * dedicated modal: 170px QR, the code at 24px with .22em tracking, a
       * validity countdown, and a "single use" note.
       *
       * Three things have to land before that is honest rather than decorative:
       *   1. a QR encoder dependency (none is vendored today, and the packaged
       *      CSP means it has to be self-hosted like the fonts are);
       *   2. a scanner on the mobile side — `docs/ux/frontend-design.md` §5.4
       *      currently rules one out, so a desktop QR has nothing to talk to;
       *   3. an expiring, single-use pairing token. Today's token has no
       *      expiry and is reusable, so a countdown and a "single use" label
       *      would be a security claim the product does not implement.
       *
       * Until then the pairing surface below states what is actually true.
       * Owner decision on 2026-07-27: ship the rest of the pass, do QR as its
       * own change. */}
      <RemoteDesktopStatusCard />
      <ConnectionInfoPanel />
      <SshForwardSettings />
    </div>
  );
}
