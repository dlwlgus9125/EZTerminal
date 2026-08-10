import type { DesktopNormalizedRegion } from '../../src/shared/remote-protocol';

export interface RemoteViewState {
  readonly zoom: number;
  readonly centerX: number;
  readonly centerY: number;
}

export interface RemoteSurfaceSize {
  readonly width: number;
  readonly height: number;
}

export interface RemoteVideoLayout {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export const FIT_REMOTE_VIEW: RemoteViewState = Object.freeze({
  zoom: 1,
  centerX: 0.5,
  centerY: 0.5,
});

export const MIN_REMOTE_ZOOM = 1;
export const MAX_REMOTE_ZOOM = 4;

function safeSize(value: number): number {
  return Number.isFinite(value) ? Math.max(1, value) : 1;
}

function fitScale(viewport: RemoteSurfaceSize, display: RemoteSurfaceSize): number {
  return Math.min(
    safeSize(viewport.width) / safeSize(display.width),
    safeSize(viewport.height) / safeSize(display.height),
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function visibleRegionForView(
  view: RemoteViewState,
  viewport: RemoteSurfaceSize,
  display: RemoteSurfaceSize,
): DesktopNormalizedRegion {
  const scale = fitScale(viewport, display) * clamp(view.zoom, MIN_REMOTE_ZOOM, MAX_REMOTE_ZOOM);
  const width = Math.min(1, safeSize(viewport.width) / (safeSize(display.width) * scale));
  const height = Math.min(1, safeSize(viewport.height) / (safeSize(display.height) * scale));
  const centerX = width >= 1 ? 0.5 : clamp(view.centerX, width / 2, 1 - width / 2);
  const centerY = height >= 1 ? 0.5 : clamp(view.centerY, height / 2, 1 - height / 2);
  return {
    x: clamp(centerX - width / 2, 0, 1 - width),
    y: clamp(centerY - height / 2, 0, 1 - height),
    width,
    height,
  };
}

export function clampRemoteView(
  view: RemoteViewState,
  viewport: RemoteSurfaceSize,
  display: RemoteSurfaceSize,
): RemoteViewState {
  const zoom = clamp(view.zoom, MIN_REMOTE_ZOOM, MAX_REMOTE_ZOOM);
  const region = visibleRegionForView({ ...view, zoom }, viewport, display);
  return {
    zoom,
    centerX: region.x + region.width / 2,
    centerY: region.y + region.height / 2,
  };
}

export function panRemoteView(
  view: RemoteViewState,
  deltaX: number,
  deltaY: number,
  viewport: RemoteSurfaceSize,
  display: RemoteSurfaceSize,
): RemoteViewState {
  if (view.zoom <= MIN_REMOTE_ZOOM) return FIT_REMOTE_VIEW;
  const scale = fitScale(viewport, display) * view.zoom;
  return clampRemoteView({
    ...view,
    centerX: view.centerX - deltaX / (safeSize(display.width) * scale),
    centerY: view.centerY - deltaY / (safeSize(display.height) * scale),
  }, viewport, display);
}

export function zoomRemoteViewAt(
  view: RemoteViewState,
  nextZoom: number,
  pointX: number,
  pointY: number,
  viewport: RemoteSurfaceSize,
  display: RemoteSurfaceSize,
): RemoteViewState {
  const boundedZoom = clamp(nextZoom, MIN_REMOTE_ZOOM, MAX_REMOTE_ZOOM);
  if (boundedZoom === MIN_REMOTE_ZOOM) return FIT_REMOTE_VIEW;
  const oldScale = fitScale(viewport, display) * view.zoom;
  const nextScale = fitScale(viewport, display) * boundedZoom;
  const offsetX = pointX - safeSize(viewport.width) / 2;
  const offsetY = pointY - safeSize(viewport.height) / 2;
  const sourceX = view.centerX + offsetX / (safeSize(display.width) * oldScale);
  const sourceY = view.centerY + offsetY / (safeSize(display.height) * oldScale);
  return clampRemoteView({
    zoom: boundedZoom,
    centerX: sourceX - offsetX / (safeSize(display.width) * nextScale),
    centerY: sourceY - offsetY / (safeSize(display.height) * nextScale),
  }, viewport, display);
}

export function mapRemotePoint(
  pointX: number,
  pointY: number,
  view: RemoteViewState,
  viewport: RemoteSurfaceSize,
  display: RemoteSurfaceSize,
): { readonly x: number; readonly y: number } | null {
  const scale = fitScale(viewport, display) * view.zoom;
  const x = view.centerX
    + (pointX - safeSize(viewport.width) / 2) / (safeSize(display.width) * scale);
  const y = view.centerY
    + (pointY - safeSize(viewport.height) / 2) / (safeSize(display.height) * scale);
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

export function relativeRemoteDelta(
  deltaX: number,
  deltaY: number,
  view: RemoteViewState,
  viewport: RemoteSurfaceSize,
  display: RemoteSurfaceSize,
): { readonly dx: number; readonly dy: number } {
  const scale = fitScale(viewport, display) * view.zoom;
  return { dx: deltaX / scale, dy: deltaY / scale };
}

export function remoteVideoLayout(
  sourceRegion: DesktopNormalizedRegion,
  view: RemoteViewState,
  viewport: RemoteSurfaceSize,
  display: RemoteSurfaceSize,
): RemoteVideoLayout {
  const scale = fitScale(viewport, display) * view.zoom;
  const centerX = safeSize(viewport.width) / 2;
  const centerY = safeSize(viewport.height) / 2;
  return {
    left: centerX + (sourceRegion.x - view.centerX) * safeSize(display.width) * scale,
    top: centerY + (sourceRegion.y - view.centerY) * safeSize(display.height) * scale,
    width: sourceRegion.width * safeSize(display.width) * scale,
    height: sourceRegion.height * safeSize(display.height) * scale,
  };
}
