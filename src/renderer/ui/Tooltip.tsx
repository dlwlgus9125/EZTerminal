import {
  cloneElement,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';

import { classNames } from './utils';

interface TooltipTriggerProps extends HTMLAttributes<HTMLElement> {
  readonly 'aria-describedby'?: string;
}

export interface TooltipProps {
  readonly children: ReactElement<TooltipTriggerProps>;
  readonly content: ReactNode;
  readonly side?: 'top' | 'right' | 'bottom' | 'left';
  readonly delay?: number;
  readonly className?: string;
}

export function Tooltip({
  children,
  className,
  content,
  delay = 350,
  side = 'top',
}: TooltipProps): JSX.Element {
  const tooltipId = `ez-ui-tooltip-${useId()}`;
  const [open, setOpen] = useState(false);
  const timerRef = useRef<number | null>(null);

  const clearTimer = (): void => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  const showWithDelay = (): void => {
    clearTimer();
    timerRef.current = window.setTimeout(() => setOpen(true), delay);
  };
  const hide = (): void => {
    clearTimer();
    setOpen(false);
  };

  useEffect(() => clearTimer, []);

  const triggerProps = children.props;
  const describedBy = [triggerProps['aria-describedby'], tooltipId].filter(Boolean).join(' ');
  const trigger = cloneElement(children, {
    'aria-describedby': describedBy,
    onMouseEnter: (event: MouseEvent<HTMLElement>) => {
      triggerProps.onMouseEnter?.(event);
      if (!event.defaultPrevented) showWithDelay();
    },
    onMouseLeave: (event: MouseEvent<HTMLElement>) => {
      triggerProps.onMouseLeave?.(event);
      hide();
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      triggerProps.onFocus?.(event);
      if (!event.defaultPrevented) {
        clearTimer();
        setOpen(true);
      }
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      triggerProps.onBlur?.(event);
      hide();
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      triggerProps.onKeyDown?.(event);
      if (event.key === 'Escape') hide();
    },
  });

  return (
    <span className={classNames('ez-ui-tooltip', className)} data-side={side}>
      {trigger}
      {open && (
        <span id={tooltipId} className="ez-ui-tooltip__content" role="tooltip">
          {content}
        </span>
      )}
    </span>
  );
}
