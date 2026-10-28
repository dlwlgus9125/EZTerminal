import { Button } from '../ui';
import { Glyph, Led } from '../ui/Glyph';
import './settings-change.css';

/** A setting this conversation's AI changed directly (cosmetic, agents, workflows): kept with undo. */
export interface SettingsChangeEntry {
  readonly id: string;
  /** e.g. "테마: Matrix → Light". */
  readonly label: string;
  readonly at: string;
  readonly undone?: boolean;
  /** Someone changed it again since: undo would overwrite their change. */
  readonly conflict?: boolean;
}
/** A setting the AI may only propose (remote access, permissions, automation): a person applies it. */
export interface SettingsProposalEntry {
  readonly id: string;
  readonly title: string;
  readonly rows: readonly { readonly name: string; readonly before: string; readonly after: string }[];
  /** What changes for safety, in one sentence. */
  readonly risk: string;
  /** Only the PC can apply it (remote access, start at login, provider enable). */
  readonly desktopOnly?: boolean;
}

export interface SettingsChangeTrackProps {
  readonly ko: boolean;
  readonly changes: readonly SettingsChangeEntry[];
  readonly proposals: readonly SettingsProposalEntry[];
  /** Phones see PC-only proposals but cannot apply them. */
  readonly onPhone?: boolean;
  readonly onUndo?: (id: string) => void;
  readonly onApply?: (id: string) => void;
  readonly onDecline?: (id: string) => void;
  readonly onOpenSettings?: () => void;
}

/**
 * Above the input box: proposals that wait for the person (amber, like every decision) and the
 * settings the AI already changed in this conversation, each with 되돌리기.
 */
export function SettingsChangeTrack({ ko, changes, proposals, onPhone = false, onUndo, onApply, onDecline, onOpenSettings }: SettingsChangeTrackProps): JSX.Element | null {
  const text = (korean: string, english: string): string => ko ? korean : english;
  if (!changes.length && !proposals.length) return null;
  return <section className="settings-change-track" aria-label={text('AI가 바꾼 설정', 'Settings the AI changed')} data-testid="settings-change-track">
    {proposals.map(proposal => <div key={proposal.id} className="settings-proposal" role="group" aria-label={proposal.title} data-testid="settings-proposal">
      <p className="settings-proposal__head"><Led tone="amber" /><span>{text('확인 필요', 'Needs you')}</span><strong>{proposal.title}</strong></p>
      <table className="settings-proposal__rows">
        <thead><tr><th scope="col">{text('설정', 'Setting')}</th><th scope="col">{text('지금', 'Now')}</th><th scope="col">{text('바꾸면', 'After')}</th></tr></thead>
        <tbody>{proposal.rows.map(row => <tr key={row.name}><th scope="row">{row.name}</th><td>{row.before}</td><td>{row.after}</td></tr>)}</tbody>
      </table>
      <p className="settings-proposal__risk"><Glyph name="warn" />{proposal.risk}</p>
      <div className="settings-proposal__actions">
        {onPhone && proposal.desktopOnly
          ? <p className="settings-proposal__pc">{text('이 설정은 PC에서만 적용할 수 있습니다.', 'Only the PC can apply this setting.')}</p>
          : <Button size="sm" variant="primary" onClick={() => onApply?.(proposal.id)}>{text('적용', 'Apply')}</Button>}
        <Button size="sm" onClick={() => onDecline?.(proposal.id)}>{text('거절', 'Decline')}</Button>
        {onOpenSettings && <Button size="sm" variant="ghost" leadingIcon={<Glyph name="set" />} onClick={onOpenSettings}>{text('설정에서 보기', 'Open in Settings')}</Button>}
      </div>
    </div>)}
    {changes.length > 0 && <div className="settings-changes">
      <p className="settings-changes__head"><Glyph name="set" /><span>{text('이 대화에서 AI가 바꾼 설정', 'Changed by the AI in this conversation')}</span></p>
      <ul className="settings-changes__list">{changes.map(change => <li key={change.id} data-undone={change.undone || undefined}>
        <span className="settings-changes__label">{change.label}</span>
        <time className="settings-changes__at">{change.at}</time>
        {change.undone
          ? <span className="settings-changes__state">{text('되돌림', 'Undone')}</span>
          : <Button size="sm" variant="ghost" leadingIcon={<Glyph name="undo" />} onClick={() => onUndo?.(change.id)}
            title={change.conflict ? text('그 뒤 다른 곳에서 바뀌었습니다. 되돌리면 그 변경을 덮어씁니다.', 'Changed elsewhere since; undoing overwrites that change.') : undefined}>{text('되돌리기', 'Undo')}</Button>}
      </li>)}</ul>
    </div>}
  </section>;
}
