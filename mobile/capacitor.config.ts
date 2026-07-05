import type { CapacitorConfig } from '@capacitor/cli';

// Mobile remote-control shell (M2): wraps the Vite web build (`dist/`) as an
// Android WebView app. No native plugins beyond core — the app talks to the
// desktop bridge purely over WS (ws-ezterminal.ts), nothing native-only is
// needed for M2's scope (stats/packet-capture are explicitly desktop-only).
const config: CapacitorConfig = {
  appId: 'com.ezterminal.remote',
  appName: 'EZTerminal Remote',
  webDir: 'dist',
  server: {
    // Capacitor's default Android WebView origin is `https://localhost` —
    // browsers block a plain `ws://` connection from an HTTPS origin as
    // "mixed content" (confirmed via M3's emulator smoke test: `Uncaught
    // SecurityError: Failed to construct 'WebSocket'`). The remote bridge
    // (src/main/remote-bridge.ts) is plain `ws://` by design (LAN/Tailscale-
    // scoped, token-gated — see the mobile remote-control plan's security
    // model), so the WebView origin must be downgraded to `http` to match.
    androidScheme: 'http',
  },
};

export default config;
