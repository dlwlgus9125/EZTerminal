import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

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
      {toast && (
        <div key={toast.id} className="mob-toast" role="status" aria-live="polite" data-testid="mobile-toast" data-action={toast.action ? 'true' : undefined}>
          <span className="mob-dot mob-dot--live" aria-hidden="true" />
          <span className="mob-toast__message">{toast.message}</span>
          {toast.action && (
            <button type="button" className="mob-toast__action" data-testid="mobile-toast-action"
              onClick={() => { const { onSelect } = toast.action!; dismiss(); onSelect(); }}>
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </MobileToastContext.Provider>
  );
}

export function useMobileToast(): ShowToast {
  return useContext(MobileToastContext);
}
