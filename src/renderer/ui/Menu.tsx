import {
  Check,
  type LucideIcon,
} from 'lucide-react';
import {
  cloneElement,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';

import { classNames, mergeRefs } from './utils';

interface MenuTriggerProps extends HTMLAttributes<HTMLElement> {
  readonly disabled?: boolean;
  readonly ref?: Ref<HTMLElement>;
}

interface MenuContextValue {
  readonly close: (restoreFocus?: boolean) => void;
}

const MenuContext = createContext<MenuContextValue | null>(null);

export interface MenuProps {
  readonly trigger: ReactElement<MenuTriggerProps>;
  readonly children: ReactNode;
  readonly label: string;
  readonly open?: boolean;
  readonly defaultOpen?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';
  readonly className?: string;
}

export function Menu({
  children,
  className,
  defaultOpen = false,
  label,
  onOpenChange,
  open,
  placement = 'bottom-start',
  trigger,
}: MenuProps): JSX.Element {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isOpen = open ?? uncontrolledOpen;
  const menuId = `ez-ui-menu-${useId()}`;
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerWithRef = trigger as ReactElement<MenuTriggerProps> & { ref?: Ref<HTMLElement> };

  const setOpen = useCallback((next: boolean): void => {
    if (open === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }, [onOpenChange, open]);
  const close = useCallback((restoreFocus = true): void => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }, [setOpen]);

  useEffect(() => {
    if (!isOpen) return;
    requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLElement>(
          '[role="menuitem"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)',
        )
        ?.focus();
    });
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && !rootRef.current?.contains(target)) close(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [close, isOpen]);

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)',
      ),
    );
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Tab') {
      close(false);
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && document.activeElement instanceof HTMLButtonElement) {
      event.preventDefault();
      document.activeElement.click();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || items.length === 0) return;
    event.preventDefault();
    const currentIndex = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[nextIndex].focus();
  };

  const triggerProps = trigger.props;
  const triggerNode = cloneElement(trigger, {
    ref: mergeRefs(triggerRef, triggerWithRef.ref),
    'aria-haspopup': 'menu',
    'aria-expanded': isOpen,
    'aria-controls': menuId,
    onClick: (event: ReactMouseEvent<HTMLElement>) => {
      triggerProps.onClick?.(event);
      if (!event.defaultPrevented && !triggerProps.disabled) setOpen(!isOpen);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      triggerProps.onKeyDown?.(event);
      if (event.defaultPrevented || triggerProps.disabled) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setOpen(true);
      }
    },
  });

  return (
    <MenuContext.Provider value={{ close }}>
      <span ref={rootRef} className={classNames('ez-ui-menu', className)} data-placement={placement}>
        {triggerNode}
        {isOpen && (
          <div
            ref={menuRef}
            id={menuId}
            className="ez-ui-menu__content"
            role="menu"
            aria-label={label}
            onKeyDown={handleMenuKeyDown}
          >
            {children}
          </div>
        )}
      </span>
    </MenuContext.Provider>
  );
}

export interface MenuItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  readonly icon?: LucideIcon;
  readonly destructive?: boolean;
  readonly onSelect: () => void;
}

export function MenuItem({
  children,
  className,
  destructive = false,
  disabled = false,
  icon: Icon,
  onSelect,
  ...props
}: MenuItemProps): JSX.Element {
  const menu = useContext(MenuContext);
  if (!menu) throw new Error('MenuItem must be used inside Menu');
  return (
    <button
      type="button"
      role="menuitem"
      className={classNames('ez-ui-menu-item', className)}
      data-destructive={destructive || undefined}
      disabled={disabled}
      tabIndex={-1}
      onClick={() => {
        if (disabled) return;
        onSelect();
        menu.close();
      }}
      {...props}
    >
      {Icon ? <Icon className="ez-ui-menu-item__icon" aria-hidden="true" /> : <span className="ez-ui-menu-item__icon" />}
      <span className="ez-ui-menu-item__label">{children}</span>
    </button>
  );
}

export interface MenuCheckboxItemProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'onClick' | 'role'> {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}

export function MenuCheckboxItem({
  checked,
  children,
  className,
  disabled = false,
  onCheckedChange,
  ...props
}: MenuCheckboxItemProps): JSX.Element {
  const menu = useContext(MenuContext);
  if (!menu) throw new Error('MenuCheckboxItem must be used inside Menu');
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      className={classNames('ez-ui-menu-item', className)}
      disabled={disabled}
      tabIndex={-1}
      onClick={() => {
        if (disabled) return;
        onCheckedChange(!checked);
      }}
      {...props}
    >
      <span className="ez-ui-menu-item__icon">{checked && <Check aria-hidden="true" />}</span>
      <span className="ez-ui-menu-item__label">{children}</span>
    </button>
  );
}

export function MenuLabel({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={classNames('ez-ui-menu-label', className)} {...props} />;
}

export function MenuSeparator({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={classNames('ez-ui-menu-separator', className)} role="separator" {...props} />;
}
