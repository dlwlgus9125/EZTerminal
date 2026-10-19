import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Plan mode is a switch beside the permission, never one of its levels. Every
 * surface that picks or shows a permission takes its words from
 * `agent-permission-copy`, so the old preset names cannot come back one file
 * at a time.
 */
const CONVERSATION_SURFACES = [
  'src/renderer/StructuredAgentSession.tsx',
  'src/renderer/ConversationStartPanel.tsx',
  'src/renderer/AgentProfilesSettings.tsx',
  'src/renderer/DelegateAgentDialog.tsx',
  'src/renderer/ConversationHistoryPicker.tsx',
  'src/renderer/chat/dock/ApprovalDock.tsx',
  'mobile/src/MobileAgentView.tsx',
  'mobile/src/MobileNewSessionDraft.tsx',
];
/** Scheduled and stage agents run alone: for them plan is a choice of its own, "plan only". */
const AUTOMATED_SURFACES = [
  'src/renderer/ScheduleSettings.tsx',
  'src/renderer/PlanningExecutionPanel.tsx',
  'src/renderer/workflow/WorkflowEditor.tsx',
  'src/renderer/workflow/WorkflowRunView.tsx',
  'src/renderer/workflow/WorkflowWorkspacePanel.tsx',
];
const SURFACES = [...CONVERSATION_SURFACES, ...AUTOMATED_SURFACES];

const source = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('agent permission surfaces', () => {
  it.each(SURFACES)('%s does not spell out the old preset names', (path) => {
    const text = source(path);
    expect(text).not.toMatch(/['"`>](?:Plan|Standard|Full access)['"`<]/u);
    expect(text).not.toMatch(/['"`](?:표준|전체 접근)['"`]/u);
  });

  it.each(CONVERSATION_SURFACES)('%s never lists plan among the permission levels', (path) => {
    const text = source(path);
    expect(text).not.toMatch(/\[\s*'plan',\s*'standard',\s*'full-access'\s*\]/u);
  });

  it('keeps the access levels to the two the permission control offers', () => {
    expect(source('src/renderer/agent-permission-copy.ts')).toContain("export const ACCESS_LEVELS: readonly AccessLevel[] = ['standard', 'full-access'];");
  });
});
