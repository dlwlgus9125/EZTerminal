import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { FileDiff, X } from 'lucide-react';
import type { DaemonTranscriptItem } from '../shared/daemon-protocol';
import { conversationFileChanges, reviewLines } from '../shared/conversation-changes';
import { Button, Dialog, Select } from './ui';
import { useAppTranslation } from './i18n';
import { readSessionViewState, saveSessionViewState } from './session-view-state';
import { ConversationReviewOverlayContext } from './conversation-review-overlay';

interface ReviewState { open: boolean; scope: 'latest' | 'all'; selected?: string; reviewed: string[]; range?: [number, number] }
export function ConversationChangeReview({ sessionId, items, wide, mobile, ownerDocument, onQuote, onOpenProjectFiles, onAsideChange }: {
  sessionId: string; items: readonly DaemonTranscriptItem[]; wide: boolean; mobile: boolean; ownerDocument?: Document; onQuote?: (text: string) => void; onOpenProjectFiles?: () => void;
  /** Reports whether the review is docked beside the transcript, so the panel can reserve room without :has(). */
  onAsideChange?: (open: boolean) => void;
}): JSX.Element {
  const { i18n } = useAppTranslation(); const ko = i18n.language.startsWith('ko');
  const HostOverlay = useContext(ConversationReviewOverlayContext);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const key = `conversation-review:${sessionId}`;
  const [state, setState] = useState<ReviewState>(() => readSessionViewState<ReviewState>(key) ?? { open: false, scope: 'latest', reviewed: [] });
  const [lineLimit, setLineLimit] = useState(400);
  const asideOpen = wide && state.open;
  useEffect(() => { onAsideChange?.(asideOpen); }, [asideOpen, onAsideChange]);
  const update = (patch: Partial<ReviewState>): void => setState(current => { const next = { ...current, ...patch }; saveSessionViewState(key, next); return next; });
  const changes = useMemo(() => conversationFileChanges(items, sessionId), [items, sessionId]);
  const latestTurn = changes.at(-1)?.turnId;
  const visible = changes.filter(change => state.scope === 'all' || change.turnId === latestTurn);
  const selected = visible.find(change => change.id === state.selected) ?? visible[0];
  const lines = useMemo(() => selected ? reviewLines(selected) : [], [selected]);
  const range = state.range;
  const start = range ? Math.min(...range) : 0; const end = range ? Math.max(...range) : -1;
  const quote = selected && range ? `Recorded change: ${selected.path}\n${selected.coverage === 'fragment' ? 'Partial operation record' : 'Provider patch'} · ${selected.id}\n${lines.slice(start, end + 1).map(line => `> ${line.before ?? ''}\t${line.after ?? ''}\t${line.text}`).join('\n')}` : '';
  const title = ko ? '변경 검토' : 'Review changes';
  const content = <div className="conversation-review" data-testid="conversation-change-review">
    <div className="conversation-review__toolbar"><Select aria-label={ko ? '변경 범위' : 'Change scope'} value={state.scope} onChange={event => update({ scope: event.target.value as ReviewState['scope'], selected: undefined, range: undefined })}>
      <option value="latest">{ko ? '최근 변경 턴' : 'Latest changed turn'}</option><option value="all">{ko ? '이 대화 전체' : 'This conversation'}</option>
    </Select>{wide && <Button variant="ghost" aria-label={ko ? '검토 닫기' : 'Close review'} onClick={() => update({ open: false })}><X /></Button>}</div>
    <p className="conversation-review__notice">{ko ? 'AI가 보고한 변경 기록입니다. 현재 작업 폴더 전체의 변경과 다를 수 있습니다.' : 'Changes reported by the AI. These may differ from the current working tree.'}</p>
    {onOpenProjectFiles && <Button variant="ghost" size="sm" onClick={() => { update({ open: false }); onOpenProjectFiles(); }}>{ko ? '현재 프로젝트 파일 열기' : 'Open current project files'}</Button>}
    {!visible.length && <p role="status">{ko ? '이 대화에서 확인 가능한 변경 패치가 없습니다.' : 'No recorded patches are available in this conversation.'}</p>}
    <ul className="conversation-review__files">{visible.map(change => <li key={change.id}><Button variant="ghost" aria-pressed={selected?.id === change.id} onClick={() => update({ selected: change.id, range: undefined })}>
      <FileDiff aria-hidden="true" /><span>{change.path}</span>{state.reviewed.includes(change.id) && <span>{ko ? '확인함' : 'Reviewed'}</span>}
    </Button></li>)}</ul>
    {selected && <><p>{selected.coverage === 'fragment' ? (ko ? '부분 기록 · 파일 줄 번호는 제공되지 않았습니다.' : 'Partial record · file line numbers were not supplied.') : (ko ? '기록된 패치 · 왼쪽은 변경 전, 오른쪽은 변경 후 줄 번호입니다.' : 'Recorded patch · before and after line numbers.')} {ko ? 'Shift로 여러 줄 선택' : 'Shift to select a range'}</p>
      <div className="conversation-review__patch" role="group" aria-label={selected.path}>
        {lines.slice(0, lineLimit).map((line, index) => <button key={index} type="button" className="conversation-review__line" data-kind={line.kind} aria-pressed={!!range && index >= start && index <= end}
          onClick={event => update({ selected: selected.id, range: event.shiftKey && range ? [range[0], index] : [index, index] })}>
          <span className="conversation-review__number">{line.before ?? ''}</span><span className="conversation-review__number">{line.after ?? ''}</span><code>{line.text || ' '}</code>
        </button>)}
      </div>
      {lines.length > lineLimit && <Button variant="ghost" onClick={() => setLineLimit(value => value + 400)}>{ko ? '패치 더 보기' : 'Show more patch lines'}</Button>}
      <div className="conversation-review__toolbar"><Button variant="ghost" onClick={() => update({ reviewed: state.reviewed.includes(selected.id) ? state.reviewed.filter(id => id !== selected.id) : [...state.reviewed, selected.id] })}>
        {state.reviewed.includes(selected.id) ? (ko ? '미확인으로 표시' : 'Mark unread') : (ko ? '확인함으로 표시' : 'Mark reviewed')}
      </Button>{onQuote && <Button disabled={!quote || quote.length > 4000} onClick={() => { onQuote(`${quote}\n\n`); if (!wide) update({ open: false }); }}>{ko ? '선택한 줄 인용' : 'Quote selected lines'}</Button>}</div>
      {quote.length > 4000 && <p role="status">{ko ? '인용할 줄을 4,000자 이내로 줄여 주세요.' : 'Select fewer lines (up to 4,000 characters).'}</p>}
    </>}
  </div>;
  return <>
    <Button ref={triggerRef} className="conversation-review__trigger" variant="ghost" size="sm" leadingIcon={<FileDiff />} aria-expanded={state.open} onClick={() => update({ open: !state.open })}>{title}{changes.length ? ` · ${changes.length}` : ''}</Button>
    {mobile && HostOverlay ? state.open && <HostOverlay title={title} onClose={() => update({ open: false })} returnFocusRef={triggerRef}>{content}</HostOverlay>
      : wide && state.open ? <aside className="conversation-review__aside" aria-label={title}>{content}</aside> : <Dialog open={state.open} onOpenChange={open => update({ open })} title={title} ownerDocument={ownerDocument} variant={mobile ? 'sheet' : 'dialog'} size="lg" closeLabel={ko ? '닫기' : 'Close'}>{content}</Dialog>}
  </>;
}
