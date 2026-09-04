import type { IpcMainInvokeEvent } from 'electron';

import {
  getClaudeEnablementGateFailure,
  isDaemonProviderId,
  parseClaudeProviderEnablement,
  type ClaudeEnablementGateFailureCode,
  type ClaudeProviderEnablement,
  type DaemonProviderManagementResult,
  type ProviderInspection,
  type ProviderModel,
  type ProviderRegistryFailureCode,
  type ProviderRegistryResult,
} from '../shared/daemon-provider';
import type { AgentProviderRegistry } from './agent-provider-registry';
import type { DaemonSnapshot } from '../shared/daemon-protocol';
import type {
  ClaudeProviderAdapter,
  ClaudeProviderEnablementStore,
} from './claude-provider-adapter';

export type DaemonProviderIpcChannel =
  | 'daemon:inspect-provider'
  | 'daemon:list-provider-models'
  | 'daemon:get-claude-enablement'
  | 'daemon:set-claude-enablement';

type DaemonProviderIpcHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown;

export interface DaemonProviderIpc {
  handle(channel: DaemonProviderIpcChannel, handler: DaemonProviderIpcHandler): void;
  removeHandler(channel: DaemonProviderIpcChannel): void;
}

export interface DaemonProviderIpcOptions {
  readonly ipc: DaemonProviderIpc;
  readonly registry: Pick<AgentProviderRegistry, 'inspect' | 'listModels'>;
  readonly getSnapshot: () => Pick<DaemonSnapshot, 'providers'>;
  readonly claudeAdapter: Pick<ClaudeProviderAdapter, 'setEnablement'>;
  readonly claudeStore: ClaudeProviderEnablementStore;
  readonly resolveDesktopPrincipal: (
    event: IpcMainInvokeEvent,
    clientInstanceId: unknown,
  ) => string | null;
  readonly claudeStoreReady?: Promise<unknown>;
  readonly reportError?: (context: string, error: unknown) => void;
}

const CHANNELS: readonly DaemonProviderIpcChannel[] = [
  'daemon:inspect-provider',
  'daemon:list-provider-models',
  'daemon:get-claude-enablement',
  'daemon:set-claude-enablement',
];

function failure<T>(
  code: Exclude<DaemonProviderManagementResult<T>, { readonly ok: true }>['code'],
  message: string,
): DaemonProviderManagementResult<T> {
  return { ok: false, code, message };
}

function principalFailure<T>(): DaemonProviderManagementResult<T> {
  return failure(
    'desktop-principal-required',
    'A connected desktop renderer is required for provider management.',
  );
}

function invalidInput<T>(): DaemonProviderManagementResult<T> {
  return failure('invalid-input', 'The provider management request is invalid.');
}

const REGISTRY_FAILURE_MESSAGES: Readonly<Record<ProviderRegistryFailureCode, string>> = {
  'provider-not-registered': 'The requested provider is not registered.',
  'provider-unavailable': 'The requested provider is unavailable.',
  'provider-incompatible': 'The provider did not return a compatible response.',
  'review-mismatch': 'Provider details changed after review.',
};

function rendererSafeRegistryResult<T>(
  result: ProviderRegistryResult<T>,
): DaemonProviderManagementResult<T> {
  return result.ok
    ? result
    : failure(result.code, REGISTRY_FAILURE_MESSAGES[result.code]);
}

function isGateCode(value: unknown): value is ClaudeEnablementGateFailureCode {
  return value === 'CLAUDE_TERMS_REQUIRED'
    || value === 'CLAUDE_COMMERCIAL_APPROVAL_REQUIRED'
    || value === 'CLAUDE_THIRD_PARTY_AUTHORIZATION_REQUIRED';
}

function gateCodeFromError(error: unknown): ClaudeEnablementGateFailureCode | null {
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return null;
  const code = (error as { readonly code?: unknown }).code;
  return isGateCode(code) ? code : null;
}

function report(
  options: DaemonProviderIpcOptions,
  context: string,
  error: unknown,
): void {
  try {
    options.reportError?.(context, error);
  } catch {
    // Diagnostics must not change provider state or expose their own failures.
  }
}

/** Installs the desktop-only provider setup boundary for the isolated preload. */
export function installDaemonProviderIpc(options: DaemonProviderIpcOptions): () => void {
  const claudeStoreReady = options.claudeStoreReady ?? Promise.resolve();
  const lifecycle = new AbortController();
  let installed = true;

  options.ipc.handle('daemon:inspect-provider', async (event, ...args) => {
    if (!options.resolveDesktopPrincipal(event, args[0])) {
      return principalFailure<ProviderInspection>();
    }
    if (args.length !== 2 || !isDaemonProviderId(args[1])) {
      return invalidInput<ProviderInspection>();
    }
    try {
      return rendererSafeRegistryResult(await options.registry.inspect(args[1], lifecycle.signal));
    } catch (error) {
      report(options, 'daemon provider inspection failed', error);
      return failure<ProviderInspection>(
        'provider-operation-failed',
        'Provider inspection could not be completed.',
      );
    }
  });

  options.ipc.handle('daemon:list-provider-models', async (event, ...args) => {
    if (!options.resolveDesktopPrincipal(event, args[0])) {
      return principalFailure<readonly ProviderModel[]>();
    }
    if (args.length !== 2 || !isDaemonProviderId(args[1])) {
      return invalidInput<readonly ProviderModel[]>();
    }
    try {
      return rendererSafeRegistryResult(await options.registry.listModels(
        options.getSnapshot(),
        args[1],
        lifecycle.signal,
      ));
    } catch (error) {
      report(options, 'daemon provider model discovery failed', error);
      return failure<readonly ProviderModel[]>(
        'provider-operation-failed',
        'Provider models could not be loaded.',
      );
    }
  });

  options.ipc.handle('daemon:get-claude-enablement', async (event, ...args) => {
    if (!options.resolveDesktopPrincipal(event, args[0])) {
      return principalFailure<ClaudeProviderEnablement>();
    }
    if (args.length !== 1) return invalidInput<ClaudeProviderEnablement>();
    try {
      await claudeStoreReady;
      const enablement = parseClaudeProviderEnablement(await options.claudeStore.load());
      if (!enablement || getClaudeEnablementGateFailure(enablement)) {
        throw new Error('Persisted Claude provider enablement is invalid.');
      }
      return { ok: true, value: enablement } satisfies DaemonProviderManagementResult<ClaudeProviderEnablement>;
    } catch (error) {
      report(options, 'Claude provider enablement read failed', error);
      return failure<ClaudeProviderEnablement>(
        'provider-operation-failed',
        'Claude provider enablement could not be loaded.',
      );
    }
  });

  options.ipc.handle('daemon:set-claude-enablement', async (event, ...args) => {
    if (!options.resolveDesktopPrincipal(event, args[0])) {
      return principalFailure<ClaudeProviderEnablement>();
    }
    if (args.length !== 2) return invalidInput<ClaudeProviderEnablement>();
    const enablement = parseClaudeProviderEnablement(args[1]);
    if (!enablement) return invalidInput<ClaudeProviderEnablement>();
    const gateFailure = getClaudeEnablementGateFailure(enablement);
    if (gateFailure) return failure(gateFailure.code, gateFailure.message);
    try {
      await claudeStoreReady;
      const persisted = parseClaudeProviderEnablement(
        await options.claudeAdapter.setEnablement(enablement),
      );
      if (!persisted || getClaudeEnablementGateFailure(persisted)) {
        throw new Error('Claude provider returned invalid enablement state.');
      }
      return { ok: true, value: persisted } satisfies DaemonProviderManagementResult<ClaudeProviderEnablement>;
    } catch (error) {
      const gateCode = gateCodeFromError(error);
      if (gateCode) {
        const currentGate = getClaudeEnablementGateFailure(enablement);
        return failure(
          gateCode,
          currentGate?.code === gateCode
            ? currentGate.message
            : 'Claude Agent enablement requirements were not satisfied.',
        );
      }
      report(options, 'Claude provider enablement write failed', error);
      return failure<ClaudeProviderEnablement>(
        'provider-operation-failed',
        'Claude provider enablement could not be saved.',
      );
    }
  });

  return () => {
    if (!installed) return;
    installed = false;
    for (const channel of CHANNELS) options.ipc.removeHandler(channel);
    lifecycle.abort();
  };
}
