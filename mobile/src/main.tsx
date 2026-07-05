import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Note: the shared `declare global { interface Window { readonly ezterminal:
// EzTerminalApi } }` augmentation (src/shared/window.d.ts) is a pure type
// declaration with no runtime code — it's brought into this program via
// mobile/tsconfig.json's `include`, not a JS import (a `.d.ts` file has
// nothing to import at runtime).

import { App } from './App';
import '../../src/renderer/index.css';
import './mobile.css';

// Mobile has no theme picker (M2 scope) — default to 'dark', matching the WS
// transport's getTheme() stub. index.css's `[data-theme]` blocks only apply
// overrides for light/high-contrast/matrix; 'dark' needs no cssVars override.
document.documentElement.dataset.theme = 'dark';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found in index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
