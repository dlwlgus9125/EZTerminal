import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';

import { IconButton } from '../../src/renderer/ui';

export function MobilePageHeader({
  title,
  status,
  actions,
  backLabel,
  backTestId = 'mobile-page-back',
  onBack,
}: {
  readonly title: ReactNode;
  readonly status?: ReactNode;
  readonly actions?: ReactNode;
  readonly backLabel: string;
  readonly backTestId?: string;
  readonly onBack: () => void;
}): JSX.Element {
  return (
    <header className="mobile-page-header">
      <IconButton
        icon={ArrowLeft}
        size="md"
        variant="ghost"
        aria-label={backLabel}
        onClick={onBack}
        data-testid={backTestId}
      />
      <div className="mobile-page-header__heading">
        <h1 className="mobile-page-header__title">{title}</h1>
        {status && <div className="mobile-page-header__status">{status}</div>}
      </div>
      {actions && <div className="mobile-page-header__actions">{actions}</div>}
    </header>
  );
}
