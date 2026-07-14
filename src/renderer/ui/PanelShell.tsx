import { X } from 'lucide-react';
import { useId, type HTMLAttributes, type ReactNode } from 'react';

import { IconButton } from './Button';
import { classNames } from './utils';

export interface PanelShellProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  readonly as?: 'section' | 'aside' | 'div';
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly footer?: ReactNode;
  readonly onClose?: () => void;
  readonly closeLabel?: string;
  readonly busy?: boolean;
}

export function PanelShell({
  actions,
  as = 'section',
  busy = false,
  children,
  className,
  closeLabel = 'Close panel',
  description,
  footer,
  onClose,
  title,
  ...props
}: PanelShellProps): JSX.Element {
  const Component = as;
  const titleId = `ez-ui-panel-title-${useId()}`;
  const descriptionId = `ez-ui-panel-description-${useId()}`;
  return (
    <Component
      className={classNames('ez-ui-panel', className)}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      aria-busy={busy || undefined}
      {...props}
    >
      <header className="ez-ui-panel__header">
        <div className="ez-ui-panel__heading">
          <h2 id={titleId} className="ez-ui-panel__title">{title}</h2>
          {description && <p id={descriptionId} className="ez-ui-panel__description">{description}</p>}
        </div>
        {(actions || onClose) && (
          <div className="ez-ui-panel__actions">
            {actions}
            {onClose && <IconButton icon={X} aria-label={closeLabel} onClick={onClose} />}
          </div>
        )}
      </header>
      <div className="ez-ui-panel__body">{children}</div>
      {footer && <footer className="ez-ui-panel__footer">{footer}</footer>}
    </Component>
  );
}
