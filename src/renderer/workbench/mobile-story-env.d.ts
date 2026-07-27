import 'vite/client';

declare global {
  /** Replaced with a boolean literal by the mobile Vite build. */
  const __EZTERMINAL_E2E__: boolean;
}

export {};
