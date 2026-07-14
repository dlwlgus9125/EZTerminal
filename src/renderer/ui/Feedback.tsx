import {
  CircleAlert,
  CircleCheck,
  Info,
  Inbox,
  LoaderCircle,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { type HTMLAttributes, type ReactNode } from 'react';

import { classNames } from './utils';

export type SemanticVariant = 'neutral' | 'accent' | 'info' | 'success' | 'warning' | 'danger';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  readonly variant?: SemanticVariant;
  readonly size?: 'sm' | 'md';
}

export function Badge({ className, size = 'md', variant = 'neutral', ...props }: BadgeProps): JSX.Element {
  return <span className={classNames('ez-ui-badge', className)} data-size={size} data-variant={variant} {...props} />;
}

const STATUS_ICONS: Record<SemanticVariant | 'loading', LucideIcon> = {
  neutral: Info,
  accent: Info,
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
  loading: LoaderCircle,
};

export interface StatusProps extends HTMLAttributes<HTMLSpanElement> {
  readonly variant?: SemanticVariant | 'loading';
  readonly icon?: LucideIcon;
  readonly live?: 'off' | 'polite' | 'assertive';
}

export function Status({
  children,
  className,
  icon,
  live = 'off',
  variant = 'neutral',
  ...props
}: StatusProps): JSX.Element {
  const Icon = icon ?? STATUS_ICONS[variant];
  return (
    <span
      className={classNames('ez-ui-status', className)}
      data-variant={variant}
      role={live === 'off' ? undefined : live === 'assertive' ? 'alert' : 'status'}
      aria-live={live === 'off' ? undefined : live}
      {...props}
    >
      <Icon className={classNames('ez-ui-status__icon', variant === 'loading' && 'is-spinning')} aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}

interface StateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly icon?: LucideIcon;
}

export function EmptyState({
  action,
  className,
  description,
  icon: Icon = Inbox,
  title,
  ...props
}: StateProps): JSX.Element {
  return (
    <div className={classNames('ez-ui-state', className)} data-variant="empty" {...props}>
      <Icon className="ez-ui-state__icon" aria-hidden="true" />
      <h3 className="ez-ui-state__title">{title}</h3>
      {description && <p className="ez-ui-state__description">{description}</p>}
      {action && <div className="ez-ui-state__action">{action}</div>}
    </div>
  );
}

export interface LoadingStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  readonly label: ReactNode;
  readonly description?: ReactNode;
}

export function LoadingState({ className, description, label, ...props }: LoadingStateProps): JSX.Element {
  return (
    <div
      className={classNames('ez-ui-state', className)}
      data-variant="loading"
      role="status"
      aria-live="polite"
      aria-busy="true"
      {...props}
    >
      <LoaderCircle className="ez-ui-state__icon is-spinning" aria-hidden="true" />
      <h3 className="ez-ui-state__title">{label}</h3>
      {description && <p className="ez-ui-state__description">{description}</p>}
    </div>
  );
}

export function ErrorState({
  action,
  className,
  description,
  icon: Icon = TriangleAlert,
  title,
  ...props
}: StateProps): JSX.Element {
  return (
    <div className={classNames('ez-ui-state', className)} data-variant="error" role="alert" {...props}>
      <Icon className="ez-ui-state__icon" aria-hidden="true" />
      <h3 className="ez-ui-state__title">{title}</h3>
      {description && <p className="ez-ui-state__description">{description}</p>}
      {action && <div className="ez-ui-state__action">{action}</div>}
    </div>
  );
}
