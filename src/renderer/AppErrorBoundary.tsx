import { Component, type ErrorInfo, type ReactNode } from 'react';

const RECOVERY_KEY = 'ezterminal.renderer-error-recovery.v1';
const RECOVERY_WINDOW_MS = 60_000;

interface Props {
  readonly children: ReactNode;
}

interface State {
  readonly error: Error | null;
  readonly reloading: boolean;
}

function readLastRecovery(): number {
  try {
    const value = Number.parseInt(sessionStorage.getItem(RECOVERY_KEY) ?? '', 10);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null, reloading: false };

  static getDerivedStateFromError(error: Error): State {
    return { error, reloading: false };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[renderer] uncaught render error', error, info.componentStack);
    const now = Date.now();
    if (now - readLastRecovery() < RECOVERY_WINDOW_MS) return;
    try {
      sessionStorage.setItem(RECOVERY_KEY, String(now));
    } catch {
      return;
    }
    this.setState({ error, reloading: true }, () => {
      void Promise.resolve(window.ezterminalDesktop?.prepareRendererRecovery())
        .catch(() => undefined)
        .finally(() => setTimeout(() => window.location.reload(), 0));
    });
  }

  private readonly retry = (): void => {
    try {
      sessionStorage.removeItem(RECOVERY_KEY);
    } catch {
      // Reload remains useful even when storage is unavailable.
    }
    void Promise.resolve(window.ezterminalDesktop?.prepareRendererRecovery())
      .catch(() => undefined)
      .finally(() => window.location.reload());
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    if (this.state.reloading) return null;
    return (
      <main
        role="alert"
        aria-live="assertive"
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: '24px',
          background: 'var(--ui-canvas)',
          color: 'var(--ui-text-primary)',
          fontFamily: 'var(--ui-font-body)',
        }}
      >
        <section style={{ maxWidth: '640px' }}>
          <h1>EZTerminal renderer recovery stopped</h1>
          <p>
            The interface failed twice within one minute. Terminal sessions remain in the main
            process; reload once when you are ready to reconnect.
          </p>
          <button type="button" onClick={this.retry}>
            Reload interface
          </button>
        </section>
      </main>
    );
  }
}
