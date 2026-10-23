import { describe, expect, it } from 'vitest';

import { liveReportVerdict } from '../scripts/live-report-verdict.mjs';

describe('live report verdict', () => {
  it('passes only when every requested scenario completed without an error or skip', () => {
    const verdict = liveReportVerdict([
      { scenario: 'codex-commands', sessionId: 's1' },
      { scenario: 'codex-commands', completed: true },
      { shot: 'claude-plan-done' },
      { scenario: 'claude-plan', completed: true },
    ], { requested: ['codex-commands', 'claude-plan'] });

    expect(verdict).toEqual({ ok: true, failures: [] });
  });

  it('fails on a recorded scenario error, a skip, a scenario that never ran and an unknown name', () => {
    const verdict = liveReportVerdict([
      { scenario: 'codex-commands', error: 'approval never arrived' },
      { scenario: 'claude-plan', skipped: 'claude is not enabled and ready' },
      { scenario: 'claude-plan', completed: true },
    ], { requested: ['codex-commands', 'claude-plan', 'agent-worktree'], unknown: ['agent-wortree'] });

    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toEqual([
      'unknown scenario name: agent-wortree',
      'codex-commands: approval never arrived',
      'claude-plan: skipped (claude is not enabled and ready)',
      'agent-worktree: did not run',
    ]);
  });

  it('accepts skips only when the caller allowed them', () => {
    const report = [
      { scenario: 'claude-plan', skipped: 'claude is not enabled and ready' },
      { scenario: 'claude-plan', completed: true },
    ];

    expect(liveReportVerdict(report, { requested: ['claude-plan'], allowSkips: true }).ok).toBe(true);
  });
});
