import { describe, expect, it } from 'vitest';

import {
  FIT_REMOTE_VIEW,
  clampRemoteView,
  mapRemotePoint,
  panRemoteView,
  relativeRemoteDelta,
  remoteVideoLayout,
  visibleRegionForView,
  zoomRemoteViewAt,
} from './remote-desktop-view-state';

const VIEWPORT = { width: 400, height: 300 };
const DISPLAY = { width: 1_600, height: 900 };

describe('remote desktop view state', () => {
  it('keeps fit mode on the full display and derives a bounded zoom region', () => {
    expect(visibleRegionForView(FIT_REMOTE_VIEW, VIEWPORT, DISPLAY)).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });

    const zoomed = visibleRegionForView(
      { zoom: 2, centerX: 0.5, centerY: 0.5 },
      VIEWPORT,
      DISPLAY,
    );
    expect(zoomed.x).toBeCloseTo(0.25);
    expect(zoomed.y).toBeCloseTo(1 / 6);
    expect(zoomed.width).toBeCloseTo(0.5);
    expect(zoomed.height).toBeCloseTo(2 / 3);
  });

  it('clamps zoom and pan so the viewport cannot leave the remote display', () => {
    expect(clampRemoteView(
      { zoom: 20, centerX: -4, centerY: 3 },
      VIEWPORT,
      DISPLAY,
    )).toEqual({
      zoom: 4,
      centerX: 0.125,
      centerY: 5 / 6,
    });

    const panned = panRemoteView(
      { zoom: 2, centerX: 0.5, centerY: 0.5 },
      200,
      0,
      VIEWPORT,
      DISPLAY,
    );
    expect(panned.centerX).toBeCloseTo(0.25);
    expect(panned.centerY).toBeCloseTo(0.5);
  });

  it('keeps the remote point under the pinch focal point stable', () => {
    const focal = { x: 300, y: 150 };
    const before = mapRemotePoint(
      focal.x,
      focal.y,
      FIT_REMOTE_VIEW,
      VIEWPORT,
      DISPLAY,
    );
    const view = zoomRemoteViewAt(
      FIT_REMOTE_VIEW,
      2,
      focal.x,
      focal.y,
      VIEWPORT,
      DISPLAY,
    );
    const after = mapRemotePoint(focal.x, focal.y, view, VIEWPORT, DISPLAY);
    expect(after?.x).toBeCloseTo(before?.x ?? 0);
    expect(after?.y).toBeCloseTo(before?.y ?? 0);
  });

  it('maps relative input and overscanned decoded regions into one coordinate space', () => {
    const view = { zoom: 2, centerX: 0.5, centerY: 0.5 };
    expect(relativeRemoteDelta(40, -20, view, VIEWPORT, DISPLAY)).toEqual({
      dx: 80,
      dy: -40,
    });
    expect(remoteVideoLayout(
      { x: 0.2, y: 0.1, width: 0.6, height: 0.8 },
      view,
      VIEWPORT,
      DISPLAY,
    )).toEqual({
      left: -40,
      top: -30,
      width: 480,
      height: 360,
    });
  });
});
