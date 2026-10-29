import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentProviderAdapter } from './agent-provider-adapter';
import { AgentCapabilityService } from './agent-capability-service';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });
async function fixture() {
  const receiptDirectory = await mkdtemp(path.join(os.tmpdir(), 'ezterminal-capability-'));
  folders.push(receiptDirectory);
  const listCapabilities = vi.fn(async () => ({ models: [], items: [{ id: 'sample@market', kind: 'plugin' as const, name: 'Sample', enabled: true, actions: ['plugin-disable' as const], status: 'connected' }], actions: ['plugin-disable' as const, 'plugin-install' as const], issues: [] }));
  const manageExtension = vi.fn(async () => undefined);
  const options = { registry: { enabledAdapter: () => ({ ok: true as const, value: { listCapabilities, manageExtension } as unknown as AgentProviderAdapter }) }, getSnapshot: () => ({ providers: [] }), hostId: 'host-1', receiptDirectory };
  const service = new AgentCapabilityService(options);
  const scope = { workspaceRoot: path.resolve('fixture'), canManage: true };
  const request = { providerId: 'codex' as const, workspaceId: 'workspace-1' };
  const catalog = await service.list(request, scope);
  if (!catalog.ok) throw new Error('fixture');
  const command = { ...request, commandId: 'command-1', expectedRevision: catalog.value.revision, action: 'plugin-disable' as const, target: 'sample@market', scope: 'user' as const };
  return { service, options, scope, request, command, listCapabilities, manageExtension };
}
describe('AgentCapabilityService', () => {
  it('reads without creating a session and exposes app skill only when tools are bound', async () => {
    const f = await fixture();
    const ordinary = await f.service.list(f.request, f.scope);
    const bound = await f.service.list(f.request, { ...f.scope, workflowToolsAvailable: true });
    expect(ordinary.ok && ordinary.value.items.some((item) => item.kind === 'app-skill')).toBe(false);
    expect(bound.ok && bound.value.items.some((item) => item.kind === 'app-skill')).toBe(true);
    expect(f.manageExtension).not.toHaveBeenCalled();
  });
  it('keeps revision stable across volatile connection status', async () => {
    const f = await fixture();
    f.listCapabilities.mockResolvedValueOnce({ models: [], items: [{ id: 'sample@market', kind: 'plugin', name: 'Sample', enabled: true, actions: ['plugin-disable'], status: 'pending' }], actions: ['plugin-disable', 'plugin-install'], issues: [] });
    expect(await f.service.manage(f.command, f.scope)).toMatchObject({ ok: true, value: { state: 'applied' } });
    expect(f.manageExtension).toHaveBeenCalledTimes(1);
  });
  it('persists receipts and never repeats a command after a lost reply or service restart', async () => {
    const f = await fixture();
    await Promise.all([f.service.manage(f.command, f.scope), f.service.manage(f.command, f.scope)]);
    expect(await new AgentCapabilityService(f.options).manage(f.command, f.scope)).toMatchObject({ ok: true, value: { state: 'applied' } });
    expect(f.manageExtension).toHaveBeenCalledTimes(1);
    expect(await f.service.manage({ ...f.command, target: 'other@market' }, f.scope)).toMatchObject({ ok: false, code: 'invalid-input' });
  });
  it('retains uncertain receipts instead of retrying a failed native call', async () => {
    const f = await fixture();
    f.manageExtension.mockRejectedValueOnce(new Error('connection lost'));
    expect(await f.service.manage(f.command, f.scope)).toMatchObject({ ok: true, value: { state: 'uncertain' } });
    expect(await new AgentCapabilityService(f.options).manage(f.command, f.scope)).toMatchObject({ ok: true, value: { state: 'uncertain' } });
    expect(f.manageExtension).toHaveBeenCalledTimes(1);
  });
  it('rejects remote read-only management, stale catalogs, unknown targets and CLI options', async () => {
    const f = await fixture();
    expect(await f.service.manage(f.command, { ...f.scope, canManage: false })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await f.service.manage({ ...f.command, expectedRevision: 'b'.repeat(64) }, f.scope)).toMatchObject({ ok: false, code: 'stale' });
    expect(await f.service.manage({ ...f.command, target: 'unknown' }, f.scope)).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(await f.service.manage({ ...f.command, action: 'plugin-install', target: '--help' }, f.scope)).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(f.manageExtension).not.toHaveBeenCalled();
  });
  it('recovers a nonsecret receipt after process restart and blocks new work until explicit acknowledgement', async () => {
    const f = await fixture();
    f.manageExtension.mockRejectedValueOnce(new Error('lost connection'));
    await f.service.manage(f.command, f.scope);
    const restarted = new AgentCapabilityService(f.options);
    const catalog = await restarted.list(f.request, f.scope);
    expect(catalog).toMatchObject({ ok: true, value: { extensionReceipts: [{ commandId: f.command.commandId, state: 'uncertain' }] } });
    expect(JSON.stringify(catalog)).not.toContain('expectedRevision');
    expect(await restarted.manage({ ...f.command, commandId: 'new-request' }, f.scope)).toMatchObject({ ok: false, code: 'stale' });
    expect(await restarted.manage({ ...f.command, target: 'receipt', recovery: 'inspect' }, { ...f.scope, workspaceRoot: path.resolve('another-workspace') })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await restarted.manage({ ...f.command, target: 'receipt', recovery: 'inspect' }, f.scope)).toMatchObject({ ok: true, value: { state: 'uncertain' } });
    expect(f.manageExtension).toHaveBeenCalledTimes(1);
    expect(await restarted.manage({ ...f.command, target: 'receipt', recovery: 'acknowledge' }, f.scope)).toMatchObject({ ok: true });
    expect(await new AgentCapabilityService(f.options).list(f.request, f.scope)).toMatchObject({ ok: true, value: { extensionReceipts: [] } });
    expect(await restarted.manage({ ...f.command, commandId: 'new-request' }, f.scope)).toMatchObject({ ok: true, value: { state: 'applied' } });
    expect(f.manageExtension).toHaveBeenCalledTimes(2);
  });
});

describe('AgentCapabilityService PC user scope', () => {
  const hostRoot = path.resolve('host-scope');
  const projectRoot = path.resolve('projects', 'app');
  const items = [
    { id: 'tool@market', kind: 'plugin' as const, name: 'tool', scope: 'user', enabled: true, actions: ['plugin-enable' as const, 'plugin-disable' as const, 'plugin-remove' as const] },
    { id: 'tool@market', kind: 'plugin' as const, name: 'tool', scope: 'project', projectPath: projectRoot, enabled: false, actions: ['plugin-enable' as const, 'plugin-disable' as const, 'plugin-remove' as const] },
    { id: 'lint@market', kind: 'plugin' as const, name: 'lint', scope: 'local', projectPath: path.resolve('elsewhere'), enabled: true, actions: ['plugin-enable' as const, 'plugin-disable' as const] },
  ];
  const available = Array.from({ length: 75 }, (_, index) => ({
    id: `plugin-${String(index).padStart(2, '0')}@${index % 2 ? 'odd' : 'even'}`, name: `plugin-${String(index).padStart(2, '0')}`,
    marketplace: index % 2 ? 'odd' : 'even', installed: index === 0, description: index === 3 ? 'x'.repeat(400) : `Plugin number ${index}`,
  }));
  async function hostFixture() {
    let updating = false;
    const receiptDirectory = await mkdtemp(path.join(os.tmpdir(), 'ezterminal-host-capability-'));
    folders.push(receiptDirectory);
    const listCapabilities = vi.fn<NonNullable<AgentProviderAdapter['listCapabilities']>>(async () => ({
      models: [], items, issues: [],
      actions: ['plugin-install' as const, 'plugin-enable' as const, 'plugin-disable' as const, 'plugin-remove' as const, 'marketplace-add' as const, 'marketplace-update' as const, 'marketplace-remove' as const],
      marketplaces: [{ name: 'market', source: 'owner/market', actions: ['marketplace-update' as const, 'marketplace-remove' as const] }, { name: 'curated', actions: [] }],
    }));
    const listAvailablePlugins = vi.fn(async () => available);
    const manageExtension = vi.fn(async () => undefined);
    const service = new AgentCapabilityService({
      registry: { enabledAdapter: () => ({ ok: true as const, value: { listCapabilities, listAvailablePlugins, manageExtension } as unknown as AgentProviderAdapter }) },
      getSnapshot: () => ({ providers: [] }), hostId: 'host-1', receiptDirectory, isUpdating: () => updating,
    });
    const scope = {
      hostRoot, canManage: true,
      workspaceRoot: (workspaceId: string) => workspaceId === 'workspace-app' ? projectRoot : undefined,
      workspaceForPath: (folder: string) => path.resolve(folder) === projectRoot ? 'workspace-app' : undefined,
    };
    const catalog = await service.listHost({ providerId: 'claude' }, scope);
    if (!catalog.ok) throw new Error('fixture');
    const command = { providerId: 'claude' as const, commandId: 'host-1', expectedRevision: catalog.value.revision, scope: 'user' as const };
    return { service, scope, catalog: catalog.value, command, listCapabilities, listAvailablePlugins, manageExtension, setUpdating: (value: boolean) => { updating = value; } };
  }

  it('reads user settings from the neutral folder and marks which project installs this app can change', async () => {
    const f = await hostFixture();
    expect(f.listCapabilities).toHaveBeenCalledWith(hostRoot, undefined, { hostUser: true });
    expect(f.catalog.workspaceId).toBe('@pc-user');
    expect(f.catalog.items.find((item) => item.scope === 'project')).toMatchObject({ workspaceId: 'workspace-app' });
    expect(f.catalog.items.find((item) => item.scope === 'local')).toMatchObject({ actions: [] });
    expect(f.catalog.marketplaces?.map((marketplace) => marketplace.name)).toEqual(['market', 'curated']);
  });

  it('keeps the workspace-bound path away from the PC user scope', async () => {
    const f = await hostFixture();
    expect(await f.service.list({ providerId: 'claude', workspaceId: '@pc-user' }, { workspaceRoot: hostRoot, canManage: true })).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(await f.service.manage({ ...f.command, workspaceId: '@pc-user', action: 'plugin-disable', target: 'tool@market' }, { workspaceRoot: hostRoot, canManage: true }))
      .toMatchObject({ ok: false, code: 'invalid-input' });
    expect(f.manageExtension).not.toHaveBeenCalled();
  });

  it('runs a PC-wide change in the neutral folder and a project change in that project', async () => {
    const f = await hostFixture();
    expect(await f.service.manageHost({ ...f.command, action: 'plugin-disable', target: 'tool@market' }, f.scope)).toMatchObject({ ok: true, value: { state: 'applied' } });
    expect(f.manageExtension).toHaveBeenLastCalledWith(hostRoot, expect.objectContaining({ scope: 'user', workspaceId: '@pc-user' }), undefined);
    const fresh = await f.service.listHost({ providerId: 'claude' }, f.scope);
    if (!fresh.ok) throw new Error('list');
    expect(await f.service.manageHost({ ...f.command, commandId: 'host-2', expectedRevision: fresh.value.revision, action: 'plugin-enable', target: 'tool@market', scope: 'project', workspaceId: 'workspace-app' }, f.scope))
      .toMatchObject({ ok: true, value: { state: 'applied' } });
    expect(f.manageExtension).toHaveBeenLastCalledWith(projectRoot, expect.objectContaining({ scope: 'project', action: 'plugin-enable' }), undefined);
  });

  it('refuses project changes outside an app project and installs the app cannot see', async () => {
    const f = await hostFixture();
    expect(await f.service.manageHost({ ...f.command, action: 'plugin-install', target: 'new@market', scope: 'project', workspaceId: 'unknown' }, f.scope)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await f.service.manageHost({ ...f.command, action: 'plugin-enable', target: 'lint@market', scope: 'local', workspaceId: 'workspace-app' }, f.scope)).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(await f.service.manageHost({ ...f.command, action: 'mcp-add', target: 'docs', scope: 'project', workspaceId: 'workspace-app', mcp: { type: 'http', url: 'https://example.com/mcp' } }, f.scope)).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(await f.service.manageHost({ ...f.command, action: 'marketplace-remove', target: 'curated' }, f.scope)).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(f.manageExtension).not.toHaveBeenCalled();
  });

  it('pages, filters and trims marketplace plugins from one cached read', async () => {
    const f = await hostFixture();
    const first = await f.service.browse({ providerId: 'claude', limit: 50 }, f.scope);
    expect(first).toMatchObject({ ok: true, value: { total: 75, offset: 0, marketplaces: ['even', 'odd'] } });
    if (!first.ok) throw new Error('browse');
    expect(first.value.entries).toHaveLength(50);
    expect(first.value.entries[3]!.description).toHaveLength(300);
    expect(await f.service.browse({ providerId: 'claude', offset: 50, limit: 50 }, f.scope)).toMatchObject({ ok: true, value: { total: 75, entries: { length: 25 } } });
    expect(await f.service.browse({ providerId: 'claude', marketplace: 'odd', query: 'PLUGIN-1' }, f.scope)).toMatchObject({ ok: true, value: { total: 5 } });
    // "number 7" is in plugin-07's description and in nothing's name: description matches still come back.
    const described = await f.service.browse({ providerId: 'claude', query: 'number 7' }, f.scope);
    expect(described.ok && described.value.entries.map((entry) => entry.name)).toEqual(['plugin-07', 'plugin-70', 'plugin-71', 'plugin-72', 'plugin-73', 'plugin-74']);
    // A name match comes before plugins that only mention the word.
    const named = await f.service.browse({ providerId: 'claude', query: 'plugin-74' }, f.scope);
    expect(named.ok && named.value.entries[0]?.name).toBe('plugin-74');
    expect(f.listAvailablePlugins).toHaveBeenCalledTimes(1);
    await f.service.browse({ providerId: 'claude', refresh: true }, f.scope);
    expect(f.listAvailablePlugins).toHaveBeenCalledTimes(2);
  });

  it('announces a change and reads the marketplaces again after it', async () => {
    const f = await hostFixture();
    const changed = vi.fn();
    const stop = f.service.onChanged(changed);
    await f.service.browse({ providerId: 'claude' }, f.scope);
    await f.service.manageHost({ ...f.command, action: 'plugin-install', target: 'plugin-01@odd' }, f.scope);
    expect(changed).toHaveBeenCalledWith('claude');
    await f.service.browse({ providerId: 'claude' }, f.scope);
    expect(f.listAvailablePlugins).toHaveBeenCalledTimes(2);
    stop();
  });

  it('refuses every read and change while the program is being updated', async () => {
    const f = await hostFixture();
    f.setUpdating(true);
    expect(await f.service.listHost({ providerId: 'claude' }, f.scope)).toMatchObject({ ok: false, code: 'unavailable' });
    expect(await f.service.browse({ providerId: 'claude' }, f.scope)).toMatchObject({ ok: false, code: 'unavailable' });
    expect(await f.service.manageHost({ ...f.command, action: 'plugin-disable', target: 'tool@market' }, f.scope)).toMatchObject({ ok: false, code: 'unavailable' });
    expect(f.manageExtension).not.toHaveBeenCalled();
  });
});
