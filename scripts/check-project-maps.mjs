import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';

import { createServer } from 'vite';

const PROJECT_MAP_DIRECTORY = '.ezterminal/project-map';
const MANIFEST_PATH = `${PROJECT_MAP_DIRECTORY}/manifest.json`;
const GIT_PREFIX = ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false'];

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function fileVersion(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function digestEvidence(content, startLine, endLine) {
  const lines = content.replace(/\r\n?/gu, '\n').split('\n');
  if (startLine < 1 || endLine < startLine || endLine > lines.length) return undefined;
  return sha256(lines.slice(startLine - 1, endLine).join('\n'));
}

function digestInputs(records) {
  const normalized = [...records]
    .sort((left, right) => compareText(left.rootAlias, right.rootAlias)
      || compareText(left.relativePath, right.relativePath))
    .map((record) => `${record.rootAlias}\u0000${record.relativePath}\u0000${record.version}`)
    .join('\n');
  return sha256(normalized);
}

function parseRootArguments(argv) {
  const bindings = new Map();
  for (const argument of argv) {
    if (!argument.startsWith('--root=')) throw new Error(`Unknown argument: ${argument}`);
    const binding = argument.slice('--root='.length);
    const separator = binding.indexOf('=');
    if (separator < 1 || separator === binding.length - 1) {
      throw new Error(`Expected --root=<alias>=<absolute-git-root>, received: ${argument}`);
    }
    const alias = binding.slice(0, separator);
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(alias)) throw new Error(`Invalid root alias: ${alias}`);
    if (bindings.has(alias)) throw new Error(`Duplicate root binding: ${alias}`);
    bindings.set(alias, path.resolve(binding.slice(separator + 1)));
  }
  return bindings;
}

function resolveInside(root, relativePath) {
  const target = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes root ${root}: ${relativePath}`);
  }
  return target;
}

function samePath(left, right) {
  const a = path.normalize(left);
  const b = path.normalize(right);
  return process.platform === 'win32'
    ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US')
    : a === b;
}

function git(root, args) {
  return execFileSync('git', [...GIT_PREFIX, ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
}

function formatDiagnostic(scope, diagnostic) {
  return `${scope} ${diagnostic.code} (${diagnostic.subject}): ${diagnostic.message}`;
}

const errors = [];
const warnings = [];
let vite;

try {
  const repoRoot = realpathSync(process.cwd());
  const rootBindings = parseRootArguments(process.argv.slice(2));
  const manifestFile = resolveInside(repoRoot, MANIFEST_PATH);
  if (!existsSync(manifestFile)) throw new Error(`Project Map manifest is missing: ${MANIFEST_PATH}`);

  vite = await createServer({
    root: repoRoot,
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  });
  const schema = await vite.ssrLoadModule('/src/shared/project-map.ts');
  const layout = await vite.ssrLoadModule('/src/shared/project-map-layout.ts');
  const parsedManifest = schema.validateProjectMapManifestText(readFileSync(manifestFile, 'utf8'));
  for (const diagnostic of parsedManifest.diagnostics) {
    const formatted = formatDiagnostic('manifest', diagnostic);
    (diagnostic.severity === 'error' ? errors : warnings).push(formatted);
  }
  const manifest = parsedManifest.value;
  if (!manifest) throw new Error('Manifest schema or semantic validation failed.');

  if (!rootBindings.has(manifest.ownerRootAlias)) rootBindings.set(manifest.ownerRootAlias, repoRoot);
  const declaredAliases = new Set(manifest.roots.map((root) => root.alias));
  for (const alias of rootBindings.keys()) {
    if (!declaredAliases.has(alias)) errors.push(`binding: alias is not declared by manifest: ${alias}`);
  }
  for (const root of manifest.roots) {
    if (!rootBindings.has(root.alias)) {
      errors.push(`binding: ${root.alias} needs --root=${root.alias}=<absolute-git-root>`);
    }
  }

  const provenance = new Map();
  for (const [alias, rootPath] of rootBindings) {
    if (!declaredAliases.has(alias)) continue;
    try {
      const realRoot = realpathSync(rootPath);
      const gitTop = realpathSync(git(realRoot, ['rev-parse', '--show-toplevel']).trim());
      if (!samePath(realRoot, gitTop)) {
        errors.push(`provenance: ${alias} must bind to its Git top-level (${gitTop})`);
        continue;
      }
      provenance.set(alias, { root: realRoot, head: git(realRoot, ['rev-parse', 'HEAD']).trim() });
    } catch (error) {
      errors.push(`provenance: ${alias} could not establish Git identity: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const entry of manifest.maps) {
    const before = errors.length;
    const owner = provenance.get(manifest.ownerRootAlias);
    if (!owner) continue;
    const relativeMapPath = `${PROJECT_MAP_DIRECTORY}/${entry.path}`;
    const mapFile = resolveInside(owner.root, relativeMapPath);
    if (!existsSync(mapFile)) {
      errors.push(`${entry.id}: missing map source ${relativeMapPath}`);
      continue;
    }
    const parsedMap = schema.validateProjectMapSpecText(readFileSync(mapFile, 'utf8'));
    for (const diagnostic of parsedMap.diagnostics) {
      const formatted = formatDiagnostic(entry.id, diagnostic);
      (diagnostic.severity === 'error' ? errors : warnings).push(formatted);
    }
    const spec = parsedMap.value;
    if (!spec) continue;
    if (spec.id !== entry.id || spec.type !== entry.type) {
      errors.push(`${entry.id}: manifest expects ${entry.id}/${entry.type}, map declares ${spec.id}/${spec.type}`);
    }

    const inputRecords = [];
    const relevantByAlias = new Map();
    const addRelevant = (alias, relativePath) => {
      const paths = relevantByAlias.get(alias) ?? new Set();
      paths.add(relativePath);
      relevantByAlias.set(alias, paths);
    };
    addRelevant(manifest.ownerRootAlias, MANIFEST_PATH);
    addRelevant(manifest.ownerRootAlias, relativeMapPath);

    for (const input of entry.authoritativeInputs) {
      const bound = provenance.get(input.rootAlias);
      if (!declaredAliases.has(input.rootAlias)) {
        errors.push(`${entry.id}: authoritative input uses unknown root alias ${input.rootAlias}`);
        continue;
      }
      if (!bound) continue;
      try {
        const bytes = readFileSync(resolveInside(bound.root, input.relativePath));
        inputRecords.push({ ...input, version: fileVersion(bytes) });
        addRelevant(input.rootAlias, input.relativePath);
      } catch (error) {
        errors.push(`${entry.id}: cannot read authoritative input ${input.rootAlias}:${input.relativePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const inputDigest = digestInputs(inputRecords);
    if (inputDigest !== entry.review.inputDigest) {
      errors.push(`${entry.id}: inputs review digest mismatch; expected ${entry.review.inputDigest}, actual ${inputDigest}`);
    }

    for (const anchor of schema.projectMapEvidence(spec)) {
      if (!declaredAliases.has(anchor.rootAlias)) {
        errors.push(`${entry.id}: evidence uses unknown root alias ${anchor.rootAlias}`);
        continue;
      }
      const bound = provenance.get(anchor.rootAlias);
      if (!bound) continue;
      try {
        const bytes = readFileSync(resolveInside(bound.root, anchor.relativePath));
        const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const digest = digestEvidence(content, anchor.startLine, anchor.endLine);
        if (!digest) {
          errors.push(`${entry.id}: evidence range is outside ${anchor.rootAlias}:${anchor.relativePath}:${anchor.startLine}-${anchor.endLine}`);
        } else if (digest !== anchor.lineDigest) {
          errors.push(`${entry.id}: evidence digest mismatch at ${anchor.rootAlias}:${anchor.relativePath}:${anchor.startLine}-${anchor.endLine}`);
        }
        addRelevant(anchor.rootAlias, anchor.relativePath);
      } catch (error) {
        errors.push(`${entry.id}: cannot read evidence ${anchor.rootAlias}:${anchor.relativePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const laidOut = layout.layoutProjectMap(spec);
    for (const diagnostic of laidOut.diagnostics) {
      const formatted = formatDiagnostic(entry.id, diagnostic);
      (diagnostic.severity === 'error' ? errors : warnings).push(formatted);
    }

    for (const [alias, relevant] of relevantByAlias) {
      const bound = provenance.get(alias);
      if (!bound || relevant.size === 0) continue;
      try {
        const status = git(bound.root, [
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
          '--',
          ...[...relevant].sort(),
        ]);
        const kind = status.length > 0 ? 'worktree-snapshot' : 'commit-pinned';
        const receipt = status.length > 0
          ? sha256(JSON.stringify({
              head: bound.head,
              status,
              files: [...relevant]
                .map((relativePath) => [
                  relativePath,
                  fileVersion(readFileSync(resolveInside(bound.root, relativePath))),
                ])
                .sort((left, right) => compareText(left[0], right[0])),
            })).slice(0, 20)
          : bound.head.slice(0, 12);
        console.log(`  provenance ${entry.id}/${alias}: ${kind} ${receipt}`);
      } catch (error) {
        errors.push(`${entry.id}: Git status failed for ${alias}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (errors.length === before) {
      console.log(`PASS ${entry.id} [schema semantics evidence inputs layout provenance]`);
    }
  }
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
} finally {
  await vite?.close();
}

for (const warning of warnings) console.warn(`WARN ${warning}`);
if (errors.length > 0) {
  for (const error of errors) console.error(`FAIL ${error}`);
  console.error(`Project Map check failed with ${errors.length} error(s).`);
  process.exitCode = 1;
} else {
  console.log(`Project Map check passed${warnings.length > 0 ? ` with ${warnings.length} warning(s)` : ''}.`);
}
