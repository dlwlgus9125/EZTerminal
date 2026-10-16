// Reference assets only; never writes product code or the approved r6 package.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as icons from 'lucide-react';

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(root, '../../../..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const names = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'Bell', 'Check', 'CheckCheck', 'ChevronDown', 'ChevronRight', 'CircleHelp', 'Code2', 'Copy', 'Download', 'Ellipsis', 'ExternalLink', 'FileCode2', 'FileText', 'Folder', 'FolderOpen', 'GitBranch', 'Globe', 'History', 'Info', 'Layers', 'Link', 'ListFilter', 'LoaderCircle', 'Menu', 'MessageSquare', 'Monitor', 'Moon', 'Package', 'Paperclip', 'Pencil', 'Play', 'Plug', 'Plus', 'RefreshCw', 'Search', 'Send', 'Settings2', 'ShieldCheck', 'Smartphone', 'Sparkles', 'Square', 'Terminal', 'Trash2', 'TriangleAlert', 'Unplug', 'Upload', 'Wrench', 'X'];
const sprite = Object.fromEntries(names.map(name => [name, renderToStaticMarkup(createElement(icons[name], { width: 18, height: 18, strokeWidth: 1.7, 'aria-hidden': 'true', focusable: 'false' }))]));
await fs.writeFile(path.join(root, 'icons.js'), `// Generated from the installed lucide-react package (ISC). See SUPPORT.md.\nwindow.REVIEW_ICONS = ${JSON.stringify(sprite)};\n`);
await fs.copyFile(path.join(repo,'node_modules/lucide-react/LICENSE'),path.join(root,'THIRD-PARTY-NOTICES.txt'));
const tokenPath = 'src/renderer/styles/ui-tokens.css';
const tokenBytes = await fs.readFile(path.join(repo, tokenPath));
await fs.writeFile(path.join(root, 'tokens.css'), `/* Generated reference copy; authority: ${tokenPath}; SHA-256: ${hash(tokenBytes)}. */\n${tokenBytes}`);
const sourcePaths = ['DESIGN.md', 'docs/ux/frontend-design.md', tokenPath, 'src/renderer/themes.ts', 'src/renderer/StructuredAgentSession.stories.tsx', 'src/renderer/StructuredAgentSession.tsx', 'src/renderer/StructuredProviderSettings.tsx', 'src/main/agent-provider-adapter.ts', 'src/main/claude-provider-adapter.ts', 'src/main/codex-provider-adapter.ts', 'docs/ux/reference/v2/APPROVAL.md', 'docs/ux/reference/v2/approvals/2026-10-13-r6-final.json'];
const sources = Object.fromEntries(await Promise.all(sourcePaths.map(async file => [file, hash(await fs.readFile(path.join(repo, file)))])));
const files = (await fs.readdir(root)).filter(file => /\.(html|css|js|md|mjs|txt)$/.test(file)).sort();
try {
  const report=JSON.parse(await fs.readFile(path.join(root,'qa-report.json'),'utf8'));
  files.push('qa-report.json',...new Set(report.captures.map(file=>`screens/${file}`)));
} catch (error) { if(error.code!=='ENOENT')throw error; }
const fingerprints = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await fs.readFile(path.join(root, file)))])));
await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({ version: 1, id: 'ezterminal-v2-agent-chat-r1', status: 'review-pending', productImplemented: false, approved: false, generatedAt: new Date().toISOString(), entry: 'index.html', designContext: { required: true, visualIdentity: 'DESIGN.md', ux: 'docs/ux/frontend-design.md', supplement: 'UI-CONTRACT.md', implementationPaths: ['src/renderer', 'mobile/src'], profileMigration: 'Not requested; preserve existing repository ownership.' }, sources, files: fingerprints }, null, 2) + '\n');
console.log(`Reference assets ready: ${names.length} icons; ${sourcePaths.length} source fingerprints; approval pending.`);
