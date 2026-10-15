import type { ChatComposerDraft } from '../shared/chat-message';
import type { ChatRecoveryController, ChatRecoveryView } from './chat-recovery';
import { useAppTranslation } from './i18n';
import { Button } from './ui';

function DraftPreview({ draft }: { readonly draft: ChatComposerDraft }): JSX.Element {
  return <div className="structured-agent-recovery__preview">
    <p>{draft.text.slice(0, 1000)}{draft.text.length > 1000 ? '…' : ''}</p>
    {draft.replyTo && <blockquote>{draft.replyTo.text.slice(0, 240)}</blockquote>}
    {draft.attachments?.length ? <ul>{draft.attachments.map((attachment) => <li key={attachment.id}>{attachment.name}</li>)}</ul> : null}
  </div>;
}

export function ChatRecoveryNotice({ controller, view }: {
  readonly controller: ChatRecoveryController | null;
  readonly view: ChatRecoveryView;
}): JSX.Element | null {
  const { i18n } = useAppTranslation();
  const ko = i18n.language.startsWith('ko');
  if (view.status === 'ready' || view.status === 'loading') return null;
  return <aside className="structured-agent-recovery" aria-label={ko ? '초안 저장 복구' : 'Draft storage recovery'}>
    <p role="status">{view.status === 'conflict'
      ? ko ? '다른 창에서 초안이 변경되었습니다. 두 초안을 비교하고 유지할 내용을 선택하세요.' : 'Another window changed this draft. Compare both drafts and choose which to keep.'
      : ko ? '초안을 안전하게 저장하지 못했습니다. 현재 입력은 이 창에 유지됩니다. 저장 상태를 확인한 뒤 전송할 수 있습니다.' : 'The draft could not be saved securely. Your input remains in this window. Check stored state before sending.'}</p>
    {view.conflict && <div className="structured-agent-recovery__comparison">
      <div><strong>{ko ? '이 창의 초안' : 'This window'}</strong><DraftPreview draft={view.draft} /></div>
      <div><strong>{ko ? '저장된 초안' : 'Stored draft'}</strong><DraftPreview draft={view.conflict.state.draft} /></div>
    </div>}
    {view.conflict?.state.pendingSubmit && <p>{ko ? '저장된 전송 확인 대기 요청은 어느 초안을 선택해도 유지됩니다.' : 'The stored pending submission is preserved with either draft choice.'}</p>}
    <div className="structured-agent-recovery__actions">
      {view.conflict ? <>
        <Button size="sm" variant="secondary" onClick={() => void controller?.resolveConflict('local')}>{ko ? '이 창의 초안 유지' : 'Keep this draft'}</Button>
        <Button size="sm" variant="ghost" onClick={() => void controller?.resolveConflict('stored')}>{ko ? '저장된 초안 불러오기' : 'Load stored draft'}</Button>
      </> : <Button size="sm" variant="secondary" onClick={() => void controller?.checkStored()}>{ko ? '저장 상태 확인' : 'Check stored state'}</Button>}
    </div>
  </aside>;
}
