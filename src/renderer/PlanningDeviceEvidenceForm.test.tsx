// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanningDeviceEvidenceForm, type PlanningDeviceEvidenceTarget } from './PlanningDeviceEvidenceForm';
import { PlanningDeviceEvidenceInputSchema, type PlanningDeviceEvidenceInput } from '../shared/planning-device-evidence';

vi.mock('./i18n', () => ({useAppTranslation: () => ({i18n: {language: 'en'}})}));
(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const target: PlanningDeviceEvidenceTarget = {scope: 'attempt',runId: 'run-test',taskId: 'task-test',validationId: 'device-test',baselineFingerprint: 'a'.repeat(64),attemptId: 'attempt-test',artifactIds: ['artifact-exact'],environment: 'Android 15',command: 'maestro test smoke.yaml'};
beforeEach(() => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  vi.stubGlobal('FileReader', class { result = 'data:image/png;base64,AQID'; onload?: () => void; readAsDataURL(): void { this.onload?.(); } });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function fill(label: string, value: string): Promise<void> {
  const element = [...container.querySelectorAll('label')].find(entry => entry.textContent?.replace('*','').trim() === label)!;
  const control = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[id="${element.htmlFor}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(control.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(control,value);
    control.dispatchEvent(new Event('input',{bubbles:true}));
  });
}
async function complete(): Promise<void> {
  await fill('Device identifier','pixel-8-usb'); await fill('OS and version','Android 15'); await fill('Installed app version','2.0.0-test');
  await fill('Exit code','0'); await fill('Started at · device local time','2026-10-13T10:00'); await fill('Finished at · device local time','2026-10-13T10:05');
  await fill('Result summary','Chat and terminal passed on device'); await fill('Execution log · up to 512 KiB','Flow smoke passed, exit 0');
  const file = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(file,'files',{value:[new File(['capture'],'capture.png',{type:'image/png'})],configurable:true});
  await act(async () => file.dispatchEvent(new Event('change',{bubbles:true})));
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
}
describe('device evidence submission', () => {
  it('requires manual attestation and sends the exact saved result identity with actual input', async () => {
    const submit = vi.fn<(value: PlanningDeviceEvidenceInput) => Promise<boolean>>(async value => { PlanningDeviceEvidenceInputSchema.parse(value); return true; });
    await act(async () => root.render(<PlanningDeviceEvidenceForm target={target} disabled={false} onSubmit={submit} onCancel={() => undefined} />));
    expect(container.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
    expect(submit).not.toHaveBeenCalled();
    await complete();
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0][0]).toMatchObject({scope:'attempt',attemptId:'attempt-test',artifactIds:['artifact-exact'],baselineFingerprint:'a'.repeat(64),deviceId:'pixel-8-usb',exitCode:0,attest:true,capture:{mimeType:'image/png',dataBase64:'AQID'}});
    expect(submit.mock.calls[0][0].startedAt).toBe(new Date('2026-10-13T10:00').toISOString());
  });
  it('retains the log and capture when the host cannot confirm the request', async () => {
    const submit = vi.fn(async () => false);
    await act(async () => root.render(<PlanningDeviceEvidenceForm target={target} disabled={false} onSubmit={submit} onCancel={() => undefined} />));
    await complete();
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    expect(container.textContent).toContain('Your input has been retained.');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AQID');
    expect([...container.querySelectorAll('textarea')].map(entry => entry.value)).toContain('Flow smoke passed, exit 0');
  });
  it('rejects an oversized capture before it can enter the pending command', async () => {
    const submit = vi.fn(async () => true);
    await act(async () => root.render(<PlanningDeviceEvidenceForm target={target} disabled={false} onSubmit={submit} onCancel={() => undefined} />));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input,'files',{value:[new File([new Uint8Array(512*1024+1)],'large.png',{type:'image/png'})]});
    await act(async () => input.dispatchEvent(new Event('change',{bubbles:true})));
    expect(container.textContent).toContain('no larger than 512 KiB');
    expect(container.querySelector('img')).toBeNull(); expect(submit).not.toHaveBeenCalled();
  });
});
