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
