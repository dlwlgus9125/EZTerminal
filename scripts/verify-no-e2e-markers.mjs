import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? 'mobile/dist');
const forbidden = ['[ez-e2e]'];
const requiredBuildSha = (process.argv[3] ?? process.env.VITE_BUILD_SHA ?? process.env.GITHUB_SHA ?? '').trim();
const textExtensions = new Set(['.css', '.html', '.js', '.json', '.map', '.txt']);

if (!existsSync(root) || !statSync(root).isDirectory()) {
  console.error(`Production output directory does not exist: ${root}`);
  process.exit(1);
}

const violations = [];
let buildShaFound = false;
let developmentBuildShaFound = false;

function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(absolute);
      continue;
    }
    if (!entry.isFile() || !textExtensions.has(path.extname(entry.name).toLowerCase())) continue;

    const content = readFileSync(absolute, 'utf8');
    if (requiredBuildSha && content.includes(requiredBuildSha)) buildShaFound = true;
    if (/buildSha\s*:\s*["']dev["']/.test(content)) developmentBuildShaFound = true;
    for (const marker of forbidden) {
      if (content.includes(marker)) {
        violations.push(`${path.relative(root, absolute)}: ${marker}`);
      }
    }
  }
}

visit(root);

if (violations.length > 0) {
  console.error('Production output contains E2E-only diagnostics:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

if (requiredBuildSha === 'dev') {
  console.error('A production/release build SHA cannot be "dev".');
  process.exit(1);
}
if (requiredBuildSha && developmentBuildShaFound) {
  console.error('Production output still contains buildSha="dev" despite an exact release SHA requirement.');
  process.exit(1);
}
if (requiredBuildSha && !buildShaFound) {
  console.error(`Production output does not contain required build SHA: ${requiredBuildSha}`);
  process.exit(1);
}

console.log(
  `Verified production output contains no E2E markers${
    requiredBuildSha ? ` and embeds build SHA ${requiredBuildSha}` : ''
  } (${root}).`,
);
