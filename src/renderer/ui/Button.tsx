import { ChevronDown, LoaderCircle, type LucideIcon } from 'lucide-react';
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from 'react';

import { classNames } from './utils';
import { VisuallyHidden } from './VisuallyHidden';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly loading?: boolean;
  readonly loadingLabel?: string;
  readonly leadingIcon?: ReactNode;
  readonly trailingIcon?: ReactNode;
  readonly fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    children,
    className,
    disabled = false,
    fullWidth = false,
    leadingIcon,
    loading = false,
    loadingLabel = 'Loading',
    size = 'md',
    trailingIcon,
    type = 'button',
    variant = 'secondary',
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={classNames('ez-ui-button', className)}
      data-variant={variant}
      data-size={size}
      data-full-width={fullWidth || undefined}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <LoaderCircle className="ez-ui-button__spinner" aria-hidden="true" />
      ) : (
        leadingIcon && <span className="ez-ui-button__icon" aria-hidden="true">{leadingIcon}</span>
      )}
      <span className="ez-ui-button__label">{children}</span>
      {loading && <VisuallyHidden>{loadingLabel}</VisuallyHidden>}
      {!loading && trailingIcon && (
        <span className="ez-ui-button__icon" aria-hidden="true">{trailingIcon}</span>
      )}
    </button>
  );
});

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  readonly 'aria-label': string;
  readonly icon: LucideIcon;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly loading?: boolean;
  readonly loadingLabel?: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    'aria-label': ariaLabel,
    className,
    disabled = false,
    icon: Icon,
    loading = false,
    loadingLabel = 'Loading',
    size = 'md',
    type = 'button',
    variant = 'ghost',
    ...props
  },
  ref,
) {
  const accessibleLabel = loading ? `${ariaLabel}, ${loadingLabel}` : ariaLabel;
  return (
    <button
      ref={ref}
      type={type}
      className={classNames('ez-ui-icon-button', className)}
      data-variant={variant}
      data-size={size}
      disabled={disabled || loading}
      aria-label={accessibleLabel}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <LoaderCircle className="ez-ui-button__spinner" aria-hidden="true" />
      ) : (
        <Icon aria-hidden="true" />
      )}
    </button>
  );
});

export interface SplitButtonProps
  extends Omit<ButtonProps, 'trailingIcon' | 'onClick'> {
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly menuOpen: boolean;
  readonly onMenuOpenChange: (open: boolean) => void;
  readonly menuLabel: string;
  readonly menuControls?: string;
}

export const SplitButton = forwardRef<HTMLButtonElement, SplitButtonProps>(function SplitButton(
  {
    children,
    className,
    disabled = false,
    loading = false,
    menuControls,
    menuLabel,
    menuOpen,
    onClick,
    onMenuOpenChange,
    size = 'md',
    variant = 'secondary',
    ...props
  },
  ref,
) {
  return (
    <div className={classNames('ez-ui-split-button', className)} role="group">
      <Button
        ref={ref}
        className="ez-ui-split-button__primary"
        variant={variant}
        size={size}
        disabled={disabled}
        loading={loading}
        onClick={onClick}
        {...props}
      >
        {children}
      </Button>
      <IconButton
        className="ez-ui-split-button__menu"
        icon={ChevronDown}
        variant={variant}
        size={size}
        disabled={disabled || loading}
        aria-label={menuLabel}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuControls}
        onClick={() => onMenuOpenChange(!menuOpen)}
      />
    </div>
  );
});
