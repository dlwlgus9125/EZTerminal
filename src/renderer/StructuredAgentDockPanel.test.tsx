// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IDockviewPanelProps } from 'dockview-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonCommand, DaemonSnapshot } from '../shared/daemon-protocol';
import {
  STRUCTURED_AGENT_DRAFT_PREFIX,
  STRUCTURED_AGENT_SESSION_PREFIX,
  StructuredAgentDockPanel,
} from './StructuredAgentDockPanel';
import { AppI18nProvider } from './i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = '2026-09-04T09:30:00.000Z';

const snapshot: DaemonSnapshot = {
  protocolVersion: 12,
  revision: 4,
  eventSequence: 9,
  generatedAt: NOW,
  runtime: { keepRunning: true, startAtLogin: false, orchestrationToolsEnabled: true, browserEnabled: false },
  projects: [{
    id: 'project-1', name: 'EZTerminal', source: 'native', revision: 1, createdAt: NOW, updatedAt: NOW,
  }],
  workspaces: [{
    id: 'project-1.root-1.workspace-other', projectId: 'project-1', name: 'Other', kind: 'worktree',
    rootPath: 'C:\\Working\\other', revision: 1, createdAt: NOW, updatedAt: NOW,
  }, {
    id: 'project-1.root-1.workspace-1', projectId: 'project-1', name: 'Stage 2', kind: 'worktree',
    rootPath: 'C:\\Working\\stage2', revision: 1, createdAt: NOW, updatedAt: NOW,
  }],
  sessions: [],
  agents: [],
  agentRelations: [],
  turns: [],
  transcriptHeads: [],
  approvals: [],
  providers: [{
    id: 'codex', displayName: 'Codex', protocol: 'codex-app-server', executablePath: 'codex',
    executableVersion: '1.0.0', argv: [], environmentVariableNames: [], capabilities: ['model:gpt-5'],
    enabled: true, health: 'ready', revision: 1, createdAt: NOW, updatedAt: NOW,
  }],
  schedules: [],
  heartbeats: [],
};

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Object.defineProperty(window, 'ezterminal', { configurable: true, value: undefined });
  vi.restoreAllMocks();
});

describe('StructuredAgentDockPanel', () => {
  it('resolves a raw project workspace to its daemon namespace before the first agent.create', async () => {
    const sent: DaemonCommand[] = [];
    const sendDaemonCommand = vi.fn(async (command: DaemonCommand) => {
      sent.push(command);
      return {
        ok: true as const,
        status: 'applied' as const,
        commandId: command.commandId,
        revision: 5,
        eventSequence: 10,
      };
    });
    const setSubscribed = vi.fn();
    Object.defineProperty(window, 'ezterminal', {
      configurable: true,
      value: {
        getDaemonSnapshot: vi.fn(async () => snapshot),
        sendDaemonCommand,
        onDaemonEvent: vi.fn(() => () => undefined),
        setDaemonEventsSubscribed: setSubscribed,
      },
    });

    let params: Record<string, unknown> = {
      historyId: `${STRUCTURED_AGENT_DRAFT_PREFIX}test`,
      projectId: 'project-1',
      rootId: 'root-1',
      workspaceId: 'workspace-1',
    };
    const updateParameters = vi.fn((next: Record<string, unknown>) => { params = next; });
    const setTitle = vi.fn();
    const props = {
      params,
      api: {
        id: 'agent-session-draft',
        getParameters: () => params,
        updateParameters,
        setTitle,
      },
    } as unknown as IDockviewPanelProps;
    act(() => root.render(
      <AppI18nProvider locale="en" languages={['en']}>
        <StructuredAgentDockPanel {...props} />
      </AppI18nProvider>,
    ));
    await flush();

    expect(sendDaemonCommand).not.toHaveBeenCalled();
    const prompt = container.querySelector<HTMLTextAreaElement>('[data-testid="structured-agent-first-prompt"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(prompt, 'Create only after this send');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      prompt.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      protocolVersion: 12,
      expectedRevision: 4,
      principal: { kind: 'desktop', id: 'renderer-agent-ui' },
      type: 'agent.create',
      payload: {
        workspaceId: 'project-1.root-1.workspace-1',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'Create only after this send',
      },
    });
    expect(updateParameters).toHaveBeenCalledWith(expect.objectContaining({
      historyId: expect.stringMatching(new RegExp(`^${STRUCTURED_AGENT_SESSION_PREFIX}`)),
      provider: 'codex',
    }));
    expect(setTitle).toHaveBeenCalledWith('Create only after this send');
    expect(container.querySelector('[data-testid="structured-agent-session"]')).not.toBeNull();
    expect(setSubscribed).toHaveBeenNthCalledWith(1, true);
  });
});
