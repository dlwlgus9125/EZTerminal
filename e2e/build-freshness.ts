import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SOURCE_INPUT_PATTERN = /\.(?:css|html|ts|tsx|woff2)$/;
const RENDERER_ARTIFACT_PATTERN = /\.(?:css|js|woff2)$/;

const REQUIRED_ROOT_INPUTS = [
  'forge.config.ts',
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'vite.interpreter.config.ts',
  'vite.main.config.ts',
  'vite.packet-capture.config.ts',
  'vite.preload.config.ts',
  'vite.renderer.config.ts',
  'vite.script-host.config.ts',
] as const;

const REQUIRED_NODE_ARTIFACTS = [
  'main.js',
  'preload.js',
  'interpreter-process.js',
  'script-host.js',
  'packet-capture-host.js',
] as const;

function listFilesRecursively(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? listFilesRecursively(absolute) : [absolute];
  });
}

function resolveRendererReference(rendererOutput: string, sourcePath: string, reference: string): string | undefined {
  const cleanReference = reference.split(/[?#]/, 1)[0];
  if (!cleanReference || /^[a-z][a-z\d+.-]*:/i.test(cleanReference) || cleanReference.startsWith('//')) {
    return undefined;
  }
  const absolute = cleanReference.startsWith('/')
    ? path.resolve(rendererOutput, `.${cleanReference}`)
    : path.resolve(path.dirname(sourcePath), cleanReference);
  const relative = path.relative(rendererOutput, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !RENDERER_ARTIFACT_PATTERN.test(absolute)) {
    return undefined;
  }
  return absolute;
}

/**
 * Include local assets referenced by the renderer entry/CSS/JS even when the
 * referenced file itself is missing. Otherwise a partially deleted Vite output
 * could look fresh simply because directory discovery can no longer see it.
 */
function referencedRendererArtifacts(rendererOutput: string, sourcePath: string): string[] {
  const contents = readFileSync(sourcePath, 'utf8');
  const references: string[] = [];
  const extension = path.extname(sourcePath);

  if (extension === '.html') {
    for (const match of contents.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+\.(?:css|js|woff2)(?:[?#][^"']*)?)["']/gi)) {
      references.push(match[1]);
    }
  } else if (extension === '.css') {
    for (const match of contents.matchAll(/\burl\(\s*["']?([^"')]+\.(?:css|js|woff2)(?:[?#][^"')]*)?)["']?\s*\)/gi)) {
      references.push(match[1]);
    }
  } else if (extension === '.js') {
    for (const match of contents.matchAll(/\bimport\(\s*["']((?:\.{1,2}\/|\/)[^"']+\.js(?:[?#][^"']*)?)["']\s*\)/gi)) {
      references.push(match[1]);
    }
  }

  return references.flatMap((reference) => {
    const resolved = resolveRendererReference(rendererOutput, sourcePath, reference);
    return resolved ? [resolved] : [];
  });
}

export function buildInputPaths(root: string): string[] {
  const sourceInputs = listFilesRecursively(path.join(root, 'src')).filter((file) => SOURCE_INPUT_PATTERN.test(file));
  const requiredRootInputs = REQUIRED_ROOT_INPUTS.map((file) => path.join(root, file));
  return [...new Set([...sourceInputs, ...requiredRootInputs])];
}

export function buildArtifactPaths(root: string): string[] {
  const buildOutput = path.join(root, '.vite', 'build');
  const rendererOutput = path.join(root, '.vite', 'renderer', 'main_window');
  const rendererEntry = path.join(rendererOutput, 'index.html');
  const emittedRendererArtifacts = listFilesRecursively(rendererOutput).filter((file) =>
    RENDERER_ARTIFACT_PATTERN.test(file),
  );
  const referenceSources = [rendererEntry, ...emittedRendererArtifacts.filter((file) => /\.(?:css|js)$/.test(file))]
    .filter(existsSync);
  const referencedArtifacts = referenceSources.flatMap((file) => referencedRendererArtifacts(rendererOutput, file));
  const nodeArtifacts = REQUIRED_NODE_ARTIFACTS.map((file) => path.join(buildOutput, file));
  return [...new Set([...nodeArtifacts, rendererEntry, ...emittedRendererArtifacts, ...referencedArtifacts])];
}

/**
 * A Playwright launch is trustworthy only when every required artifact exists
 * and the oldest artifact is at least as new as the newest build input.
 */
export function areBuildArtifactsFresh(artifactPaths: readonly string[], inputPaths: readonly string[]): boolean {
  if (artifactPaths.length === 0 || inputPaths.length === 0) return false;
  if (artifactPaths.some((artifact) => !existsSync(artifact))) return false;
  if (inputPaths.some((input) => !existsSync(input))) return false;

  const oldestArtifact = Math.min(...artifactPaths.map((artifact) => statSync(artifact).mtimeMs));
  const newestInput = Math.max(...inputPaths.map((input) => statSync(input).mtimeMs));
  return oldestArtifact >= newestInput;
}
