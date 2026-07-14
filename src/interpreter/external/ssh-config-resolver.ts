/**
 * Safe OpenSSH-config alias resolution.
 *
 * The user's config is parsed in-process under strict bounds. Only four inert
 * connection fields are copied into a private temporary config; `ssh -G` is
 * then run against that sanitized file. The original config is never handed
 * to OpenSSH because `-G` may evaluate `Match exec` directives.
 */

import { execFile as nodeExecFile } from 'node:child_process';
import { constants as fsConstants, type Dirent } from 'node:fs';
import {
  access,
  chmod,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import {
  BoundedFileReadError,
  readBoundedRegularFile,
} from './ssh-file-reader';

export const SSH_CONFIG_MAX_BYTES = 1024 * 1024;
export const SSH_CONFIG_MAX_FILES = 16;
export const SSH_CONFIG_MAX_DEPTH = 4;
export const SSH_CONFIG_MAX_LINE_BYTES = 8 * 1024;
export const SSH_CONFIG_MAX_IDENTITIES = 16;
export const SSH_G_TIMEOUT_MS = 3_000;
export const SSH_G_STDOUT_MAX_BYTES = 256 * 1024;
export const SSH_G_STDERR_MAX_BYTES = 64 * 1024;

const SAFE_DIRECTIVES = new Set(['hostname', 'user', 'port', 'identityfile']);
const UNSAFE_DIRECTIVES = new Set([
  'exec',
  'localcommand',
  'remotecommand',
  'knownhostscommand',
  'permitlocalcommand',
]);
const MATCH_CRITERIA = new Set(['all', 'canonical', 'final', 'exec', 'host', 'originalhost', 'localnetwork', 'localuser', 'tagged', 'user']);
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

interface ConfigLine {
  readonly tokens: readonly string[];
  readonly source: string;
  readonly line: number;
}

interface SafeConfigValues {
  readonly hostname?: string;
  readonly user?: string;
  readonly port?: string;
  readonly identityFiles: readonly string[];
}

export interface ResolvedSshAlias {
  readonly alias: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly keyPath?: string;
}

export interface ResolveSshAliasRequest {
  readonly alias: string;
  readonly portOverride?: number;
  readonly keyPathOverride?: string;
  readonly signal?: AbortSignal;
}

export interface SshGResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type SshGRunner = (
  executable: string,
  args: readonly string[],
  options: { readonly signal?: AbortSignal },
) => Promise<SshGResult>;

export interface SshConfigResolverDeps {
  readonly homeDir?: string;
  readonly configPath?: string;
  readonly tempDir?: string;
  readonly sshExecutable?: string;
  readonly runSshG?: SshGRunner;
}

function sshConfigError(message: string, line?: ConfigLine): Error {
  const location = line ? ` (${line.source}:${line.line})` : '';
  return new Error(`ssh-connect: ${message}${location}`);
}

/** Tokenize one ssh_config line without invoking a shell or expanding values. */
export function tokenizeSshConfigLine(raw: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | null = null;
  let tokenStarted = false;

  const push = (): void => {
    if (!tokenStarted) return;
    tokens.push(token);
    token = '';
    tokenStarted = false;
  };

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (!quote && ch === '#') break;
    if (ch === '\\') {
      const next = raw[i + 1];
      const escapable = next !== undefined && (
        quote !== null
          ? next === quote || next === '\\'
          : /[\s#"'\\]/.test(next)
      );
      if (escapable) {
        token += next;
        tokenStarted = true;
        i += 1;
      } else {
        token += ch;
        tokenStarted = true;
      }
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else token += ch;
      tokenStarted = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    token += ch;
    tokenStarted = true;
  }
  if (quote) throw sshConfigError('unterminated quote in SSH config');
  push();

  if (tokens.length > 0) {
    const equals = tokens[0].indexOf('=');
    if (equals > 0) {
      const first = tokens[0];
      tokens.splice(0, 1, first.slice(0, equals), first.slice(equals + 1));
    } else if (tokens[1] === '=') {
      tokens.splice(1, 1);
    }
  }
  return tokens;
}

function globToRegExp(pattern: string): RegExp {
  let source = '^';
  for (const ch of pattern) {
    if (ch === '*') source += '.*';
    else if (ch === '?') source += '.';
    else source += ch.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  return new RegExp(`${source}$`, 'i');
}

function splitPatterns(values: readonly string[]): string[] {
  return values.flatMap((value) => value.split(',')).filter(Boolean);
}

/** OpenSSH pattern-list semantics: a matching negation always wins. */
export function hostPatternsMatch(values: readonly string[], host: string): boolean {
  const patterns = splitPatterns(values);
  let positive = false;
  for (const raw of patterns) {
    const negated = raw.startsWith('!');
    const pattern = negated ? raw.slice(1) : raw;
    if (!pattern || !globToRegExp(pattern).test(host)) continue;
    if (negated) return false;
    positive = true;
  }
  return positive;
}

function expandHomePath(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2));
  if (value.startsWith('~')) throw sshConfigError(`unsupported home-user expansion '${value}'`);
  return value;
}

async function expandIncludePattern(pattern: string, rootDir: string, home: string): Promise<string[]> {
  if (Buffer.byteLength(pattern, 'utf8') > 4096) throw sshConfigError('SSH Include path is too long');
  const expanded = expandHomePath(pattern, home);
  const absolute = isAbsolute(expanded) ? expanded : resolve(rootDir, expanded);
  const filePattern = basename(absolute);
  const parent = dirname(absolute);
  if (!/[?*]/.test(filePattern)) return [absolute];
  if (/[?*]/.test(parent)) {
    throw sshConfigError(`wildcards are only supported in the final Include path segment: '${pattern}'`);
  }
  let entries: Dirent<string>[];
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const matcher = globToRegExp(filePattern);
  return entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && matcher.test(entry.name))
    .map((entry) => join(parent, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

async function readExpandedConfig(configPath: string, home: string): Promise<ConfigLine[]> {
  const rootDir = dirname(configPath);
  const output: ConfigLine[] = [];
  const stack = new Set<string>();
  let filesRead = 0;
  let totalBytes = 0;

  const visit = async (path: string, depth: number, optional: boolean): Promise<void> => {
    if (depth > SSH_CONFIG_MAX_DEPTH) throw sshConfigError(`SSH Include depth exceeds ${SSH_CONFIG_MAX_DEPTH}`);
    if (filesRead >= SSH_CONFIG_MAX_FILES) throw sshConfigError(`SSH config expands beyond ${SSH_CONFIG_MAX_FILES} files`);

    let canonical: string;
    let bytes: Buffer;
    try {
      const file = await readBoundedRegularFile(
        path,
        SSH_CONFIG_MAX_BYTES - totalBytes,
        'SSH config file',
      );
      canonical = file.canonicalPath;
      bytes = file.bytes;
    } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw sshConfigError(`SSH config file was not found: ${path}`);
      }
      if (error instanceof BoundedFileReadError && error.reason === 'too-large') {
        throw sshConfigError(`SSH config expands beyond ${SSH_CONFIG_MAX_BYTES} bytes`);
      }
      throw error;
    }
    if (stack.has(canonical)) throw sshConfigError(`SSH Include cycle detected at ${canonical}`);
    filesRead += 1;
    totalBytes += bytes.byteLength;
    if (totalBytes > SSH_CONFIG_MAX_BYTES) {
      throw sshConfigError(`SSH config expands beyond ${SSH_CONFIG_MAX_BYTES} bytes`);
    }

    stack.add(canonical);
    try {
      const lines = bytes.toString('utf8').split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const raw = lines[index];
        if (Buffer.byteLength(raw, 'utf8') > SSH_CONFIG_MAX_LINE_BYTES) {
          throw sshConfigError(`SSH config line exceeds ${SSH_CONFIG_MAX_LINE_BYTES} bytes`, {
            tokens: [], source: canonical, line: index + 1,
          });
        }
        const tokens = tokenizeSshConfigLine(raw);
        if (tokens.length === 0) continue;
        if (tokens[0].toLowerCase() === 'include') {
          if (tokens.length < 2) {
            throw sshConfigError('Include requires at least one path', { tokens, source: canonical, line: index + 1 });
          }
          for (const includePattern of tokens.slice(1)) {
            const matches = await expandIncludePattern(includePattern, rootDir, home);
            for (const match of matches) await visit(match, depth + 1, true);
          }
          continue;
        }
        output.push({ tokens, source: canonical, line: index + 1 });
      }
    } finally {
      stack.delete(canonical);
    }
  };

  await visit(configPath, 0, false);
  return output;
}

function resolveEffectiveHostname(configured: string | undefined, originalHost: string): string | null {
  if (configured === undefined) return originalHost;
  let resolved = '';
  for (let index = 0; index < configured.length; index += 1) {
    const char = configured[index];
    if (char !== '%') {
      resolved += char;
      continue;
    }
    const token = configured[index + 1];
    if (token === '%') resolved += '%';
    else if (token === 'h') resolved += originalHost;
    else return null;
    index += 1;
  }
  return resolved;
}

/** Return false only when a host criterion proves this Match cannot apply. */
function matchCouldApply(
  tokens: readonly string[],
  originalHost: string,
  effectiveHost: string | null,
): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    const criterion = tokens[index].toLowerCase();
    if (criterion !== 'host' && criterion !== 'originalhost') continue;
    const patterns: string[] = [];
    for (index += 1; index < tokens.length; index += 1) {
      if (MATCH_CRITERIA.has(tokens[index].toLowerCase())) {
        index -= 1;
        break;
      }
      patterns.push(tokens[index]);
    }
    const candidate = criterion === 'host' ? effectiveHost : originalHost;
    // Unknown HostName token expansion cannot prove non-applicability. Preserve
    // the resolver's fail-closed contract and reject the Match instead.
    if (patterns.length > 0 && candidate !== null && !hostPatternsMatch(patterns, candidate)) {
      return false;
    }
  }
  return true;
}

function singleValue(line: ConfigLine, directive: string): string {
  if (line.tokens.length !== 2 || line.tokens[1].length === 0) {
    throw sshConfigError(`${directive} requires exactly one non-empty value`, line);
  }
  const value = line.tokens[1];
  if (/\p{Cc}/u.test(value)) throw sshConfigError(`${directive} contains a control character`, line);
  return value;
}

function isUnsafeDirective(directive: string): boolean {
  return UNSAFE_DIRECTIVES.has(directive)
    || directive.startsWith('proxy')
    || directive.startsWith('canonical')
    || directive.includes('forward');
}

function selectSafeValues(lines: readonly ConfigLine[], alias: string): SafeConfigValues {
  let active = true;
  let matchedHost = false;
  let hostname: string | undefined;
  let user: string | undefined;
  let port: string | undefined;
  const identityFiles: string[] = [];

  for (const line of lines) {
    const directive = line.tokens[0].toLowerCase();
    if (directive === 'host') {
      if (line.tokens.length < 2) throw sshConfigError('Host requires at least one pattern', line);
      active = hostPatternsMatch(line.tokens.slice(1), alias);
      if (active) matchedHost = true;
      continue;
    }
    if (directive === 'match') {
      const effectiveHost = resolveEffectiveHostname(hostname, alias);
      if (matchCouldApply(line.tokens.slice(1), alias, effectiveHost)) {
        throw sshConfigError('applicable Match directives are not supported for config aliases', line);
      }
      active = false;
      continue;
    }
    if (!active) continue;
    if (isUnsafeDirective(directive)) {
      throw sshConfigError(`unsafe SSH directive '${line.tokens[0]}' applies to alias '${alias}'`, line);
    }
    if (!SAFE_DIRECTIVES.has(directive)) continue;

    const value = singleValue(line, line.tokens[0]);
    if (directive === 'hostname' && hostname === undefined) hostname = value;
    else if (directive === 'user' && user === undefined) user = value;
    else if (directive === 'port' && port === undefined) port = value;
    else if (directive === 'identityfile') {
      if (identityFiles.length >= SSH_CONFIG_MAX_IDENTITIES) {
        throw sshConfigError(`more than ${SSH_CONFIG_MAX_IDENTITIES} IdentityFile entries apply to alias '${alias}'`, line);
      }
      identityFiles.push(value);
    }
  }

  if (!matchedHost) throw sshConfigError(`no Host entry matches config alias '${alias}'`);
  if (port !== undefined && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
    throw sshConfigError(`invalid Port '${port}' for config alias '${alias}'`);
  }
  return { hostname, user, port, identityFiles };
}

function quoteConfigValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildSanitizedConfig(alias: string, values: SafeConfigValues): string {
  const lines = [`Host ${alias}`];
  if (values.hostname !== undefined) lines.push(`  HostName ${quoteConfigValue(values.hostname)}`);
  if (values.user !== undefined) lines.push(`  User ${quoteConfigValue(values.user)}`);
  if (values.port !== undefined) lines.push(`  Port ${quoteConfigValue(values.port)}`);
  for (const identity of values.identityFiles) lines.push(`  IdentityFile ${quoteConfigValue(identity)}`);
  return `${lines.join('\n')}\n`;
}

export const runOpenSshG: SshGRunner = (executable, args, options) =>
  new Promise((resolvePromise, rejectPromise) => {
    nodeExecFile(
      executable,
      [...args],
      {
        encoding: 'utf8',
        maxBuffer: SSH_G_STDOUT_MAX_BYTES + 1,
        timeout: SSH_G_TIMEOUT_MS,
        windowsHide: true,
        shell: false,
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        if (error) rejectPromise(error);
        else resolvePromise({ stdout, stderr });
      },
    );
  });

function describeSshGError(error: unknown): Error {
  const err = error as NodeJS.ErrnoException & { killed?: boolean; stdout?: string; stderr?: string };
  if (err?.name === 'AbortError') return sshConfigError('SSH config resolution was cancelled');
  if (err?.code === 'ENOENT') return sshConfigError('OpenSSH client executable was not found');
  if (err?.code === 'ETIMEDOUT' || err?.killed) return sshConfigError(`ssh -G timed out after ${SSH_G_TIMEOUT_MS}ms`);
  if (err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return sshConfigError('ssh -G output exceeded its size limit');
  return sshConfigError(`ssh -G failed: ${err?.message ?? String(error)}`);
}

function parseSshGOutput(stdout: string): { host: string; port: number; user: string; identityFiles: string[] } {
  if (Buffer.byteLength(stdout, 'utf8') > SSH_G_STDOUT_MAX_BYTES) {
    throw sshConfigError('ssh -G output exceeded its size limit');
  }
  let host: string | undefined;
  let port: number | undefined;
  let user: string | undefined;
  const identityFiles: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    if (Buffer.byteLength(raw, 'utf8') > SSH_CONFIG_MAX_LINE_BYTES) throw sshConfigError('ssh -G emitted an oversized line');
    const separator = raw.search(/\s/);
    if (separator < 1) continue;
    const key = raw.slice(0, separator).toLowerCase();
    const value = raw.slice(separator).trim();
    if (key === 'hostname' && host === undefined) host = value;
    else if (key === 'user' && user === undefined) user = value;
    else if (key === 'port' && port === undefined && /^\d+$/.test(value)) port = Number(value);
    else if (key === 'identityfile' && identityFiles.length < SSH_CONFIG_MAX_IDENTITIES) identityFiles.push(value);
  }
  if (!host || !user || port === undefined || port < 1 || port > 65535) {
    throw sshConfigError('ssh -G did not return a valid HostName, User, and Port');
  }
  return { host, port, user, identityFiles };
}

function expandIdentityPath(raw: string, target: { alias: string; host: string; port: number; user: string }, home: string): string {
  let value = expandHomePath(raw, home);
  const replacements: Record<string, string> = {
    '%': '%',
    d: home,
    h: target.host,
    n: target.alias,
    p: String(target.port),
    r: target.user,
  };
  value = value.replace(/%([A-Za-z%])/g, (_match, token: string) => {
    const replacement = replacements[token];
    if (replacement === undefined) throw sshConfigError(`unsupported IdentityFile token '%${token}'`);
    return replacement;
  });
  return isAbsolute(value) ? value : resolve(home, value);
}

async function firstReadableIdentity(
  candidates: readonly string[],
  target: { alias: string; host: string; port: number; user: string },
  home: string,
): Promise<string | undefined> {
  if (candidates.some((candidate) => candidate.toLowerCase() === 'none')) return undefined;
  for (const candidate of candidates) {
    const path = expandIdentityPath(candidate, target, home);
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      await access(path, fsConstants.R_OK);
      return path;
    } catch {
      // OpenSSH also tries its identity list in order; unreadable entries are skipped.
    }
  }
  return undefined;
}

export async function resolveSshConfigAlias(
  request: ResolveSshAliasRequest,
  deps: SshConfigResolverDeps = {},
): Promise<ResolvedSshAlias> {
  const alias = request.alias;
  if (!ALIAS_RE.test(alias)) throw sshConfigError(`invalid SSH config alias '${alias}'`);
  if (request.portOverride !== undefined && (!Number.isInteger(request.portOverride) || request.portOverride < 1 || request.portOverride > 65535)) {
    throw sshConfigError('--port must be an integer between 1 and 65535');
  }
  request.signal?.throwIfAborted();

  const home = deps.homeDir ?? homedir();
  const configPath = deps.configPath ?? join(home, '.ssh', 'config');
  const lines = await readExpandedConfig(configPath, home);
  const safeValues = selectSafeValues(lines, alias);
  const sanitized = buildSanitizedConfig(alias, safeValues);
  const directory = await mkdtemp(join(deps.tempDir ?? tmpdir(), 'ezterminal-ssh-'));
  const sanitizedPath = join(directory, 'config');
  try {
    await chmod(directory, 0o700);
    await writeFile(sanitizedPath, sanitized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await chmod(sanitizedPath, 0o600);
    request.signal?.throwIfAborted();

    let result: SshGResult;
    try {
      result = await (deps.runSshG ?? runOpenSshG)(
        deps.sshExecutable ?? 'ssh',
        ['-G', '-F', sanitizedPath, '--', alias],
        { signal: request.signal },
      );
    } catch (error) {
      throw describeSshGError(error);
    }
    if (Buffer.byteLength(result.stderr, 'utf8') > SSH_G_STDERR_MAX_BYTES) {
      throw sshConfigError('ssh -G diagnostic output exceeded its size limit');
    }
    const parsed = parseSshGOutput(result.stdout);
    const port = request.portOverride ?? parsed.port;
    const target = { alias, host: parsed.host, port, user: parsed.user };
    const keyPath = request.keyPathOverride ?? await firstReadableIdentity(parsed.identityFiles, target, home);
    return { ...target, keyPath };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
