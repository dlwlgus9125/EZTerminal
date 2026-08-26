export const DOCK_PANEL_COMPONENTS = [
  'terminal',
  'agent-session',
  'project-editor',
  'project-map',
  'openclaw-chat',
] as const;

export type DockPanelComponent = (typeof DOCK_PANEL_COMPONENTS)[number];
export type DockPanelLifecycle = 'session-surface' | 'passive';

export interface DockPanelCapabilities {
  readonly detachable: boolean;
  readonly lifecycle: DockPanelLifecycle;
}

const CAPABILITIES: Readonly<Record<DockPanelComponent, DockPanelCapabilities>> = Object.freeze({
  terminal: Object.freeze({ detachable: true, lifecycle: 'session-surface' }),
  'agent-session': Object.freeze({ detachable: true, lifecycle: 'passive' }),
  'project-editor': Object.freeze({ detachable: true, lifecycle: 'passive' }),
  'project-map': Object.freeze({ detachable: false, lifecycle: 'passive' }),
  'openclaw-chat': Object.freeze({ detachable: true, lifecycle: 'passive' }),
});

export function isDockPanelComponent(value: unknown): value is DockPanelComponent {
  return typeof value === 'string'
    && (DOCK_PANEL_COMPONENTS as readonly string[]).includes(value);
}

export function dockPanelCapabilities(value: unknown): DockPanelCapabilities | null {
  return isDockPanelComponent(value) ? CAPABILITIES[value] : null;
}

export function isDetachableDockPanelComponent(value: unknown): value is DockPanelComponent {
  return dockPanelCapabilities(value)?.detachable === true;
}

export function isPassiveDockPanelComponent(value: unknown): value is DockPanelComponent {
  return dockPanelCapabilities(value)?.lifecycle === 'passive';
}
