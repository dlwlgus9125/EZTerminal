import path from 'node:path';

import { DaemonStore } from '../../src/main/daemon-store';

/**
 * A managed parent with a managed child, whose own child is provider-native: the smallest
 * daemon graph that exercises nesting, direct child chats and a read-only provider subagent.
 * Seeded straight into a profile's daemon store before the app starts.
 */
export const PARENT_SESSION_ID = 'managed-parent';
export const CHILD_SESSION_ID = 'managed-child';
export const NATIVE_SESSION_ID = 'provider-native-child';
export const PROJECT_ID = 'structured-child-project';
export const WORKSPACE_ID = 'structured-child-workspace';

export async function seedAgentTree(userDataDir: string, workspaceRoot: string): Promise<void> {
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
