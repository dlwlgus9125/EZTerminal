import {
  installWebViewCompatibility,
  isWebViewCompatibilityInstalled,
} from './webview-compat';

// This entrypoint intentionally has no static application imports. A static
// React/JSX import can be evaluated before a sibling polyfill import after
// bundling. Installing first and crossing a dynamic-import boundary makes the
// WebView 74 runtime contract deterministic for every application dependency.
installWebViewCompatibility();

if (!isWebViewCompatibilityInstalled()) {
  throw new Error('WebView compatibility bootstrap did not complete');
}

// Emitted only after the installer call and runtime assertion above. The
// release verifier requires this completion sentinel to precede the dynamic
// application import, so a bundle that merely contains fallback definitions
// cannot pass without executing the bootstrap contract first.
Object.defineProperty(globalThis, '__EZTERMINAL_WEBVIEW74_BOOTSTRAP_READY__', {
  configurable: false,
  enumerable: false,
  writable: false,
  value: true,
});

export const mobileAppReady = import('./main');
