// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanningResultRecord } from '../shared/planning-result';
import { PlanningIntegrationStatus, PlanningResultDetails, type PlanningResultReader } from './PlanningResultDetails';
import { planningExecutionFixture } from './planning-execution-fixtures';

vi.mock('./i18n', () => ({ useAppTranslation: () => ({ i18n: { language: 'en' } }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
const saved: PlanningResultRecord = { version: 1, projectId: 'project-test', runId: 'run-test', taskId: 'task-test', attemptId: 'attempt-test', baselineFingerprint: 'a'.repeat(64), artifacts: [{artifactId: 'artifact-test', revision: 1}], rootPath: 'C:/result/workspace', baseCommit: 'a'.repeat(40), commit: 'b'.repeat(40), changedPaths: ['src/result.ts'], validations: [{validationId: 'validation-test', status: 'passed', exitCode: 0, logRefs: ['log-test'], summary: 'Required tests passed'}] };
const click = async (name: string): Promise<void> => {
  const button = [...document.querySelectorAll('button')].find((entry) => entry.textContent === name);
  if (!button) throw new Error(`Missing button: ${name}`);
  await act(async () => button.click());
};

describe('saved planning results', () => {
  it('offers device evidence only for the frozen device check and binds the exact attempt artifacts', async () => {
    const run = { ...planningExecutionFixture().execution.runs[0], runId: saved.runId };
    run.preparation.tasks[0].taskId = saved.taskId;
    run.preparation.tasks[0].validations = [{validationId: 'device-check', method: 'device', environment: 'Android 15', acceptanceIds: ['acceptance-1']}];
    const read = vi.fn<PlanningResultReader>(async () => ({ok:true,kind:'attempt',result:{...saved,validations:[{validationId:'device-check',status:'not-run',logRefs:[],summary:'Device evidence required'},{validationId:'not-device',status:'not-run',logRefs:[],summary:'Command pending'}]}}));
    await act(async () => root.render(<PlanningResultDetails selection={{kind:'attempt',projectId:saved.projectId,attemptId:saved.attemptId}} read={read} executionRuns={[run]} onRecordDeviceEvidence={async () => true} onClose={() => undefined} disabled={false} />));
    expect([...document.querySelectorAll('button')].filter(entry => entry.textContent === 'Attach device evidence')).toHaveLength(1);
    await click('Attach device evidence');
    const form = document.querySelector('form[aria-label="Device validation evidence"]')!;
    expect(form.textContent).toContain('attempt-test · artifact-test');
    expect(form.textContent).toContain('Android 15');
    expect(form.textContent).toContain(saved.baselineFingerprint);
  });
  it('reads stored device captures by hash and identifies their user supplied provenance', async () => {
    const hash = 'd'.repeat(64);
    const read = vi.fn<PlanningResultReader>(async query => query.kind === 'capture' ? {ok:true,kind:'capture',mimeType:'image/png',dataBase64:'AQID'} : {ok:true,kind:'attempt',result:{...saved,validations:[{...saved.validations[0],device:{provenance:'user-attested',proofId:'c'.repeat(64),principalId:'desktop-user',deviceId:'pixel-8',platformVersion:'Android 15',appVersion:'2.0.0',command:'maestro smoke.yaml',exitCode:0,startedAt:'2026-10-13T00:00:00.000Z',finishedAt:'2026-10-13T00:05:00.000Z',captureRefs:['host-private-path'],captureHash:hash,logHash:'e'.repeat(64)}}]}});
    await act(async () => root.render(<PlanningResultDetails selection={{kind:'attempt',projectId:saved.projectId,attemptId:saved.attemptId}} read={read} onClose={() => undefined} disabled={false} />));
    expect(document.body.textContent).toContain('Performed and attested by the user');
    await click('View saved device capture');
    expect(read).toHaveBeenCalledWith({kind:'capture',projectId:saved.projectId,reference:hash});
    expect(document.body.textContent).not.toContain('host-private-path');
    expect(document.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AQID');
  });
  it('queries exact saved artifact diff and log identities without passing renderer paths to the host', async () => {
    const read = vi.fn<PlanningResultReader>(async (query) => {
      if (query.kind === 'attempt') return {ok: true, kind: 'attempt', result: saved};
      if (query.kind === 'diff') return {ok: true, kind: 'diff', text: '+ exact committed change'};
      if (query.kind === 'log') return {ok: true, kind: 'log', text: 'Required tests passed\nexit 0'};
      return {ok: false, message: 'Unexpected request'};
    });
    await act(async () => root.render(<PlanningResultDetails selection={{kind: 'attempt', projectId: saved.projectId, attemptId: saved.attemptId}} read={read} onClose={() => undefined} disabled={false} />));
    await click('View frozen result diff');
    expect(read).toHaveBeenCalledWith({kind: 'diff', projectId: saved.projectId, attemptId: saved.attemptId});
    expect(document.body.textContent).toContain('+ exact committed change');
    await click('Validation log 1');
    expect(read).toHaveBeenCalledWith({kind: 'log', projectId: saved.projectId, reference: 'log-test'});
    expect(document.body.textContent).toContain('Required tests passed\nexit 0');
  });
  it('does not infer integration success from the existence of a reviewed run', async () => {
    const read = vi.fn<PlanningResultReader>(async () => ({ok: true, kind: 'integration', integration: null}));
    await act(async () => root.render(<PlanningIntegrationStatus projectId="project-test" runId="reviewed-run" revision={5} read={read} onOpen={() => undefined} disabled={false} />));
    expect(container.textContent).toContain('Integration not confirmed');
    expect(container.textContent).not.toContain('Integration passed');
    expect(container.textContent).not.toContain('Successful revision');
  });
  it('keeps a previous successful revision distinct from a failed integration candidate', async () => {
    const read = vi.fn<PlanningResultReader>(async () => ({ok: true, kind: 'integration', integration: {version: 1, projectId: 'project-test', runId: 'run-test', inputFingerprint: 'a'.repeat(64), status: 'failed', inputArtifacts: [], workspacePath: 'C:/integration', candidateCommit: 'b'.repeat(40), previousSuccessfulCommit: 'c'.repeat(40), validations: [], error: 'Integration tests failed'}}));
    await act(async () => root.render(<PlanningIntegrationStatus projectId="project-test" runId="run-test" revision={5} read={read} onOpen={() => undefined} disabled={false} />));
    expect(container.textContent).toContain('Integration failed');
    expect(container.textContent).toContain(`Previous successful revision: ${'c'.repeat(40)}`);
    expect(container.textContent).not.toContain('Integration passed');
    expect(container.textContent).not.toContain('b'.repeat(40));
  });
  it('shows unavailable evidence as an error and never presents a fabricated pass', async () => {
    const read = vi.fn<PlanningResultReader>(async () => ({ok: false, message: 'Result workspace unavailable'}));
    await act(async () => root.render(<PlanningResultDetails selection={{kind: 'attempt', projectId: saved.projectId, attemptId: saved.attemptId}} read={read} onClose={() => undefined} disabled={false} />));
    expect(document.body.textContent).toContain('Result workspace unavailable');
    expect(document.body.textContent).not.toContain('Required tests passed');
  });
});
