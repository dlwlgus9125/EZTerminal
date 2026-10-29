import {
  CLAUDE_FIRST_LAUNCH_AUTHENTICATION_DETAIL,
  CODEX_FIRST_LAUNCH_AUTHENTICATION_DETAIL,
  type ProviderProbeResult,
} from './daemon-provider';
import type { DaemonProvider } from './daemon-protocol';

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Whether a provider the person reviewed still matches what is installed now. Shared by the
 * settings card and the in-app program update, which turns the provider back on only if this holds.
 */
export function daemonProviderMatchesProbe(
  provider: DaemonProvider | undefined,
  probe: ProviderProbeResult,
  reviewDigest: string,
): boolean {
  if (!provider || provider.id !== probe.providerId) return false;
  const stableIdentityMatches = provider.displayName === probe.displayName
    && provider.protocol === probe.protocol
    && provider.executablePath === probe.executablePath
    && arraysEqual(provider.argv, probe.argv)
    && arraysEqual(provider.environmentVariableNames, probe.environmentVariableNames)
    && arraysEqual(provider.capabilities, probe.capabilities);
  if (!stableIdentityMatches) return false;

  const versionMatches = provider.executableVersion === probe.executableVersion;
  const reviewMatches = provider.reviewDigest === reviewDigest;
  if (versionMatches && reviewMatches) return true;

  // Only the version moved: both CLIs update in place, and the review stays bound to
  // the executable path, launch argv and environment rather than to one build.
  return !versionMatches
    && !reviewMatches
    && provider.enabled
    && probe.available
    && probe.authenticationState === 'first-launch'
    && probe.unavailableReason === undefined
    && Boolean(provider.reviewDigest)
    && (
      (provider.id === 'codex'
        && provider.protocol === 'codex-app-server'
        && probe.authenticationDetail === CODEX_FIRST_LAUNCH_AUTHENTICATION_DETAIL
        && (probe.reviewNotices?.length ?? 0) === 0)
      || (provider.id === 'claude'
        && provider.protocol === 'claude-agent-sdk'
        && probe.authenticationDetail === CLAUDE_FIRST_LAUNCH_AUTHENTICATION_DETAIL)
    );
}
