import { X } from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

import { useNativeOverlayRegistration } from '../native-overlay';
import { getActiveAppDocument } from '../desktop-window-registry';
import { IconButton } from './Button';
import {
  isolateModalBackground,
  isTopModalLayer,
  registerModalLayer,
} from './modal-isolation';
import { classNames, getFocusableElements } from './utils';

export interface DialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: ReactNode;
  /** Optional severity glyph beside the title. Presentation only. */
  readonly icon?: ReactNode;
  readonly description?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly size?: 'sm' | 'md' | 'lg';
  readonly role?: 'dialog' | 'alertdialog';
  readonly dismissible?: boolean;
  readonly closeOnBackdrop?: boolean;
  readonly closeLabel?: string;
  readonly initialFocusRef?: RefObject<HTMLElement>;
  readonly className?: string;
  readonly variant?: 'dialog' | 'sheet';
  /** Severity rail across the top of the panel. Presentation only — it never
   * changes focus, dismissal, or the announced role. */
  readonly tone?: 'neutral' | 'warning' | 'danger';
  /** Stable integration-test seam for the rendered modal panel. */
  readonly testId?: string;
  /** Stable integration-test seam for the built-in dismiss action. */
  readonly closeButtonTestId?: string;
  /** Document that owns this modal for its entire open lifetime. */
  readonly ownerDocument?: Document;
}

export function Dialog({
  children,
  className,
  closeLabel = 'Close dialog',
  closeButtonTestId,
  closeOnBackdrop = true,
  description,
  dismissible = true,
  footer,
  icon,
  initialFocusRef,
  onOpenChange,
  open,
  ownerDocument,
  role = 'dialog',
  size = 'md',
  title,
  testId,
  tone = 'neutral',
  variant = 'dialog',
}: DialogProps): JSX.Element | null {
  const titleId = `ez-ui-dialog-title-${useId()}`;
  const descriptionId = `ez-ui-dialog-description-${useId()}`;
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const dismissibleRef = useRef(dismissible);
  const initialFocusTargetRef = useRef(initialFocusRef);
  const onOpenChangeRef = useRef(onOpenChange);
  const portalDocumentRef = useRef<Document | null>(null);
  dismissibleRef.current = dismissible;
  initialFocusTargetRef.current = initialFocusRef;
  onOpenChangeRef.current = onOpenChange;
  useNativeOverlayRegistration(open);
  if (!open) portalDocumentRef.current = null;
  else portalDocumentRef.current ??= ownerDocument ?? getActiveAppDocument();
  const portalDocument = portalDocumentRef.current ?? ownerDocument ?? document;

  useEffect(() => {
    if (!open) return;
    const ownerWindow = portalDocument.defaultView ?? window;
    const activeElement = portalDocument.activeElement;
    previousFocusRef.current = activeElement
      && typeof (activeElement as HTMLElement).focus === 'function'
      ? activeElement as HTMLElement
      : null;
    const backdrop = panelRef.current?.closest<HTMLElement>('.ez-ui-dialog-backdrop');
    const releaseLayer = backdrop
      ? registerModalLayer(backdrop, portalDocument)
      : () => undefined;
    const releaseBackground = backdrop
      ? isolateModalBackground(backdrop, [], portalDocument)
      : () => undefined;
    const animationFrame = ownerWindow.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      (initialFocusTargetRef.current?.current ?? getFocusableElements(panel)[0] ?? panel).focus();
    });

    const handleKeyDown = (event: KeyboardEvent): void => {
      const panel = panelRef.current;
      if (!panel || !isTopModalLayer(backdrop ?? null)) return;
      if (event.key === 'Escape' && dismissibleRef.current) {
        event.preventDefault();
        onOpenChangeRef.current(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = getFocusableElements(panel);
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!panel.contains(portalDocument.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && portalDocument.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && portalDocument.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    portalDocument.addEventListener('keydown', handleKeyDown);
    return () => {
      ownerWindow.cancelAnimationFrame(animationFrame);
      portalDocument.removeEventListener('keydown', handleKeyDown);
      releaseBackground();
      releaseLayer();
      ownerWindow.requestAnimationFrame(() => previousFocusRef.current?.focus());
    };
  }, [open, portalDocument]);

  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="ez-ui-dialog-backdrop"
      data-variant={variant}
      onMouseDown={(event) => {
        if (
          event.target === event.currentTarget
          && isTopModalLayer(event.currentTarget)
          && dismissible
          && closeOnBackdrop
        ) {
          onOpenChange(false);
        }
      }}
    >
      <div
        ref={panelRef}
        className={classNames('ez-ui-dialog', className)}
        data-testid={testId}
        data-size={size}
        data-variant={variant}
        data-tone={tone}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <header className="ez-ui-dialog__header">
          {/* Decorative by construction: the tone rail, the title and the body
              already carry the severity, so the glyph is hidden from assistive
              technology rather than announced as a second copy of it. */}
          {icon && <span className="ez-ui-dialog__icon" aria-hidden="true">{icon}</span>}
          <div className="ez-ui-dialog__heading">
            <h2 id={titleId} className="ez-ui-dialog__title">{title}</h2>
            {description && (
              <p id={descriptionId} className="ez-ui-dialog__description">{description}</p>
            )}
          </div>
          {dismissible && (
            <IconButton
              icon={X}
              aria-label={closeLabel}
              data-testid={closeButtonTestId}
              onClick={() => onOpenChange(false)}
            />
          )}
        </header>
        <div className="ez-ui-dialog__body">{children}</div>
        {footer && <footer className="ez-ui-dialog__footer">{footer}</footer>}
      </div>
    </div>,
    portalDocument.body,
  );
}

export type ActionSheetProps = Omit<DialogProps, 'variant'>;

export function ActionSheet(props: ActionSheetProps): JSX.Element | null {
  return <Dialog {...props} variant="sheet" />;
}
