/*
 * Real-session visual check for the UX overhaul. Runs real Codex and Claude
 * turns from the built app against the isolated profile copy that
 * capture-ux-overhaul.mjs created, in a scratch git project, and screenshots
 * the conversation at each moment worth seeing (working, approval, question,
 * plan, done) in both chat skins. Costs provider tokens; dev-only.
 *
 *   node scripts/capture-ux-overhaul.mjs <stage> --build   # copies + migrates the profile
 *   node scripts/verify-ux-live.mjs <stage> [scenario...]
 *
 * Output: artifacts/ux-overhaul/<stage>-live/*.png and live-report.json
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import playwright from '@playwright/test';

const { _electron: electron } = playwright;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN_ENTRY = path.join(ROOT, '.vite', 'build', 'main.js');
const [stage, ...only] = process.argv.slice(2);
if (!stage || !/^[\w.-]+$/u.test(stage)) throw new Error('Usage: verify-ux-live.mjs <stage> [scenario...]');
const profile = path.join(ROOT, 'artifacts', 'ux-overhaul', `profile-${stage}`);
if (!existsSync(profile)) throw new Error(`Run capture-ux-overhaul.mjs ${stage} first: ${profile} is missing.`);
const output = path.join(ROOT, 'artifacts', 'ux-overhaul', `${stage}-live`);
const workspace = path.join(ROOT, 'artifacts', 'ux-overhaul', `live-workspace-${stage}`);
const SESSION_PREFIX = 'structured-session-';

const SCENARIOS = [
  {
    name: 'claude-read', provider: 'claude', preset: 'standard',
    prompt: 'README.md와 src/app.ts를 읽고 greet 함수가 무엇을 하는지 두 문장으로 설명한 뒤, 짧은 TypeScript 예시 코드 블록을 하나 보여 줘. 파일은 수정하지 마.',
  },
  {
    name: 'claude-command', provider: 'claude', preset: 'standard',
    prompt: '셸 명령으로 `node --version`을 실행하고 결과를 한 문장으로 알려 줘. 다른 명령은 실행하지 마.',
  },
  {
    name: 'claude-question', provider: 'claude', preset: 'standard',
    prompt: 'AskUserQuestion 도구로 src/app.ts의 인사말을 격식체로 할지 반말로 할지 나에게 물어봐(선택지 두 개). 답을 받으면 한 문장으로 확인만 하고 파일은 수정하지 마.',
  },
  {
    name: 'claude-plan', provider: 'claude', preset: 'plan',
    prompt: 'src/app.ts의 greet 옆에 farewell(name) 함수를 추가하는 계획을 세 줄로 세우고 ExitPlanMode로 제시해. 승인되면 그대로 구현해.',
  },
  {
    name: 'codex-commands', provider: 'codex', preset: 'standard',
    prompt: '`node --version`과 `node -e "process.exit(3)"`를 각각 별도의 셸 명령으로 실행하고 두 결과를 한 문장으로 알려 줘. 다른 것은 실행하지 마.',
  },
  {
    name: 'codex-edit', provider: 'codex', preset: 'standard',
    prompt: 'src/app.ts에서 greet 함수 이름을 greetUser로 바꾸고 호출부도 고친 다음, notes.md 파일을 만들어 "greet를 greetUser로 바꿈" 한 줄만 적어 줘. 다른 것은 하지 마.',
  },
  {
    name: 'codex-plan', provider: 'codex', preset: 'standard',
    prompt: 'update_plan으로 세 단계(README.md 읽기, src/app.ts 읽기, greet 반환값을 한 문장으로 답하기)를 관리하면서 순서대로 진행해. 파일은 수정하지 마.',
  },
].filter((scenario) => only.length === 0 || only.includes(scenario.name));

function prepareWorkspace() {
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(path.join(workspace, 'src'), { recursive: true });
  writeFileSync(path.join(workspace, 'README.md'), '# demo-app\n\nA tiny TypeScript app used to check the agent chat.\n');
  writeFileSync(path.join(workspace, 'src', 'app.ts'), 'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n\nexport function main(): void {\n  console.log(greet(\'world\'));\n}\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=ux-live', '-c', 'user.email=ux-live@example.invalid', 'commit', '-qm', 'init']]) {
    execFileSync('git', args, { cwd: workspace });
  }
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

async function snapshot(page) {
  return page.evaluate(() => window.ezterminal.getDaemonSnapshot());
}

async function poll(read, test, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (test(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await wait(500);
  }
}

async function command(page, type, payload) {
  const snap = await snapshot(page);
  const commandId = `ux-live-${type}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  return page.evaluate((envelope) => window.ezterminal.sendDaemonCommand(envelope), {
    protocolVersion: snap.protocolVersion, commandId, idempotencyKey: commandId, expectedRevision: snap.revision,
    issuedAt: new Date().toISOString(), principal: { kind: 'desktop', id: 'renderer-agent-ui' }, type, payload,
  });
}

async function shoot(page, name, report) {
  const skin = page.locator('[data-testid="structured-agent-skin"]').first();
  const shots = [];
  for (const value of ['cli', 'bubble']) {
    if (await skin.count()) {
      await skin.selectOption(value).catch(() => undefined);
      await wait(400);
    }
    const file = `${name}-${value}.png`;
    await page.screenshot({ path: path.join(output, file) });
    shots.push(file);
  }
  report.push({ shot: name, files: shots });
}

async function resolvePending(page, approval) {
  const dock = page.locator('.chat-dock').first();
  const kind = approval.request?.kind;
  if (kind === 'question') {
    await dock.locator('.chat-dock__option').first().click();
    await dock.getByRole('button', { name: /답변 보내기|Submit answer|다음|Next/u }).last().click();
  } else if (kind === 'plan') {
    await dock.getByRole('button', { name: /승인하고 시작|Approve and start/u }).click();
  } else {
    await dock.getByRole('button', { name: /^(허용|Allow)$/u }).click();
  }
}

async function runScenario(page, project, scenario, report) {
  const snap = await snapshot(page);
  const provider = snap.providers.find((entry) => entry.id === scenario.provider);
  if (!provider?.enabled || provider.health !== 'ready') {
    report.push({ scenario: scenario.name, skipped: `${scenario.provider} is not enabled and ready` });
    return;
  }
  const sessionId = `ux-live-${scenario.name}-${Date.now()}`;
  const created = await command(page, 'agent.create', {
    sessionId, workspaceId: project.workspaceId, title: `UX live · ${scenario.name}`,
    providerId: scenario.provider, permissionPreset: scenario.preset, initialPrompt: scenario.prompt,
  });
  if (!created?.ok) throw new Error(`${scenario.name}: agent.create failed ${JSON.stringify(created)}`);
  const panelId = `agent-session-${SESSION_PREFIX}${sessionId}`;
  await page.evaluate(({ id, historyId, title, projectId }) => window.__ezAddDockPanel({
    id, component: 'agent-session', title, params: { historyId, projectId },
  }, { kind: 'main-tab' }), { id: panelId, historyId: `${SESSION_PREFIX}${sessionId}`, title: scenario.name, projectId: project.projectId });
  const seen = new Set();
  const handled = new Set();
  const deadline = Date.now() + 300_000;
  let finalState = 'timeout';
  while (Date.now() < deadline) {
    const current = await snapshot(page);
    const agent = current.agents.find((entry) => entry.sessionId === sessionId);
    const pending = current.approvals.find((entry) => entry.sessionId === sessionId && entry.state === 'pending');
    if (pending && !handled.has(pending.id)) {
      await page.locator('.chat-dock').first().waitFor({ timeout: 15_000 }).catch(() => undefined);
      await wait(800);
      await shoot(page, `${scenario.name}-pending-${pending.request?.kind ?? 'legacy'}`, report);
      await resolvePending(page, pending);
      handled.add(pending.id);
      await wait(1500);
      continue;
    }
    if (agent?.state === 'working' && !seen.has('working')
      && await page.locator('.chat-row[data-kind="assistant"], .chat-row[data-kind="activity"]').count()) {
      seen.add('working');
      await shoot(page, `${scenario.name}-working`, report);
    }
    const turns = current.turns.filter((turn) => turn.sessionId === sessionId);
    if (turns.length > 0 && turns.every((turn) => ['completed', 'failed', 'interrupted'].includes(turn.state)) && !pending) {
      finalState = turns.map((turn) => turn.state).join(',');
      if (scenario.preset === 'plan') report.push({ scenario: scenario.name, permissionPresetAfter: agent?.permissionPreset });
      break;
    }
    await wait(700);
  }
  await wait(1500);
  await shoot(page, `${scenario.name}-done`, report);
  report.push({ scenario: scenario.name, sessionId, finalState });
  await page.evaluate((id) => window.__ezDock.getPanel(id)?.api.close(), panelId);
}

mkdirSync(output, { recursive: true });
prepareWorkspace();
const app = await electron.launch({
  args: [MAIN_ENTRY, '--lang=ko-KR'],
  env: {
    ...process.env,
    EZTERMINAL_USER_DATA_DIR: profile,
    EZTERMINAL_ALLOW_MULTIPLE_INSTANCES: '1',
    EZTERMINAL_DISABLE_UPDATE_CHECK: '1',
    EZTERMINAL_DISABLE_OPENCLAW_SUPERVISOR: '1',
    EZTERMINAL_REMOTE_PORT: '47999',
  },
});
const report = [];
try {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 1600, height: 1000 }));
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await poll(() => page.evaluate(() => window.ezterminal.getDaemonAvailability()), (value) => value?.state === 'ready', 60_000, 'daemon');
  const saved = await page.evaluate((root) => window.ezterminal.saveAgentProject({ name: 'UX live check', primaryRoot: root, additionalRoots: [], pinned: false }), workspace);
  // A rerun on the same profile finds the scratch project already registered.
  if (!saved?.ok && saved?.reason !== 'duplicate') throw new Error(`saveAgentProject failed: ${JSON.stringify(saved)}`);
  const ready = await poll(() => snapshot(page), (snap) => snap.workspaces.some((entry) => samePath(entry.rootPath, workspace)), 60_000, 'scratch workspace');
  const scratch = ready.workspaces.find((entry) => samePath(entry.rootPath, workspace));
  const project = { projectId: scratch.projectId, workspaceId: scratch.id };
  for (const scenario of SCENARIOS) {
    try {
      await runScenario(page, project, scenario, report);
    } catch (error) {
      report.push({ scenario: scenario.name, error: String(error?.message ?? error) });
      await page.screenshot({ path: path.join(output, `${scenario.name}-error.png`) }).catch(() => undefined);
    }
  }
} finally {
  writeFileSync(path.join(output, 'live-report.json'), JSON.stringify(report, null, 2));
  await app.close();
}
process.stdout.write(`${JSON.stringify({ stage, output, report }, null, 1)}\n`);
