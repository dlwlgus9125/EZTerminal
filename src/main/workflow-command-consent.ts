import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IpcMain } from 'electron';
import { z } from 'zod';

import type { WorkflowCheckConsentResult, WorkflowCheckStatus } from '../shared/workflow-checks';
import type { WorkflowGraph } from '../shared/workflow-graph';
import { JsonFile } from './json-file';

/**
 * 확인 명령 동의: a stage's check runs a command on this PC, and a flow can come with the project folder
 * (or be written by an AI), so a person allows each command once here. The allowance covers the command,
 * this project folder, this platform and the content of the script the command calls (a package.json
 * script or a script file), so a stage that edits that script is asked about again — the digest is
 * computed again in the stage's result folder right before the check runs.
 */

const FILE = 'workflow-command-consents.json';
const MAX_CONSENTS = 2_000;
const MAX_SCRIPT_BYTES = 1024 * 1024;

const ConsentSchema = z.object({
  digest: z.string().regex(/^[0-9a-f]{64}$/u), projectId: z.string().min(1).max(160), subprojectId: z.string().min(1).max(160),
  nodeId: z.string().min(1).max(160), checkId: z.string().min(1).max(160), command: z.string().min(1).max(4_000),
  grantedBy: z.string().min(1).max(200), grantedAt: z.string().datetime(),
}).strict();
export type WorkflowCommandConsent = z.infer<typeof ConsentSchema>;
const FileSchema = z.object({ version: z.literal(1), consents: z.array(ConsentSchema).max(MAX_CONSENTS) }).strict();
type ConsentFile = z.infer<typeof FileSchema>;
const EMPTY: ConsentFile = { version: 1, consents: [] };

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const RUNNERS = new Set(['pnpm', 'npm', 'yarn', 'bun']);
const INTERPRETERS = new Set(['node', 'python', 'python3', 'py', 'bash', 'sh', 'pwsh', 'powershell', 'deno', 'tsx', 'ts-node']);
const SCRIPT_FILE = /\.(?:m?js|cjs|ts|mts|sh|ps1|cmd|bat|py)$/iu;

/** Splits a command line into words (double or single quotes keep spaces); enough to find what it calls. */
function words(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/gu)].map(match => match[1] ?? match[2] ?? match[3] ?? '');
}

/** A file inside the folder, or nothing (a path outside it, a link out of it, or a missing file). */
async function insideFile(root: string, relative: string): Promise<string | undefined> {
  if (path.isAbsolute(relative)) return undefined;
  const target = path.resolve(root, relative);
  try {
    const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
    const inside = path.relative(realRoot, realTarget);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return undefined;
    const stat = await fs.stat(realTarget);
    return stat.isFile() && stat.size <= MAX_SCRIPT_BYTES ? realTarget : undefined;
  } catch { return undefined; }
}

/** What a command calls, resolved in a folder: each script by name with a digest, or why it cannot be allowed. */
export interface CheckScripts { readonly scripts: Readonly<Record<string, string>>; readonly blocked?: string }

/** A path a command names: relative, inside the folder, and there. */
function isPathLike(word: string): boolean {
  return word.startsWith('./') || word.startsWith('.\\') || word.startsWith('../') || word.startsWith('..\\') || path.isAbsolute(word) || SCRIPT_FILE.test(word);
}

/**
 * What the command calls, by name, with a digest of its content: `pnpm test` → package.json's `test` script and the
 * script files that script runs, `node scripts/x.mjs` or `./run.sh` → that file. A script path that leaves the folder
 * or is not there blocks the allowance (the person could not see what would run).
 */
export async function resolveCheckScripts(root: string, command: string, depth = 0): Promise<CheckScripts> {
  const scripts: Record<string, string> = {};
  // A package script may chain commands: each one is resolved the same way.
  for (const segment of command.split(/&&|\|\||;|\|/u).map(part => part.trim()).filter(Boolean)) {
    const parts = words(segment).filter(part => !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(part));
    const first = path.basename(parts[0] ?? '').replace(/\.(?:cmd|exe|ps1)$/iu, '').toLowerCase();
    let file: string | undefined;
    if (RUNNERS.has(first)) {
      const rest = parts.slice(1).filter(part => !part.startsWith('-'));
      const name = rest[0] === 'run' || rest[0] === 'run-script' ? rest[1] : rest[0];
      const manifest = await insideFile(root, 'package.json');
      if (!name || !manifest) continue;
      let script = '';
      try { script = String((JSON.parse(await fs.readFile(manifest, 'utf8')) as { scripts?: Record<string, unknown> }).scripts?.[name] ?? ''); }
      catch { return { scripts, blocked: 'package.json could not be read, so what the check runs cannot be shown.' }; }
      scripts[`package.json#${name}`] = sha256(script);
      // What the script itself runs (one level: a script calling another package script is named, not followed again).
      if (script && depth < 1) {
        const nested = await resolveCheckScripts(root, script, depth + 1);
        Object.assign(scripts, nested.scripts);
        if (nested.blocked) return { scripts, blocked: nested.blocked };
      }
      continue;
    }
    if (INTERPRETERS.has(first)) file = parts.slice(1).find(part => !part.startsWith('-'));
    else if (parts[0] && isPathLike(parts[0])) file = parts[0];
    if (!file || !isPathLike(file)) continue;
    const found = await insideFile(root, file);
    if (!found) return { scripts, blocked: `The check runs ${file}, which is outside the project folder or missing, so it cannot be allowed.` };
    scripts[file.replace(/\\/gu, '/')] = sha256(await fs.readFile(found));
  }
  return { scripts };
}

/** The allowance digest: the command, the project folder, the platform and what the command calls. */
export function checkConsentDigest(input: { readonly command: string; readonly projectRoot: string; readonly platform: string; readonly scripts: Readonly<Record<string, string>> }): string {
  const scripts = Object.fromEntries(Object.keys(input.scripts).sort().map(key => [key, input.scripts[key]]));
  return sha256(JSON.stringify({ v: 1, command: input.command.trim(), projectRoot: path.resolve(input.projectRoot).toLowerCase(), platform: input.platform, scripts }));
}

export class WorkflowCommandConsentStore {
  private readonly file: JsonFile;
  private cached: readonly WorkflowCommandConsent[] = [];
  private readonly ready: Promise<void>;

  constructor(directory: string, private readonly platform: string = process.platform) {
    this.file = new JsonFile(directory, FILE);
    this.ready = this.file.init().then(async () => { this.cached = (await this.file.readValidated(raw => { const parsed = FileSchema.safeParse(raw); return parsed.success ? parsed.data : null; }, EMPTY)).consents; });
  }

  /** The digest of a check computed in `scriptRoot` (the project, or a stage's result folder) for `projectRoot`. */
  async digest(projectRoot: string, scriptRoot: string, command: string): Promise<{ readonly digest: string; readonly scripts: readonly string[]; readonly blocked?: string }> {
    const resolved = await resolveCheckScripts(scriptRoot, command);
    return { digest: checkConsentDigest({ command, projectRoot, platform: this.platform, scripts: resolved.scripts }), scripts: Object.keys(resolved.scripts).sort(),
      ...(resolved.blocked ? { blocked: resolved.blocked } : {}) };
  }

  async allowed(digest: string): Promise<boolean> {
    await this.ready;
    return this.cached.some(entry => entry.digest === digest);
  }

  /** Every check of the flow's AI stages, computed in the project folder. */
  async status(projectId: string, subprojectId: string, projectRoot: string, graph: WorkflowGraph): Promise<readonly WorkflowCheckStatus[]> {
    await this.ready;
    const result: WorkflowCheckStatus[] = [];
    for (const node of graph.nodes) for (const check of node.checks ?? []) {
      const { digest, scripts, blocked } = await this.digest(projectRoot, projectRoot, check.command);
      const allowed = !blocked && this.cached.some(entry => entry.digest === digest);
      const previous = [...this.cached].reverse().find(entry => entry.projectId === projectId && entry.subprojectId === subprojectId && entry.nodeId === node.id && entry.checkId === check.id);
      result.push({ nodeId: node.id, checkId: check.id, command: check.command, digest, allowed, scripts, ...(blocked ? { blocked } : {}),
        ...(allowed ? {} : { reason: !previous ? 'new' as const : previous.command.trim() === check.command.trim() ? 'script-changed' as const : 'changed' as const }),
        ...(!allowed && previous && previous.command.trim() !== check.command.trim() ? { before: previous.command } : {}) });
    }
    return result;
  }

  /** A person allows one check as it is now; a digest that no longer matches is refused (look again). */
  async grant(input: { readonly projectId: string; readonly subprojectId: string; readonly projectRoot: string; readonly graph: WorkflowGraph; readonly nodeId: string; readonly checkId: string; readonly digest: string; readonly grantedBy: string; readonly now: Date }): Promise<WorkflowCheckConsentResult> {
    await this.ready;
    const check = input.graph.nodes.find(node => node.id === input.nodeId)?.checks?.find(entry => entry.id === input.checkId);
    if (!check) return { ok: false, error: 'not-found', message: 'This check is no longer in the workflow.' };
    const current = await this.digest(input.projectRoot, input.projectRoot, check.command);
    if (current.blocked) return { ok: false, error: 'blocked', message: current.blocked };
    if (current.digest !== input.digest) return { ok: false, error: 'changed', message: 'The command or the script it calls changed. Look at it again before allowing it.' };
    const entry: WorkflowCommandConsent = { digest: current.digest, projectId: input.projectId, subprojectId: input.subprojectId, nodeId: input.nodeId, checkId: input.checkId,
      command: check.command, grantedBy: input.grantedBy, grantedAt: input.now.toISOString() };
    const next = await this.file.update(raw => { const parsed = FileSchema.safeParse(raw); return parsed.success ? parsed.data : null; }, EMPTY,
      current => ({ version: 1 as const, consents: [...current.consents.filter(item => item.digest !== entry.digest), entry].slice(-MAX_CONSENTS) }), 'allow workflow check');
    if (!next) return { ok: false, error: 'unavailable', message: 'The allowance could not be saved.' };
    this.cached = next.consents;
    return { ok: true, checks: await this.status(input.projectId, input.subprojectId, input.projectRoot, input.graph) };
  }

  async flush(): Promise<void> { await this.file.flush(); }
}

/** `workflow-checks:status|allow` for the desktop renderer (a person on this PC only). */
export function installWorkflowCheckIpc(input: {
  readonly ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  readonly authorized: (event: Electron.IpcMainInvokeEvent, clientId: unknown) => boolean;
  readonly status: (projectId: string, subprojectId: string) => Promise<WorkflowCheckConsentResult>;
  readonly allow: (projectId: string, subprojectId: string, nodeId: string, checkId: string, digest: string) => Promise<WorkflowCheckConsentResult>;
}): () => void {
  const text = (value: unknown, max = 160): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
  const forbidden = { ok: false, error: 'forbidden', message: 'An authenticated application surface is required.' } as const;
  input.ipc.handle('workflow-checks:status', async (event, clientId: unknown, projectId: unknown, subprojectId: unknown) => {
    if (!input.authorized(event, clientId)) return forbidden;
    if (!text(projectId) || !text(subprojectId)) return { ok: false, error: 'invalid', message: 'Choose a workflow.' };
    return input.status(projectId, subprojectId);
  });
  input.ipc.handle('workflow-checks:allow', async (event, clientId: unknown, projectId: unknown, subprojectId: unknown, nodeId: unknown, checkId: unknown, digest: unknown) => {
    if (!input.authorized(event, clientId)) return forbidden;
    if (!text(projectId) || !text(subprojectId) || !text(nodeId) || !text(checkId) || !text(digest, 64)) return { ok: false, error: 'invalid', message: 'Choose a check.' };
    return input.allow(projectId, subprojectId, nodeId, checkId, digest);
  });
  return () => { for (const channel of ['status', 'allow']) input.ipc.removeHandler(`workflow-checks:${channel}`); };
}
