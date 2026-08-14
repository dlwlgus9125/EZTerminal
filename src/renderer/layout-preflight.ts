import {
  createDockview,
  type DockviewApi,
  type IContentRenderer,
  type ITabRenderer,
  type SerializedDockview,
} from 'dockview-react';

import {
  buildLayoutEnvelope,
  collectSerializedPanelIds,
  removePanelsFromSerializedLayout,
  type LayoutEnvelope,
  type SerializedLayout,
} from '../shared/layout-schema';

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

function popoutPanelIds(layout: SerializedLayout): Set<string> {
  const ids = new Set<string>();
  for (const popout of layout.popoutGroups ?? []) {
    const members = popout.data
      ? popout.data.views
      : collectSerializedPanelIds(popout.grid?.root);
    for (const id of members) ids.add(id);
  }
  return ids;
}

function panelRecord(
  layout: SerializedLayout,
  ids: ReadonlySet<string>,
): SerializedLayout['panels'] {
  return Object.fromEntries(
    Object.entries(layout.panels).filter(([id]) => ids.has(id)),
  ) as SerializedLayout['panels'];
}

function createPreflightLayoutSegments(
  envelope: LayoutEnvelope,
): Array<{ readonly layout: SerializedDockview; readonly expectedPanels: number }> {
  const detachedIds = popoutPanelIds(envelope.layout);
  const mainIds = new Set(
    Object.keys(envelope.layout.panels).filter((id) => !detachedIds.has(id)),
  );
  const segments: Array<{ layout: SerializedDockview; expectedPanels: number }> = [];

  if (mainIds.size > 0) {
    const main = structuredClone(envelope.layout) as SerializedLayout;
    delete main.popoutGroups;
    main.panels = panelRecord(envelope.layout, mainIds);
    segments.push({
      layout: main as unknown as SerializedDockview,
      expectedPanels: mainIds.size,
    });
  }

  for (const popout of envelope.layout.popoutGroups ?? []) {
    const ids = popout.data
      ? new Set(popout.data.views)
      : collectSerializedPanelIds(popout.grid?.root);
    const grid = popout.grid
      ? structuredClone(popout.grid)
      : {
          root: {
            type: 'branch' as const,
            data: [{
              type: 'leaf' as const,
              data: structuredClone(popout.data!),
              size: popout.position.width,
            }],
          },
          width: popout.position.width,
          height: popout.position.height,
          orientation: 'HORIZONTAL',
        };
    segments.push({
      layout: {
        grid,
        panels: panelRecord(envelope.layout, ids),
        activeGroup: popout.data?.id,
      } as unknown as SerializedDockview,
      expectedPanels: ids.size,
    });
  }
  return segments;
}

function preflightSerializedLayout(
  layout: SerializedDockview,
  expectedPanels: number,
): boolean {
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
    api.fromJSON(layout);
    valid = expectedPanels > 0 && api.panels.length === expectedPanels;
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
 * Exercise dockview's real deserializer without touching the live workspace.
 *
 * A schema-valid envelope can still contain a nested grid shape that dockview
 * itself cannot restore. Preset application is destructive, so validate that
 * shape against a detached, inert dockview before any live session teardown.
 * Every failure is closed and every successfully-created instance is disposed.
 */
export function preflightLayoutEnvelope(envelope: LayoutEnvelope): boolean {
  const segments = createPreflightLayoutSegments(envelope);
  return (
    segments.length > 0
    && segments.every(({ layout, expectedPanels }) => (
      preflightSerializedLayout(layout, expectedPanels)
    ))
  );
}

/**
 * Removes one panel from either the main or a popout grid, then exercises the
 * result through schema validation and Dockview's real deserializer. This is
 * used by capability-gated startup restore: a hidden native panel must never
 * mount just so it can be closed.
 *
 * `null` is fail-closed and tells the caller to open its normal default pane.
 * The input envelope is never mutated.
 */
export function removePanelFromLayoutEnvelope(
  envelope: LayoutEnvelope,
  panelId: string,
): LayoutEnvelope | null {
  if (!envelope.layout.panels[panelId]) return envelope;
  const pruned = removePanelsFromSerializedLayout(envelope.layout, new Set([panelId]));
  const filtered = buildLayoutEnvelope(pruned, envelope.savedAt);
  if (!filtered || filtered.layout.panels[panelId]) return null;
  return preflightLayoutEnvelope(filtered) ? filtered : null;
}
