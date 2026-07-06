import type { ThemeName } from '../../src/shared/layout-schema';

// ThemeMenu — a bottom-sheet theme picker (mobile-only; the desktop cycles
// themes with a single toolbar button instead, see App.tsx's `cycleTheme`).
// The swatch hexes below are the themes' own bg/accent colors (not read from
// `THEMES` in themes.ts — that module exports `ITheme`/CSS-var objects, not a
// UI-friendly swatch pair), so they're hardcoded here deliberately.
export interface ThemeOption {
  readonly name: ThemeName;
  readonly label: string;
  readonly bg: string;
  readonly accent: string;
}

// Exported so MobileSettingsView (M4) can render the same theme list without
// duplicating the swatch hexes — this is the ONLY change to this file (D5:
// mobile/e2e/parity.ts drives ThemeMenu by fixed screen geometry, so it must
// otherwise stay byte-identical).
export const THEME_OPTIONS: readonly ThemeOption[] = [
  { name: 'dark', label: 'Dark', bg: '#0c0c0c', accent: '#29d398' },
  { name: 'light', label: 'Light', bg: '#f5f5f5', accent: '#0e8a4b' },
  { name: 'high-contrast', label: 'High Contrast', bg: '#000000', accent: '#00ff66' },
  { name: 'matrix', label: 'Matrix', bg: '#010301', accent: '#5fe7ac' },
];

export function ThemeMenu({
  open,
  current,
  onSelect,
  onClose,
}: {
  open: boolean;
  current: ThemeName;
  onSelect: (name: ThemeName) => void;
  onClose: () => void;
}): JSX.Element | null {
  if (!open) return null;

  return (
    <div className="theme-menu-backdrop" data-testid="theme-menu-backdrop" onClick={onClose}>
      <div
        className="theme-menu-sheet"
        data-testid="theme-menu"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="theme-menu-title">Theme</h3>
        <ul className="theme-menu-list">
          {THEME_OPTIONS.map((opt) => (
            <li key={opt.name}>
              <button
                type="button"
                className={
                  opt.name === current ? 'theme-menu-option theme-menu-option--active' : 'theme-menu-option'
                }
                onClick={() => {
                  onSelect(opt.name);
                  onClose();
                }}
                data-testid={`theme-option-${opt.name}`}
              >
                <span className="theme-menu-swatch" style={{ background: opt.bg }} aria-hidden="true">
                  <span className="theme-menu-swatch-dot" style={{ background: opt.accent }} />
                </span>
                <span className="theme-menu-label">{opt.label}</span>
                {opt.name === current && (
                  <span className="theme-menu-check" aria-hidden="true">
                    ✓
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
