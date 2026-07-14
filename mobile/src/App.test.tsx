import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppI18nProvider } from '../../src/renderer/i18n';
import { App } from './App';
import type { ConnectionHealthSnapshot, RemoteConnectionState } from './transport/connection-health';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./connection-credential-store', () => ({
  ConnectionCredentialStore: class ConnectionCredentialStore {
    load(): Promise<{ connection: { url: string; token: string }; warning: null }> {
      return Promise.resolve({
        connection: { url: 'wss://desktop.example.ts.net', token: 'test-token' },
        warning: null,
      });
    }

    save(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

vi.mock('./MobileWorkspace', () => ({ MobileWorkspace: () => null }));

vi.mock('./transport/ws-ezterminal', () => ({
  WsEzTerminalTransport: class WsEzTerminalTransport {
    isAuthed = false;
    private connectionState: RemoteConnectionState = 'connecting';
    private health: ConnectionHealthSnapshot = {
      state: 'connecting',
      attempt: 0,
      nextRetryAt: null,
      lastConnectedAt: null,
      endpointKind: 'tailscale',
    };
    private readonly authListeners = new Set<(authed: boolean) => void>();
    private readonly stateListeners = new Set<(state: RemoteConnectionState) => void>();
    private readonly healthListeners = new Set<(snapshot: ConnectionHealthSnapshot) => void>();
    private readonly deadListeners = new Set<() => void>();

    constructor() {
      (globalThis as { __appTestTransport?: unknown }).__appTestTransport = this;
    }

    onAuthChange(listener: (authed: boolean) => void): () => void {
      this.authListeners.add(listener);
      listener(this.isAuthed);
      return () => this.authListeners.delete(listener);
    }

    onConnectionStateChange(listener: (state: RemoteConnectionState) => void): () => void {
      this.stateListeners.add(listener);
      listener(this.connectionState);
      return () => this.stateListeners.delete(listener);
    }

    onConnectionHealthChange(listener: (snapshot: ConnectionHealthSnapshot) => void): () => void {
      this.healthListeners.add(listener);
      listener(this.health);
      return () => this.healthListeners.delete(listener);
    }

    onSessionDead(listener: () => void): () => void {
      this.deadListeners.add(listener);
      return () => this.deadListeners.delete(listener);
    }

    disconnect(): void {
      this.emitAuth(false);
      this.emitState('disconnected');
    }

    retryNow(): boolean {
      return true;
    }

    getConnectionDiagnostics(): string {
      return 'redacted diagnostics';
    }

    emitAuth(authed: boolean): void {
      this.isAuthed = authed;
      for (const listener of this.authListeners) listener(authed);
    }

    emitState(state: RemoteConnectionState): void {
      this.connectionState = state;
      for (const listener of this.stateListeners) listener(state);
    }

    emitHealth(snapshot: ConnectionHealthSnapshot): void {
      this.health = snapshot;
      for (const listener of this.healthListeners) listener(snapshot);
    }
  },
}));

interface AppTestTransport {
  emitAuth(authed: boolean): void;
  emitState(state: RemoteConnectionState): void;
  emitHealth(snapshot: ConnectionHealthSnapshot): void;
}

let host: HTMLDivElement;
let root: Root;

function transport(): AppTestTransport {
  const current = (globalThis as { __appTestTransport?: AppTestTransport }).__appTestTransport;
  if (!current) throw new Error('App test transport was not created');
  return current;
}

beforeEach(async () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <AppI18nProvider locale="ko" languages={[]}>
        <App />
      </AppI18nProvider>,
    );
    await Promise.resolve();
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (globalThis as { __appTestTransport?: AppTestTransport }).__appTestTransport;
  delete (window as unknown as { ezterminal?: unknown }).ezterminal;
  vi.clearAllTimers();
});

describe('App connection health banner', () => {
  it('renders localized verdict copy from the active App locale', async () => {
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="connect-submit"]')!.click());

    await act(async () => {
      transport().emitState('connected');
      transport().emitHealth({
        state: 'connected',
        attempt: 0,
        nextRetryAt: null,
        lastConnectedAt: Date.now(),
        endpointKind: 'tailscale',
      });
      transport().emitAuth(true);
      await Promise.resolve();
    });

    act(() => {
      transport().emitAuth(false);
      transport().emitState('reconnecting');
      transport().emitHealth({
        state: 'reconnecting',
        attempt: 3,
        nextRetryAt: null,
        lastConnectedAt: null,
        endpointKind: 'tailscale',
      });
    });

    expect(host.querySelector('#mobile-connection-health-title')?.textContent)
      .toBe('아직 연결할 수 없음');
    expect(host.querySelector('#mobile-connection-health-detail')?.textContent)
      .toBe('3번째 연결 시도가 실패했습니다. 자동으로 다시 시도합니다.');
    expect(host.querySelector('[data-testid="mobile-reconnect-scrim"]')?.textContent)
      .toContain('이 기기에서 Tailscale이 연결되어 있는지 확인해 주세요.');
  });
});
