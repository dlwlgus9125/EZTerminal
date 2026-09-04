import { ChevronLeft } from 'lucide-react';

import {
  StructuredAgentDraftPanel,
  StructuredAgentSessionPanel,
  type StructuredAgentDraftPanelProps,
  type StructuredAgentSessionPanelProps,
} from '../../src/renderer/StructuredAgentSession';
import { useAppTranslation } from '../../src/renderer/i18n';

export interface MobileStructuredAgentSessionProps
  extends Omit<StructuredAgentSessionPanelProps, 'variant'> {
  readonly onBack: () => void;
}

export function MobileStructuredAgentSession({
  onBack,
  ...props
}: MobileStructuredAgentSessionProps): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <main className="mob-page mob-structured-agent" data-testid="mobile-structured-agent-session">
      <div className="mob-structured-agent__navigation">
        <button type="button" className="mob-icon-btn" aria-label={t('common.back')} onClick={onBack}>
          <ChevronLeft aria-hidden="true" />
        </button>
        <span>{t('rail.agents')}</span>
      </div>
      <StructuredAgentSessionPanel {...props} variant="mobile" />
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
          <ChevronLeft aria-hidden="true" />
        </button>
        <span>{t('rail.agents')}</span>
      </div>
      <StructuredAgentDraftPanel {...props} variant="mobile" />
    </main>
  );
}
