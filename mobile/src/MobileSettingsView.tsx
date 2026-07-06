import { useCallback, useState } from 'react';

import type { ThemeName } from '../../src/shared/layout-schema';
import {
  UI_SCALE_DEFAULT,
  UI_SCALE_STEP,
  applyUiScale,
  clampUiScale,
} from '../../src/renderer/ui-scale';
import { THEME_OPTIONS } from './ThemeMenu';
import { loadUiScale, saveUiScale } from './ui-scale';

const CONNECTION_STORAGE_KEY = 'ezterminal-mobile-connection';

/** Best-effort read of the saved connection's server URL for display only
 * (see App.tsx's `loadSaved`/`STORAGE_KEY` for the persisted shape) — any
 * parse failure just shows the empty-state dash, same as App.tsx's own
 * corrupt-value handling. */
function readConnectionUrl(): string {
  try {
    const raw = localStorage.getItem(CONNECTION_STORAGE_KEY);
    if (!raw) return '';
    const parsed: unknown = JSON.parse(raw);
    const url = (parsed as { url?: unknown } | null)?.url;
    return typeof url === 'string' ? url : '';
  } catch {
    return '';
  }
}

// MobileSettingsView — full-screen settings overlay (v0.2.0 M4). Modeled on
// MobileStatsView.tsx's structure (standalone view, own header, `.btn`/
// `--term-*` styling). Reached only from the authed MobileWorkspace, so
// "Connection" always reflects a live session — there is no disconnected
// state to render here.
interface MobileSettingsViewProps {
  readonly currentTheme: ThemeName;
  readonly onThemeSelect: (name: ThemeName) => void;
  readonly onClose: () => void;
  readonly onDisconnect: () => void;
}

export function MobileSettingsView({
  currentTheme,
  onThemeSelect,
  onClose,
  onDisconnect,
}: MobileSettingsViewProps): JSX.Element {
  const [uiScale, setUiScale] = useState(() => loadUiScale());
  const [connectionUrl] = useState(() => readConnectionUrl());

  // clamp -> applyUiScale (live) -> saveUiScale (persist) -> state, per plan D1/D5.
  const setScale = useCallback((percent: number) => {
    const clamped = clampUiScale(percent);
    applyUiScale(clamped);
    saveUiScale(clamped);
    setUiScale(clamped);
  }, []);

  const dec = useCallback(() => setScale(uiScale - UI_SCALE_STEP), [setScale, uiScale]);
  const inc = useCallback(() => setScale(uiScale + UI_SCALE_STEP), [setScale, uiScale]);
  const reset = useCallback(() => setScale(UI_SCALE_DEFAULT), [setScale]);

  return (
    <div className="mobile-settings-view" data-testid="mobile-settings-view">
      <header className="mobile-settings-head">
        <button
          type="button"
          className="btn"
          onClick={onClose}
          aria-label="Close settings"
          data-testid="mobile-settings-close"
        >
          ✕
        </button>
        <h2 className="mobile-settings-title">Settings</h2>
      </header>

      <div className="mobile-settings-body">
        <section className="status-section">
          <h2 className="status-section-title">Theme</h2>
          <ul className="mobile-settings-theme-list">
            {THEME_OPTIONS.map((opt) => (
              <li key={opt.name}>
                <button
                  type="button"
                  className={
                    opt.name === currentTheme
                      ? 'theme-menu-option theme-menu-option--active'
                      : 'theme-menu-option'
                  }
                  onClick={() => onThemeSelect(opt.name)}
                  data-testid={`settings-theme-${opt.name}`}
                >
                  <span className="theme-menu-swatch" style={{ background: opt.bg }} aria-hidden="true">
                    <span className="theme-menu-swatch-dot" style={{ background: opt.accent }} />
                  </span>
                  <span className="theme-menu-label">{opt.label}</span>
                  {opt.name === currentTheme && (
                    <span className="theme-menu-check" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="status-section">
          <h2 className="status-section-title">UI Scale</h2>
          <div className="settings-scale-stepper">
            <button
              type="button"
              className="btn"
              onClick={dec}
              aria-label="Decrease UI scale"
              data-testid="settings-scale-dec"
            >
              −
            </button>
            <span className="settings-scale-value" data-testid="settings-scale-value">
              {uiScale}%
            </span>
            <button
              type="button"
              className="btn"
              onClick={inc}
              aria-label="Increase UI scale"
              data-testid="settings-scale-inc"
            >
              +
            </button>
            <button
              type="button"
              className="btn"
              onClick={reset}
              aria-label="Reset UI scale"
              data-testid="settings-scale-reset"
            >
              Reset
            </button>
          </div>
        </section>

        <section className="status-section">
          <h2 className="status-section-title">Connection</h2>
          <div className="status-metric" data-testid="settings-connection-url">
            {connectionUrl || '—'}
          </div>
          <div className="status-metric" data-testid="settings-connection-status">
            Connected
          </div>
          <button
            type="button"
            className="btn"
            onClick={onDisconnect}
            data-testid="settings-disconnect-btn"
          >
            Disconnect
          </button>
        </section>
      </div>
    </div>
  );
}
