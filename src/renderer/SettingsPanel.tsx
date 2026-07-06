import { useCallback, useEffect, useState } from 'react';

import { UI_SCALE_DEFAULT } from './ui-scale';

/**
 * Settings drawer (v0.2.0 M2): UI scale stepper, remote bridge toggle.
 * Right-edge overlay reusing StatusPanel/ConnectionInfoPanel's
 * `status-drawer`/`status-section` chrome — same slot family, different
 * content, so it shares App.tsx's stats/pairing mutual-exclusion group.
 */
interface SettingsPanelProps {
  readonly uiScale: number;
  readonly onChangeUiScale: (percent: number) => void;
}

export function SettingsPanel({
  uiScale,
  onChangeUiScale,
}: SettingsPanelProps): JSX.Element {
  const [remoteEnabled, setRemoteEnabled] = useState<boolean | null>(null);
  const [remotePort, setRemotePort] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    void window.ezterminal.getRemoteEnabled().then((v) => {
      if (alive) setRemoteEnabled(v);
    });
    void window.ezterminal.getRemoteConnectionInfo().then((info) => {
      if (alive) setRemotePort(info.port);
    });
    return () => {
      alive = false;
    };
  }, []);

  const handleRemoteToggle = useCallback((e: React.ChangeEvent<HTMLInputElement>): void => {
    const next = e.target.checked;
    void window.ezterminal.setRemoteEnabled(next).then((running) => setRemoteEnabled(running));
  }, []);

  const remoteLoading = remoteEnabled === null || remotePort === null;

  return (
    <div className="status-drawer" data-testid="settings-panel">
      <section className="status-section">
        <h2 className="status-section-title">UI Scale</h2>
        <div className="settings-scale-stepper">
          <button
            type="button"
            className="btn btn-split"
            onClick={() => onChangeUiScale(uiScale - 10)}
            data-testid="settings-scale-dec"
          >
            −
          </button>
          <span className="settings-scale-value" data-testid="settings-scale-value">
            {uiScale}%
          </span>
          <button
            type="button"
            className="btn btn-split"
            onClick={() => onChangeUiScale(uiScale + 10)}
            data-testid="settings-scale-inc"
          >
            +
          </button>
          <button
            type="button"
            className="btn btn-split"
            onClick={() => onChangeUiScale(UI_SCALE_DEFAULT)}
            data-testid="settings-scale-reset"
          >
            Reset
          </button>
        </div>
      </section>

      <section className="status-section">
        <h2 className="status-section-title">Remote Access</h2>
        {remoteLoading ? (
          <div className="status-loading">Loading…</div>
        ) : (
          <>
            <label className="settings-radio-row">
              <input
                type="checkbox"
                checked={remoteEnabled}
                onChange={handleRemoteToggle}
                data-testid="settings-remote-toggle"
              />
              <span>Enable remote access</span>
            </label>
            <div className="status-metric">
              WS bridge on port {remotePort} — {remoteEnabled ? 'running' : 'off'}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
