import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const outputFlag = process.argv.indexOf('--output');
const output = resolve(
  root,
  outputFlag >= 0 ? process.argv[outputFlag + 1] : 'artifacts/sbom.cdx.json',
);

function run(command, args) {
  const executable = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : command;
  const executableArgs =
    process.platform === 'win32' ? ['/d', '/s', '/c', command, ...args] : args;
  return execFileSync(executable, executableArgs, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

async function packageLicense(path) {
  if (!path) return undefined;
  try {
    const manifest = JSON.parse(await readFile(resolve(path, 'package.json'), 'utf8'));
    return typeof manifest.license === 'string' ? manifest.license : undefined;
  } catch {
    return undefined;
  }
}

function npmLicenseChoice(value) {
  if (!value) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (/\b(?:AND|OR|WITH)\b|[()]/.test(normalized)) {
    return { expression: normalized };
  }
  if (/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(normalized) && normalized !== 'UNLICENSED') {
    return { license: { id: normalized } };
  }
  return { license: { name: normalized } };
}

function npmPurl(name, version) {
  if (name.startsWith('@') && name.includes('/')) {
    const [scope, packageName] = name.split('/', 2);
    return `pkg:npm/${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

const npmProjects = JSON.parse(run('pnpm', ['list', '-r', '--prod', '--json', '--depth', 'Infinity']));
const npmPackages = new Map();

function collectNpmDependencies(bucket) {
  for (const [name, dependency] of Object.entries(bucket ?? {})) {
    if (!dependency?.version) continue;
    npmPackages.set(`npm:${name}@${dependency.version}`, {
      name,
      version: dependency.version,
      path: dependency.path,
    });
    collectNpmDependencies(dependency.dependencies);
    collectNpmDependencies(dependency.optionalDependencies);
  }
}

for (const project of npmProjects) {
  collectNpmDependencies(project.dependencies);
  collectNpmDependencies(project.optionalDependencies);
}

const cargoMetadata = JSON.parse(
  execFileSync('cargo', [
    'metadata',
    '--locked',
    '--format-version', '1',
    '--filter-platform', 'x86_64-pc-windows-msvc',
    '--manifest-path', 'native/remote-host/Cargo.toml',
  ], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }),
);

const cargoNodes = new Map(
  (cargoMetadata.resolve?.nodes ?? []).map((node) => [node.id, node]),
);
const cargoProductionIds = new Set();
const cargoQueue = [...cargoMetadata.workspace_members];
while (cargoQueue.length > 0) {
  const id = cargoQueue.pop();
  if (!id || cargoProductionIds.has(id)) continue;
  cargoProductionIds.add(id);
  const node = cargoNodes.get(id);
  for (const dependency of node?.deps ?? []) {
    if (!dependency.dep_kinds.some((kind) => kind.kind !== 'dev')) continue;
    cargoQueue.push(dependency.pkg);
  }
}

const components = [];
for (const [ref, dependency] of [...npmPackages].sort(([left], [right]) => left.localeCompare(right))) {
  const license = await packageLicense(dependency.path);
  const licenseChoice = npmLicenseChoice(license);
  components.push({
    type: 'library',
    'bom-ref': ref,
    group: dependency.name.startsWith('@') ? dependency.name.split('/')[0] : undefined,
    name: dependency.name,
    version: dependency.version,
    purl: npmPurl(dependency.name, dependency.version),
    licenses: licenseChoice ? [licenseChoice] : undefined,
    properties: [{ name: 'ezterminal:ecosystem', value: 'npm' }],
  });
}

for (const pkg of cargoMetadata.packages.filter(
  (candidate) => (
    cargoProductionIds.has(candidate.id)
    && !cargoMetadata.workspace_members.includes(candidate.id)
  ),
).sort((left, right) => {
  return `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`);
})) {
  const ref = `cargo:${pkg.name}@${pkg.version}`;
  components.push({
    type: 'library',
    'bom-ref': ref,
    name: pkg.name,
    version: pkg.version,
    purl: `pkg:cargo/${pkg.name}@${pkg.version}`,
    licenses: pkg.license ? [{ expression: pkg.license }] : undefined,
    externalReferences: pkg.repository
      ? [{ type: 'vcs', url: pkg.repository }]
      : undefined,
    properties: [{ name: 'ezterminal:ecosystem', value: 'cargo' }],
  });
}

const contract = JSON.parse(await readFile(resolve(root, 'release/version.json'), 'utf8'));
const document = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    component: {
      type: 'application',
      'bom-ref': `application:ezterminal@${contract.version}`,
      name: 'EZTerminal',
      version: contract.version,
    },
    tools: [{ vendor: 'EZTerminal', name: 'scripts/generate-sbom.mjs' }],
  },
  components,
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
process.stdout.write(`Wrote ${components.length} components to ${output}\n`);
