import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import {
  dirname,
  extname,
  posix,
  relative,
  resolve,
} from 'node:path';

export const ACTIVE_CONTRACTS = Object.freeze([
  'docs/design/terminal-runtime.md',
  'docs/design/workbench-lifecycle.md',
  'docs/design/remote-terminal.md',
  'docs/design/remote-desktop.md',
  'docs/design/external-integrations.md',
  'docs/ux/frontend-design.md',
]);

const ARCHITECTURE_PATH = 'docs/architecture.md';
const ACTIVE_STATUS = '> 문서 상태: **활성 규범 계약**';
const ARCHITECTURE_STATUS = '> 문서 상태: **공식 아키텍처 진입점**';

const LEGACY_REFERENCE_PATTERNS = [
  { pattern: /architecture §/u, label: 'bare architecture section reference' },
  { pattern: /docs\/research\//u, label: 'removed docs/research path' },
  {
    pattern: /docs\/design\/(?:layout-persistence-design|pty-backpressure-design|shell-core-architecture|scripting-design|ssh-remote-design|mobile-remote-control-design|openclaw-management-design|remote-desktop-design)\.md/u,
    label: 'archived design path',
  },
];

const FORBIDDEN_ACTIVE_STATUS = [
  /\bGATED\b/iu,
  /\bReady for (?:build|[A-Z]-M\d+)\b/iu,
  /\bDecision complete:/iu,
  /\bGate record:/iu,
  /\bBaseline:\s*[0-9a-f]{7,}\b/iu,
  /\bLOCKED \(\d{4}-\d{2}-\d{2}\)/iu,
];

const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.md']);

function toPosix(value) {
  return value.replaceAll('\\', '/');
}

function absolute(root, repoPath) {
  return resolve(root, ...repoPath.split('/'));
}

function read(root, repoPath) {
  return readFileSync(absolute(root, repoPath), 'utf8');
}

function listFiles(root, repoPath, predicate = () => true) {
  const start = absolute(root, repoPath);
  if (!existsSync(start)) return [];

  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visit(target);
      } else if (entry.isFile() && predicate(target)) {
        files.push(toPosix(relative(root, target)));
      }
    }
  };
  visit(start);
  return files.sort();
}

function parseMarkdownLinks(source) {
  const links = [];
  const pattern = /!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^)]*["'])?\)/gu;
  for (const match of source.matchAll(pattern)) {
    links.push(match[1].replace(/^<|>$/gu, ''));
  }
  return links;
}

function headingSlugs(source) {
  const slugs = new Set();
  const counts = new Map();
  for (const match of source.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gmu)) {
    const base = match[1]
      .trim()
      .toLocaleLowerCase('en-US')
      .replace(/[`*_~]/gu, '')
      .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
      .replace(/\s+/gu, '-')
      .replace(/-+/gu, '-');
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${count}`);
  }
  return slugs;
}

function resolveLocalLink(fromPath, rawTarget) {
  if (!rawTarget || /^[a-z][a-z0-9+.-]*:/iu.test(rawTarget)) return null;
  const hashIndex = rawTarget.indexOf('#');
  const rawPath = hashIndex >= 0 ? rawTarget.slice(0, hashIndex) : rawTarget;
  const anchor = hashIndex >= 0 ? rawTarget.slice(hashIndex + 1) : '';
  let decoded = rawPath;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    // The target is reported as missing below; malformed escapes are not repaired.
  }
  const targetPath = decoded
    ? posix.normalize(posix.join(posix.dirname(fromPath), decoded))
    : fromPath;
  return { anchor, targetPath };
}

function section(source, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const start = new RegExp(`^## ${escaped}\\s*$`, 'mu').exec(source);
  if (!start) return null;
  const bodyStart = start.index + start[0].length;
  const rest = source.slice(bodyStart);
  const next = /^##\s+/mu.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

function validateLinks(root, repoPath, source, errors) {
  let checked = 0;
  for (const rawTarget of parseMarkdownLinks(source)) {
    const local = resolveLocalLink(repoPath, rawTarget);
    if (!local) continue;
    checked += 1;
    if (local.targetPath.startsWith('../') || local.targetPath === '..') {
      errors.push(`${repoPath}: link escapes the repository: ${rawTarget}`);
      continue;
    }
    const target = absolute(root, local.targetPath);
    if (!existsSync(target)) {
      errors.push(`${repoPath}: missing local target: ${rawTarget}`);
      continue;
    }
    if (local.anchor && statSync(target).isFile() && extname(target).toLowerCase() === '.md') {
      const slugs = headingSlugs(readFileSync(target, 'utf8'));
      if (!slugs.has(local.anchor.toLocaleLowerCase('en-US'))) {
        errors.push(`${repoPath}: missing heading anchor: ${rawTarget}`);
      }
    }
  }
  return checked;
}

function activeResolvedLinks(repoPath, source) {
  return new Set(
    parseMarkdownLinks(source)
      .map((target) => resolveLocalLink(repoPath, target)?.targetPath)
      .filter(Boolean),
  );
}

function validateEvidence(repoPath, source, errors) {
  for (const heading of ['근거 소스', '검증']) {
    const body = section(source, heading);
    if (body === null) {
      errors.push(`${repoPath}: missing required section "## ${heading}"`);
      continue;
    }
    const localLinks = parseMarkdownLinks(body)
      .map((target) => resolveLocalLink(repoPath, target))
      .filter(Boolean);
    if (localLinks.length === 0) {
      errors.push(`${repoPath}: section "## ${heading}" needs a local evidence link`);
    }
  }
}

function validateLegacyReferences(root, paths, errors) {
  for (const repoPath of paths) {
    const source = read(root, repoPath);
    for (const { pattern, label } of LEGACY_REFERENCE_PATTERNS) {
      if (pattern.test(source)) errors.push(`${repoPath}: ${label}`);
    }
  }
}

export function validateDocumentationContract(root) {
  const errors = [];
  const requiredFiles = [
    'README.md',
    'docs/ROADMAP.md',
    ARCHITECTURE_PATH,
    'docs/archive/README.md',
    'docs/release/README.md',
    ...ACTIVE_CONTRACTS,
  ];
  for (const repoPath of requiredFiles) {
    if (!existsSync(absolute(root, repoPath))) errors.push(`missing required document: ${repoPath}`);
  }
  if (errors.length > 0) throw new Error(`Documentation contract failed:\n- ${errors.join('\n- ')}`);

  const architecture = read(root, ARCHITECTURE_PATH);
  if (!architecture.includes(ARCHITECTURE_STATUS)) {
    errors.push(`${ARCHITECTURE_PATH}: missing official architecture status`);
  }
  validateEvidence(ARCHITECTURE_PATH, architecture, errors);

  const architectureLinks = activeResolvedLinks(ARCHITECTURE_PATH, architecture);
  for (const contract of ACTIVE_CONTRACTS) {
    if (!architectureLinks.has(contract)) {
      errors.push(`${ARCHITECTURE_PATH}: active contract is not indexed: ${contract}`);
    }
  }

  for (const contract of ACTIVE_CONTRACTS) {
    const source = read(root, contract);
    if (!source.includes(ACTIVE_STATUS)) {
      errors.push(`${contract}: missing active normative status`);
    }
    validateEvidence(contract, source, errors);
    for (const pattern of FORBIDDEN_ACTIVE_STATUS) {
      if (pattern.test(source)) {
        errors.push(`${contract}: contains archived plan status: ${pattern}`);
      }
    }
  }

  const actualDesignDocs = listFiles(
    root,
    'docs/design',
    (target) => extname(target).toLowerCase() === '.md',
  );
  const expectedDesignDocs = ACTIVE_CONTRACTS.filter((path) => path.startsWith('docs/design/')).sort();
  for (const repoPath of actualDesignDocs) {
    if (!expectedDesignDocs.includes(repoPath)) errors.push(`orphan active design document: ${repoPath}`);
  }
  for (const repoPath of expectedDesignDocs) {
    if (!actualDesignDocs.includes(repoPath)) errors.push(`missing active design document: ${repoPath}`);
  }

  const readmeLinks = activeResolvedLinks('README.md', read(root, 'README.md'));
  if (!readmeLinks.has(ARCHITECTURE_PATH)) errors.push('README.md: missing architecture entry point');
  const roadmapLinks = activeResolvedLinks('docs/ROADMAP.md', read(root, 'docs/ROADMAP.md'));
  if (!roadmapLinks.has(ARCHITECTURE_PATH)) errors.push('docs/ROADMAP.md: missing architecture entry point');

  const archiveIndex = read(root, 'docs/archive/README.md');
  const archivedDesignDocs = listFiles(
    root,
    'docs/archive/design',
    (target) => extname(target).toLowerCase() === '.md',
  );
  for (const repoPath of archivedDesignDocs) {
    const archiveRelative = repoPath.replace(/^docs\/archive\//u, '');
    if (!archiveIndex.includes(archiveRelative)) {
      errors.push(`docs/archive/README.md: archived design is not indexed: ${archiveRelative}`);
    }
  }

  const linkCheckedDocs = [
    'README.md',
    'docs/ROADMAP.md',
    ARCHITECTURE_PATH,
    'docs/archive/README.md',
    'docs/release/README.md',
    ...ACTIVE_CONTRACTS,
    ...listFiles(root, 'docs/archive', (target) => extname(target).toLowerCase() === '.md'),
  ];
  let checkedLinks = 0;
  for (const repoPath of new Set(linkCheckedDocs)) {
    checkedLinks += validateLinks(root, repoPath, read(root, repoPath), errors);
  }

  const codePaths = [
    ...listFiles(root, 'src', (target) => TEXT_EXTENSIONS.has(extname(target).toLowerCase())),
    ...listFiles(root, 'mobile/src', (target) => TEXT_EXTENSIONS.has(extname(target).toLowerCase())),
    ...listFiles(root, 'e2e', (target) => TEXT_EXTENSIONS.has(extname(target).toLowerCase())),
  ];
  validateLegacyReferences(
    root,
    [...new Set(['README.md', 'docs/ROADMAP.md', 'docs/release/README.md', ARCHITECTURE_PATH, ...ACTIVE_CONTRACTS, ...codePaths])],
    errors,
  );

  if (errors.length > 0) {
    throw new Error(`Documentation contract failed:\n- ${errors.join('\n- ')}`);
  }

  return {
    activeContracts: ACTIVE_CONTRACTS.length,
    archivedDocuments: listFiles(root, 'docs/archive', (target) => extname(target).toLowerCase() === '.md').length,
    checkedLinks,
  };
}
