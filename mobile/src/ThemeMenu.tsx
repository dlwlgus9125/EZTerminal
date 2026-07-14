import { Check } from 'lucide-react';
import { useCallback, useRef, useState, type RefObject } from 'react';

import type { ThemeName } from '../../src/shared/layout-schema';
import { listThemes } from '../../src/renderer/themes';
import { useAppTranslation } from '../../src/renderer/i18n';
import { MobileActionSheet } from './MobileActionSheet';
import { importCustomTheme } from './theme';

// ThemeMenu — a bottom-sheet theme picker (mobile-only; the desktop cycles
// themes with a single toolbar button instead, see App.tsx's `cycleTheme`).
//
// theme-effects-font Wave 3: the row list is now built from `listThemes()`
// (built-in ∪ imported custom, see theme.ts's registry) instead of a
// hardcoded 4-entry array, and the sheet gained an Import control — mobile's
// only way to add a custom theme (no filesystem to folder-scan, unlike
// desktop's theme-store.ts).
export function ThemeMenu({
  open,
  current,
  onSelect,
  onClose,
  returnFocusRef,
}: {
  open: boolean;
  current: ThemeName;
  onSelect: (name: ThemeName) => void;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement>;
}): JSX.Element | null {
  const { t } = useAppTranslation();
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const runImport = useCallback((json: string) => {
    const result = importCustomTheme(json);
    if (result.ok) {
      setImportText('');
      setImportError(null);
    } else {
      setImportError(t('mobile.themeMenu.invalid'));
    }
  }, [t]);

  const selectTheme = useCallback((theme: ThemeName): void => {
    onSelect(theme);
    onClose();
    requestAnimationFrame(() => returnFocusRef?.current?.focus());
  }, [onClose, onSelect, returnFocusRef]);

  if (!open) return null;

  const themes = listThemes();

  return (
    <MobileActionSheet
      title={t('mobile.themeMenu.title')}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      testId="theme-menu"
    >
        <ul className="theme-menu-list">
          {themes.map((theme) => {
            // Built-ins carry an explicit `swatch` (theme-effects-font Wave 1) so
            // they keep their hand-tuned bg/accent pair; a custom mod without one
            // derives its swatch from the same cssVars/xterm fields the rest of
            // the app reads, with a final hardcoded fallback for a mod that sets
            // neither.
            const swatch = theme.swatch ?? {
              bg: theme.cssVars['--term-bg'] ?? theme.xterm.background ?? '#000000',
              accent: theme.cssVars['--term-green'] ?? theme.xterm.foreground ?? '#29d398',
            };
            return (
              <li key={theme.id}>
                <button
                  type="button"
                  className={
                    theme.id === current ? 'theme-menu-option theme-menu-option--active' : 'theme-menu-option'
                  }
                  onClick={() => selectTheme(theme.id)}
                  aria-pressed={theme.id === current}
                  data-testid={`theme-option-${theme.id}`}
                >
                  <span className="theme-menu-swatch" style={{ background: swatch.bg }} aria-hidden="true">
                    <span className="theme-menu-swatch-dot" style={{ background: swatch.accent }} />
                  </span>
                  <span className="theme-menu-label">{theme.name}</span>
                  {theme.id === current && (
                    <span className="theme-menu-check" aria-hidden="true">
                      <Check size={16} />
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="theme-menu-import">
          <textarea
            className="mobile-file-path-input"
            style={{ width: '100%', minHeight: 60, resize: 'vertical' }}
            placeholder={t('mobile.themeMenu.pasteJson')}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            data-testid="theme-menu-import-textarea"
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button
              type="button"
              className="btn"
              onClick={() => runImport(importText)}
              data-testid="theme-menu-import-btn"
            >
              {t('mobile.themeMenu.import')}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => fileInputRef.current?.click()}
              data-testid="theme-menu-import-file-btn"
            >
              {t('mobile.themeMenu.fromFile')}
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            className="mobile-file-hidden-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = ''; // allow re-picking the same file again
              if (!file) return;
              void file.text().then(runImport);
            }}
            data-testid="theme-menu-import-file-input"
          />
          {importError && (
            <div className="mobile-file-error" data-testid="theme-menu-import-error">
              {importError}
            </div>
          )}
        </div>
    </MobileActionSheet>
  );
}
