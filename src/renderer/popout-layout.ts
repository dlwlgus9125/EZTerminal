import type { SerializedDockview } from 'dockview-react';

/**
 * Dockview's public addPopoutGroup position is relative to the source window,
 * while toJSON persists absolute screen coordinates. Convert only at the
 * restore boundary so the on-disk representation remains monitor-stable.
 */
export function prepareLayoutForDockviewRestore(
  layout: unknown,
  sourceWindow: Pick<Window, 'screenX' | 'screenY'> = window,
): SerializedDockview {
  const prepared = structuredClone(layout) as Record<string, unknown>;
  const originX = Number.isFinite(sourceWindow.screenX) ? sourceWindow.screenX : 0;
  const originY = Number.isFinite(sourceWindow.screenY) ? sourceWindow.screenY : 0;
  if (Array.isArray(prepared.popoutGroups)) {
    for (const candidate of prepared.popoutGroups) {
      if (typeof candidate !== 'object' || candidate === null) continue;
      const popout = candidate as Record<string, unknown>;
      delete popout.url;
      delete popout.gridReferenceGroup;
      if (typeof popout.position !== 'object' || popout.position === null) continue;
      const position = popout.position as Record<string, unknown>;
      if (typeof position.left === 'number') position.left -= originX;
      if (typeof position.top === 'number') position.top -= originY;
    }
  }
  return prepared as unknown as SerializedDockview;
}
