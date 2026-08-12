/** Runtime-only presentation policy. It is deliberately absent from layout
 * persistence: reopening the app always recomputes it from native visibility. */
export type RuntimeLifecycleTier = 'active' | 'passive' | 'parked';

export const RUNTIME_PARK_GRACE_MS = 30_000;
export const RUNTIME_PARKED_SCROLLBACK_LINES = 1_000;

export interface RuntimeSurfaceActivity {
  readonly panelVisible: boolean;
  readonly windowFocused: boolean;
  readonly windowVisible: boolean;
  readonly windowMinimized: boolean;
}
