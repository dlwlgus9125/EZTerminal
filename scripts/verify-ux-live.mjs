/*
 * Real-session visual check for the UX overhaul. Runs real Codex and Claude
 * turns from the built app against the isolated profile copy that
 * capture-ux-overhaul.mjs created, in a scratch git project, and screenshots
 * the conversation at each moment worth seeing (working, approval, question,
 * plan, done) in both chat skins. Costs provider tokens; dev-only.
 *
 *   node scripts/capture-ux-overhaul.mjs <stage> --build   # copies + migrates the profile
 *   node scripts/verify-ux-live.mjs <stage> [--appearance=user|dark] [--allow-skips] [scenario...]
 *
 * Exits non-zero when a requested scenario throws, is skipped (unless
 * --allow-skips), never runs, or a scenario name is unknown. The verdict is
 * the first field of live-report.json.
 *
 * --appearance=user restores the theme and effects of the real profile (read
 * only) into the copy; capture-ux-overhaul's second pass leaves it on Dark.
 *
 * Output: artifacts/ux-overhaul/<stage>-live/*.png and live-report.json
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import playwright from '@playwright/test';
import { liveReportVerdict } from './live-report-verdict.mjs';

const { _electron: electron } = playwright;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN_ENTRY = path.join(ROOT, '.vite', 'build', 'main.js');
const [stage, ...rest] = process.argv.slice(2);
const appearance = rest.find((arg) => arg.startsWith('--appearance='))?.slice('--appearance='.length) ?? 'dark';
const only = rest.filter((arg) => !arg.startsWith('--'));
/** Skipped scenarios (provider not ready, prerequisite missing) fail the run unless this is passed. */
const allowSkips = rest.includes('--allow-skips');
if (!stage || !/^[\w.-]+$/u.test(stage)) throw new Error('Usage: verify-ux-live.mjs <stage> [scenario...]');
const profile = path.join(ROOT, 'artifacts', 'ux-overhaul', `profile-${stage}`);
if (!existsSync(profile)) throw new Error(`Run capture-ux-overhaul.mjs ${stage} first: ${profile} is missing.`);
const output = path.join(ROOT, 'artifacts', 'ux-overhaul', `${stage}-live${appearance === 'user' ? '-user' : ''}`);
const workspace = path.join(ROOT, 'artifacts', 'ux-overhaul', `live-workspace-${stage}`);
/** Outside the scratch workspace, so deleting it needs the user's approval under Standard. */
const outsideFile = path.join(ROOT, 'artifacts', 'ux-overhaul', `outside-ux-live-${stage}.txt`);
const SESSION_PREFIX = 'structured-session-';

const RESULTS_PROMPT = 'src/app.ts에서 greet 함수 이름을 greetUser로 바꾸고 호출부도 고쳐 줘. 그다음 report.html 파일을 만들어 <h1>Greeting report</h1> 제목과 바뀐 내용을 설명하는 짧은 목록을 넣고, <style>로 제목을 파란색으로 꾸며 줘. 마지막으로 notes.md에 한 줄 요약을 적어 줘. 파일 수정과 생성은 파일 편집 도구로 해 줘(읽기는 셸을 써도 돼). 다른 것은 하지 마.';

const ALL_SCENARIOS = [
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
    name: 'codex-approval', provider: 'codex', preset: 'standard',
    prompt: `셸 명령으로 ${'../'}outside-ux-live-STAGE.txt 파일을 삭제해. 도구 호출이 거부되거나 실패하면 즉시 멈추고 한 문장으로 알려 줘. 다른 것은 하지 마.`,
  },
  {
    // "이 대화 동안 편집 자동 승인" on the first edit: the second edit runs without asking.
    name: 'claude-session-edit', provider: 'claude', preset: 'standard', allowSession: true,
    prompt: 'Write 도구로 notes.md와 todo.md 두 파일을 차례로 만들어 줘. 각 파일에는 "ok" 한 줄만 적어. 다른 것은 하지 마.',
    expect: { files: ['notes.md', 'todo.md'], approvals: 1 },
  },
  {
    // A task list (update_plan), not plan mode.
    name: 'codex-todo', provider: 'codex', preset: 'standard',
    prompt: 'update_plan으로 세 단계(README.md 읽기, src/app.ts 읽기, greet 반환값을 한 문장으로 답하기)를 관리하면서 순서대로 진행해. 파일은 수정하지 마.',
  },
  {
    // Plan mode from the composer: Shift+Tab, Full access chosen before the plan, approved from the dock.
    name: 'claude-plan-full', provider: 'claude', preset: 'standard', viaComposer: { plan: true, access: '전체 권한' },
    prompt: 'src/app.ts의 greet 옆에 farewell(name) 함수를 추가하는 계획을 세 줄로 세우고 ExitPlanMode로 제시해. 승인되면 그대로 구현해.',
    expect: { presetAfter: 'full-access', fileContains: ['src/app.ts', 'farewell'] },
  },
  {
    // Codex's own plan mode: it asks through request_user_input, proposes a plan, and the conversation asks to run it.
    name: 'codex-plan-mode', provider: 'codex', preset: 'standard', viaComposer: { plan: true }, proposal: true,
    prompt: 'src/app.ts의 greet 옆에 farewell(name) 함수를 추가하려고 해. 먼저 request_user_input 도구로 작별 문구를 "Goodbye"와 "See you" 중 무엇으로 할지 나에게 물어봐. 답을 받으면 세 줄짜리 계획을 제안해.',
    expect: { presetAfter: 'standard', fileContains: ['src/app.ts', 'farewell'] },
  },
  {
    // The same with Full access chosen before the plan: Codex runs unsandboxed after approval.
    name: 'codex-plan-mode-full', provider: 'codex', preset: 'standard', viaComposer: { plan: true, access: '전체 권한' }, proposal: true,
    prompt: 'src/app.ts의 greet 옆에 farewell(name) 함수를 추가하려고 해. 먼저 request_user_input 도구로 작별 문구를 "Goodbye"와 "See you" 중 무엇으로 할지 나에게 물어봐. 답을 받으면 세 줄짜리 계획을 제안해.',
    expect: { presetAfter: 'full-access', fileContains: ['src/app.ts', 'farewell'] },
  },
  {
    // Two Agent-tool subagents and a background shell command: only the subagents get their own chats.
    name: 'claude-subagents', provider: 'claude', preset: 'standard', inspectSubagents: true,
    prompt: 'Agent 도구로 Explore 서브에이전트 두 개를 동시에 실행해: 하나는 README.md의 제목을 읽어 알려 주고, 다른 하나는 greet 함수가 정의된 위치를 찾아. 그리고 `node -e "setTimeout(() => console.log(1), 3000)"`를 백그라운드 셸 명령(run_in_background)으로 실행해. 두 서브에이전트와 백그라운드 명령이 모두 끝난 뒤 두 문장으로 답해. 파일은 수정하지 마.',
  },
  {
    // The approval a subagent raises is answered in the parent conversation.
    name: 'claude-subagent-approval', provider: 'claude', preset: 'standard', inspectSubagents: true, outside: true,
    prompt: `Agent 도구로 general-purpose 서브에이전트 하나를 실행해서 ${'../'}outside-ux-live-STAGE.txt 파일을 셸 명령으로 삭제하게 하고 결과를 알려 줘. 너는 직접 명령을 실행하지 마.`,
  },
  {
    name: 'codex-subagent-approval', provider: 'codex', preset: 'standard', inspectSubagents: true, outside: true,
    prompt: `서브 에이전트 하나를 만들어서 ${'../'}outside-ux-live-STAGE.txt 파일을 셸 명령으로 삭제하게 하고, 그 결과를 기다렸다가 한 문장으로 알려 줘. 너는 직접 명령을 실행하지 마.`,
  },
  {
    // No provider: a worktree made from the project menu, work written into it, then commit and merge from its row.
    name: 'worktree-merge', run: (page, project, report) => runWorktreeMerge(page, project, report),
  },
  {
    // Settings → 에이전트 협업 profile, then 검토 맡기기 from a real chat: the child reviews and reports back once.
    name: 'delegate-review', run: (page, project, report) => runDelegateReview(page, project, report),
  },
  {
    // The person's 자동 승인 switch in 실행 준비 saves to the subproject (no run is started).
    name: 'auto-approve-ui', run: (page, project, report) => runAutoApproveUi(page, project, report),
  },
  {
    // The parent starts a child, waits on it and quotes its answer: one parent turn, no report turn.
    name: 'agent-wait', run: (page, project, report) => runAgentMcp(page, project, report, 'agent-wait',
      'MCP 도구 create_agent로 서브에이전트를 하나 만들어 줘(providerId: claude, permissionPreset: plan, 지시: "README.md의 첫 줄 제목을 그대로 알려 줘"). 그다음 wait_agent로 끝날 때까지 기다리고, 서브에이전트가 알려 준 제목을 한 문장으로 인용해 줘. 너는 파일을 직접 읽지 마.',
      (snap, id) => parentSettled(snap, id)),
  },
  {
    // The child needs an approval first (needsAttention), then runs 90s: the second wait outlasts Codex's 60s default.
    name: 'agent-wait-long', run: (page, project, report) => runAgentMcp(page, project, report, 'agent-wait-long',
      'MCP 도구 create_agent로 서브에이전트를 하나 만들어 줘(providerId: claude, permissionPreset: standard, 지시: "셸 명령 node -e \\"setTimeout(() => console.log(42), 90000)\\" 를 실행하고 출력된 숫자만 알려 줘"). wait_agent로 기다리고, needsAttention이 true면 사람이 승인할 때까지 기다린 뒤 wait_agent를 timeoutSeconds 200으로 다시 불러. 끝나면 서브에이전트가 알려 준 숫자를 알려 줘.',
      (snap, id) => parentSettled(snap, id)),
  },
  {
    // The same 90-second wait from a Codex parent: Codex gives MCP tools 60 seconds unless told otherwise.
    name: 'agent-wait-long-codex', run: (page, project, report) => runAgentMcp(page, project, report, 'agent-wait-long-codex',
      'MCP 도구 create_agent로 서브에이전트를 하나 만들어 줘(providerId: claude, permissionPreset: standard, 지시: "셸 명령 node -e \\"setTimeout(() => console.log(42), 90000)\\" 를 실행하고 출력된 숫자만 알려 줘"). wait_agent로 기다리고, needsAttention이 true면 사람이 승인할 때까지 기다린 뒤 wait_agent를 timeoutSeconds 200으로 다시 불러. 끝나면 서브에이전트가 알려 준 숫자를 알려 줘.',
      (snap, id) => parentSettled(snap, id), undefined, 'codex'),
  },
  {
    // A plan-only child an agent started: nobody approves its plan, so it must answer with the plan instead of waiting.
    name: 'agent-plan-child', run: (page, project, report) => runAgentMcp(page, project, report, 'agent-plan-child',
      'MCP 도구 create_agent로 서브에이전트를 하나 만들어 줘(providerId: claude, permissionPreset: plan, 지시: "src/app.ts의 greet 옆에 farewell(name) 함수를 추가하는 계획을 세워 줘. 구현하지 마."). wait_agent를 timeoutSeconds 150으로 불러 기다려. needsAttention이 true면 더 기다리지 말고 "서브에이전트가 승인을 기다립니다"라고만 답하고 끝내. 끝나면 서브에이전트의 계획을 세 줄로 요약해 줘.',
      (snap, id) => parentSettled(snap, id), undefined, 'claude',
      { leavePending: (approval, who) => who === 'child' && approval.request?.kind === 'plan' }),
  },
  {
    // The same for a Codex child: plan mode stays read-only, with no plan-mode questions or proposal to answer.
    name: 'codex-plan-unattended', run: (page, project, report) => runAgentMcp(page, project, report, 'codex-plan-unattended',
      'MCP 도구 create_agent로 서브에이전트를 하나 만들어 줘(providerId: codex, permissionPreset: plan, 지시: "src/app.ts의 greet 옆에 farewell(name) 함수를 추가하는 계획을 세 줄로 세워 줘. 구현하지 마."). wait_agent를 timeoutSeconds 200으로 불러 기다려. needsAttention이 true면 더 기다리지 말고 "서브에이전트가 승인을 기다립니다"라고만 답하고 끝내. 끝나면 서브에이전트의 계획을 세 줄로 요약해 줘.',
      (snap, id) => parentSettled(snap, id), undefined, 'claude',
      { leavePending: (_approval, who) => who === 'child' }),
  },
  {
    // reportBack: the parent ends its turn and the result arrives once as its next message.
    name: 'agent-report-back', run: (page, project, report) => runAgentMcp(page, project, report, 'agent-report-back',
      'MCP 도구 create_agent로 서브에이전트를 하나 만들어 줘(providerId: claude, permissionPreset: plan, reportBack: true, 지시: "README.md의 첫 줄 제목을 알려 줘"). 기다리지 말고 "맡겼습니다"라고만 답하고 턴을 끝내. 나중에 결과가 오면 그 제목을 한 문장으로 알려 줘.',
      (snap, id) => parentSettled(snap, id, 2)),
  },
  {
    // The parent creates a worktree and starts a child there that writes a file only in that worktree.
    name: 'agent-worktree', run: (page, project, report) => runAgentMcp(page, project, report, 'agent-worktree',
      'MCP 도구 create_worktree로 브랜치 "ux-live/STAGE-agent" 워크트리를 만들어 줘. 그 결과의 workspaceId로 create_agent를 불러(providerId: claude, permissionPreset: standard) 서브에이전트가 자기 작업 폴더에 notes.md 파일을 만들고 "from child" 한 줄만 쓰게 해. wait_agent로 기다린 뒤 어느 폴더에 썼는지 알려 줘.',
      (snap, id) => parentSettled(snap, id),
      async (snap) => {
        const worktree = snap.workspaces.find((entry) => entry.kind === 'worktree' && !entry.archivedAt && entry.name === `ux-live/${stage}-agent`);
        return { worktree: worktree ? { id: worktree.id, rootPath: worktree.rootPath } : null,
          notesInWorktree: Boolean(worktree && existsSync(path.join(worktree.rootPath, 'notes.md'))),
          notesInMain: existsSync(path.join(workspace, 'notes.md')) };
      }),
  },
  {
    // Run after agent-worktree: merge its worktree, see cleanup refused while a chat there waits, then clean it up.
    name: 'worktree-cleanup', run: (page, project, report) => runWorktreeCleanup(page, project, report),
  },
  {
    // Results tab: real edits (Claude's own hunks), a created page and note. Full access, so no approval click moves focus.
    name: 'claude-results', provider: 'claude', preset: 'full-access', inspectResults: true, focusComposer: true,
    prompt: RESULTS_PROMPT,
  },
  {
    name: 'codex-results', provider: 'codex', preset: 'full-access', inspectResults: true, focusComposer: true,
    prompt: RESULTS_PROMPT,
  },
];
const SCENARIOS = ALL_SCENARIOS.filter((scenario) => only.length === 0 || only.includes(scenario.name));
const unknownScenarios = only.filter((name) => !ALL_SCENARIOS.some((scenario) => scenario.name === name));

function prepareWorkspace() {
  rmSync(workspace, { recursive: true, force: true });
  writeFileSync(outsideFile, 'Delete me only after approval.\n');
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

/** The desktop header keeps the skin in its session menu; a missing switch fails the run. */
async function selectSkin(page, value) {
  const session = page.locator('[data-testid="structured-agent-session"]:visible').first();
  if (await session.getAttribute('data-skin') === value) return;
  await session.getByTestId('structured-agent-menu').click();
  await page.getByTestId(`structured-agent-skin-${value}`).click();
  for (let attempt = 0; await session.getAttribute('data-skin') !== value; attempt += 1) {
    if (attempt >= 25) throw new Error(`The chat skin did not switch to ${value}.`);
    await wait(200);
  }
}

async function shoot(page, name, report) {
  const shots = [];
  for (const value of ['cli', 'bubble']) {
    await selectSkin(page, value);
    await wait(400);
    const file = `${name}-${value}.png`;
    await page.screenshot({ path: path.join(output, file) });
    shots.push(file);
  }
  report.push({ shot: name, files: shots });
}

async function resolvePending(page, approval, panel = page, scenario = {}) {
  const dock = panel.locator('.chat-dock').first();
  const kind = approval.request?.kind;
  if (scenario.allowSession && (kind === 'file-change' || kind === 'command')) {
    await dock.getByTestId('chat-dock-allow-session').click();
    return;
  }
  if (kind === 'question') {
    await dock.locator('.chat-dock__option').first().click();
    await dock.getByRole('button', { name: /답변 보내기|Submit answer|다음|Next/u }).last().click();
  } else if (kind === 'plan') {
    await dock.getByTestId('chat-dock-approve-plan').click();
  } else {
    await dock.getByRole('button', { name: /^(허용|Allow)$/u }).click();
  }
}

/** Plan mode the way a person turns it on: Shift+Tab in the message box, the access pill, then Enter. */
async function sendViaComposer(page, panel, sessionId, scenario, report) {
  const input = panel.getByTestId('structured-agent-composer-input');
  await input.waitFor({ timeout: 30_000 });
  await input.click();
  if (scenario.viaComposer.plan) {
    await page.keyboard.press('Shift+Tab');
    await poll(() => snapshot(page), (snap) => snap.agents.find((entry) => entry.sessionId === sessionId)?.permissionPreset === 'plan', 15_000, 'plan mode on');
    const pressed = await panel.getByTestId('structured-agent-live-plan').getAttribute('aria-pressed');
    if (pressed !== 'true') throw new Error(`${scenario.name}: the plan switch did not turn on (aria-pressed=${pressed}).`);
  }
  if (scenario.viaComposer.access) {
    await panel.getByTestId('structured-agent-live-permission').click();
    await page.getByRole('menuitemradio', { name: new RegExp(scenario.viaComposer.access, 'u') }).click();
  }
  await wait(400);
  await shoot(page, `${scenario.name}-composer`, report);
  await input.click();
  await input.fill(scenario.prompt.replace('STAGE', stage));
  await page.keyboard.press('Enter');
}

async function runScenario(page, project, scenario, report) {
  if (scenario.run) return scenario.run(page, project, report);
  const snap = await snapshot(page);
  const provider = snap.providers.find((entry) => entry.id === scenario.provider);
  if (!provider?.enabled || provider.health !== 'ready') {
    report.push({ scenario: scenario.name, skipped: `${scenario.provider} is not enabled and ready` });
    return;
  }
  const sessionId = `ux-live-${scenario.name}-${Date.now()}`;
  if (scenario.outside) writeFileSync(outsideFile, 'Delete me only after approval.\n');
  const created = await command(page, 'agent.create', {
    sessionId, workspaceId: project.workspaceId, title: `UX live · ${scenario.name}`,
    providerId: scenario.provider, permissionPreset: scenario.preset,
    ...(scenario.viaComposer ? {} : { initialPrompt: scenario.prompt.replace('STAGE', stage) }),
  });
  if (!created?.ok) throw new Error(`${scenario.name}: agent.create failed ${JSON.stringify(created)}`);
  const panelId = `agent-session-${SESSION_PREFIX}${sessionId}`;
  await page.evaluate(({ id, historyId, title, projectId }) => window.__ezAddDockPanel({
    id, component: 'agent-session', title, params: { historyId, projectId },
  }, { kind: 'main-tab' }), { id: panelId, historyId: `${SESSION_PREFIX}${sessionId}`, title: scenario.name, projectId: project.projectId });
  const panel = page.locator(`section[data-session-id="${sessionId}"]`);
  if (scenario.viaComposer) await sendViaComposer(page, panel, sessionId, scenario, report);
  if (scenario.focusComposer) {
    // Where a person would be: in the message box (it takes a queued message while the AI works).
    const input = panel.getByTestId('structured-agent-composer-input');
    await input.waitFor({ timeout: 30_000 }).catch(() => undefined);
    await poll(() => input.isEnabled().catch(() => false), Boolean, 30_000, 'message box enabled').catch(() => undefined);
    await input.click().catch(() => undefined);
  }
  const cpu = scenario.inspectResults ? sampleRendererCpu() : undefined;
  const seen = new Set();
  const handled = new Set();
  const deadline = Date.now() + 300_000;
  let finalState = 'timeout';
  let resultsAtOpen;
  let focusBefore;
  while (Date.now() < deadline) {
    if (scenario.inspectResults && !resultsAtOpen) {
      const focus = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? null);
      // The moment the Results tab appears: where it went, and whether the message box kept focus.
      resultsAtOpen = await page.evaluate((ownerId) => {
        const dock = window.__ezDock;
        const results = dock?.getPanel(`agent-results-${ownerId}`);
        if (!results) return undefined;
        return {
          split: results.group !== dock.getPanel(ownerId)?.group,
          visible: results.api.isVisible,
          composerFocused: document.activeElement?.getAttribute('data-testid') === 'structured-agent-composer-input',
          activePanelIsConversation: dock.activePanel?.id === ownerId,
          focusNow: document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? null,
        };
      }, panelId);
      if (resultsAtOpen) resultsAtOpen = { ...resultsAtOpen, focusBefore, focusKept: focusBefore === resultsAtOpen.focusNow };
      else focusBefore = focus;
    }
    const current = await snapshot(page);
    const agent = current.agents.find((entry) => entry.sessionId === sessionId);
    const pending = current.approvals.find((entry) => entry.sessionId === sessionId && entry.state === 'pending');
    if (pending && !handled.has(pending.id)) {
      await panel.locator('.chat-dock').first().waitFor({ timeout: 15_000 }).catch(() => undefined);
      await wait(800);
      await shoot(page, `${scenario.name}-pending-${pending.request?.kind ?? 'legacy'}`, report);
      await resolvePending(page, pending, panel, scenario);
      if (pending.request?.kind === 'plan') seen.add('plan-approval');
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
      // Codex plan mode: the conversation asks to run the proposed plan; approving starts the next turn.
      // A host with plan-proposal-v1 asked through a plan approval (handled above); older hosts show the dock.
      if (scenario.proposal && !seen.has('proposal') && !seen.has('plan-approval')) {
        const proposal = panel.getByTestId('chat-dock-proposed-plan');
        if (await proposal.waitFor({ timeout: 15_000 }).then(() => true, () => false)) {
          seen.add('proposal');
          await wait(800);
          await shoot(page, `${scenario.name}-proposal`, report);
          await proposal.getByTestId('chat-dock-approve-plan').click();
          await poll(() => snapshot(page), (snap) => snap.turns.filter((turn) => turn.sessionId === sessionId).length > turns.length, 30_000, 'implementation turn');
          continue;
        }
        report.push({ scenario: scenario.name, proposal: 'not shown' });
      }
      finalState = turns.map((turn) => turn.state).join(',');
      if (scenario.preset === 'plan') report.push({ scenario: scenario.name, permissionPresetAfter: agent?.permissionPreset });
      break;
    }
    await wait(700);
  }
  const cpuSamples = cpu ? cpu.stop() : undefined;
  await wait(1500);
  await shoot(page, `${scenario.name}-done`, report);
  if (scenario.inspectResults) await inspectResults(page, scenario, report, cpuSamples, resultsAtOpen, panelId);
  const subagents = scenario.inspectSubagents ? await inspectSubagents(page, scenario, sessionId, report) : undefined;
  const after = scenario.expect ? (await snapshot(page)).agents.find((entry) => entry.sessionId === sessionId) : undefined;
  report.push({ scenario: scenario.name, sessionId, finalState, approvalsResolved: handled.size,
    ...(scenario.name === 'codex-approval' || scenario.outside ? { outsideFileDeleted: !existsSync(outsideFile) } : {}),
    ...(scenario.expect?.presetAfter ? {
      presetAfter: after?.permissionPreset, presetAsExpected: after?.permissionPreset === scenario.expect.presetAfter,
      fileChanged: readFileSync(path.join(workspace, scenario.expect.fileContains[0]), 'utf8').includes(scenario.expect.fileContains[1]),
    } : {}),
    ...(scenario.expect?.files ? {
      filesWritten: scenario.expect.files.filter((file) => existsSync(path.join(workspace, file))),
      approvalsAsExpected: handled.size === scenario.expect.approvals,
    } : {}),
    ...(subagents ? { subagents } : {}) });
  await page.evaluate((id) => window.__ezDock.getPanel(id)?.api.close(), panelId);
}

/** Renderer CPU (percent of one core) every 2s while a turn runs, from Electron's own process metrics. */
function sampleRendererCpu() {
  const samples = [];
  let stopped = false;
  const tick = async () => {
    while (!stopped) {
      const metrics = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics()
        .filter((metric) => metric.type === 'Tab').map((metric) => metric.cpu.percentCPUUsage)).catch(() => []);
      if (metrics.length) samples.push(Math.max(...metrics));
      await wait(2000);
    }
  };
  void tick();
  return { stop: () => { stopped = true; return samples; } };
}

/** The Results tab beside the conversation: did it open on its own, keep the message box focused, show numbered changes. */
async function inspectResults(page, scenario, report, cpuSamples, atOpen, ownerId) {
  // A Results tab next to the conversation (narrow group) is brought forward to look at it.
  await page.evaluate((id) => window.__ezDock?.getPanel(`agent-results-${id}`)?.api.setActive(), ownerId);
  const results = page.locator('[data-testid="conversation-results"]:visible').first();
  const opened = await results.waitFor({ timeout: 20_000 }).then(() => true, () => false);
  const facts = {
    autoOpened: Boolean(atOpen),
    ...(atOpen ? { atOpen } : {}),
    shown: opened,
    ...(cpuSamples?.length ? { rendererCpuMax: Math.round(Math.max(...cpuSamples)), rendererCpuAvg: Math.round(cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length) } : {}),
  };
  if (!opened) { report.push({ scenario: scenario.name, results: facts }); return; }
  const shot = async (name) => { await wait(900); await page.screenshot({ path: path.join(output, `${scenario.name}-${name}.png`) }); report.push({ shot: `${scenario.name}-${name}` }); };
  await results.getByTestId('results-tab-changes').click();
  await shot('results-changes');
  facts.numberedPatches = await results.locator('.results-patch[data-numbered]').count();
  facts.fragmentNotes = await results.getByText(/부분 기록|Partial record/u).count();
  facts.files = await results.locator('.results-file-list .results-file').allInnerTexts();
  await results.getByRole('combobox', { name: /변경 범위|Change scope/u }).selectOption('git').catch(() => undefined);
  await shot('results-git');
  facts.gitFiles = await results.locator('.results-file-list .results-file').count();
  await results.getByTestId('results-tab-files').click();
  const page_ = results.getByRole('button', { name: /^report\.html/u });
  if (await page_.count()) {
    await page_.first().click();
    await wait(1500);
    facts.htmlPreview = await results.getByTestId('results-artifact-frame').getAttribute('src').catch(() => null);
  }
  await shot('results-files');
  await results.getByTestId('results-tab-summary').click();
  await shot('results-summary');
  report.push({ scenario: scenario.name, results: facts });
}

/**
 * A parent chat that uses the orchestration MCP itself: it starts children, waits on them or lets
 * them report back, and may create a worktree. Approvals anywhere in its tree are allowed.
 */
async function runAgentMcp(page, project, report, name, prompt, settledWhen, collect, parentProvider = 'claude', { leavePending = () => false } = {}) {
  const ready = (await snapshot(page)).providers.filter((entry) => entry.enabled && entry.health === 'ready').map((entry) => entry.id);
  for (const provider of new Set(['claude', parentProvider])) {
    if (!ready.includes(provider)) { report.push({ scenario: name, skipped: `${provider} is not enabled and ready` }); return; }
  }
  // Children need the host toggle on when the parent is created; it is put back afterwards.
  const before = (await snapshot(page)).runtime.orchestrationToolsEnabled;
  if (!before) await command(page, 'runtime.set-settings', { orchestrationToolsEnabled: true });
  try {
    const parentId = `ux-live-${name}-${Date.now()}`;
    const created = await command(page, 'agent.create', {
      sessionId: parentId, workspaceId: project.workspaceId, title: `UX live · ${name}`, providerId: parentProvider, permissionPreset: 'standard', initialPrompt: prompt.replace('STAGE', stage),
    });
    if (!created?.ok) throw new Error(`${name}: agent.create failed ${JSON.stringify(created)}`);
    const panelId = `agent-session-${SESSION_PREFIX}${parentId}`;
    await page.evaluate(({ id, historyId, projectId }) => window.__ezAddDockPanel({ id, component: 'agent-session', title: name, params: { historyId, projectId } }, { kind: 'main-tab' }),
      { id: panelId, historyId: `${SESSION_PREFIX}${parentId}`, projectId: project.projectId });
    const tree = (snap) => {
      const ids = new Set([parentId]);
      for (let grew = true; grew;) {
        grew = false;
        for (const relation of snap.agentRelations) if (ids.has(relation.parentSessionId) && !ids.has(relation.childSessionId)) { ids.add(relation.childSessionId); grew = true; }
      }
      return ids;
    };
    const allowed = [];
    const leftPending = new Map();
    const final = await poll(async () => {
      const snap = await snapshot(page);
      const ids = tree(snap);
      for (const approval of snap.approvals.filter((entry) => entry.state === 'pending' && ids.has(entry.sessionId))) {
        const who = approval.sessionId === parentId ? 'parent' : 'child';
        // Nobody answers this one: it shows whether an unattended agent waits on a person.
        if (leavePending(approval, who)) { leftPending.set(approval.id, { session: who, title: approval.title.slice(0, 80), kind: approval.request?.kind }); continue; }
        allowed.push({ session: who, title: approval.title.slice(0, 80) });
        await command(page, 'permission.resolve', { approvalId: approval.id, decision: 'allow' });
      }
      return snap;
    }, (snap) => settledWhen(snap, parentId), 600_000, `${name} settled`);
    await wait(2000);
    await shoot(page, `${name}-parent`, report);
    const children = final.agentRelations.filter((relation) => relation.parentSessionId === parentId);
    const transcriptOf = async (id) => {
      const page_ = await page.evaluate((sessionId) => window.ezterminal.getDaemonTranscript(sessionId, 0, 500), id);
      return Array.isArray(page_?.items) ? page_.items : Array.isArray(page_) ? page_ : [];
    };
    const parentItems = await transcriptOf(parentId);
    const tools = parentItems.filter((item) => item.kind === 'tool-call').map((item) => item.text.slice(0, 80));
    const answer = parentItems.filter((item) => item.kind === 'assistant-message' && !item.isDelta).map((item) => item.text).at(-1) ?? '';
    const facts = { scenario: name, parentId, allowed, leftPending: [...leftPending.values()], tools, answer: answer.slice(0, 400),
      parentTurns: final.turns.filter((turn) => turn.sessionId === parentId).map((turn) => turn.state),
      children: children.map((relation) => {
        const session = final.sessions.find((entry) => entry.id === relation.childSessionId);
        return { owner: relation.owner, title: session?.title, workspaceId: session?.workspaceId, turns: final.turns.filter((turn) => turn.sessionId === relation.childSessionId).map((turn) => turn.state) };
      }),
      reports: parentItems.filter((item) => item.kind === 'user-message' && item.payload?.type === 'subagent').length };
    report.push({ ...facts, ...(collect ? await collect(final, parentId, facts) : {}) });
  } finally {
    if (!before) await command(page, 'runtime.set-settings', { orchestrationToolsEnabled: false }).catch(() => undefined);
  }
}

const parentSettled = (snap, parentId, turns = 1) => {
  const own = snap.turns.filter((turn) => turn.sessionId === parentId);
  return own.length >= turns && own.every((turn) => ['completed', 'failed', 'interrupted'].includes(turn.state));
};

/** A subproject made runnable, opened from the tree; 실행 준비 shows 자동 승인 and the switch saves it. */
async function runAutoApproveUi(page, project, report) {
  const name = 'auto-approve-ui';
  const shot = async (label) => {
    await wait(600);
    await page.screenshot({ path: path.join(output, `${name}-${label}.png`) });
    report.push({ shot: `${name}-${label}`, files: [`${name}-${label}.png`] });
  };
  const exec = (command) => page.evaluate((value) => window.ezterminal.executeWorkflowCommand(value), command);
  const read = await page.evaluate((id) => window.ezterminal.getWorkflowSnapshot(id), project.projectId);
  if (!read?.ok) throw new Error(`workflow read failed ${JSON.stringify(read)}`);
  const providerId = (await snapshot(page)).providers.find((entry) => entry.enabled && entry.health === 'ready')?.id ?? 'codex';
  const subprojectId = `ux-live-sub-${Date.now().toString(36)}`;
  const title = `자동 승인 확인 ${stage}`;
  const created = await exec({ projectId: project.projectId, hostId: read.snapshot.hostId, commandId: `create-${subprojectId}`, expectedRevision: read.snapshot.registryRevision,
    type: 'subproject.create', payload: { id: subprojectId, title, goal: 'README 제목 확인', presetId: 'research' } });
  if (!created?.ok) throw new Error(`subproject.create failed ${JSON.stringify(created)}`);
  const subproject = created.snapshot.subprojects.find((entry) => entry.id === subprojectId);
  const graph = structuredClone(subproject.graph);
  for (const node of graph.nodes) if (node.operation === 'agent') Object.assign(node, { providerId, model: 'default', instructions: 'README.md의 제목을 읽어 알려 줘.', acceptance: ['제목을 그대로 인용한다'] });
  const patched = await exec({ projectId: project.projectId, hostId: read.snapshot.hostId, commandId: `patch-${subprojectId}`, expectedRevision: subproject.revision, subprojectId,
    type: 'workflow.patch', payload: { graph, summary: 'live check' } });
  if (!patched?.ok) throw new Error(`workflow.patch failed ${JSON.stringify(patched)}`);
  await page.getByTestId('rail-agents').click().catch(() => undefined);
  await wait(1500);
  const expand = page.locator('button[aria-label="펼치기: UX live check"]').first();
  if (await expand.count()) { await expand.click(); await wait(800); }
  await page.locator(`[role="treeitem"][aria-label^="${title}"]`).first().click();
  await wait(2500);
  await page.getByRole('button', { name: '실행 준비', exact: true }).last().click();
  const toggle = page.getByTestId('workflow-auto-approve');
  await toggle.waitFor({ state: 'attached', timeout: 15_000 });
  await shot('prepare-off');
  // A controlled switch: it turns on once the subproject saved.
  await toggle.click({ force: true });
  const saved = await poll(() => page.evaluate((id) => window.ezterminal.getWorkflowSnapshot(id), project.projectId),
    (value) => value?.ok && value.snapshot.subprojects.find((entry) => entry.id === subprojectId)?.autoApprove === true, 15_000, 'autoApprove saved');
  await shot('prepare-on');
  report.push({ scenario: name, subprojectId, autoApprove: saved.snapshot.subprojects.find((entry) => entry.id === subprojectId)?.autoApprove });
  await page.keyboard.press('Escape');
}

/** A profile made in Settings, a parent chat that edits, 검토 맡기기, the report back, and the start panel picker. */
async function runDelegateReview(page, project, report) {
  const name = 'delegate-review';
  const shot = async (label) => {
    await wait(600);
    await page.screenshot({ path: path.join(output, `${name}-${label}.png`) });
    report.push({ shot: `${name}-${label}`, files: [`${name}-${label}.png`] });
  };
  const ready = (await snapshot(page)).providers.filter((entry) => entry.enabled && entry.health === 'ready').map((entry) => entry.id);
  // Claude when it is ready: Codex sometimes stalls on reads (out of scope here).
  const providerId = ready.includes('claude') ? 'claude' : ready.includes('codex') ? 'codex' : undefined;
  if (!providerId) { report.push({ scenario: name, skipped: 'no provider is enabled and ready' }); return; }
  const orchestrationBefore = (await snapshot(page)).runtime.orchestrationToolsEnabled;
  // A rerun on the same profile starts from no saved profiles.
  await page.evaluate(async () => { for (const profile of await window.ezterminal.chatAgentProfiles.list()) await window.ezterminal.chatAgentProfiles.remove(profile.id); });

  // A parent chat that changes one line, opened in a tab.
  const parentId = `ux-live-${name}-${Date.now()}`;
  const created = await command(page, 'agent.create', {
    sessionId: parentId, workspaceId: project.workspaceId, title: 'UX live · greet 수정', providerId, permissionPreset: 'standard',
    initialPrompt: 'src/app.ts의 greet가 돌려주는 문자열 끝의 느낌표를 두 개로 바꿔 줘. 다른 것은 하지 말고 한 문장으로 끝났다고만 알려 줘.',
  });
  if (!created?.ok) throw new Error(`${name}: agent.create failed ${JSON.stringify(created)}`);
  const panelId = `agent-session-${SESSION_PREFIX}${parentId}`;
  await page.evaluate(({ id, historyId, projectId }) => window.__ezAddDockPanel({
    id, component: 'agent-session', title: 'greet 수정', params: { historyId, projectId },
  }, { kind: 'main-tab' }), { id: panelId, historyId: `${SESSION_PREFIX}${parentId}`, projectId: project.projectId });
  const turnsOf = async (sessionId) => (await snapshot(page)).turns.filter((turn) => turn.sessionId === sessionId);
  const settled = (turns) => turns.length > 0 && turns.every((turn) => ['completed', 'failed', 'interrupted'].includes(turn.state));
  const allowed = [];
  // Waits for a condition, allowing whatever these chats ask for on the way.
  const until = async (sessionIds, test, timeoutMs, label) => poll(async () => {
    const snap = await snapshot(page);
    for (const approval of snap.approvals.filter((entry) => entry.state === 'pending' && sessionIds.includes(entry.sessionId))) {
      allowed.push({ sessionId: approval.sessionId, title: approval.title });
      await command(page, 'permission.resolve', { approvalId: approval.id, decision: 'allow' });
    }
    return snap;
  }, (snap) => test(snap), timeoutMs, label);
  const turnsIn = (snap, sessionId) => snap.turns.filter((turn) => turn.sessionId === sessionId);
  // Settings → 에이전트 → 에이전트 협업: add the reviewer profile by hand.
  await page.getByTestId('btn-toggle-settings').click();
  await page.getByTestId('settings-category-agents').click();
  const section = page.getByTestId('agent-collaboration-settings');
  await section.scrollIntoViewIfNeeded();
  await shot('settings');
  await section.getByRole('button', { name: '프로필 추가' }).click();
  const fields = section.getByRole('textbox');
  await fields.nth(0).fill('꼼꼼한 검토자');
  const selects = section.locator('select');
  await selects.nth(0).selectOption(providerId);
  await selects.nth(2).selectOption('low');
  await selects.nth(3).selectOption('standard');
  await fields.nth(1).fill('바뀐 코드를 고치지 않고 검토만 할 때');
  await section.getByRole('button', { name: '저장', exact: true }).click();
  await poll(() => page.evaluate(() => window.ezterminal.chatAgentProfiles.list()), (list) => list.length > 0, 10_000, 'saved profile');
  await shot('settings-profile');
  await page.getByTestId('btn-toggle-settings').click();

  await until([parentId], (snap) => settled(turnsIn(snap, parentId)), 300_000, 'parent edit').catch(async (error) => {
    const snap = await snapshot(page);
    throw new Error(`${error.message}: ${JSON.stringify(turnsIn(snap, parentId).map((turn) => [turn.state, turn.errorCode]))}`);
  });
  await wait(2500);

  // 검토 맡기기 from the conversation menu.
  const session = page.locator('[data-testid="structured-agent-session"]:visible').first();
  await session.getByTestId('structured-agent-menu').click();
  await page.getByTestId('structured-agent-delegate-review').click();
  await page.getByTestId('delegate-agent-dialog').waitFor();
  await shot('dialog');
  await page.getByTestId('delegate-agent-submit').click();
  await page.getByTestId('delegate-agent-dialog').waitFor({ state: 'hidden', timeout: 30_000 });
  const relation = await poll(() => snapshot(page), (snap) => snap.agentRelations.some((entry) => entry.parentSessionId === parentId), 30_000, 'child relation');
  const childId = relation.agentRelations.find((entry) => entry.parentSessionId === parentId).childSessionId;
  await wait(2000);
  await shot('child-started');
  await until([parentId, childId], (snap) => settled(turnsIn(snap, childId)), 300_000, 'child review');
  // The report arrives as the parent's next turn; wait for the parent to answer it.
  await until([parentId, childId], (snap) => turnsIn(snap, parentId).length >= 2 && settled(turnsIn(snap, parentId)), 300_000, 'parent answer to the report');
  await wait(2000);
  await shoot(page, `${name}-reported`, report);
  const parentItems = await page.evaluate((id) => window.ezterminal.getDaemonTranscript?.(id), parentId);
  const list = Array.isArray(parentItems?.items) ? parentItems.items : Array.isArray(parentItems) ? parentItems : [];
  const reportItem = list.find((item) => item.kind === 'user-message' && item.payload?.type === 'subagent');
  const finalSnap = await snapshot(page);
  const child = finalSnap.sessions.find((entry) => entry.id === childId);
  const childAgent = finalSnap.agents.find((entry) => entry.sessionId === childId);

  // The child opens from the parent's 서브에이전트 track.
  const track = session.locator('[data-testid="structured-agent-child"]').first();
  if (await track.count()) { await track.click(); await wait(2500); await shoot(page, `${name}-child`, report); }

  // New chat: the profile picker fills AI and permission.
  await page.getByTestId('rail-agents').click().catch(() => undefined);
  await wait(800);
  // A project row shows new chat once the pointer reaches its actions.
  await page.getByRole('button', { name: 'UX live check 관리', exact: true }).first().hover();
  await page.getByRole('button', { name: '새 채팅: UX live check' }).first().click();
  await wait(2000);
  const picker = page.locator('[data-testid="conversation-start-profile"]:visible').first();
  await picker.selectOption({ label: '꼼꼼한 검토자' });
  await wait(800);
  const pickedProvider = await page.locator('[aria-label="대화 AI"]:visible').first().inputValue();
  await shot('start-profile');

  report.push({ scenario: name, providerId, orchestrationBefore, allowed, parentId, childId,
    child: { title: child?.title, provider: childAgent?.providerId, effort: childAgent?.reasoningEffort, permission: childAgent?.permissionPreset,
      owner: finalSnap.agentRelations.find((entry) => entry.childSessionId === childId)?.owner },
    parentTurns: (await turnsOf(parentId)).map((turn) => turn.state), childTurns: (await turnsOf(childId)).map((turn) => turn.state),
    reportMessage: reportItem ? { text: reportItem.text.slice(0, 300), payload: reportItem.payload } : null,
    startPanel: { pickedProvider } });
}

/** Project menu → 새 워크트리 → work lands in it → 검토 대기 → commit → merge → 완료, all from the sidebar. */
async function runWorktreeMerge(page, project, report) {
  const name = 'worktree-merge';
  const branch = `ux-live/${stage}-${Date.now().toString(36)}`;
  const shot = async (label) => {
    await wait(600);
    await page.screenshot({ path: path.join(output, `${name}-${label}.png`) });
    report.push({ shot: `${name}-${label}`, files: [`${name}-${label}.png`] });
  };
  await page.getByTestId('rail-agents').click().catch(() => undefined);
  await wait(1200);
  await page.getByRole('button', { name: 'UX live check 관리', exact: true }).first().click();
  await page.getByRole('menuitem', { name: '새 워크트리…' }).click();
  await page.getByTestId('new-worktree-branch').fill(branch);
  await shot('create');
  await page.getByTestId('new-worktree-create').click();
  const created = await poll(() => snapshot(page), (snap) => snap.workspaces.some((entry) => entry.projectId === project.projectId && entry.kind === 'worktree' && entry.name === branch), 60_000, 'worktree workspace');
  const worktree = created.workspaces.find((entry) => entry.projectId === project.projectId && entry.kind === 'worktree' && entry.name === branch);
  await page.getByTestId('new-worktree-dialog').waitFor({ state: 'hidden', timeout: 15_000 });
  await wait(1500);
  const select = page.locator('[aria-label="대화 작업 위치"]:visible').first();
  const startPanel = { draftWorkspace: await select.inputValue().catch(() => undefined),
    offersNewWorktree: await select.locator('option', { hasText: '새 워크트리…' }).count() };
  await shot('draft');
  // What an agent would have done in the worktree.
  writeFileSync(path.join(worktree.rootPath, 'notes.md'), `Worked on ${branch}.\n`);
  await page.getByTestId('rail-agents').click().catch(() => undefined);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await wait(2500);
  const expand = page.locator('button[aria-label="펼치기: UX live check"]').first();
  if (await expand.count()) { await expand.click(); await wait(800); }
  const row = page.locator('[role="treeitem"]', { hasText: branch }).first();
  const reviewLabel = await row.getAttribute('aria-label');
  await shot('review');
  await row.hover();
  await page.locator('[data-testid="workspace-merge"]').first().click();
  await page.getByTestId('worktree-merge-dialog').waitFor();
  await wait(1200);
  await shot('dialog-dirty');
  await page.getByTestId('worktree-commit-message').fill('Add notes from the worktree');
  await page.getByTestId('worktree-commit').click();
  await poll(() => page.getByTestId('worktree-merge-ahead').textContent(), (text) => text === '1', 15_000, 'commit ahead');
  await shot('dialog-ready');
  await page.getByTestId('worktree-merge-confirm').click();
  await page.locator('.worktree-merge__done').waitFor({ timeout: 30_000 });
  await shot('merged');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await wait(2500);
  const doneLabel = await page.locator('[role="treeitem"]', { hasText: branch }).first().getAttribute('aria-label');
  await shot('done');
  const log = execFileSync('git', ['log', '--oneline', '-3'], { cwd: workspace, encoding: 'utf8' }).trim().split('\n');
  report.push({ scenario: name, branch, startPanel, reviewLabel, doneLabel, mainLog: log, notesMerged: existsSync(path.join(workspace, 'notes.md')) });
}

/**
 * The worktree agent-worktree left (an idle Claude child whose process holds the folder, and its
 * uncommitted notes.md): commit and merge it from the sidebar, see cleanup refused while a chat
 * there waits on an approval, then clean it up and check what went.
 */
async function runWorktreeCleanup(page, project, report) {
  const name = 'worktree-cleanup';
  const branch = `ux-live/${stage}-agent`;
  const shot = async (label) => {
    await wait(600);
    await page.screenshot({ path: path.join(output, `${name}-${label}.png`) });
    report.push({ shot: `${name}-${label}`, files: [`${name}-${label}.png`] });
  };
  const before = await snapshot(page);
  const worktree = before.workspaces.find((entry) => entry.kind === 'worktree' && !entry.archivedAt && entry.name === branch);
  if (!worktree) { report.push({ scenario: name, skipped: `run agent-worktree first: no ${branch} worktree` }); return; }
  const chatsIn = (snap) => snap.sessions.filter((session) => session.workspaceId === worktree.id && session.kind === 'agent');
  // A chat there that waits on an approval keeps the worktree busy.
  const blockerId = `ux-live-cleanup-blocker-${Date.now()}`;
  const created = await command(page, 'agent.create', {
    sessionId: blockerId, workspaceId: worktree.id, title: 'UX live · cleanup blocker', providerId: 'claude', permissionPreset: 'standard',
    initialPrompt: '셸 명령 node -e "console.log(1)" 을 실행해 줘.',
  });
  if (!created?.ok) throw new Error(`${name}: agent.create failed ${JSON.stringify(created)}`);
  const pending = await poll(() => snapshot(page), (snap) => snap.approvals.some((entry) => entry.sessionId === blockerId && entry.state === 'pending'), 180_000, 'blocker approval');
  const approval = pending.approvals.find((entry) => entry.sessionId === blockerId && entry.state === 'pending');

  await page.getByTestId('rail-agents').click().catch(() => undefined);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await wait(2500);
  const expand = page.locator('button[aria-label="펼치기: UX live check"]').first();
  if (await expand.count()) { await expand.click(); await wait(800); }
  const row = page.locator('[role="treeitem"]', { hasText: branch }).first();
  await row.hover();
  const merge = row.locator('[data-testid="workspace-merge"]');
  await ((await merge.count()) ? merge.first() : page.locator('[data-testid="workspace-merge"]').first()).click();
  await page.getByTestId('worktree-merge-dialog').waitFor();
  await wait(1200);
  if (await page.getByTestId('worktree-commit-message').count()) {
    await page.getByTestId('worktree-commit-message').fill('Add notes from the child agent');
    await page.getByTestId('worktree-commit').click();
    await poll(() => page.getByTestId('worktree-merge-ahead').textContent(), (text) => text === '1', 15_000, 'commit ahead');
  }
  // A worktree merged in an earlier run goes straight to cleanup.
  if (await page.getByTestId('worktree-merge-confirm').count()) await page.getByTestId('worktree-merge-confirm').click();
  await page.getByTestId('worktree-cleanup').waitFor({ timeout: 30_000 });
  await shot('merged');
  await page.getByTestId('worktree-cleanup').click();
  await wait(800);
  const busy = {
    confirmDisabled: await page.getByTestId('worktree-cleanup-confirm').isDisabled(),
    consequences: (await page.getByTestId('worktree-cleanup-consequences').textContent())?.trim(),
    focused: await page.evaluate(() => document.activeElement?.textContent),
  };
  await shot('busy');
  await command(page, 'permission.resolve', { approvalId: approval.id, decision: 'deny' });
  await poll(() => snapshot(page), (snap) => {
    const agent = snap.agents.find((entry) => entry.sessionId === blockerId);
    return agent && !agent.currentTurnId && agent.queuedTurnCount === 0
      && !snap.turns.some((turn) => turn.sessionId === blockerId && !['completed', 'failed', 'interrupted'].includes(turn.state));
  }, 120_000, 'blocker settled');
  await poll(() => page.getByTestId('worktree-cleanup-confirm').isDisabled(), (disabled) => disabled === false, 15_000, 'cleanup enabled');
  const ready = { consequences: (await page.getByTestId('worktree-cleanup-consequences').textContent())?.trim() };
  await shot('confirm');
  const chatIds = chatsIn(await snapshot(page)).map((session) => session.id);
  const started = Date.now();
  await page.getByTestId('worktree-cleanup-confirm').click();
  await page.getByTestId('worktree-merge-dialog').waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => undefined);
  const tookMs = Date.now() - started;
  const leftOpen = await page.getByTestId('worktree-merge-dialog').count();
  const dialogText = leftOpen ? (await page.getByTestId('worktree-merge-dialog').textContent())?.trim() : undefined;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await wait(2500);
  await shot('after');
  const after = await snapshot(page);
  const branches = execFileSync('git', ['branch', '--list', '--format=%(refname:short)'], { cwd: workspace, encoding: 'utf8' }).trim().split(/\r?\n/u);
  report.push({ scenario: name, branch, busy, ready, tookMs, dialogText,
    folderGone: !existsSync(worktree.rootPath), branchGone: !branches.includes(branch),
    workspaceArchived: Boolean(after.workspaces.find((entry) => entry.id === worktree.id)?.archivedAt),
    chats: chatIds.map((id) => ({ id, state: after.agents.find((entry) => entry.sessionId === id)?.state })),
    rowGone: (await page.locator('[role="treeitem"]', { hasText: branch }).count()) === 0,
    notesMerged: existsSync(path.join(workspace, 'notes.md')) });
}

/** The subagents of a finished scenario: what the daemon stored, and how they look when opened. */
async function inspectSubagents(page, scenario, sessionId, report) {
  const snap = await snapshot(page);
  const children = snap.agentRelations.filter((relation) => relation.parentSessionId === sessionId);
  const facts = [];
  for (const relation of children) {
    const child = snap.sessions.find((entry) => entry.id === relation.childSessionId);
    const items = await page.evaluate((id) => window.ezterminal.getDaemonTranscript?.(id), relation.childSessionId).catch(() => undefined);
    facts.push({ owner: relation.owner, title: child?.title, state: child?.state,
      kinds: Array.isArray(items?.items) ? items.items.map((item) => item.kind) : Array.isArray(items) ? items.map((item) => item.kind) : 'unread' });
  }
  const open = page.locator('[data-testid="structured-agent-session"]:visible button[aria-label^="열기: "], [data-testid="structured-agent-session"]:visible button[aria-label^="Open: "]').first();
  if (await open.count()) {
    await open.click();
    await wait(2500);
    await shoot(page, `${scenario.name}-subagent`, report);
    const back = page.locator('[data-testid="structured-agent-session"]:visible [data-testid="structured-agent-parent"]').first();
    if (await back.count()) { await back.click(); await wait(1500); }
  } else {
    report.push({ scenario: scenario.name, note: 'no subagent link was rendered' });
  }
  await page.getByTestId('rail-agents').click().catch(() => undefined);
  await wait(1200);
  const expand = page.locator(`[aria-label^="펼치기: UX live · ${scenario.name}"], [aria-label^="Expand: UX live · ${scenario.name}"]`).first();
  if (await expand.count()) { await expand.click(); await wait(800); }
  await page.screenshot({ path: path.join(output, `${scenario.name}-tree.png`) });
  report.push({ shot: `${scenario.name}-tree`, files: [`${scenario.name}-tree.png`] });
  await page.getByTestId('rail-agents').click().catch(() => undefined);
  return facts;
}

function applyAppearance() {
  if (appearance !== 'user') return;
  const source = path.join(process.env.EZTERMINAL_CAPTURE_SOURCE_PROFILE ?? path.join(process.env.APPDATA ?? '', 'EZTerminal'), 'settings.json');
  const target = path.join(profile, 'settings.json');
  const real = JSON.parse(readFileSync(source, 'utf8'));
  const copy = JSON.parse(readFileSync(target, 'utf8'));
  for (const key of Object.keys(real)) if (/^(theme|effect|fx|ui[A-Z]|font)/u.test(key)) copy[key] = real[key];
  writeFileSync(target, JSON.stringify(copy, null, 2));
}

mkdirSync(output, { recursive: true });
prepareWorkspace();
applyAppearance();
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
let verdict = { ok: false, failures: ['the run stopped before any verdict'] };
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
      report.push({ scenario: scenario.name, completed: true });
    } catch (error) {
      report.push({ scenario: scenario.name, error: String(error?.message ?? error) });
      await page.screenshot({ path: path.join(output, `${scenario.name}-error.png`) }).catch(() => undefined);
    }
  }
} finally {
  verdict = liveReportVerdict(report, { requested: SCENARIOS.map((scenario) => scenario.name), unknown: unknownScenarios, allowSkips });
  writeFileSync(path.join(output, 'live-report.json'), JSON.stringify({ verdict, report }, null, 2));
  await app.close();
}
process.stdout.write(`${JSON.stringify({ stage, output, verdict, report }, null, 1)}\n`);
if (!verdict.ok) {
  process.stderr.write(`verify-ux-live failed:\n${verdict.failures.map((failure) => `  - ${failure}`).join('\n')}\n`);
  process.exitCode = 1;
}
