import type { AgentApprovalRisk } from './agent';

/**
 * Risk classification for a tool call an agent is asking permission to run.
 *
 * The output drives one thing: how loudly the approval card shouts. `danger`
 * paints red and blinks, `write` paints amber, `read` stays neutral. Because a
 * human still makes the actual decision, the cost of over-classifying is noise
 * and the cost of under-classifying is a red command wearing amber. So the
 * middle value is the default: anything unrecognized is `write`, and only
 * patterns that are unambiguously destructive earn `danger`.
 *
 * Commands are tokenized rather than pattern-matched whole. Scanning raw text
 * for a letter is how `rm --force` ends up misread as recursive, and how
 * `echo "rm -rf /"` ends up misread as the thing it prints.
 */

const READ_ONLY_TOOLS = new Set([
  'read', 'glob', 'grep', 'websearch', 'webfetch',
  'notebookread', 'todowrite', 'task', 'listmcpresources', 'readmcpresource',
]);

const WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'notebookedit', 'applypatch']);

const SHELL_TOOLS = new Set(['bash', 'shell', 'powershell', 'cmd', 'exec', 'run', 'runcommand']);

/** Command heads that cannot change the machine. `cd` is included: it moves a
 * cursor, it does not write anything. */
const READ_ONLY_HEADS = new Set([
  'ls', 'dir', 'gci', 'get-childitem', 'tree',
  'cat', 'type', 'gc', 'get-content', 'head', 'tail', 'more',
  'pwd', 'cd', 'echo', 'printf',
  'grep', 'findstr', 'select-string', 'rg', 'ag', 'fd', 'find',
  'wc', 'sort', 'uniq', 'diff', 'cmp', 'md5sum', 'sha256sum', 'get-filehash',
  'which', 'where', 'whoami', 'hostname', 'date', 'uname', 'systeminfo',
  'ps', 'tasklist', 'top', 'df', 'du', 'free', 'stat', 'file', 'env', 'printenv',
  'true', 'false', 'sleep', 'test',
]);

/** `git` is neither: its subcommand decides. Anything not listed here is a
 * write, which is correct for commit/push/merge/rebase/checkout. */
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'describe',
  'rev-parse', 'ls-files', 'ls-remote', 'ls-tree', 'cat-file', 'shortlog',
  'config', 'remote', 'branch', 'tag', 'stash', 'worktree',
]);

/** Subcommands above stop being read-only the moment one of these shows up. */
const GIT_MUTATING_FLAGS = new Set([
  '-d', '-D', '-f', '-m', '-M', '-u',
  '--delete', '--force', '--move', '--rename', '--set-url', '--unset',
  '--add', '--prune', '--push', '--pop', '--apply', '--drop', '--edit',
]);

/** Heads that end a machine's current state outright. */
const DANGER_HEADS = new Set([
  'sudo', 'runas', 'shutdown', 'reboot', 'halt', 'poweroff',
  'restart-computer', 'stop-computer', 'diskpart', 'clear-disk', 'initialize-disk',
  'mkfs', 'invoke-expression', 'iex',
]);

const DOWNLOADERS = new Set(['curl', 'wget', 'iwr', 'invoke-webrequest', 'invoke-restmethod', 'irm']);
const SHELL_INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'powershell', 'pwsh', 'cmd']);

interface Segment {
  /** Executable basename, lowercased, extension stripped. */
  readonly head: string;
  /** Everything after the head, quotes stripped. */
  readonly args: readonly string[];
}

/** Split on whitespace while honouring quotes, then drop the quote characters
 * so a quoted argument is compared by its value. */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | '`' | null = null;
  let started = false;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/u.test(char)) {
      if (started || current) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
  }
  if (started || current) tokens.push(current);
  return tokens;
}

/** Split a chain on its unquoted separators. A chain is exactly as risky as
 * its riskiest link, so `ls && rm -rf build` must not read as a listing. */
function splitSegments(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | '`' | null = null;
  for (const char of command) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '|' || char === ';' || char === '&' || char === '\n') {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.filter((part) => part.trim().length > 0);
}

function basename(token: string): string {
  const normalized = token.replace(/\\/gu, '/');
  const last = normalized.slice(normalized.lastIndexOf('/') + 1);
  return last.toLocaleLowerCase('en-US').replace(/\.(?:exe|cmd|bat|ps1|sh)$/u, '');
}

function parseSegment(text: string): Segment | null {
  const tokens = tokenize(text.trim().replace(/^!\s*/u, ''));
  if (tokens.length === 0) return null;
  return { head: basename(tokens[0] ?? ''), args: tokens.slice(1) };
}

/** True when a short flag cluster such as `-rf` carries `letter`. Long flags
 * are matched by name instead, so `--force` never counts as recursion. */
function hasShortFlag(args: readonly string[], letter: string): boolean {
  const lower = letter.toLocaleLowerCase('en-US');
  return args.some(
    (arg) =>
      arg.startsWith('-') &&
      !arg.startsWith('--') &&
      arg.slice(1).toLocaleLowerCase('en-US').includes(lower),
  );
}

function hasLongFlag(args: readonly string[], ...names: readonly string[]): boolean {
  return args.some((arg) => names.includes(arg.toLocaleLowerCase('en-US')));
}

/** PowerShell accepts any unambiguous prefix, so `-Rec` is `-Recurse`. */
function hasPowerShellSwitch(args: readonly string[], full: string): boolean {
  return args.some((arg) => {
    if (!arg.startsWith('-')) return false;
    const name = arg.slice(1).toLocaleLowerCase('en-US');
    return name.length >= 3 && full.startsWith(name);
  });
}

function hasSlashFlag(args: readonly string[], letter: string): boolean {
  return args.some((arg) => arg.toLocaleLowerCase('en-US') === `/${letter}`);
}

function isDangerous(segment: Segment): boolean {
  const { head, args } = segment;
  if (DANGER_HEADS.has(head)) return true;

  // Recursion is what makes a delete unbounded. Force alone is not enough.
  if (head === 'rm') return hasShortFlag(args, 'r') || hasLongFlag(args, '--recursive');
  if (head === 'del' || head === 'erase' || head === 'rd' || head === 'rmdir') {
    return hasSlashFlag(args, 's');
  }
  if (head === 'remove-item' || head === 'ri') return hasPowerShellSwitch(args, 'recurse');

  if (head === 'format') return args.some((arg) => /^[a-z]:$/iu.test(arg));
  if (head === 'dd') return args.some((arg) => arg.toLocaleLowerCase('en-US').startsWith('of='));
  if (head === 'reg') {
    const subcommand = args[0]?.toLocaleLowerCase('en-US') ?? '';
    return ['add', 'delete', 'import', 'restore'].includes(subcommand);
  }
  if (head === 'set-itemproperty' || head === 'new-itemproperty' || head === 'remove-itemproperty') {
    return args.some((arg) => /^hk(?:lm|cu|cr|u|cc):/iu.test(arg));
  }
  if (head === 'chmod') return args.includes('777');
  if (head === 'icacls' || head === 'takeown') return hasSlashFlag(args, 'grant');
  if (head === 'npm' || head === 'pnpm' || head === 'yarn') return args[0] === 'publish';

  if (head === 'git') {
    const subcommand = args[0]?.toLocaleLowerCase('en-US') ?? '';
    const rest = args.slice(1);
    if (subcommand === 'push') return hasShortFlag(rest, 'f') || hasLongFlag(rest, '--force', '--force-with-lease');
    if (subcommand === 'reset') return hasLongFlag(rest, '--hard');
    if (subcommand === 'clean') return hasShortFlag(rest, 'f');
  }
  return false;
}

function classifySegment(text: string): AgentApprovalRisk {
  const segment = parseSegment(text);
  if (!segment) return 'read';
  if (isDangerous(segment)) return 'danger';
  if (segment.head === 'git') {
    const subcommand = segment.args[0]?.toLocaleLowerCase('en-US') ?? '';
    if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return 'write';
    return segment.args.slice(1).some((arg) => GIT_MUTATING_FLAGS.has(arg)) ? 'write' : 'read';
  }
  return READ_ONLY_HEADS.has(segment.head) ? 'read' : 'write';
}

const RANK: Record<AgentApprovalRisk, number> = { read: 0, write: 1, danger: 2 };

/** Downloading something and handing it straight to a shell is dangerous as a
 * pair even though neither half is dangerous alone. */
function pipesDownloadIntoShell(segments: readonly string[]): boolean {
  for (let i = 0; i < segments.length - 1; i += 1) {
    const from = parseSegment(segments[i] ?? '');
    const into = parseSegment(segments[i + 1] ?? '');
    if (!from || !into) continue;
    const target = into.head === 'sudo' ? basename(into.args[0] ?? '') : into.head;
    if (DOWNLOADERS.has(from.head) && SHELL_INTERPRETERS.has(target)) return true;
  }
  return false;
}

/** Classify a shell command on its own. */
export function classifyCommandRisk(command: string): AgentApprovalRisk {
  const segments = splitSegments(command);
  if (segments.length === 0) return 'write';
  if (pipesDownloadIntoShell(segments)) return 'danger';
  let worst: AgentApprovalRisk = 'read';
  for (const segment of segments) {
    const risk = classifySegment(segment);
    if (RANK[risk] > RANK[worst]) worst = risk;
    if (worst === 'danger') break;
  }
  return worst;
}

/**
 * Classify a pending tool call. `command` is only consulted for shell-shaped
 * tools; a `Write` call does not become dangerous because the file it writes
 * happens to contain the text `rm -rf`.
 */
export function classifyApprovalRisk(toolName: string, command?: string): AgentApprovalRisk {
  const tool = toolName.trim().toLocaleLowerCase('en-US');
  if (READ_ONLY_TOOLS.has(tool)) return 'read';
  if (WRITE_TOOLS.has(tool)) return 'write';
  if (SHELL_TOOLS.has(tool) || tool === '') {
    const text = command?.trim();
    return text ? classifyCommandRisk(text) : 'write';
  }
  return 'write';
}
