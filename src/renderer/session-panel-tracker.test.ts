import { describe, expect, it, vi } from 'vitest';

import { SessionPanelTracker } from './session-panel-tracker';

describe('SessionPanelTracker', () => {
  it('keeps every pane bound to the same session and disposes them independently', () => {
    const tracker = new SessionPanelTracker();
    const firstToken = {};
    const secondToken = {};
    const first = tracker.mountPane('panel-1', firstToken);
    const second = tracker.mountPane('panel-2', secondToken, 'session-1');

    expect(first.bind('session-1')).toBe(true);
    expect(second.bind('session-1')).toBe(true);
    expect(tracker.getBound('session-1')).toEqual([
      { panelId: 'panel-1', instanceToken: firstToken },
      { panelId: 'panel-2', instanceToken: secondToken },
    ]);

    second.dispose();
    expect(tracker.getBound('session-1')).toEqual([
      { panelId: 'panel-1', instanceToken: firstToken },
    ]);
  });

  it('does not let cleanup from an old instance delete a reused panel id', () => {
    const tracker = new SessionPanelTracker();
    const oldToken = {};
    const replacementToken = {};
    const oldLease = tracker.mountPane('panel-reused', oldToken, 'session-1');
    const replacementLease = tracker.mountPane('panel-reused', replacementToken, 'session-1');

    expect(oldLease.bind('session-1')).toBe(true);
    expect(replacementLease.bind('session-1')).toBe(true);
    oldLease.dispose();

    expect(tracker.getBound('session-1')).toEqual([
      { panelId: 'panel-reused', instanceToken: replacementToken },
    ]);
  });

  it('removes an unbound pending adoption on dispose and rejects a late bind', () => {
    const tracker = new SessionPanelTracker();
    const token = {};
    tracker.trackPending('session-1', 'panel-1', token);
    const lease = tracker.mountPane('panel-1', token, 'session-1');
    expect(tracker.hasSession('session-1')).toBe(true);

    lease.dispose();
    expect(tracker.hasSession('session-1')).toBe(false);
    expect(lease.bind('session-1')).toBe(false);
  });

  it('retains a fallback creator under the requested pending session until removal', () => {
    const tracker = new SessionPanelTracker();
    const token = {};
    tracker.trackPending('requested-session', 'panel-1', token);
    const lease = tracker.mountPane('panel-1', token, 'requested-session');

    expect(lease.bind('fallback-session')).toBe(true);
    expect(tracker.getPending('requested-session')).toEqual([
      { panelId: 'panel-1', instanceToken: token },
    ]);
    expect(tracker.getBound('fallback-session')).toEqual([
      { panelId: 'panel-1', instanceToken: token },
    ]);
  });

  it('keeps a restored or manually adopted fallback as an ordinary fresh pane', () => {
    const tracker = new SessionPanelTracker();
    const token = {};
    const lease = tracker.mountPane('restored-panel', token, 'stale-session');

    expect(lease.bind('fresh-session')).toBe(true);
    expect(tracker.getPending('stale-session')).toEqual([]);
    expect(tracker.getBound('fresh-session')).toEqual([
      { panelId: 'restored-panel', instanceToken: token },
    ]);
  });

  it('takes every exact pending and bound pane for an external removal', () => {
    const onBoundChange = vi.fn();
    const tracker = new SessionPanelTracker(onBoundChange);
    const firstToken = {};
    const secondToken = {};
    const pendingToken = {};
    tracker.mountPane('panel-1', firstToken).bind('session-1');
    tracker.mountPane('panel-2', secondToken, 'session-1').bind('session-1');
    tracker.trackPending('session-1', 'panel-pending', pendingToken);

    expect(tracker.takeSession('session-1')).toEqual({
      bound: [
        { panelId: 'panel-1', instanceToken: firstToken },
        { panelId: 'panel-2', instanceToken: secondToken },
      ],
      pending: [{ panelId: 'panel-pending', instanceToken: pendingToken }],
    });
    expect(tracker.hasSession('session-1')).toBe(false);
    expect(onBoundChange).toHaveBeenCalledTimes(3);
  });

  it('is stable across a StrictMode-style mount/dispose/remount cycle', () => {
    const tracker = new SessionPanelTracker();
    const token = {};
    tracker.trackPending('session-1', 'panel-1', token);
    tracker.mountPane('panel-1', token, 'session-1').dispose();
    const liveLease = tracker.mountPane('panel-1', token, 'session-1');

    expect(tracker.getPending('session-1')).toEqual([
      { panelId: 'panel-1', instanceToken: token },
    ]);
    expect(liveLease.bind('session-1')).toBe(true);
    expect(tracker.getPending('session-1')).toEqual([]);
  });
});
