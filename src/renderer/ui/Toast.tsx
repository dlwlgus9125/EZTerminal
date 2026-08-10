import {
  CircleAlert,
  CircleCheck,
  Info,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { getActiveAppDocument } from '../desktop-window-registry';
import { useNativeOverlayRegistration } from '../native-overlay';
import { IconButton } from './Button';
import { classNames } from './utils';

export type ToastVariant = 'info' | 'success' | 'warning' | 'danger';

export interface ToastOptions {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly variant?: ToastVariant;
  readonly action?: ReactNode;
  /** Milliseconds before dismissal. Set to 0 to keep the toast until dismissed. */
  readonly duration?: number;
}

interface ToastRecord extends ToastOptions {
  readonly id: string;
  readonly ownerDocument: Document;
}

interface ToastContextValue {
  readonly pushToast: (options: ToastOptions, ownerDocument?: Document) => string;
  readonly dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);
let toastSequence = 0;

const TOAST_ICONS: Record<ToastVariant, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
};

export interface ToastProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'>, ToastOptions {
  readonly onDismiss?: () => void;
  readonly dismissLabel?: string;
  readonly ownerDocument?: Document;
}

export function Toast({
  action,
  className,
  description,
  dismissLabel = 'Dismiss notification',
  duration = 4200,
  onDismiss,
  ownerDocument = document,
  title,
  variant = 'info',
  ...props
}: ToastProps): JSX.Element {
  useNativeOverlayRegistration();
  const [paused, setPaused] = useState(false);
  const Icon = TOAST_ICONS[variant];

  useEffect(() => {
    if (duration <= 0 || paused || !onDismiss) return;
    const ownerWindow = ownerDocument.defaultView ?? window;
    const timer = ownerWindow.setTimeout(onDismiss, duration);
    return () => ownerWindow.clearTimeout(timer);
  }, [duration, onDismiss, ownerDocument, paused]);

  return (
    <div
      className={classNames('ez-ui-toast', className)}
      data-variant={variant}
      role={variant === 'danger' ? 'alert' : 'status'}
      aria-live={variant === 'danger' ? 'assertive' : 'polite'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      {...props}
    >
      <Icon className="ez-ui-toast__icon" aria-hidden="true" />
      <div className="ez-ui-toast__copy">
        <div className="ez-ui-toast__title">{title}</div>
        {description && <div className="ez-ui-toast__description">{description}</div>}
        {action && <div className="ez-ui-toast__action">{action}</div>}
      </div>
      {onDismiss && <IconButton icon={X} aria-label={dismissLabel} size="sm" onClick={onDismiss} />}
    </div>
  );
}

export interface ToastProviderProps {
  readonly children: ReactNode;
  readonly maxVisible?: number;
  readonly viewportLabel?: string;
}

export function ToastProvider({
  children,
  maxVisible = 4,
  viewportLabel = 'Notifications',
}: ToastProviderProps): JSX.Element {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const dismissToast = useCallback((id: string): void => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);
  const pushToast = useCallback(
    (options: ToastOptions, ownerDocument?: Document): string => {
      toastSequence += 1;
      const id = `ez-ui-toast-${toastSequence}`;
      const targetDocument = ownerDocument ?? getActiveAppDocument();
      setToasts((current) => {
        const otherDocuments = current.filter((toast) => toast.ownerDocument !== targetDocument);
        const targetToasts = current
          .filter((toast) => toast.ownerDocument === targetDocument)
          .concat({ ...options, id, ownerDocument: targetDocument })
          .slice(-Math.max(1, maxVisible));
        return [...otherDocuments, ...targetToasts];
      });
      return id;
    },
    [maxVisible],
  );
  const context = useMemo(() => ({ dismissToast, pushToast }), [dismissToast, pushToast]);
  const groupedToasts = useMemo(() => {
    const groups = new Map<Document, ToastRecord[]>();
    if (typeof document !== 'undefined') groups.set(document, []);
    for (const toast of toasts) {
      const group = groups.get(toast.ownerDocument);
      if (group) group.push(toast);
      else groups.set(toast.ownerDocument, [toast]);
    }
    return [...groups];
  }, [toasts]);

  return (
    <ToastContext.Provider value={context}>
      {children}
      {typeof document !== 'undefined' && groupedToasts.map(([ownerDocument, records], index) => {
        if (!ownerDocument.body || ownerDocument.defaultView?.closed) return null;
        return createPortal(
          <div className="ez-ui-toast-viewport" role="region" aria-label={viewportLabel}>
            {records.map((toast) => (
              <Toast key={toast.id} {...toast} onDismiss={() => dismissToast(toast.id)} />
            ))}
          </div>,
          ownerDocument.body,
          `toast-viewport-${index}`,
        );
      })}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside ToastProvider');
  return context;
}
