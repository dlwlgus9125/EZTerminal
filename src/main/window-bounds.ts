import type { Rectangle } from 'electron';

export const AUXILIARY_WINDOW_MIN_WIDTH = 480;
export const AUXILIARY_WINDOW_MIN_HEIGHT = 320;

function finiteInteger(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.round(value) : fallback;
}

/** Keep restored auxiliary bounds entirely inside one visible work area. */
export function clampWindowBounds(bounds: Rectangle, workArea: Rectangle): Rectangle {
  const workWidth = Math.max(1, finiteInteger(workArea.width, 1));
  const workHeight = Math.max(1, finiteInteger(workArea.height, 1));
  const width = Math.min(
    workWidth,
    Math.max(Math.min(AUXILIARY_WINDOW_MIN_WIDTH, workWidth), finiteInteger(bounds.width, 800)),
  );
  const height = Math.min(
    workHeight,
    Math.max(Math.min(AUXILIARY_WINDOW_MIN_HEIGHT, workHeight), finiteInteger(bounds.height, 600)),
  );
  const minX = finiteInteger(workArea.x, 0);
  const minY = finiteInteger(workArea.y, 0);
  const maxX = minX + workWidth - width;
  const maxY = minY + workHeight - height;
  const x = Math.min(maxX, Math.max(minX, finiteInteger(bounds.x, minX)));
  const y = Math.min(maxY, Math.max(minY, finiteInteger(bounds.y, minY)));
  return { x, y, width, height };
}
