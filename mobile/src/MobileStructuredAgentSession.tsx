import { Glyph } from '../../src/renderer/ui';
import {
  StructuredAgentDraftPanel,
  StructuredAgentSessionPanel,
  type StructuredAgentDraftPanelProps,
  type StructuredAgentSessionPanelProps,
} from '../../src/renderer/StructuredAgentSession';
import { useAppTranslation } from '../../src/renderer/i18n';
import type { MobileChatSaveStatus } from './use-mobile-chat-draft';
import './mobile-v2.css';

export interface MobileStructuredAgentSessionProps
  extends Omit<StructuredAgentSessionPanelProps, 'variant'> {
  readonly onBack: () => void;
  readonly draftStorageStatus?: MobileChatSaveStatus;
  readonly onRetryDraftStorage?: () => void;
  readonly offlineRead?: boolean;
}

export function MobileStructuredAgentSession({
  onBack,
  draftStorageStatus,
  onRetryDraftStorage,
  offlineRead = false,
  recoveryControl,
  ...props
}: MobileStructuredAgentSessionProps): JSX.Element {
  const { t,i18n } = useAppTranslation();
  const ko=(i18n.resolvedLanguage ?? i18n.language).startsWith('ko');
  // One header row (I4): back · title · state · results · extensions · ⋯. The notes that used to
  // stack above it sit just above the message box, where they matter.
  const notes = (
    <>
      {recoveryControl}
      {offlineRead && <p className="mobile-v2-draft-status" data-kind="offline" role="status">{ko
        ? '오프라인 · 마지막으로 받은 대화를 표시합니다. 재시작 후에는 최근 저장한 일부만 보일 수 있습니다. 전체 원본은 PC 연결 후 불러옵니다.'
        : 'Offline · Showing previously received messages. After restart, only recently cached messages may be available. Reconnect to load the full transcript.'}</p>}
      {/* A provider-owned subagent has no composer, so it has no draft to report. */}
      {draftStorageStatus && !(props.owner === 'provider-native' && props.parent) && <p className="mobile-v2-draft-status" data-state={draftStorageStatus} role="status">
        {draftStorageStatus === 'loading' ? (ko ? '기기 초안 불러오는 중…' : 'Loading device draft…')
          : draftStorageStatus === 'saving' ? (ko ? '기기에 저장 중…' : 'Saving on this device…')
            : draftStorageStatus === 'unavailable' ? (ko ? '보안 저장소에 초안을 저장하지 못했습니다.' : 'The draft could not be saved securely.')
              : (ko ? '초안을 기기에 저장했습니다. 재연결 후 자동 전송하지 않습니다.' : 'Draft saved on this device. Reconnecting will not send it.')}
        {draftStorageStatus === 'unavailable' && onRetryDraftStorage && <button type="button" className="mob-btn-ghost" onClick={onRetryDraftStorage}>{t('common.retry')}</button>}
      </p>}
    </>
  );
  return (
    <main className="mob-page mob-structured-agent" data-testid="mobile-structured-agent-session">
      <StructuredAgentSessionPanel
        {...props}
        variant="mobile"
        compactHeader
        headerLeading={(
          <button type="button" className="mob-icon-btn mob-structured-agent__back" aria-label={t('common.back')} onClick={onBack} data-testid="mobile-structured-agent-back">
            <Glyph name="back" size={20} />
          </button>
        )}
        recoveryControl={notes}
      />
    </main>
  );
}

export interface MobileStructuredAgentDraftProps
  extends Omit<StructuredAgentDraftPanelProps, 'variant'> {
  readonly onBack: () => void;
}

export function MobileStructuredAgentDraft({
  onBack,
  ...props
}: MobileStructuredAgentDraftProps): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <main className="mob-page mob-structured-agent" data-testid="mobile-structured-agent-draft">
      <div className="mob-structured-agent__navigation">
        <button type="button" className="mob-icon-btn" aria-label={t('common.back')} onClick={onBack}>
          <Glyph name="back" size={20} />
        </button>
        <span>{t('rail.agents')}</span>
      </div>
      <StructuredAgentDraftPanel {...props} variant="mobile" />
    </main>
  );
}
