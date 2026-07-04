import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Strict CSP for the PACKAGED renderer (SEC-MED-3), injected as a <meta> only at
// build time. It is NOT applied in dev because Vite's HMR needs inline scripts /
// eval / a websocket that this policy blocks. `style-src 'unsafe-inline'` stays so
// ansi_up's inline color styles render. `frame-ancestors` is intentionally OMITTED
// here — it is ignored (and warns) when delivered via <meta>; main enforces it as a
// response header instead.
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; " +
  "base-uri 'none'; form-action 'none'";

function injectCspMeta(): Plugin {
  return {
    name: 'ezterminal-csp-meta',
    apply: 'build',
    transformIndexHtml(html) {
      const meta = `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`;
      return html.replace('</head>', `  ${meta}\n  </head>`);
    },
  };
}

// Vite config for the renderer process (React UI).
// https://vitejs.dev/config
export default defineConfig({
  plugins: [react(), injectCspMeta()],
});
