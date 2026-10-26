import { resizeWindow } from './workbench-navigation';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { test, expect, createRegisteredE2eTempDir, type Page } from './test';

import { launchApp } from './launch-app';
import { manageProject, openAllProjects } from './project-navigation';
import { encodeClaudeProjectDirName } from '../src/main/claude-history-adapter';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const PROMPT = 'audit the android emulator handoff';

function envelope(cwd: string, index: number): Record<string, unknown> {
  return {
    parentUuid: index === 0 ? null : `uuid-${String(index - 1)}`,
    isSidechain: false,
    uuid: `uuid-${String(index)}`,
    timestamp: new Date(Date.UTC(2026, 6, 27, 0, 0, index)).toISOString(),
    userType: 'external',
    entrypoint: 'cli',
    cwd,
    sessionId: SESSION_ID,
    version: '2.1.220',
    gitBranch: 'main',
  };
}

/**
 * Seeds a Claude Code store shaped like the real one: the project directory is
 * the lossy encoding of the cwd, the transcript opens with the slash-command
 * preamble a real session has, and the typed prompt is registered in the shared
 * prompt log rather than being findable near the head.
 */
function seedClaudeStore(
  home: string,
  projectRoot: string,
  extraTurns = 0,
  appendLaterFileChange = false,
): void {
  const projectDirectory = path.join(
    home,
    '.claude',
    'projects',
    encodeClaudeProjectDirName(projectRoot),
  );
  mkdirSync(projectDirectory, { recursive: true });
  const records: Record<string, unknown>[] = [
    { type: 'mode', mode: 'normal', sessionId: SESSION_ID },
    { type: 'file-history-snapshot', messageId: 'snapshot-1', snapshot: {}, isSnapshotUpdate: false },
    {
      ...envelope(projectRoot, 0),
      type: 'user',
      isMeta: true,
      message: { role: 'user', content: '<local-command-caveat>Caveat: …</local-command-caveat>' },
    },
    {
      ...envelope(projectRoot, 1),
      type: 'user',
      message: { role: 'user', content: '<command-name>/clear</command-name>' },
    },
    {
      ...envelope(projectRoot, 2),
      type: 'user',
      promptId: 'prompt-1',
      message: { role: 'user', content: PROMPT },
      origin: { kind: 'human' },
      promptSource: 'typed',
    },
    {
      ...envelope(projectRoot, 3),
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'reading the handoff package now' }],
      },
    },
    {
      ...envelope(projectRoot, 4),
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_1',
          name: 'Bash',
          input: { command: 'pnpm test:unit', description: 'Run tests' },
        }],
      },
    },
    {
      ...envelope(projectRoot, 5),
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_edit_1',
          name: 'Edit',
          input: {
            file_path: 'src/app.ts',
            old_string: 'export const answer = 1;',
            new_string: 'export const answer = 2;',
          },
        }],
        stop_reason: 'tool_use',
      },
    },
    {
      ...envelope(projectRoot, 6),
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_edit_1', content: 'updated' }],
      },
    },
    {
      ...envelope(projectRoot, 7),
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'edit complete' }],
        stop_reason: 'end_turn',
      },
    },
  ];
  if (appendLaterFileChange) {
    records.push(
      {
        ...envelope(projectRoot, 8),
        type: 'user',
        message: { role: 'user', content: 'make a later unrelated change' },
        origin: { kind: 'human' },
        promptSource: 'typed',
      },
      {
        ...envelope(projectRoot, 9),
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'toolu_edit_2',
            name: 'Edit',
            input: {
              file_path: 'src/other.ts',
              old_string: 'export const later = 1;',
              new_string: 'export const later = 2;',
            },
          }],
          stop_reason: 'tool_use',
        },
      },
      {
        ...envelope(projectRoot, 10),
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_edit_2', content: 'updated' }],
        },
      },
      {
        ...envelope(projectRoot, 11),
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'later edit complete' }],
          stop_reason: 'end_turn',
        },
      },
    );
  }
  // Older turns go before the newest one, so only the newest page is rendered
  // first and reaching the earliest requires scrolling up.
  if (extraTurns > 0) {
    const earlier: Record<string, unknown>[] = [];
    for (let index = 1; index <= extraTurns; index += 1) {
      earlier.push(
        {
          ...envelope(projectRoot, 100 + index * 2),
          type: 'user',
          message: { role: 'user', content: `earlier turn ${String(index)}` },
          origin: { kind: 'human' },
          promptSource: 'typed',
        },
        {
          ...envelope(projectRoot, 101 + index * 2),
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: `reply ${String(index)}` }] },
        },
      );
    }
    records.splice(4, 0, ...earlier);
  }
  writeFileSync(
    path.join(projectDirectory, `${SESSION_ID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
  writeFileSync(
    path.join(home, '.claude', 'history.jsonl'),
    `${JSON.stringify({
      display: PROMPT,
      pastedContents: {},
      timestamp: 1_785_181_625_234,
      project: projectRoot,
      sessionId: SESSION_ID,
    })}\n`,
    'utf8',
  );
}

/** A project EZTerminal itself observed Agent work in — the only kind that is
 * listed, alongside explicitly saved ones. */
function seedTerminalProject(userDataDir: string, projectRoot: string): void {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    path.join(userDataDir, 'agent-projects.json'),
    JSON.stringify({
      version: 3,
      projects: [{
        projectId: 'seeded-terminal-project',
        name: 'Handoff',
        primaryRoot: projectRoot,
        additionalRoots: [],
        pinned: true,
        origin: 'terminal',
        lastActiveAt: 1_785_181_625_234,
        createdAt: 1_785_181_600_000,
        updatedAt: 1_785_181_625_234,
      }],
    }),
    'utf8',
  );
}

/** 모든 프로젝트 → Handoff's ⋯ → CLI history: the history dialog on that project's CLI records. */
async function openProjectHistory(window: Page): Promise<void> {
  await manageProject(window, 'Handoff', 'CLI history');
  const history = window.getByTestId('conversation-history-dialog');
  await expect(history).toBeVisible();
  await expect(history.getByRole('combobox', { name: 'Source' })).toHaveValue('native');
}

const historyRows = (window: Page) => window.getByTestId('conversation-history-dialog').locator('.conversation-history__row');

test('lists a local Claude session for a terminal project and opens it read-only', async () => {
  const home = createRegisteredE2eTempDir('ezterm-e2e-claude-home-');
  const projectRoot = createRegisteredE2eTempDir('ezterm-e2e-claude-root-');
  const userDataDir = createRegisteredE2eTempDir('ezterm-e2e-claude-data-');
  mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  writeFileSync(
    path.join(projectRoot, 'src', 'app.ts'),
    '// workspace-only context before\n\nexport const answer = 2;\n\n// workspace-only context after\n',
    'utf8',
  );
  writeFileSync(path.join(projectRoot, 'src', 'other.ts'), 'export const later = 2;\n', 'utf8');
  seedClaudeStore(home, projectRoot, 0, true);
  seedTerminalProject(userDataDir, projectRoot);

  // The adapter resolves the Claude store from the user's home directory.
  const app = await launchApp(userDataDir, { USERPROFILE: home, HOME: home });
  const window = await app.firstWindow();
  await resizeWindow(window, { width: 1440, height: 900 });

  // The terminal project is listed in 모든 프로젝트.
  const projects = await openAllProjects(window);
  await expect(projects).toContainText('Handoff');
  await window.keyboard.press('Escape');

  // The session list is fetched no earlier than CLI history being chosen
  // from the project's overflow menu.
  await openProjectHistory(window);
  const rows = historyRows(window);
  await expect(rows).toHaveCount(1, { timeout: 15_000 });
  await expect(rows.first()).toContainText('Claude');
  await expect(rows.first()).toContainText(PROMPT);
  // The provider's session id and transcript path never reach the renderer.
  await expect(window.getByTestId('conversation-history-dialog')).not.toContainText(SESSION_ID);

  // The conversation body is fetched no earlier than the session being opened,
  // and opening it must not start a run.
  await rows.first().click();
  const panel = window.getByTestId('conversation-start');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  const transcript = panel.getByTestId('structured-agent-transcript');
  await expect(transcript).toContainText(PROMPT);
  await expect(transcript).toContainText('reading the handoff package now');
  // Tool activity reads as a collapsed run ("Ran 1 command and edited 1 file"); expanding it names the command.
  await expect(transcript).toContainText('Ran 1 command');
  await transcript.locator('.chat-run__header').first().click();
  await expect(transcript).toContainText('pnpm test:unit');
  // Slash-command plumbing is not conversation.
  await expect(transcript).not.toContainText('/clear');
  await expect(transcript).not.toContainText('Caveat:');
  // Roles are provider-driven: the prompt keeps the sigil, the reply is labelled
  // with the provider that produced it rather than a hardcoded agent name.
  await expect(panel.getByTestId('structured-agent-session')).toHaveAttribute('data-provider', 'claude');
  await expect(panel.getByTestId('structured-agent-composer-input')).toBeVisible();

  // A structured file-change activity is itself the review affordance: one
  // click opens that exact file in the unified read-only Project editor.
  await transcript.locator('.conversation-history__changes summary').click();
  const fileChange = transcript.getByRole('button', { name: 'src/app.ts', exact: true });
  await expect(fileChange).toContainText('src/app.ts');
  await fileChange.click();
  const diff = window.getByTestId('project-editor-panel');
  await expect(diff).toBeVisible({ timeout: 20_000 });
  await expect(diff.locator('.project-editor__breadcrumb')).toContainText('src/app.ts');
  await expect(diff.locator('.monaco-diff-editor')).toBeVisible({ timeout: 20_000 });
  await expect(diff).toContainText('Agent turn');
  await expect(diff).toContainText('Current context');
  await expect(diff).not.toContainText('Change fragment');
  await expect(diff.locator('.monaco-diff-editor'))
    .toContainText('workspace-only context before');
  await expect(diff.locator('.monaco-diff-editor'))
    .toContainText('workspace-only context after');
  await expect(diff.locator('.line-insert, .char-insert').first()).toBeVisible();
  await expect(diff.getByTestId('open-current-project-file')).toHaveCount(0);
  await expect(window.getByTestId('project-editor-panel')).toHaveCount(1);

  await app.close();
});

test('keeps the complete current file and an unplaced provider record in one review surface', async () => {
  const home = createRegisteredE2eTempDir('ezterm-e2e-claude-record-home-');
  const projectRoot = createRegisteredE2eTempDir('ezterm-e2e-claude-record-root-');
  const userDataDir = createRegisteredE2eTempDir('ezterm-e2e-claude-record-data-');
  mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  writeFileSync(
    path.join(projectRoot, 'src', 'app.ts'),
    '// complete file first line\n\nexport const answer = 3;\n\n// complete file last line\n',
    'utf8',
  );
  seedClaudeStore(home, projectRoot);
  seedTerminalProject(userDataDir, projectRoot);

  const app = await launchApp(userDataDir, { USERPROFILE: home, HOME: home });
  const window = await app.firstWindow();
  await resizeWindow(window, { width: 1440, height: 900 });

  await openProjectHistory(window);
  await historyRows(window).first().click();
  const transcript = window.getByTestId('conversation-start').getByTestId('structured-agent-transcript');
  await transcript.locator('.conversation-history__changes summary').click();
  const fileChange = transcript.getByRole('button', { name: 'src/app.ts', exact: true });
  await expect(fileChange).toBeVisible({ timeout: 15_000 });
  await fileChange.click();

  const diff = window.getByTestId('project-editor-panel');
  await expect(diff).toBeVisible({ timeout: 20_000 });
  await expect(diff).toContainText('Current file + record');
  await expect(diff.locator('.monaco-editor')).toBeVisible({ timeout: 20_000 });
  await expect(diff.locator('.monaco-diff-editor')).toHaveCount(0);
  await expect(diff.locator('.view-lines')).toContainText('complete file first line');
  await expect(diff.locator('.view-lines')).toContainText('complete file last line');
  const record = diff.locator('.project-editor__recorded-accessibility');
  await expect(record).toContainText('current location could not be verified');
  await expect(record).toContainText('export const answer = 1;');
  await expect(record).toContainText('export const answer = 2;');
  await expect(diff.getByTestId('open-current-project-file')).toHaveCount(0);

  await app.close();
});

test('opens the newest twenty turns and loads earlier ones on scroll-up', async () => {
  const home = createRegisteredE2eTempDir('ezterm-e2e-claude-scroll-home-');
  const projectRoot = createRegisteredE2eTempDir('ezterm-e2e-claude-scroll-root-');
  const userDataDir = createRegisteredE2eTempDir('ezterm-e2e-claude-scroll-data-');
  // 25 earlier turns plus the newest one: more than one transcript page.
  seedClaudeStore(home, projectRoot, 25);
  seedTerminalProject(userDataDir, projectRoot);

  const app = await launchApp(userDataDir, { USERPROFILE: home, HOME: home });
  const window = await app.firstWindow();
  await resizeWindow(window, { width: 1440, height: 900 });
  // The wide shell docks the sidebar beside the transcript; opened before the resize lands (a slow runner), it is a
  // modal overlay and the transcript behind it cannot be clicked.
  await expect.poll(() => window.evaluate(() => matchMedia('(min-width: 1200px)').matches)).toBe(true);

  await openProjectHistory(window);
  const rows = historyRows(window);
  await expect(rows).toHaveCount(1, { timeout: 15_000 });
  await rows.first().click();

  const transcript = window.getByTestId('conversation-start').getByTestId('structured-agent-transcript');
  const turns = transcript.locator('.chat-row[data-kind="user"]');
  // Exactly one page: the newest twenty of the twenty-six turns on disk.
  await expect(turns).toHaveCount(20, { timeout: 15_000 });
  await expect(transcript).toContainText(PROMPT);
  await expect(turns.first()).toContainText('earlier turn 7');

  await transcript.getByRole('button', { name: 'Load earlier messages' }).click();
  // The remaining six are prepended, not swapped in.
  await expect(turns).toHaveCount(26, { timeout: 15_000 });
  await expect(turns.first()).toContainText('earlier turn 1');
  await expect(transcript).toContainText(PROMPT);

  await app.close();
});

test('explicit terminal continuation opens a Claude run rooted at the recorded project', async () => {
  const home = createRegisteredE2eTempDir('ezterm-e2e-claude-resume-home-');
  const projectRoot = createRegisteredE2eTempDir('ezterm-e2e-claude-resume-root-');
  const userDataDir = createRegisteredE2eTempDir('ezterm-e2e-claude-resume-data-');
  seedClaudeStore(home, projectRoot);
  seedTerminalProject(userDataDir, projectRoot);

  const app = await launchApp(userDataDir, { USERPROFILE: home, HOME: home });
  const window = await app.firstWindow();
  await resizeWindow(window, { width: 1440, height: 900 });

  await openProjectHistory(window);
  const rows = historyRows(window);
  await expect(rows).toHaveCount(1, { timeout: 15_000 });
  await rows.first().click();
  await expect(window.getByTestId('conversation-start')).toBeVisible({ timeout: 15_000 });
  await window.getByTestId('conversation-start').getByTestId('structured-agent-menu').click();
  await window.getByRole('menuitem', { name: 'Continue in terminal', exact: true }).click();
  // The workspace still holds its original empty terminal tab; the resumed one
  // is the only pane carrying a run block.
  const pane = window.getByTestId('pane')
    .filter({ has: window.getByTestId('block-command') });
  await expect(pane).toBeVisible({ timeout: 20_000 });

  // Claude has no `--cd`: it resolves its session store from the process cwd, so
  // the resumed shell MUST have been created in the project root.
  const promptCwd = pane.getByTestId('prompt-cwd');
  await expect(promptCwd).toBeVisible({ timeout: 20_000 });
  await expect(promptCwd).toHaveAttribute('title', new RegExp(
    path.basename(projectRoot).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'),
    'u',
  ));

  // The block is labelled by provider, and the session id never reaches the DOM.
  await expect(pane.getByTestId('block-command').first()).toHaveText('claude');
  await expect(pane).not.toContainText(SESSION_ID);

  await app.close();
});
