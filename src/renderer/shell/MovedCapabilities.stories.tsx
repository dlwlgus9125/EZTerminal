import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, within } from 'storybook/test';

import type { AgentProjectSummary } from '../../shared/agent-history';
import type { PlanningIntegrationRecord, PlanningResultRecord } from '../../shared/planning-result';
import type { ProjectArchiveResult } from '../../shared/project-archive';
import { AppI18nProvider } from '../i18n';
import { PlanningResultDetails, type PlanningResultReader, type PlanningResultSelection } from '../PlanningResultDetails';
import { ProjectArchiveDialog } from '../ProjectArchiveDialog';
import { ProjectEditorDialog, type ProjectRegistryAccess } from '../ProjectDialogs';
import { projectArchivePendingStore } from '../project-archive-pending';
import '../index.css';
import './shell.css';
import './tool-screens.css';

/**
 * What I5 moves out of the old planning panel before deleting it: a flow run's integration result,
 * retrying a failed independent review, the project's backup and restore, and result details on the
 * phone. Production dialogs on story records (the run bar's lamp is in Production/Workflow/Flow canvas).
 */
const SHA = (ch: string, length = 40) => ch.repeat(length);

const INTEGRATION: PlanningIntegrationRecord = {
  version: 1, projectId: 'project-story', runId: 'run-story', inputFingerprint: SHA('c', 64), status: 'failed',
  inputArtifacts: [{ artifactId: 'login:implement', revision: 2 }, { artifactId: 'login:review', revision: 1 }],
  workspacePath: '<WORKSPACE>/.ezterminal/integration/run-story', candidateCommit: SHA('d'), previousSuccessfulCommit: SHA('a'),
  validations: [
    { validationId: 'pnpm test', status: 'failed', exitCode: 1, logRefs: ['log-integration'], summary: '2 tests failed in login.spec.ts' },
    { validationId: 'pnpm lint', status: 'passed', exitCode: 0, logRefs: [], summary: 'No problems' },
  ],
  error: 'Validation failed after merging the reviewed results.',
};

const ATTEMPT: PlanningResultRecord = {
  version: 1, projectId: 'project-story', runId: 'run-story', taskId: 'login:implement', attemptId: 'attempt-2', baselineFingerprint: SHA('b', 64),
  artifacts: [{ artifactId: 'login:implement', revision: 2 }], rootPath: '<WORKSPACE>/.ezterminal/runs/run-story/implement', baseCommit: SHA('a'), commit: SHA('e'),
  changedPaths: ['src/login/session.ts', 'src/login/session.test.ts'],
  validations: [{ validationId: 'pnpm test', status: 'passed', exitCode: 0, logRefs: [], summary: 'All tests passed' }],
  error: 'The review AI did not answer (Codex exited).', reviewAttempt: 1,
};

const read: PlanningResultReader = async (query) => {
  if (query.kind === 'integration') return { ok: true, kind: 'integration', integration: INTEGRATION };
  if (query.kind === 'attempt') return { ok: true, kind: 'attempt', result: ATTEMPT };
  return { ok: false, message: 'Story: not stored.' };
};

function Results({ selection, onRetryReview }: { readonly selection: PlanningResultSelection; readonly onRetryReview?: () => void }): JSX.Element {
  const locale: 'ko' | 'en' = document.documentElement.lang === 'ko' ? 'ko' : 'en';
  return (
    <AppI18nProvider locale={locale} languages={[locale]}>
      <div className="app ez-shell" style={{ width: '100vw', height: '100vh', background: 'var(--ui-floor)' }} />
      <PlanningResultDetails selection={selection} read={read} onClose={() => undefined} disabled={false} {...(onRetryReview ? { onRetryReview } : {})} />
    </AppI18nProvider>
  );
}

const PROJECT: AgentProjectSummary = {
  projectId: 'p-ez', name: 'EZTerminal', primaryRoot: '<WORKSPACE>\\EZTerminal', additionalRoots: [], pinned: true, saved: true, sessionCount: 4, providers: ['codex'], lastActiveAt: 1,
};
const REGISTRY: ProjectRegistryAccess = {
  listAgentProjects: async () => ({ items: [PROJECT], nextCursor: null }),
  saveAgentProject: async () => ({ ok: true as const, project: PROJECT }),
  removeAgentProject: async () => true,
};
const ARCHIVE = {
  access: {
    executeProjectArchive: async (request: { type: string }): Promise<ProjectArchiveResult> => (request.type === 'inventory'
      ? { ok: true, kind: 'inventory', inventory: { projectId: 'p-ez', token: SHA('f', 64), revision: 3,
        groups: [{ kind: 'workflows', items: 2, bytes: 48_000 }, { kind: 'conversations', items: 14, bytes: 2_310_000 }, { kind: 'execution', items: 6, bytes: 122_000 }],
        conversations: [
          { sessionId: 's-login', title: '로그인 세션 만료 처리', items: 64, bytes: 812_000, deletable: false, protection: 'active' },
          { sessionId: 's-old', title: '예전 설정 화면 정리', items: 31, bytes: 240_000, deletable: true },
        ] } }
      : { ok: false, error: 'unavailable', message: 'Story: nothing is written.' }),
  },
  pending: projectArchivePendingStore('story', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }),
};

function Backup({ open }: { readonly open: 'editor' | 'archive' }): JSX.Element {
  const locale: 'ko' | 'en' = document.documentElement.lang === 'ko' ? 'ko' : 'en';
  const [view, setView] = useState(open);
  return (
    <AppI18nProvider locale={locale} languages={[locale]}>
      <div className="app ez-shell" style={{ width: '100vw', height: '100vh', background: 'var(--ui-floor)' }} />
      {view === 'editor'
        ? <ProjectEditorDialog open mode={{ kind: 'edit', project: PROJECT }} access={REGISTRY} onClose={() => undefined} onSaved={() => undefined} onOpenArchive={() => setView('archive')} />
        : <ProjectArchiveDialog project={{ projectId: PROJECT.projectId, name: PROJECT.name }} archive={ARCHIVE} onClose={() => setView('editor')} />}
    </AppI18nProvider>
  );
}

const meta = {
  title: 'Production/Desk/Moved from the planning panel',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** 흐름 실행 막대 "결과": the run's integration record (it used to be the old panel's 작업 tab). */
export const IntegrationResult: Story = {
  render: () => <Results selection={{ kind: 'integration', projectId: 'project-story', subprojectId: 'login', runId: 'run-story' }} />,
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await expect(await body.findByText(/Validation failed after merging/u)).toBeVisible();
  },
};

/** A stage attempt whose independent review failed: 독립 검토 다시 요청 is right there. */
export const RetryIndependentReview: Story = {
  render: () => <Results selection={{ kind: 'attempt', projectId: 'project-story', subprojectId: 'login', attemptId: 'attempt-2' }} onRetryReview={fn()} />,
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement.ownerDocument.body).findByTestId('planning-result-retry-review')).toBeVisible();
  },
};

/** 프로젝트 설정 (the board's or a conversation's) now leads to backup and restore. */
export const ProjectBackupEntry: Story = {
  render: () => <Backup open="editor" />,
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement.ownerDocument.body).findByTestId('agent-project-backup')).toBeVisible();
  },
};

export const ProjectBackupDialog: Story = {
  render: () => <Backup open="archive" />,
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement.ownerDocument.body).findByTestId('project-archive-dialog')).toBeVisible();
  },
};

/** The phone's flow screen 결과 opens the same record (it had no way to read results before). */
export const PhoneFlowResults: Story = {
  parameters: { viewport: { defaultViewport: 'mobile2' } },
  render: () => <div style={{ width: 412, height: 915 }}><Results selection={{ kind: 'integration', projectId: 'project-story', subprojectId: 'login', runId: 'run-story' }} /></div>,
};
