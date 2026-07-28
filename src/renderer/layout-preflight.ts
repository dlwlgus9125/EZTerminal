import {
  createDockview,
  type DockviewApi,
  type IContentRenderer,
  type ITabRenderer,
  type SerializedDockview,
} from 'dockview-react';

import { buildLayoutEnvelope, type LayoutEnvelope } from '../shared/layout-schema';

function createInertContentRenderer(): IContentRenderer {
  return {
    element: document.createElement('div'),
    init: () => undefined,
  };
}

function createInertTabRenderer(): ITabRenderer {
  return {
    element: document.createElement('div'),
    init: () => undefined,
  };
}

/**
 * Exercise dockview's real deserializer without touching the live workspace.
 *
 * A schema-valid envelope can still contain a nested grid shape that dockview
 * itself cannot restore. Preset application is destructive, so validate that
 * shape against a detached, inert dockview before any live session teardown.
 * Every failure is closed and every successfully-created instance is disposed.
 */
export function preflightLayoutEnvelope(envelope: LayoutEnvelope): boolean {
  const host = document.createElement('div');
  let api: DockviewApi | undefined;
  let valid = false;

  try {
    api = createDockview(host, {
      announcements: false,
      createComponent: createInertContentRenderer,
      createTabComponent: createInertTabRenderer,
      disableAutoResizing: true,
      disableDnd: true,
      disableFloatingGroups: true,
    });
    api.fromJSON(envelope.layout as unknown as SerializedDockview);
    valid = api.panels.length > 0;
  } catch {
    valid = false;
  } finally {
    try {
      api?.dispose();
    } catch {
      valid = false;
    }
  }

  return valid;
}

/**
 * Removes one panel through dockview's own deserializer/serializer instead of
 * manually rewriting its nested grid. This is used by capability-gated startup
 * restore: a hidden native panel must never mount just so it can be closed.
 *
 * `null` is fail-closed and tells the caller to open its normal default pane.
 * The input envelope is never mutated.
 */
export function removePanelFromLayoutEnvelope(
  envelope: LayoutEnvelope,
  panelId: string,
): LayoutEnvelope | null {
  if (!envelope.layout.panels[panelId]) return envelope;

  const host = document.createElement('div');
  let api: DockviewApi | undefined;
  let result: LayoutEnvelope | null = null;

  try {
    api = createDockview(host, {
      announcements: false,
      createComponent: createInertContentRenderer,
      createTabComponent: createInertTabRenderer,
      disableAutoResizing: true,
      disableDnd: true,
      disableFloatingGroups: true,
    });
    api.fromJSON(envelope.layout as unknown as SerializedDockview);
    api.getPanel(panelId)?.api.close();
    if (api.panels.length > 0) {
      const filtered = buildLayoutEnvelope(api.toJSON(), envelope.savedAt);
      result = filtered?.layout.panels[panelId] ? null : filtered;
    }
  } catch {
    result = null;
  } finally {
    try {
      api?.dispose();
    } catch {
      result = null;
    }
  }

  return result;
}
