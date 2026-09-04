import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { DaemonStore } from '../src/main/daemon-store';
import { launchApp } from './launch-app';
import { createRegisteredE2eTempDir, expect, test } from './test';

const PARENT_SESSION_ID = 'managed-parent';
const CHILD_SESSION_ID = 'managed-child';
const NATIVE_SESSION_ID = 'provider-native-child';
const PROJECT_ID = 'structured-child-project';
const WORKSPACE_ID = 'structured-child-workspace';
const RESTORED_PANEL_ID = 'agent-session-structured-session-managed-parent';

async function seedDaemonGraph(userDataDir: string, workspaceRoot: string): Promise<void> {
  const store = new DaemonStore(userDataDir, {
    now: () => new Date('2026-09-04T09:00:00.000Z'),
    idFactory: (() => {
      let sequence = 0;
      return () => `structured-child-event-${++sequence}`;
    })(),
  });
  await store.init();
  try {
    await store.applySystemCommit({
      mutations: [
        {
          kind: 'runtime.update',
          value: { orchestrationToolsEnabled: true },
        },
        {
          kind: 'project.upsert',
          value: {
            id: PROJECT_ID,
            name: 'Structured child fixture',
            rootPath: workspaceRoot,
            source: 'native',
          },
        },
        {
          kind: 'workspace.upsert',
          value: {
            id: WORKSPACE_ID,
            projectId: PROJECT_ID,
            name: 'Fixture workspace',
            kind: 'local',
            rootPath: workspaceRoot,
          },
        },
        {
          kind: 'provider.upsert',
          value: {
            id: 'codex',
            displayName: 'Codex',
            protocol: 'codex-app-server',
            executablePath: path.join(workspaceRoot, 'unused-codex-fixture.exe'),
            executableVersion: '0.152.1',
            argv: ['app-server'],
            environmentVariableNames: [
              'PATH',
              'CODEX_HOME',
              'OPENAI_API_KEY',
              'HTTP_PROXY',
              'HTTPS_PROXY',
              'NO_PROXY',
            ],
            capabilities: ['model:gpt-5'],
            reviewDigest: 'a'.repeat(64),
            enabled: true,
            health: 'ready',
          },
        },
        ...[
          { id: PARENT_SESSION_ID, title: 'Lead Agent' },
          { id: CHILD_SESSION_ID, title: 'Managed Implementer' },
          { id: NATIVE_SESSION_ID, title: 'Provider Native Reviewer' },
        ].map(({ id, title }) => ({
          kind: 'session.upsert' as const,
          value: {
            id,
            projectId: PROJECT_ID,
            workspaceId: WORKSPACE_ID,
            kind: 'agent' as const,
            title,
            state: 'idle' as const,
            source: 'structured' as const,
          },
        })),
        ...[PARENT_SESSION_ID, CHILD_SESSION_ID, NATIVE_SESSION_ID].map((sessionId) => ({
          kind: 'agent.upsert' as const,
          value: {
            sessionId,
            providerId: 'codex',
            model: 'gpt-5',
            permissionPreset: 'standard' as const,
            state: 'idle' as const,
            queuedTurnCount: 0,
            orchestrationEnabled: true,
          },
        })),
        {
          kind: 'agent-relation.upsert',
          value: {
            id: 'parent-managed-child',
            treeId: PARENT_SESSION_ID,
            parentSessionId: PARENT_SESSION_ID,
            childSessionId: CHILD_SESSION_ID,
            owner: 'managed',
            depth: 1,
          },
        },
        {
          kind: 'agent-relation.upsert',
          value: {
            id: 'managed-provider-native-child',
            treeId: PARENT_SESSION_ID,
            parentSessionId: CHILD_SESSION_ID,
            childSessionId: NATIVE_SESSION_ID,
            owner: 'provider-native',
            depth: 2,
          },
        },
        {
          kind: 'transcript.append',
          items: [
            {
              id: 'parent-message',
              sessionId: PARENT_SESSION_ID,
              kind: 'assistant-message',
              text: 'I delegated the implementation and review.',
              isDelta: false,
              isSensitive: false,
            },
            {
              id: 'managed-message',
              sessionId: CHILD_SESSION_ID,
              kind: 'assistant-message',
              text: 'Implementation is ready for direct follow-up.',
              isDelta: false,
              isSensitive: false,
            },
            {
              id: 'native-message',
              sessionId: NATIVE_SESSION_ID,
              kind: 'notice',
              text: 'Provider-owned review is visible but controlled by Codex.',
              isDelta: false,
              isSensitive: false,
            },
          ],
        },
      ],
    });
  } finally {
    await store.close();
  }
}

function seedRestoredParentPanel(userDataDir: string): void {
  writeFileSync(
    path.join(userDataDir, 'layout.json'),
    JSON.stringify({
      schemaVersion: 1,
      savedAt: '2026-09-04T09:00:00.000Z',
      layout: {
        grid: {
          root: {
            type: 'branch',
            data: [{
              type: 'leaf',
              data: {
                views: [RESTORED_PANEL_ID],
                activeView: RESTORED_PANEL_ID,
                id: 'structured-child-group',
              },
              size: 720,
            }],
            size: 1280,
          },
          width: 1280,
          height: 720,
          orientation: 'VERTICAL',
        },
        panels: {
          [RESTORED_PANEL_ID]: {
            id: RESTORED_PANEL_ID,
            title: 'Lead Agent',
            renderer: 'always',
            tabComponent: 'props.defaultTabComponent',
            contentComponent: 'agent-session',
            params: { historyId: `structured-session-${PARENT_SESSION_ID}` },
          },
        },
        activeGroup: 'structured-child-group',
      },
    }),
    'utf8',
  );
}

test('restored Agent opens managed and provider-native children with enforced ownership', async () => {
  const userDataDir = createRegisteredE2eTempDir('ezterm-e2e-structured-child-data-');
  const workspaceRoot = createRegisteredE2eTempDir('ezterm-e2e-structured-child-workspace-');
  await seedDaemonGraph(userDataDir, workspaceRoot);
  seedRestoredParentPanel(userDataDir);

  const app = await launchApp(userDataDir);
  try {
    const window = await app.firstWindow();
    await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

    const parent = window.locator(
      `[data-testid="structured-agent-session"][data-session-id="${PARENT_SESSION_ID}"]`,
    );
    await expect(parent).toBeVisible();
    await expect(parent.getByRole('heading', { name: 'Lead Agent' })).toBeVisible();
    await expect(parent.getByText('I delegated the implementation and review.')).toBeVisible();

    const managedChild = parent.getByTestId('structured-agent-child').filter({
      hasText: 'Managed Implementer',
    });
    await expect(managedChild).toContainText('Managed');
    await managedChild.click();

    const managed = window.locator(
      `[data-testid="structured-agent-session"][data-session-id="${CHILD_SESSION_ID}"]`,
    );
    await expect(managed).toBeVisible();
    await expect(managed.getByText('Implementation is ready for direct follow-up.')).toBeVisible();
    await expect(managed.getByTestId('structured-agent-composer-input')).toBeEnabled();
    await expect(managed.getByTestId('structured-agent-detach')).toBeVisible();

    const providerNativeChild = managed.getByTestId('structured-agent-child').filter({
      hasText: 'Provider Native Reviewer',
    });
    await expect(providerNativeChild).toContainText('Provider-owned');
    await expect(providerNativeChild).toContainText('Read only');
    await providerNativeChild.click();

    const providerNative = window.locator(
      `[data-testid="structured-agent-session"][data-session-id="${NATIVE_SESSION_ID}"]`,
    );
    await expect(providerNative).toBeVisible();
    await expect(providerNative.getByText('Provider-owned · Read only')).toBeVisible();
    await expect(providerNative.getByTestId('structured-agent-composer-input')).toBeDisabled();
    await expect(providerNative.getByTestId('structured-agent-composer-disabled-reason'))
      .toContainText('direct messages and lifecycle changes stay with the parent provider');
    await expect(providerNative.getByTestId('structured-agent-lifecycle')).toHaveCount(0);

    const beforeReadOnlyCheck = await window.evaluate(async () => (
      globalThis.window.ezterminal.getDaemonSnapshot()
    ));
    await expect(providerNative.getByTestId('structured-agent-composer-input')).toHaveValue('');
    const afterReadOnlyCheck = await window.evaluate(async () => (
      globalThis.window.ezterminal.getDaemonSnapshot()
    ));
    expect(afterReadOnlyCheck?.revision).toBe(beforeReadOnlyCheck?.revision);

    await window.locator('.dv-tab', { hasText: 'Managed Implementer' }).click();
    await expect(managed).toBeVisible();
    await managed.getByTestId('structured-agent-detach').click();
    await expect(managed.getByTestId('structured-agent-detach')).toHaveCount(0);

    await expect.poll(async () => {
      const snapshot = await window.evaluate(async () => (
        globalThis.window.ezterminal.getDaemonSnapshot()
      ));
      const detached = snapshot?.agentRelations.find((relation) => (
        relation.childSessionId === CHILD_SESSION_ID
      ));
      const rebasedNative = snapshot?.agentRelations.find((relation) => (
        relation.childSessionId === NATIVE_SESSION_ID
      ));
      return {
        detached: typeof detached?.detachedAt === 'string',
        nativeDepth: rebasedNative?.depth,
        nativeTree: rebasedNative?.treeId,
      };
    }).toEqual({
      detached: true,
      nativeDepth: 1,
      nativeTree: CHILD_SESSION_ID,
    });

    const directInstruction = 'Please verify the implementation directly.';
    const detachedRevision = (await window.evaluate(async () => (
      globalThis.window.ezterminal.getDaemonSnapshot()
    )))?.revision ?? 0;
    await managed.getByTestId('structured-agent-composer-input').fill(directInstruction);
    await managed.getByTestId('structured-agent-send').click();
    await expect(managed.getByText(directInstruction, { exact: true })).toBeVisible();

    await expect.poll(async () => {
      const [snapshot, transcript] = await window.evaluate(async ({ sessionId }) => Promise.all([
        globalThis.window.ezterminal.getDaemonSnapshot(),
        globalThis.window.ezterminal.getDaemonTranscript(sessionId, 0, 100),
      ]), { sessionId: CHILD_SESSION_ID });
      const turn = snapshot?.turns.find((candidate) => candidate.sessionId === CHILD_SESSION_ID);
      return {
        revisionAdvanced: (snapshot?.revision ?? 0) > detachedRevision,
        directTurnCreated: turn !== undefined,
        persistedInstruction: transcript.some((item) => (
          item.kind === 'user-message' && item.text === directInstruction
        )),
      };
    }).toEqual({
      revisionAdvanced: true,
      directTurnCreated: true,
      persistedInstruction: true,
    });
  } finally {
    await app.close();
  }
});
