#!/usr/bin/env node
/**
 * SecureAtomicFile has two Windows ACL modes (see its header). The per-file mode
 * re-verifies a file's own DACL on every read and write; the protected-directory
 * mode verifies one inheritable directory DACL and then trusts inheritance. That
 * trade is made for draft stores only — drafts are DPAPI ciphertext and are saved
 * while the user types, and a cold PowerShell run costs seconds per save. This
 * guard keeps the directory mode from spreading to other secrets and keeps its
 * directory check strict. It reads source; it does not run anything.
 *
 * Run: node scripts/guard-secure-storage.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

const DRAFT_DIRECTORIES = ['chat-state', 'workflow-drafts'];

// ── 1. only main.ts (for the draft stores) and the module itself use the directory mode ──
const mainSources = readdirSync(path.join(root, 'src/main'))
  .filter((name) => /\.ts$/u.test(name) && !/\.test\.ts$/u.test(name));
for (const name of mainSources) {
  if (name === 'secure-atomic-file.ts' || name === 'main.ts') continue;
  if (/\bprotectedDirectoryAcl\b/u.test(read(`src/main/${name}`))) {
    failures.push(
      `src/main/${name} uses protectedDirectoryAcl. The directory ACL mode is for draft stores only; `
        + 'tokens, keys and other secrets keep per-file ACL verification.',
    );
  }
}

const main = read('src/main/main.ts');
const directories = [...main.matchAll(/draftDirectory\('([^']+)'\)/gu)].map((match) => match[1]).sort();
if (JSON.stringify(directories) !== JSON.stringify([...DRAFT_DIRECTORIES].sort())) {
  failures.push(
    `src/main/main.ts protects ${JSON.stringify(directories)} with the directory ACL mode; expected exactly `
      + `${JSON.stringify(DRAFT_DIRECTORIES)}. Add a store here only if its content is DPAPI ciphertext saved on input.`,
  );
}
if ((main.match(/\bprotectedDirectoryAcl\(/gu) ?? []).length !== 1) {
  failures.push('src/main/main.ts must create directory ACLs only through draftDirectory().');
}

// ── 2. the directory check stays protected, inheritable and link-free ───────
const secure = read('src/main/secure-atomic-file.ts');
const directoryScript = secure.match(/const WINDOWS_DIRECTORY_ACL_SCRIPT = String\.raw`([\s\S]*?)`\.trim\(\);/u)?.[1] ?? '';
for (const [needle, reason] of [
  ['SetAccessRuleProtection($true, $false)', 'drop the parent\'s inherited ACEs'],
  ['ReparsePoint', 'reject a junction or link planted in place of the directory'],
  ["'ContainerInherit, ObjectInherit'", 'make files created inside inherit the DACL'],
  ['AreAccessRulesProtected', 'verify the protection after setting it'],
  ['Unexpected ACL principal', 'reject any principal other than the user and SYSTEM'],
]) {
  if (!directoryScript.includes(needle)) {
    failures.push(`The secure directory ACL script no longer contains ${needle}; it must ${reason}.`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.map((line) => `- ${line}`).join('\n')}\n`);
  process.exit(1);
}

process.stdout.write('Secure storage guard: directory ACL mode limited to draft stores, directory check strict.\n');
