// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewSessionDraftPanel, type NewSessionDraftPanelProps } from './NewSessionDraftPanel';
import { sessionStartSnapshot } from './session-start.fixtures';
import { AppI18nProvider } from './i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const button = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
const click = (id: string) => act(() => button(id).click());
function select(id: string, value: string) {
  act(() => {
    const node = host.querySelector<HTMLSelectElement>(`[data-testid="${id}"]`)!;
    node.value = value; node.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
function setup(overrides: Partial<NewSessionDraftPanelProps> = {}) {
  const props: NewSessionDraftPanelProps = {
    snapshot: sessionStartSnapshot, projectId: 'project', workspaceId: 'feature',
    agent: { providers: [], workspaces: sessionStartSnapshot.workspaces.map((workspace) => ({ id: workspace.id, label: workspace.name, kind: workspace.kind })), onCreate: vi.fn(async () => ({ ok: true as const })) },
    access: {
      getDaemonSnapshot: vi.fn(async () => sessionStartSnapshot),
      listAgentProjectLaunchers: vi.fn(async () => [{ launcherId: 'codex-cli', provider: 'codex' as const, name: 'Codex CLI', supportsAdditionalRoots: true }]),
      prepareAgentLaunch: vi.fn(async (target, launcherId) => ({ ok: true as const, target, launcherId, provider: 'codex' as const, name: 'Codex CLI', cwd: sessionStartSnapshot.workspaces[1].rootPath, roots: [], ignoredAdditionalRootCount: 0, revision: 'reviewed' })),
    },
    onTerminal: vi.fn(async () => ({ ok: true as const })), onLaunchCli: vi.fn(async () => undefined), ...overrides,
  };
  act(() => root.render(<AppI18nProvider locale="en" languages={['en']}><NewSessionDraftPanel {...props} /></AppI18nProvider>));
  return props;
}

describe('New session routing', () => {
  it('opens a contextual regular terminal with no ready Agent provider', async () => {
    const props = setup(); await flush();
    click('new-session-terminal');
    expect(props.onTerminal).not.toHaveBeenCalled();
    expect(props.agent.onCreate).not.toHaveBeenCalled();
    expect(props.access.prepareAgentLaunch).not.toHaveBeenCalled();
    expect(button('new-session-open-terminal').disabled).toBe(false);
    click('new-session-open-terminal'); await flush();
    expect(props.onTerminal).toHaveBeenCalledExactlyOnceWith('feature', undefined);
  });

  it('offers a standalone terminal without daemon authority or a project', async () => {
    const props = setup({ snapshot: null, projectId: undefined, workspaceId: undefined }); await flush();
    click('new-session-terminal'); select('new-session-project', 'local');
    click('new-session-open-terminal'); await flush();
    expect(props.onTerminal).toHaveBeenCalledExactlyOnceWith(undefined, undefined);
  });

  it('does not silently replace an unavailable contextual Workspace', async () => {
    const props = setup({ workspaceId: 'removed-worktree' }); await flush();
    click('new-session-terminal');
    expect(button('new-session-open-terminal').disabled).toBe(true);
    expect(props.onTerminal).not.toHaveBeenCalled();
  });

  it('revalidates the exact worktree and launches one CLI only after Start', async () => {
    const props = setup(); await flush();
    click('new-session-cli'); select('session-cli-launcher', 'codex-cli');
    expect(props.access.prepareAgentLaunch).not.toHaveBeenCalled();
    act(() => { button('session-cli-start').click(); button('session-cli-start').click(); });
    expect(button('new-session-terminal').disabled).toBe(true);
    await flush();
    expect(props.access.prepareAgentLaunch).toHaveBeenCalledExactlyOnceWith({ kind: 'directory', directory: sessionStartSnapshot.workspaces[1].rootPath }, 'codex-cli');
    expect(props.onLaunchCli).toHaveBeenCalledOnce();
    expect(props.onTerminal).not.toHaveBeenCalled();
  });

  it('rejects a workspace removed between selection and CLI Start', async () => {
    const props = setup(); await flush();
    vi.mocked(props.access.getDaemonSnapshot).mockResolvedValue({ ...sessionStartSnapshot, workspaces: [] });
    click('new-session-cli'); select('session-cli-launcher', 'codex-cli'); click('session-cli-start'); await flush();
    expect(props.onLaunchCli).not.toHaveBeenCalled();
    expect(props.access.prepareAgentLaunch).not.toHaveBeenCalled();
    expect(host.textContent).toContain('selected workspace is unavailable');
  });

  it('locks type and location during uncertain Agent delivery', async () => {
    const props = setup({ agent: { providers: [], workspaces: [], deliveryRecovery: true, initialWorkspaceId: 'feature', initialProviderId: 'codex', initialPrompt: 'submitted', onCreate: vi.fn(async () => ({ ok: true as const })) } }); await flush();
    expect(button('new-session-terminal').disabled).toBe(true);
    expect(button('new-session-cli').disabled).toBe(true);
    expect(props.onTerminal).not.toHaveBeenCalled();
  });
});
