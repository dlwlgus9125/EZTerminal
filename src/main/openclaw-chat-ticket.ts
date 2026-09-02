import type { OpenClawStatus } from '../shared/openclaw';
import type { OpenClawChatTicketFailureReason } from '../shared/remote-protocol';

export interface OpenClawChatTicketProxy {
  readonly port: number;
  mintTicket(): string;
}

export interface OpenClawChatTicketDependencies {
  isDesktopRuntimeRunning(): boolean;
  getGatewayStatus(): Promise<OpenClawStatus>;
  getChatToken(): Promise<string | null>;
  ensureProxy(): Promise<OpenClawChatTicketProxy | null>;
  stopProxy(): Promise<void>;
}

export type OpenClawChatTicketMintResult =
  | { readonly ticket: string; readonly proxyPort: number; readonly token: string }
  | {
      readonly ticket: null;
      readonly reason: Exclude<OpenClawChatTicketFailureReason, 'timeout'>;
    };

/**
 * Mints the short-lived mobile tunnel credential only after both the gateway
 * and the desktop runtime are usable. Keeping this transaction outside the
 * Electron bootstrap gives the availability policy a direct regression seam.
 */
export async function mintOpenClawChatTicket(
  dependencies: OpenClawChatTicketDependencies,
): Promise<OpenClawChatTicketMintResult> {
  if (!dependencies.isDesktopRuntimeRunning()) {
    return { ticket: null, reason: 'proxy-unavailable' };
  }
  const status = await dependencies.getGatewayStatus();
  if (status.state === 'unknown') return { ticket: null, reason: 'gateway-unreachable' };
  if (status.state !== 'running') return { ticket: null, reason: 'gateway-stopped' };
  const token = await dependencies.getChatToken();
  if (!token) return { ticket: null, reason: 'token-unavailable' };
  const proxy = await dependencies.ensureProxy();
  if (!proxy || !dependencies.isDesktopRuntimeRunning()) {
    if (proxy) await dependencies.stopProxy();
    return { ticket: null, reason: 'proxy-unavailable' };
  }
  return { ticket: proxy.mintTicket(), proxyPort: proxy.port, token };
}
