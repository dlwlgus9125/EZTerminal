import { realpath } from 'node:fs/promises';
import path from 'node:path';

import type {
  TerminalFileLocationRequest,
  TerminalFileLocationResult,
} from '../shared/terminal-file-location';
import type { TerminalFileCapabilityIssuer } from './terminal-file-capability';

const MAX_PATH_CHARS = 8_192;
const MAX_POSITION = 1_000_000_000;

function validPosition(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value > 0 && value <= MAX_POSITION);
}

function containedBy(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Resolve an explicit terminal gesture against its command-start workspace. */
export async function resolveTerminalFileLocation(
  request: TerminalFileLocationRequest,
  capabilities: TerminalFileCapabilityIssuer,
): Promise<TerminalFileLocationResult> {
  if (request.executionKind !== 'local') {
    return { ok: false, reason: request.executionKind === 'ssh' ? 'remote' : 'invalid' };
  }
  if (
    typeof request.path !== 'string' ||
    typeof request.cwd !== 'string' ||
    request.path.length === 0 ||
    request.cwd.length === 0 ||
    request.path.length > MAX_PATH_CHARS ||
    request.cwd.length > MAX_PATH_CHARS ||
    request.path.includes('\0') ||
    request.cwd.includes('\0') ||
    !validPosition(request.line) ||
    !validPosition(request.column)
  ) {
    return { ok: false, reason: 'invalid' };
  }

  try {
    const root = await realpath(path.resolve(request.cwd));
    const unresolved = path.isAbsolute(request.path)
      ? path.resolve(request.path)
      : path.resolve(root, request.path);
    const target = await realpath(unresolved);
    if (!containedBy(root, target)) return { ok: false, reason: 'outside-workspace' };
    const issued = await capabilities.issue(target, root);
    if (!issued.ok) return issued;
    return {
      ok: true,
      path: target,
      capability: issued.capability,
      ...(request.line === undefined ? {} : { line: request.line }),
      ...(request.column === undefined ? {} : { column: request.column }),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'unreadable' };
  }
}
