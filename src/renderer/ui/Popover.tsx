import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type Ref,
} from 'react';

import { classNames, getFocusableElements, mergeRefs } from './utils';

interface PopoverTriggerProps extends HTMLAttributes<HTMLElement> {
  readonly disabled?: boolean;
  readonly ref?: Ref<HTMLElement>;
}

export interface PopoverProps {
  readonly trigger: ReactElement<PopoverTriggerProps>;
  readonly children: React.ReactNode;
  readonly open?: boolean;
  readonly defaultOpen?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';
  readonly ariaLabel: string;
  readonly className?: string;
  readonly contentClassName?: string;
  readonly initialFocus?: boolean;
}

export function Popover({
  ariaLabel,
  children,
  className,
  contentClassName,
  defaultOpen = false,
  initialFocus = false,
  onOpenChange,
  open,
  placement = 'bottom-start',
  trigger,
}: PopoverProps): JSX.Element {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isOpen = open ?? uncontrolledOpen;
  const contentId = `ez-ui-popover-${useId()}`;
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const triggerWithRef = trigger as ReactElement<PopoverTriggerProps> & { ref?: Ref<HTMLElement> };

  const setOpen = useCallback((next: boolean): void => {
    if (open === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }, [onOpenChange, open]);

  useEffect(() => {
    if (!isOpen) return;
    if (initialFocus) {
      requestAnimationFrame(() => {
        const content = contentRef.current;
        if (!content) return;
        (getFocusableElements(content)[0] ?? content).focus();
      });
    }
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && !rootRef.current?.contains(target)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      requestAnimationFrame(() => triggerRef.current?.focus());
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [initialFocus, isOpen, setOpen]);

  const triggerProps = trigger.props;
  const triggerNode = cloneElement(trigger, {
    ref: mergeRefs(triggerRef, triggerWithRef.ref),
    'aria-haspopup': 'dialog',
    'aria-expanded': isOpen,
    'aria-controls': contentId,
    onClick: (event: ReactMouseEvent<HTMLElement>) => {
      triggerProps.onClick?.(event);
      if (!event.defaultPrevented && !triggerProps.disabled) setOpen(!isOpen);
    },
  });

  return (
    <span ref={rootRef} className={classNames('ez-ui-popover', className)} data-placement={placement}>
      {triggerNode}
      {isOpen && (
        <div
          ref={contentRef}
          id={contentId}
          className={classNames('ez-ui-popover__content', contentClassName)}
          role="dialog"
          aria-label={ariaLabel}
          tabIndex={-1}
        >
          {children}
        </div>
      )}
    </span>
  );
}
