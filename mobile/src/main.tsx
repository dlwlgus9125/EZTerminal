import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Note: the shared `declare global { interface Window { readonly ezterminal:
// EzTerminalApi } }` augmentation (src/shared/window.d.ts) is a pure type
// declaration with no runtime code — it's brought into this program via
// mobile/tsconfig.json's `include`, not a JS import (a `.d.ts` file has
// nothing to import at runtime).

import { App } from './App';
import { MobileUiPreferencesProvider } from './MobileUiPreferencesProvider';
import { applyTheme, loadCustomThemes, loadFont, loadTheme } from './theme';
import { loadUiScale } from './ui-scale';
import { setUserFontId } from '../../src/renderer/theme-runtime';
import { applyUiScale } from '../../src/renderer/ui-scale';
import '../../src/renderer/mobile-shared.css';
import '../../src/renderer/ui/styles.css';
import './mobile.css';
import './workbench.css';

// Keep theme/font hydration in this eager entrypoint. MobileWorkspace is lazy,
// so putting these side effects in that chunk would make the first loadTheme()
// run before persisted custom themes are registered and silently select the
// fallback theme instead. The font seed likewise belongs to boot state rather
// than an authenticated-workspace module lifetime.
loadCustomThemes();
setUserFontId(loadFont());

// Mobile picks its own theme independent of the desktop bridge (M4 scope,
// localStorage-only — see theme.ts's module doc).
applyTheme(loadTheme());

// Same independence for UI scale (D1) — mobile's own localStorage key, shared
// clamp/apply logic with the desktop (src/renderer/ui-scale.ts).
applyUiScale(loadUiScale());

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found in index.html');
}

createRoot(container).render(
  <StrictMode>
    <MobileUiPreferencesProvider>
      <App />
    </MobileUiPreferencesProvider>
  </StrictMode>,
);
