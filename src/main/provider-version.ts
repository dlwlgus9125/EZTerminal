/**
 * Shared semantic-version parsing for provider executable compatibility gates.
 * Provider adapters compare a user-installed CLI against a minimum supported
 * version, so the parser must reject anything it cannot order confidently.
 */

export interface SemanticVersion {
  readonly core: readonly [number, number, number];
  readonly prerelease?: string;
}

const SEMANTIC_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function semanticVersion(value: string): SemanticVersion | undefined {
  const match = SEMANTIC_VERSION_PATTERN.exec(value);
  if (!match) return undefined;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  if (!core.every(Number.isSafeInteger)) return undefined;
  const prerelease = match[4];
  if (prerelease?.split('.').some((part) => /^\d+$/u.test(part) && part.length > 1 && part.startsWith('0'))) {
    return undefined;
  }
  return { core, ...(prerelease ? { prerelease } : {}) };
}

/** Orders release cores only; callers reject prereleases before comparing. */
export function compareSemanticVersions(left: SemanticVersion, right: SemanticVersion): number {
  for (let index = 0; index < left.core.length; index += 1) {
    const difference = left.core[index]! - right.core[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}
