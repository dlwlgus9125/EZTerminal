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

const MobileToastContext = createContext<(message: string) => void>(() => undefined);

/**
 * The authenticated shell's single transient-feedback surface. Every send
 * confirmation the commercial pass calls for (key sent, Ctrl latched, PC
 * control ended, …) routes through here rather than each screen inventing its
 * own banner.
 */
export function MobileToastProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const [toast, setToast] = useState<{ readonly id: number; readonly message: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextIdRef = useRef(0);

  const showToast = useCallback((message: string) => {
    if (!message) return;
    nextIdRef.current += 1;
    setToast({ id: nextIdRef.current, message });
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setToast(null);
    }, TOAST_MS);
  }, []);

  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);

  const value = useMemo(() => showToast, [showToast]);

  return (
    <MobileToastContext.Provider value={value}>
      {children}
      {toast && (
        <div key={toast.id} className="mob-toast" role="status" aria-live="polite" data-testid="mobile-toast">
          <span className="mob-dot mob-dot--live" aria-hidden="true" />
          <span>{toast.message}</span>
        </div>
      )}
    </MobileToastContext.Provider>
  );
}

export function useMobileToast(): (message: string) => void {
  return useContext(MobileToastContext);
}
