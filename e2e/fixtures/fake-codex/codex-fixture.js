// Direct-Codex keyboard/clipboard E2E fixture. Its filename and shim basename
// deliberately exercise the same direct-command classification as `codex.cmd`
// without requiring the real CLI or authentication in CI. `--xterm` emits the
// same high-confidence bracketed-paste/focus burst used by interactive agents.
// The version and app-server branches also let structured-Agent E2E cross the
// production provider discovery/review/JSON-RPC seam without using the host's
// installed Codex version or account.
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const versionFile = process.env.TMPDIR
  ? path.join(process.env.TMPDIR, 'ezterminal-e2e-codex-version.txt')
  : undefined;
let fixtureVersion = '0.153.4';
if (versionFile) {
  try {
    fixtureVersion = fs.readFileSync(versionFile, 'utf8').trim() || fixtureVersion;
  } catch {
    // Most fixture consumers do not need mutable version state.
  }
}
// Optional streamed reply for the chat profiler: {chars, chunks, chunkDelayMs, startDelayMs}.
// The provider environment is an allowlist, so the setting is a file beside the version file.
const replyFile = process.env.TMPDIR
  ? path.join(process.env.TMPDIR, 'ezterminal-e2e-codex-reply.json')
  : undefined;
function readReplyConfig() {
  if (!replyFile) return null;
  try {
    return JSON.parse(fs.readFileSync(replyFile, 'utf8'));
  } catch {
    return null;
  }
}
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

if (args.includes('--version')) {
  process.stdout.write(`codex-cli ${fixtureVersion}\n`, () => process.exit(0));
} else if (args[0] === 'app-server') {
  let input = '';
  let nextThread = 0;
  let nextTurn = 0;
  const threadConfigs = new Map();
  const threadCwds = new Map();
  const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const respond = (frame, result) => write({ jsonrpc: '2.0', id: frame.id, result });

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
    for (;;) {
      const newline = input.indexOf('\n');
      if (newline < 0) break;
      const line = input.slice(0, newline).trim();
      input = input.slice(newline + 1);
      if (!line) continue;
      const frame = JSON.parse(line);
      if (frame.id === undefined) continue;
      switch (frame.method) {
        case 'initialize':
          respond(frame, {
            userAgent: `codex-cli/${fixtureVersion}`,
            codexHome: 'C:\\fixture\\.codex',
            platformFamily: 'windows',
            platformOs: 'windows',
          });
          break;
        case 'model/list':
          respond(frame, {
            data: [{
              id: 'gpt-5.6-fixture',
              model: 'gpt-5.6-fixture',
              displayName: 'GPT 5.6 Fixture',
              isDefault: true,
            }],
            nextCursor: null,
          });
          break;
        case 'skills/list':
          respond(frame, { data: [{ cwd: frame.params?.cwds?.[0], errors: [], skills: [
            { name: 'fixture-review', path: 'C:\\fixture\\skills\\review\\SKILL.md', description: 'Review fixture changes', enabled: true, scope: 'user' },
          ] }] });
          break;
        case 'plugin/installed':
          respond(frame, { marketplaces: [], marketplaceLoadErrors: [] });
          break;
        case 'mcpServerStatus/list':
          respond(frame, { data: [], nextCursor: null });
          break;
        case 'config/read':
          respond(frame, { config: { mcp_servers: {} }, origins: {} });
          break;
        case 'thread/start': {
          const threadId = `fixture-thread-${++nextThread}`;
          threadConfigs.set(threadId, frame.params?.config);
          if (typeof frame.params?.cwd === 'string') threadCwds.set(threadId, frame.params.cwd);
          respond(frame, { thread: { id: threadId }, model: 'gpt-5.6-fixture' });
          break;
        }
        case 'turn/start': {
          const threadId = frame.params?.threadId;
          const turnSequence = ++nextTurn;
          const turnId = `fixture-turn-${turnSequence}`;
          if (process.env.TMPDIR) fs.writeFileSync(path.join(process.env.TMPDIR, 'ezterminal-e2e-codex-last-input.json'), JSON.stringify(frame.params?.input));
          respond(frame, { turn: { id: turnId, status: 'inProgress', items: [] } });
          setTimeout(async () => {
            write({
              jsonrpc: '2.0',
              method: 'turn/started',
              params: { threadId, turn: { id: turnId, status: 'inProgress', items: [] } },
            });
            // Deterministic provider behavior, crossing the real authenticated app-tool
            // endpoint. The product still owns preview validation and persistence.
            let responseText = 'Structured Codex fixture ready.';
            if (JSON.stringify(frame.params?.input).includes('EZTERMINAL_E2E_PREVIEW')) {
              try {
                const descriptor = threadConfigs.get(threadId)?.mcp_servers?.ezterminal_orchestration;
                if (!descriptor) throw new Error('Missing app-tool descriptor');
                const call = async (name, args) => {
                  const response = await fetch(descriptor.url, { method: 'POST', headers: { ...descriptor.http_headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: `${name}-${turnSequence}`, method: 'tools/call', params: { name, arguments: args } }) });
                  const data = await response.json();
                  if (data.error || data.result?.isError) throw new Error(JSON.stringify(data.error ?? data.result));
                  return JSON.parse(data.result.content[0].text);
                };
                const state = await call('workflow_read', {});
                if (!state.preview) throw new Error('Creation preview unavailable');
                const graph = state.preview.graph;
                graph.nodes[0].title = 'AI preview stage';
                const result = await call('preview_workflow', { commandId: `preview-${threadId}-${turnSequence}`, previewId: state.preview.id, expectedRevision: state.preview.revision, graph });
                if (!result.ok) throw new Error(result.message);
                responseText = 'AI preview updated through the authenticated app tool.';
              } catch (reason) { responseText = `Preview fixture failed: ${String(reason)}`; }
            }
            // Results tab: the AI creates a note and edits a file in the working folder, as Codex reports it.
            if (JSON.stringify(frame.params?.input).includes('EZTERMINAL_E2E_RESULTS')) {
              const cwd = threadCwds.get(threadId);
              if (cwd) {
                const notePath = path.join(cwd, 'results-note.md');
                const appPath = path.join(cwd, 'results-app.ts');
                fs.writeFileSync(notePath, '# Results note\n\nCreated by the fixture.\n');
                const before = 'export const answer = 41;\n';
                const after = 'export const answer = 42;\n';
                if (!fs.existsSync(appPath)) fs.writeFileSync(appPath, before);
                fs.writeFileSync(appPath, after);
                const changes = [
                  { path: notePath, kind: { type: 'add' }, diff: '# Results note\n\nCreated by the fixture.\n' },
                  { path: appPath, kind: { type: 'update', move_path: null }, diff: '@@ -1,1 +1,1 @@\n-export const answer = 41;\n+export const answer = 42;\n' },
                ];
                const itemId = `fixture-file-change-${turnSequence}`;
                write({ jsonrpc: '2.0', method: 'item/started', params: { threadId, turnId, startedAtMs: Date.now(), item: { type: 'fileChange', id: itemId, changes, status: 'inProgress' } } });
                write({ jsonrpc: '2.0', method: 'item/completed', params: { threadId, turnId, completedAtMs: Date.now(), item: { type: 'fileChange', id: itemId, changes, status: 'completed' } } });
                responseText = 'Updated `results-app.ts` and wrote `results-note.md`.';
              }
            }
            // Results tab isolation: an HTML report (inline script, its own stylesheet, a network
            // request and an outbound link) and a PDF, written only in the working folder.
            if (JSON.stringify(frame.params?.input).includes('EZTERMINAL_E2E_ARTIFACTS')) {
              const cwd = threadCwds.get(threadId);
              if (cwd) {
                const html = [
                  '<!doctype html><html><head><title>Report</title><link rel="stylesheet" href="report.css"></head><body>',
                  '<h1 id="title">Fixture report</h1><p id="script">script did not run</p><p id="bridge">bridge unknown</p><p id="network">network pending</p><p id="sibling">sibling pending</p>',
                  '<a id="out" href="https://example.com/">Outbound link</a>',
                  '<script>',
                  "document.getElementById('script').textContent = 'script ran';",
                  "try { document.getElementById('bridge').textContent = typeof parent.ezterminal === 'undefined' ? 'no bridge' : 'BRIDGE VISIBLE'; } catch (error) { document.getElementById('bridge').textContent = 'no bridge'; }",
                  "fetch('https://example.com/').then(function () { document.getElementById('network').textContent = 'NETWORK ALLOWED'; }, function () { document.getElementById('network').textContent = 'network blocked'; });",
                  "fetch('report.css').then(function (response) { return response.text(); }).then(function () { document.getElementById('sibling').textContent = 'SIBLING READ'; }, function () { document.getElementById('sibling').textContent = 'sibling read blocked'; });",
                  '</script></body></html>',
                ].join('\n');
                // A complete PDF (cross-reference table with real byte offsets) so the viewer draws a page.
                const objects = [
                  '<</Type/Catalog/Pages 2 0 R>>',
                  '<</Type/Pages/Kids[3 0 R]/Count 1>>',
                  '<</Type/Page/Parent 2 0 R/MediaBox[0 0 360 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
                  '<</Length 46>>\nstream\nBT /F1 24 Tf 40 64 Td (Fixture PDF page) Tj ET\nendstream',
                  '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
                ];
                let pdf = '%PDF-1.4\n';
                const offsets = objects.map((body, index) => {
                  const offset = Buffer.byteLength(pdf);
                  pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
                  return offset;
                });
                const xref = Buffer.byteLength(pdf);
                pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
                pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
                const files = [
                  ['report.html', html],
                  ['report.css', '#title { color: rgb(200, 0, 0); }\n'],
                  ['paper.pdf', pdf],
                ];
                const changes = files.map(([name, content]) => {
                  fs.writeFileSync(path.join(cwd, name), content);
                  return { path: path.join(cwd, name), kind: { type: 'add' }, diff: content };
                });
                const itemId = `fixture-artifacts-${turnSequence}`;
                write({ jsonrpc: '2.0', method: 'item/started', params: { threadId, turnId, startedAtMs: Date.now(), item: { type: 'fileChange', id: itemId, changes, status: 'inProgress' } } });
                write({ jsonrpc: '2.0', method: 'item/completed', params: { threadId, turnId, completedAtMs: Date.now(), item: { type: 'fileChange', id: itemId, changes, status: 'completed' } } });
                responseText = 'Wrote `report.html` with `report.css`, and `paper.pdf`.';
              }
            }
            // Chat profiler: stream a fixed-length reply in timed deltas, ending with a sentinel.
            const reply = readReplyConfig();
            if (reply) {
              const itemId = `fixture-message-${turnSequence}`;
              const body = `${'Streamed profile reply. '.repeat(Math.ceil(reply.chars / 24)).slice(0, reply.chars)} [[end]]`;
              const size = Math.ceil(body.length / Math.max(1, reply.chunks));
              await sleep(reply.startDelayMs ?? 0);
              for (let offset = 0; offset < body.length; offset += size) {
                write({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId, turnId, itemId, delta: body.slice(offset, offset + size) } });
                await sleep(reply.chunkDelayMs ?? 0);
              }
              responseText = body;
            }
            write({
              jsonrpc: '2.0',
              method: 'item/completed',
              params: {
                threadId,
                turnId,
                completedAtMs: Date.now(),
                item: {
                  id: `fixture-message-${turnSequence}`,
                  type: 'agentMessage',
                  text: responseText,
                  phase: null,
                },
              },
            });
            // Usage arrives before the turn ends, as from the real app-server; this account has only a weekly window.
            const tokens = { totalTokens: 19120, inputTokens: 18697, cachedInputTokens: 12416, cacheWriteInputTokens: 0, outputTokens: 423, reasoningOutputTokens: 206 };
            write({
              jsonrpc: '2.0',
              method: 'thread/tokenUsage/updated',
              params: { threadId, turnId, tokenUsage: { total: tokens, last: tokens, modelContextWindow: 258400 } },
            });
            write({
              jsonrpc: '2.0',
              method: 'account/rateLimits/updated',
              params: { rateLimits: {
                limitId: 'codex',
                primary: { usedPercent: 26, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + (53 * 60 * 60) },
                secondary: null,
              } },
            });
            write({
              jsonrpc: '2.0',
              method: 'turn/completed',
              params: {
                threadId,
                turn: { id: turnId, status: 'completed', error: null, items: [] },
              },
            });
          }, 10);
          break;
        }
        case 'account/rateLimits/read':
          // This account has only a weekly window, like the one the captures came from.
          respond(frame, { rateLimits: {
            limitId: 'codex',
            primary: { usedPercent: 26, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + (53 * 60 * 60) },
            secondary: null,
          } });
          break;
        case 'thread/unsubscribe':
          // Records which threads the app released (an e2e checks /clear releases the old one).
          if (process.env.TMPDIR) {
            const marker = path.join(process.env.TMPDIR, 'ezterminal-e2e-codex-unsubscribed.json');
            let released = [];
            try { released = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { released = []; }
            fs.writeFileSync(marker, JSON.stringify([...released, frame.params?.threadId]));
          }
          respond(frame, { status: 'notLoaded' });
          break;
        case 'turn/interrupt':
        case 'thread/settings/update':
          respond(frame, {});
          break;
        default:
          write({
            jsonrpc: '2.0',
            id: frame.id,
            error: { code: -32601, message: `Unsupported fixture method: ${frame.method}` },
          });
      }
    }
  });
  process.stdin.resume();
} else {
  const scrollbackScenario = process.env.EZTERMINAL_E2E_CODEX_SCROLLBACK === '1';
  const projectMapScenario = process.env.EZTERMINAL_E2E_PROJECT_MAP_AGENT === '1';
  if (scrollbackScenario) {
    // Codex normally owns the alternate screen. That buffer has no scrollback,
    // so overflowing it reproduces the missing-middle transcript symptom. The
    // product-owned launch must opt into Codex's inline mode to keep all markers.
    if (!args.includes('--no-alt-screen')) process.stdout.write('\x1b[?1049h');
    process.stdout.write('\x1b[?2004h');
    setTimeout(() => {
      const markers = Array.from(
        { length: 80 },
        (_, index) => `CODEX-SEQ-${String(index + 1).padStart(3, '0')}`,
      );
      process.stdout.write(`${markers.join('\r\n')}\r\n`);
    }, 100);
  } else {
    if (args.includes('--xterm') || projectMapScenario) {
      process.stdout.write('\x1b[?2004h\x1b[?1004h');
    }
    process.stdout.write('FAKE-CODEX-READY COPY-ME\r\n');
    if (args.includes('--model')) process.stdout.write(`CLI-MODEL:${args[args.indexOf('--model') + 1]}\r\n`);
  }

  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();

  let line = '';
  let received = '';
  let interrupted = false;
  process.stdin.on('data', (data) => {
    received += data;
    if (data.includes('\x03')) process.stdout.write('CTRL-C-RECEIVED\r\n');
    if (data.includes('\x04')) process.stdout.write('CTRL-D-RECEIVED\r\n');
    if (data.includes('\x06')) process.stdout.write('CTRL-F-RECEIVED\r\n');
    if (data.includes('\x10')) process.stdout.write('CTRL-P-RECEIVED\r\n');
    if (data.includes('\x16')) process.stdout.write('CTRL-V-RECEIVED\r\n');
    if (data.includes('\x1b')) {
      interrupted = true;
      process.stdout.write('ESC-RECEIVED\r\n');
    }
    if (received.includes('first\nsecond')) {
      process.stdout.write('MULTILINE-PASTE-RECEIVED\r\n');
      received = '';
    }

    const printable = data.replace(/[\x00-\x1f\x7f]/gu, '');
    if (printable) process.stdout.write(`TEXT:${JSON.stringify(printable)}\r\n`);

    for (const character of data) {
      if (character === '\x15') {
        line = '';
        continue;
      }
      if (character === '\r' || character === '\n') {
        // A mounted xterm can answer terminal capability/focus queries between
        // Escape and the submitted line. Those replies are not user text, so
        // accept the recovery instruction at the end of the accumulated input.
        if (line.trim().endsWith('continue') && interrupted) {
          process.stdout.write('RECOVERY-SEQUENCE\r\n');
          interrupted = false;
        }
        if (line.trim() === '/exit' || line.trim() === '/quit') {
          process.stdout.write('EXPLICIT-EXIT\r\n');
          process.exit(0);
        }
        line = '';
      } else if (character >= ' ') {
        line += character;
      }
    }
  });
}
