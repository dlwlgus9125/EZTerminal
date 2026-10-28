import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { DaemonApproval } from '../shared/daemon-protocol';
import {
  isSettingsProposalRequest,
  settingsChangeLine,
  settingsEditLabel,
  type SettingsChangesAccess,
  type SettingsConversationView,
} from '../shared/settings-changes';
import { SettingsChangeTrack, type SettingsChangeEntry, type SettingsProposalEntry } from './chat/SettingsChangeTrack';

function clock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.valueOf()) ? '' : `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * 대화로 설정 바꾸기, in one conversation: what its AI changed (with 되돌리기, or 차이 보기 when it changed
 * since) and what became of its proposals. A pending proposal is decided in the approval dock, which
 * reads its rows from `proposal`.
 */
export function useConversationSettings(input: {
  readonly sessionId: string;
  readonly approvals: readonly DaemonApproval[];
  readonly korean: boolean;
  readonly access?: SettingsChangesAccess;
}): { readonly track?: ReactNode; readonly proposal: (approvalId: string) => SettingsProposalEntry | undefined } {
  const { sessionId, approvals, korean, access } = input;
  const [view, setView] = useState<SettingsConversationView | null>(null);
  const [diffs, setDiffs] = useState<ReadonlySet<string>>(() => new Set());
  // A proposal raised, decided or expired shows up as an approval change.
  const approvalKey = approvals.filter((approval) => isSettingsProposalRequest(approval.providerRequestId))
    .map((approval) => `${approval.id}:${approval.state}`).join('|');

  const refresh = useCallback(() => {
    if (!access || !sessionId) return;
    void access.conversation(sessionId).then(setView).catch(() => undefined);
  }, [access, sessionId]);
  useEffect(() => { refresh(); }, [refresh, approvalKey]);
  useEffect(() => access?.onChanged(() => refresh()), [access, refresh]);
  useEffect(() => { setView(null); setDiffs(new Set()); }, [sessionId]);

  const ko = korean;
  const byApproval = useMemo(() => new Map(approvals.map((approval) => [approval.id, approval])), [approvals]);
  const proposals = useMemo(() => view?.proposals ?? [], [view]);

  const pendingEntry = useCallback((approvalId: string): SettingsProposalEntry | undefined => {
    const proposal = proposals.find((entry) => entry.approvalId === approvalId);
    return proposal ? { id: proposal.id, title: proposal.title, rows: proposal.rows, risk: proposal.risk, desktopOnly: proposal.desktopOnly } : undefined;
  }, [proposals]);

  const changes: SettingsChangeEntry[] = (view?.changes ?? []).map((change) => {
    const row = settingsEditLabel(change, ko);
    const value = (raw: unknown): string => settingsEditLabel({ ...change, before: raw, after: raw }, ko).after;
    return {
      id: change.id,
      label: settingsChangeLine(row),
      at: clock(change.at),
      ...(change.undone ? { undone: true } : {}),
      ...(change.conflict ? { conflict: true } : {}),
      ...(change.conflict && diffs.has(change.id) ? { diff: { before: row.before, after: row.after, current: value(change.current) } } : {}),
    };
  });
  // The dock decides a pending proposal; here: applying, failed, decided on another device, expired.
  const outcomes: SettingsProposalEntry[] = proposals.flatMap((proposal): SettingsProposalEntry[] => {
    const approval = byApproval.get(proposal.approvalId);
    const base = { id: proposal.id, title: proposal.title, rows: proposal.rows, risk: proposal.risk, desktopOnly: proposal.desktopOnly };
    if (proposal.state === 'applying') return [{ ...base, state: 'applying' }];
    if (proposal.state === 'failed') return [{ ...base, state: 'failed', ...(proposal.detail ? { detail: proposal.detail } : {}) }];
    if ((proposal.state === 'applied' || proposal.state === 'declined') && proposal.resolvedBy === 'android') {
      return [{ ...base, state: 'resolved-elsewhere', detail: proposal.state === 'applied' ? (ko ? '폰에서 적용' : 'applied on the phone') : (ko ? '폰에서 거절' : 'declined on the phone') }];
    }
    if (proposal.state === 'pending' && approval?.state === 'expired') return [{ ...base, state: 'expired' }];
    return [];
  });

  const undo = useCallback((id: string) => {
    if (!access) return;
    void access.undo(id).catch(() => undefined).finally(refresh);
  }, [access, refresh]);
  const toggleDiff = useCallback((id: string) => {
    setDiffs((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const track = access && (changes.length > 0 || outcomes.length > 0)
    ? <SettingsChangeTrack ko={ko} changes={changes} proposals={outcomes} onUndo={undo} onShowDiff={toggleDiff} />
    : undefined;
  return { ...(track ? { track } : {}), proposal: pendingEntry };
}
