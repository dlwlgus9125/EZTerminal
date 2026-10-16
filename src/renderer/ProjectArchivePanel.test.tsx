// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectArchiveInventory, ProjectArchiveManifest } from '../shared/project-archive';
import { ProjectArchivePanel, type ProjectArchiveAccess } from './ProjectArchivePanel';

vi.mock('./i18n', () => ({ useAppTranslation: () => ({ i18n: { language: 'en' } }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const inventory: ProjectArchiveInventory = {projectId:'project-test',token:'a'.repeat(64),revision:8,groups:[{kind:'transcript',items:5,bytes:1000}],conversations:[{sessionId:'archived-chat',title:'Archived conversation',items:3,bytes:600,deletable:true},{sessionId:'active-chat',title:'Active conversation',items:2,bytes:400,deletable:false,protection:'Active session'}]};
const manifest: ProjectArchiveManifest = {version:1,createdAt:'2026-10-13T00:00:00.000Z',projectId:'source-project',projectName:'Archived project',source:{planningRevision:2,daemonRevision:7,executionRevision:4},entries:[],exclusions:[{item:'Credentials',reason:'Machine-local secrets'}],portable:true,notes:[],integrity:'b'.repeat(64)};
const button = (name: string): HTMLButtonElement => { const match = [...document.querySelectorAll('button')].find((entry)=>entry.textContent === name); if (!match) throw new Error(`Missing ${name}`); return match; };
const click = async (name: string): Promise<void> => { await act(async () => button(name).click()); };
describe('project archive safety boundaries', () => {
  it('retains the exact export request after an uncertain outcome and persists it before sending', async () => {
    const persisted: unknown[] = [];
    const execute = vi.fn<ProjectArchiveAccess['executeProjectArchive']>(async (request) => {
      if (request.type === 'inventory') return {ok:true,kind:'inventory',inventory};
      expect(persisted.at(-1)).toEqual(request);
      throw new Error('Connection lost');
    });
    await act(async () => root.render(<ProjectArchivePanel projectId="project-test" access={{executeProjectArchive:execute}} disabled={false} persistPendingRequest={async(request)=>{persisted.push(request);}} />));
    await click('Export project records');
    expect(button('Export project records').disabled).toBe(true);
    const first = execute.mock.calls.find(([request])=>request.type === 'export')![0];
    await click('Check archive request');
    expect(execute.mock.calls.at(-1)![0]).toEqual(first);
  });
  it('does not export when durable request persistence fails', async () => {
    const execute = vi.fn<ProjectArchiveAccess['executeProjectArchive']>(async()=>({ok:true,kind:'inventory',inventory}));
    await act(async () => root.render(<ProjectArchivePanel projectId="project-test" access={{executeProjectArchive:execute}} disabled={false} persistPendingRequest={async()=>{throw new Error('Encrypted draft store unavailable');}} />));
    await click('Export project records');
    expect(execute.mock.calls.every(([request])=>request.type === 'inventory')).toBe(true);
    expect(container.textContent).toContain('Encrypted draft store unavailable');
  });
  it('sends only explicitly selected deletable records with the exact inventory token after in-app confirmation', async () => {
    const execute = vi.fn<ProjectArchiveAccess['executeProjectArchive']>(async (request) => request.type === 'cleanup' ? {ok:true,kind:'cleanup',removedItems:3} : {ok:true,kind:'inventory',inventory});
    await act(async () => root.render(<ProjectArchivePanel projectId="project-test" access={{executeProjectArchive:execute}} disabled={false} />));
    const checkboxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(checkboxes[1].disabled).toBe(true);
    await act(async () => checkboxes[0].click());
    await click('Clean selected records');
    expect(execute.mock.calls.some(([request]) => request.type === 'cleanup')).toBe(false);
    expect(button('Permanently remove records').disabled).toBe(true);
    const confirmation = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')!;
    await act(async () => confirmation.click());
    await click('Permanently remove records');
    expect(execute).toHaveBeenCalledWith({type:'cleanup',projectId:'project-test',inventoryToken:inventory.token,sessionIds:['archived-chat'],confirmation:'delete-selected-archived-history'});
  });
  it('inspects exclusions before a separate restore request and never restores on package selection', async () => {
    const execute = vi.fn<ProjectArchiveAccess['executeProjectArchive']>(async (request) => request.type === 'inspect' ? {ok:true,kind:'inspect',archiveId:'opaque-archive',manifest} : {ok:true,kind:'inventory',inventory});
    await act(async () => root.render(<ProjectArchivePanel projectId="project-test" access={{executeProjectArchive:execute}} disabled={false} />));
    await click('Choose and inspect package');
    expect(container.textContent).toContain('Machine-local secrets');
    expect(execute.mock.calls.some(([request]) => request.type === 'restore')).toBe(false);
    expect(button('Restore as new project').disabled).toBe(false);
  });
  it('does not read or mutate host records while disconnected', async () => {
    const execute = vi.fn<ProjectArchiveAccess['executeProjectArchive']>();
    await act(async () => root.render(<ProjectArchivePanel projectId="project-test" access={{executeProjectArchive:execute}} disabled />));
    expect(execute).not.toHaveBeenCalled();
    expect(button('Choose and inspect package').disabled).toBe(true);
  });
});
