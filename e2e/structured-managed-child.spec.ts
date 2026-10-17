import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { CHILD_SESSION_ID, NATIVE_SESSION_ID, PARENT_SESSION_ID, seedAgentTree as seedDaemonGraph } from './fixtures/agent-tree-fixture';
import { launchApp } from './launch-app';
import { createRegisteredE2eTempDir, expect, test } from './test';

const RESTORED_PANEL_ID = 'agent-session-structured-session-managed-parent';

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
    // Session actions live in the header's menu.
    await managed.getByTestId('structured-agent-menu').click();
    await expect(managed.getByTestId('structured-agent-detach')).toBeVisible();
    await window.keyboard.press('Escape');

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
    // A provider-owned subagent reads as a child of its parent: a way back, no composer, no lifecycle.
    await expect(providerNative.getByTestId('structured-agent-parent')).toContainText('Managed Implementer');
    await expect(providerNative.getByTestId('structured-agent-subagent-footer'))
      .toContainText('The parent conversation runs this subagent');
    await expect(providerNative.getByTestId('structured-agent-composer-input')).toHaveCount(0);
    await expect(providerNative.getByTestId('structured-agent-lifecycle')).toHaveCount(0);

    const beforeReadOnlyCheck = await window.evaluate(async () => (
      globalThis.window.ezterminal.getDaemonSnapshot()
    ));
    await providerNative.getByTestId('structured-agent-parent').click();
    await expect(managed).toBeVisible();
    const afterReadOnlyCheck = await window.evaluate(async () => (
      globalThis.window.ezterminal.getDaemonSnapshot()
    ));
    expect(afterReadOnlyCheck?.revision).toBe(beforeReadOnlyCheck?.revision);

    await window.locator('.dv-tab', { hasText: 'Managed Implementer' }).click();
    await expect(managed).toBeVisible();
    await managed.getByTestId('structured-agent-menu').click();
    await managed.getByTestId('structured-agent-detach').click();
    await managed.getByTestId('structured-agent-menu').click();
    await expect(managed.getByTestId('structured-agent-detach')).toHaveCount(0);
    await window.keyboard.press('Escape');

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
    // The composer also contains this text while the encrypted submit envelope
    // is being saved. Wait for a delivered transcript item before checking the
    // daemon receipt, rather than mistaking the editable draft for delivery.
    // A stopped fixture provider keeps the accepted message in the canonical
    // history view. Its visual identity remains the same after the runtime ends.
    const deliveredConversation = window.getByTestId('structured-agent-session').filter({
      has: window.getByRole('heading', { name: 'Managed Implementer', exact: true }),
    });
    await expect(deliveredConversation.getByTestId('structured-agent-transcript')
      .getByText(directInstruction, { exact: true })).toBeVisible({ timeout: 20_000 });

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
