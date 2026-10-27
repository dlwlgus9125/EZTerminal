import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { e2eLog } from './e2e-telemetry';

/** Handoff "Interactions & Motion": a toast is a pill that self-dismisses. */
const TOAST_MS = 2600;
/** A toast with an action stays long enough to reach it. */
const TOAST_ACTION_MS = 5000;

/** One follow-up a toast offers (the terminal's "sent" notice opens the conversation). */
export interface MobileToastAction {
  readonly label: string;
  readonly onSelect: () => void;
}

type ShowToast = (message: string, action?: MobileToastAction) => void;

const MobileToastContext = createContext<ShowToast>(() => undefined);

/**
 * The authenticated shell's single transient-feedback surface. Every send
 * confirmation the commercial pass calls for (key sent, Ctrl latched, PC
 * control ended, …) routes through here rather than each screen inventing its
 * own banner.
 */
export function MobileToastProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const [toast, setToast] = useState<{ readonly id: number; readonly message: string; readonly action?: MobileToastAction } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextIdRef = useRef(0);

  // One container on the page from the start: a dialog opened later isolates it (inert) like the rest of the page,
  // so a toast that arrives while a modal is open cannot be used over it.
  const [host] = useState<HTMLDivElement | null>(() => (typeof document === 'undefined' ? null : document.createElement('div')));
  useLayoutEffect(() => {
    if (!host) return;
    host.className = 'mob-toast-host';
    document.body.appendChild(host);
    return () => host.remove();
  }, [host]);

  const showToast = useCallback<ShowToast>((message, action) => {
    if (!message) return;
    nextIdRef.current += 1;
    setToast({ id: nextIdRef.current, message, ...(action ? { action } : {}) });
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setToast(null);
    }, action ? TOAST_ACTION_MS : TOAST_MS);
  }, []);
  const dismiss = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    setToast(null);
  }, []);

  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);

  const value = useMemo(() => showToast, [showToast]);

  return (
    <MobileToastContext.Provider value={value}>
      {children}
      {toast && host && createPortal(
        <div key={toast.id} className="mob-toast" role="status" aria-live="polite" data-testid="mobile-toast" data-action={toast.action ? 'true' : undefined}>
          <span className="mob-dot mob-dot--live" aria-hidden="true" />
          <span className="mob-toast__message">{toast.message}</span>
          {toast.action && (
            <button type="button" className="mob-toast__action" data-testid="mobile-toast-action"
              // Pressed while typing (the terminal's box keeps the keyboard up): taking focus would close the
              // keyboard, shift the layout under the finger and lose the click. The box keeps focus instead.
              onPointerDown={(event) => event.preventDefault()}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => { const { onSelect } = toast.action!; e2eLog('toast-action:', toast.action!.label); dismiss(); onSelect(); }}>
              {toast.action.label}
            </button>
          )}
        </div>,
        // On the page itself: inside the shell a fixed toast is placed against a frame the keyboard does not
        // shrink, so it would sit under the keyboard exactly when a message was just typed and sent.
        host,
      )}
    </MobileToastContext.Provider>
  );
}

export function useMobileToast(): ShowToast {
  return useContext(MobileToastContext);
}
