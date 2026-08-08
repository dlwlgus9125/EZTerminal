import {
  Component,
  Suspense,
  createElement,
  lazy,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type Attributes,
  type ReactNode,
} from 'react';

import {
  RESOURCE_PROFILE_POLICY,
  type UiResourceProfile,
} from '../shared/resource-profile';

export interface FeatureModuleLoader<Props extends object> {
  preload(): Promise<void>;
  reset(): void;
  status(): FeatureLoadStatus;
  lazyComponent(): ComponentType<Props>;
}

export type FeatureLoadStatus = 'idle' | 'loading' | 'loaded';

export interface PreloadableFeature {
  preload(): Promise<void>;
}

/** One deduplicated module promise shared by intent, idle and rendered loads. */
export function createFeatureModuleLoader<Module, Props extends object>(
  loadModule: () => Promise<Module>,
  select: (module: Module) => ComponentType<Props>,
): FeatureModuleLoader<Props> {
  let modulePromise: Promise<Module> | null = null;
  let status: FeatureLoadStatus = 'idle';

  const load = (): Promise<Module> => {
    if (modulePromise) return modulePromise;
    status = 'loading';
    const guarded = loadModule()
      .then((module) => {
        if (modulePromise === guarded) status = 'loaded';
        return module;
      })
      .catch((error: unknown) => {
        if (modulePromise === guarded) {
          modulePromise = null;
          status = 'idle';
        }
        throw error;
      });
    modulePromise = guarded;
    return guarded;
  };

  return Object.freeze({
    preload: () => load().then(() => undefined),
    reset: () => {
      modulePromise = null;
      status = 'idle';
    },
    status: () => status,
    lazyComponent: () => lazy(async () => ({ default: select(await load()) })) as unknown as ComponentType<Props>,
  });
}

interface FeatureErrorBoundaryProps {
  readonly children: ReactNode;
  readonly errorMessage: string;
  readonly retryLabel: string;
  readonly closeLabel?: string;
  readonly onRetry: () => void;
  readonly onClose?: () => void;
}

interface FeatureErrorBoundaryState {
  readonly failed: boolean;
}

class FeatureErrorBoundary extends Component<FeatureErrorBoundaryProps, FeatureErrorBoundaryState> {
  state: FeatureErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): FeatureErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error('[feature-loader] feature render failed:', error);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="status-loading feature-load-error" role="alert">
        <span>{this.props.errorMessage}</span>
        <div className="feature-load-error__actions">
          <button type="button" className="btn" onClick={this.props.onRetry}>
            {this.props.retryLabel}
          </button>
          {this.props.onClose && this.props.closeLabel && (
            <button type="button" className="btn" onClick={this.props.onClose}>
              {this.props.closeLabel}
            </button>
          )}
        </div>
      </div>
    );
  }
}

export function LazyFeature<Props extends object>({
  loader,
  componentProps,
  loading,
  errorMessage,
  retryLabel,
  closeLabel,
  onClose,
}: {
  readonly loader: FeatureModuleLoader<Props>;
  readonly componentProps: Props;
  readonly loading: ReactNode;
  readonly errorMessage: string;
  readonly retryLabel: string;
  readonly closeLabel?: string;
  readonly onClose?: () => void;
}): JSX.Element {
  const [generation, setGeneration] = useState(0);
  const [armed, setArmed] = useState(() => loader.status() === 'loaded');
  const LazyComponent = useMemo(() => {
    void generation;
    return loader.lazyComponent();
  }, [generation, loader]);
  const retry = useCallback(() => {
    loader.reset();
    setArmed(false);
    setGeneration((current) => current + 1);
  }, [loader]);

  // Commit the lightweight destination before evaluating a cold feature
  // module, which can otherwise occupy the renderer before the fallback paints.
  useEffect(() => {
    if (armed) return undefined;
    let cancelled = false;
    const start = (): void => {
      if (cancelled) return;
      void loader.preload().catch(() => undefined);
      startTransition(() => setArmed(true));
    };
    if (typeof requestAnimationFrame === 'function') {
      const frame = requestAnimationFrame(start);
      return () => {
        cancelled = true;
        cancelAnimationFrame(frame);
      };
    }
    const timer = setTimeout(start, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [armed, generation, loader]);

  if (!armed) return <>{loading}</>;

  return (
    <FeatureErrorBoundary
      key={generation}
      errorMessage={errorMessage}
      retryLabel={retryLabel}
      closeLabel={closeLabel}
      onRetry={retry}
      onClose={onClose}
    >
      <Suspense fallback={loading}>
        {createElement(LazyComponent, componentProps as Attributes & Props)}
      </Suspense>
    </FeatureErrorBoundary>
  );
}

type IdleWindow = Window & typeof globalThis & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/** Schedule background preload only after persisted preferences are known. */
export function useProfileFeaturePreload(
  loaders: readonly PreloadableFeature[],
  profile: UiResourceProfile,
  ready: boolean,
): void {
  useEffect(() => {
    if (!ready || typeof window === 'undefined' || document.visibilityState === 'hidden') return;
    const mode = RESOURCE_PROFILE_POLICY[profile].preload;
    if (mode === 'intent') return;
    let cancelled = false;
    const preload = (): void => {
      if (cancelled) return;
      for (const loader of loaders) void loader.preload().catch(() => undefined);
    };
    const idleWindow = window as IdleWindow;
    if (mode === 'idle' && idleWindow.requestIdleCallback) {
      const handle = idleWindow.requestIdleCallback(preload, { timeout: 1_500 });
      return () => {
        cancelled = true;
        idleWindow.cancelIdleCallback?.(handle);
      };
    }
    const handle = window.setTimeout(preload, mode === 'eager' ? 0 : 600);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [loaders, profile, ready]);
}

export function preloadOnIntent(loader: PreloadableFeature): void {
  void loader.preload().catch(() => undefined);
}
