const REQUIRED_OS_ENVIRONMENT_VARIABLES = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'SHELL',
  'USER',
  'USERNAME',
  'LOGNAME',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
] as const;

const SENSITIVE_ENVIRONMENT_VARIABLES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AZURE_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'EZTERMINAL_ORCHESTRATION_TOKEN',
] as const;

export interface SanitizedProviderDiagnostic {
  readonly text: string;
  readonly redacted: boolean;
}

/**
 * Builds the complete child environment instead of spreading process.env.
 * Provider auth/network variables must be explicitly disclosed by the review
 * descriptor; unrelated ambient credentials therefore never cross this seam.
 */
export function buildProviderProcessEnvironment(
  disclosedNames: readonly string[],
  source: NodeJS.ProcessEnv = process.env,
  fixed: Readonly<Record<string, string | undefined>> = {},
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of new Set([...REQUIRED_OS_ENVIRONMENT_VARIABLES, ...disclosedNames])) {
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  for (const [name, value] of Object.entries(fixed)) {
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function replacePattern(
  value: string,
  pattern: RegExp,
  replacement: string | ((substring: string, ...args: string[]) => string),
): { readonly value: string; readonly changed: boolean } {
  pattern.lastIndex = 0;
  const changed = pattern.test(value);
  pattern.lastIndex = 0;
  return { value: changed ? value.replace(pattern, replacement as string) : value, changed };
}

/** Removes credential-shaped material before a provider diagnostic is logged or persisted. */
export function sanitizeProviderDiagnostic(
  diagnostic: unknown,
  options: {
    readonly explicitSecrets?: readonly string[];
    readonly maxLength?: number;
  } = {},
): SanitizedProviderDiagnostic {
  let text = diagnostic instanceof Error
    ? diagnostic.message
    : typeof diagnostic === 'string'
      ? diagnostic
      : String(diagnostic);
  let redacted = false;
  const replace = (
    pattern: RegExp,
    replacement: string | ((substring: string, ...args: string[]) => string),
  ): void => {
    const result = replacePattern(text, pattern, replacement);
    text = result.value;
    redacted ||= result.changed;
  };

  for (const secret of options.explicitSecrets ?? []) {
    if (!secret || secret.length < 4 || !text.includes(secret)) continue;
    text = text.split(secret).join('[redacted secret]');
    redacted = true;
  }

  replace(/\bsk-ant-[A-Za-z0-9_-]{8,}\b/giu, '[redacted Anthropic key]');
  replace(/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/giu, '[redacted OpenAI key]');
  replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, '[redacted JWT]');
  replace(/(\b(?:authorization|proxy-authorization)\s*[:=]\s*bearer\s+)[^\s,;]+/giu, '$1[redacted]');
  replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}\b/giu, 'Bearer [redacted]');

  const sensitiveNames = SENSITIVE_ENVIRONMENT_VARIABLES.join('|');
  replace(
    new RegExp(`(\\b(?:${sensitiveNames})\\s*[=:]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,;]+)`, 'giu'),
    '$1[redacted]',
  );

  const maxLength = Math.max(1, Math.min(options.maxLength ?? 20_000, 1024 * 1024));
  return { text: text.slice(0, maxLength), redacted };
}

export function sameEnvironmentVariableSet(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  if (actual.length !== new Set(actual).size || expected.length !== new Set(expected).size) return false;
  const actualSet = new Set(actual);
  return actualSet.size === expected.length && expected.every((name) => actualSet.has(name));
}
