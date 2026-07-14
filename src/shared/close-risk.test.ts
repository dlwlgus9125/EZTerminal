import { describe, expect, it } from 'vitest';

import {
  classifyCloseRisk,
  countCloseRisks,
  planPaneClose,
  sameActiveRunSet,
} from './close-risk';

const BASE = {
  destroysSession: true,
  isBusy: true,
  executionKind: 'local' as const,
  hasSshPrompt: false,
  hasActiveAgent: false,
};

describe('classifyCloseRisk', () => {
  it('does not guard adopted mirrors, dead sessions, or known-idle creator panes', () => {
    expect(classifyCloseRisk({ ...BASE, destroysSession: false })).toBeNull();
    expect(classifyCloseRisk({ ...BASE, isDead: true })).toBeNull();
    expect(classifyCloseRisk({ ...BASE, isBusy: false })).toBeNull();
  });

  it('classifies each destructive activity and fails closed for an old/unknown run', () => {
    expect(classifyCloseRisk({ ...BASE, hasSshPrompt: true })).toBe('ssh-prompt');
    expect(classifyCloseRisk({ ...BASE, hasActiveAgent: true })).toBe('active-agent');
    expect(classifyCloseRisk({ ...BASE, executionKind: 'ssh' })).toBe('ssh-active');
    expect(classifyCloseRisk(BASE)).toBe('running-command');
    expect(classifyCloseRisk({ ...BASE, executionKind: null })).toBe('unknown');
  });

  it('counts aggregate preset risks without losing zero-valued categories', () => {
    expect(countCloseRisks(['running-command', 'running-command', 'ssh-active'])).toEqual({
      'ssh-prompt': 0,
      'active-agent': 0,
      'ssh-active': 1,
      'running-command': 2,
      unknown: 0,
    });
  });
});

describe('sameActiveRunSet', () => {
  it('ignores order and duplicates but rejects additions and replacements', () => {
    expect(sameActiveRunSet(['run-b', 'run-a'], ['run-a', 'run-b'])).toBe(true);
    expect(sameActiveRunSet(['run-a', 'run-a'], ['run-a'])).toBe(true);
    expect(sameActiveRunSet(['run-a'], ['run-a', 'run-b'])).toBe(false);
    expect(sameActiveRunSet(['run-a'], ['run-b'])).toBe(false);
  });
});

describe('planPaneClose', () => {
  it('blocks an unavailable pane snapshot regardless of the confirmation preference', () => {
    expect(planPaneClose(null, true)).toEqual({ kind: 'blocked' });
    expect(planPaneClose(null, false)).toEqual({ kind: 'blocked' });
  });

  it('confirms known risky state only when enabled, while known-safe state closes', () => {
    expect(planPaneClose(BASE, true)).toEqual({ kind: 'confirm', risk: 'running-command' });
    expect(planPaneClose(BASE, false)).toEqual({ kind: 'close' });
    expect(planPaneClose({ ...BASE, isBusy: false }, true)).toEqual({ kind: 'close' });
  });
});
