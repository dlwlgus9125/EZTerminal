import { createHash } from 'node:crypto';

import type {
  DaemonProvider,
  DaemonSnapshot,
  ProviderEnableInput,
} from '../shared/daemon-protocol';
import {
  validateProviderProbe,
  type AgentProviderAdapter,
  type ProviderModel,
  type ProviderProbeResult,
} from './agent-provider-adapter';

export interface ProviderInspection {
  readonly probe: ProviderProbeResult;
  /** Binds the executable, argv, capabilities and every review notice. */
  readonly reviewDigest: string;
}

export type ProviderRegistryFailureCode =
  | 'provider-not-registered'
  | 'provider-unavailable'
  | 'provider-incompatible'
  | 'review-mismatch';

export type ProviderRegistryResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: ProviderRegistryFailureCode;
      readonly message: string;
    };

function canonicalProbe(probe: ProviderProbeResult): Readonly<Record<string, unknown>> {
  const reviewNotices = 'reviewNotices' in probe && Array.isArray(probe.reviewNotices)
    ? probe.reviewNotices
    : [];
  return {
    providerId: probe.providerId,
    displayName: probe.displayName,
    protocol: probe.protocol,
    available: probe.available,
    executablePath: probe.executablePath,
    executableVersion: probe.executableVersion,
    argv: [...probe.argv],
    environmentVariableNames: [...probe.environmentVariableNames].sort(),
    capabilities: [...probe.capabilities].sort(),
    unavailableReason: probe.unavailableReason ?? null,
    reviewNotices,
  };
}

/** Stable acknowledgement token shown by provider review UI before enable. */
export function createProviderReviewDigest(probe: ProviderProbeResult): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalProbe(probe)))
    .digest('hex');
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function inputMatchesProbe(input: ProviderEnableInput, probe: ProviderProbeResult): boolean {
  return input.providerId === probe.providerId
    && input.displayName === probe.displayName
    && input.protocol === probe.protocol
    && input.executablePath === probe.executablePath
    && input.executableVersion === probe.executableVersion
    && sameStringArray(input.argv, probe.argv)
    && sameStringArray(input.environmentVariableNames, probe.environmentVariableNames)
    && sameStringArray(input.capabilities, probe.capabilities);
}

/**
 * Deep provider boundary: discovery, review binding, model lookup and enabled
 * adapter selection stay here. DaemonRuntime never knows executable lookup,
 * provider auth, or protocol-specific process details.
 */
export class AgentProviderRegistry {
  private readonly adapters = new Map<string, AgentProviderAdapter>();

  constructor(adapters: readonly AgentProviderAdapter[]) {
    for (const adapter of adapters) {
      if (!adapter.providerId.trim()) throw new Error('Provider adapter id is required.');
      if (this.adapters.has(adapter.providerId)) {
        throw new Error(`Duplicate provider adapter id: ${adapter.providerId}`);
      }
      this.adapters.set(adapter.providerId, adapter);
    }
  }

  providerIds(): readonly string[] {
    return [...this.adapters.keys()].sort();
  }

  async inspect(providerId: string, signal?: AbortSignal): Promise<ProviderRegistryResult<ProviderInspection>> {
    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      return { ok: false, code: 'provider-not-registered', message: `Provider is not registered: ${providerId}` };
    }
    try {
      const probe = await adapter.probe(signal);
      validateProviderProbe(probe);
      if (probe.providerId !== providerId) {
        return {
          ok: false,
          code: 'provider-incompatible',
          message: `Provider probe identity mismatch: expected ${providerId}, received ${probe.providerId}.`,
        };
      }
      return { ok: true, value: { probe, reviewDigest: createProviderReviewDigest(probe) } };
    } catch (error) {
      return {
        ok: false,
        code: 'provider-incompatible',
        message: error instanceof Error ? error.message : 'Provider probe failed.',
      };
    }
  }

  async authorizeEnable(
    input: ProviderEnableInput,
    signal?: AbortSignal,
  ): Promise<ProviderRegistryResult<Omit<DaemonProvider, 'revision' | 'createdAt' | 'updatedAt'>>> {
    const inspected = await this.inspect(input.providerId, signal);
    if (!inspected.ok) return inspected;
    const { probe, reviewDigest } = inspected.value;
    if (!probe.available) {
      return {
        ok: false,
        code: 'provider-unavailable',
        message: probe.unavailableReason ?? `${probe.displayName} is unavailable.`,
      };
    }
    if (input.reviewDigest !== reviewDigest || !inputMatchesProbe(input, probe)) {
      return {
        ok: false,
        code: 'review-mismatch',
        message: 'Provider details changed after review. Inspect and approve the current executable again.',
      };
    }
    return {
      ok: true,
      value: {
        id: probe.providerId,
        displayName: probe.displayName,
        protocol: probe.protocol,
        executablePath: probe.executablePath,
        executableVersion: probe.executableVersion,
        argv: probe.argv,
        environmentVariableNames: probe.environmentVariableNames,
        capabilities: probe.capabilities,
        enabled: true,
        health: 'ready',
      },
    };
  }

  enabledAdapter(
    snapshot: Pick<DaemonSnapshot, 'providers'>,
    providerId: string,
  ): ProviderRegistryResult<AgentProviderAdapter> {
    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      return { ok: false, code: 'provider-not-registered', message: `Provider is not registered: ${providerId}` };
    }
    const provider = snapshot.providers.find((candidate) => candidate.id === providerId);
    if (!provider?.enabled || provider.health !== 'ready') {
      return {
        ok: false,
        code: 'provider-unavailable',
        message: `${provider?.displayName ?? providerId} is not enabled and ready.`,
      };
    }
    return { ok: true, value: adapter };
  }

  async listModels(providerId: string, signal?: AbortSignal): Promise<ProviderRegistryResult<readonly ProviderModel[]>> {
    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      return { ok: false, code: 'provider-not-registered', message: `Provider is not registered: ${providerId}` };
    }
    try {
      return { ok: true, value: await adapter.listModels(signal) };
    } catch (error) {
      return {
        ok: false,
        code: 'provider-unavailable',
        message: error instanceof Error ? error.message : 'Provider model discovery failed.',
      };
    }
  }

  async dispose(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.adapters.values()].map((adapter) => adapter.dispose()),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Provider adapters failed to dispose.');
  }
}
