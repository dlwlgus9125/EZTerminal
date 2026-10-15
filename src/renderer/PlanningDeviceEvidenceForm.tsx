import { useId, useState, type FormEvent } from 'react';
import {
  DEVICE_EVIDENCE_MAX_ITEM_BYTES,
  PlanningDeviceEvidenceInputSchema,
  type PlanningDeviceEvidenceInput,
} from '../shared/planning-device-evidence';
import { useAppTranslation } from './i18n';
import { Button, Field, Input } from './ui';

export type PlanningDeviceEvidenceTarget = {
  runId: string;
  taskId: string;
  validationId: string;
  baselineFingerprint: string;
  environment: string;
  command?: string;
} & ({ scope: 'attempt'; attemptId: string; artifactIds: string[] } | { scope: 'integration'; candidateCommit: string });

export function PlanningDeviceEvidenceForm({ target, disabled, onSubmit, onCancel }: {
  target: PlanningDeviceEvidenceTarget;
  disabled: boolean;
  onSubmit: (input: PlanningDeviceEvidenceInput) => Promise<boolean>;
  onCancel: () => void;
}): JSX.Element {
  const { i18n } = useAppTranslation();
  const korean = (i18n.resolvedLanguage ?? i18n.language).startsWith('ko');
  const text = (ko: string, en: string): string => korean ? ko : en;
  const fieldId = useId();
  const [fields, setFields] = useState({ deviceId: '', platformVersion: '', appVersion: '', command: target.command ?? '', exitCode: '', startedAt: '', finishedAt: '', summary: '', textLog: '' });
  const [capture, setCapture] = useState<PlanningDeviceEvidenceInput['capture'] | null>(null);
  const [attest, setAttest] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = (key: keyof typeof fields, value: string): void => setFields(current => ({ ...current, [key]: value }));
  const chooseCapture = async (file?: File): Promise<void> => {
    if (!file) return;
    setError(null);
    if (file.size > DEVICE_EVIDENCE_MAX_ITEM_BYTES || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError(text('512 KiB 이하의 PNG, JPEG, WebP 캡처를 선택하세요.', 'Choose a PNG, JPEG, or WebP capture no larger than 512 KiB.'));
      return;
    }
    setBusy(true);
    try {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error(text('캡처를 읽지 못했습니다.', 'The capture could not be read.')));
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.readAsDataURL(file);
      });
      setCapture({ mimeType: file.type as PlanningDeviceEvidenceInput['capture']['mimeType'], dataBase64 });
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (disabled || busy) return;
    setError(null);
    const toIso = (value: string): string => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : ''; };
    const identity = { runId: target.runId, taskId: target.taskId, validationId: target.validationId, baselineFingerprint: target.baselineFingerprint, ...(target.scope === 'attempt' ? {scope: target.scope, attemptId: target.attemptId, artifactIds: target.artifactIds} : {scope: target.scope, candidateCommit: target.candidateCommit}) };
    const parsed = PlanningDeviceEvidenceInputSchema.safeParse({ ...identity, ...fields, exitCode: fields.exitCode.trim() ? Number(fields.exitCode) : Number.NaN, startedAt: toIso(fields.startedAt), finishedAt: toIso(fields.finishedAt), capture, attest });
    if (!parsed.success) {
      setError(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('\n'));
      return;
    }
    setBusy(true);
    try {
      if (!(await onSubmit(parsed.data))) setError(text('증빙을 확정하지 못했습니다. 실행 요청의 오류 또는 미확정 상태를 확인하세요. 입력한 내용은 유지됩니다.', 'The evidence was not confirmed. Check the execution request error or unresolved state. Your input has been retained.'));
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const locked = disabled || busy;
  return <form className="planning-workspace__device-evidence" onSubmit={event => void submit(event)} aria-label={text('실기기 검증 증빙', 'Device validation evidence')}>
    <h3>{text('직접 실행한 실기기 검증', 'Device check performed by you')}</h3>
    <p>{text('앱이 직접 실행한 결과와 구분하여 기록합니다. 아래 결과 revision을 기기에 설치하고 실제 실행한 로그와 캡처를 첨부하세요.', 'This is recorded as evidence supplied by you. Install the exact result revision below on your device and attach the log and capture from your actual check.')}</p>
    <dl className="planning-workspace__result-meta"><dt>{text('검증', 'Validation')}</dt><dd>{target.taskId} · {target.validationId}</dd><dt>{text('환경', 'Environment')}</dt><dd>{target.environment}</dd><dt>{text('결과', 'Result')}</dt><dd><code>{target.scope === 'attempt' ? `${target.attemptId} · ${target.artifactIds.join(', ')}` : target.candidateCommit}</code></dd><dt>{text('기준선', 'Baseline')}</dt><dd><code>{target.baselineFingerprint}</code></dd></dl>
    <div className="planning-workspace__form-grid">
      <Field label={text('기기 식별자', 'Device identifier')} required><Input value={fields.deviceId} disabled={locked} onChange={event => update('deviceId', event.target.value)} required /></Field>
      <Field label={text('OS 및 버전', 'OS and version')} required><Input value={fields.platformVersion} disabled={locked} onChange={event => update('platformVersion', event.target.value)} required /></Field>
      <Field label={text('설치한 앱 버전', 'Installed app version')} required><Input value={fields.appVersion} disabled={locked} onChange={event => update('appVersion', event.target.value)} required /></Field>
      <Field label={text('실행 명령 또는 절차', 'Command or procedure')} required><Input value={fields.command} disabled={locked} onChange={event => update('command', event.target.value)} required /></Field>
      <Field label={text('종료 코드', 'Exit code')} required><Input type="number" step={1} value={fields.exitCode} disabled={locked} onChange={event => update('exitCode', event.target.value)} required /></Field>
      <Field label={text('시작 시각 · 기기 현지 시간', 'Started at · device local time')} required><Input type="datetime-local" value={fields.startedAt} disabled={locked} onChange={event => update('startedAt', event.target.value)} required /></Field>
      <Field label={text('종료 시각 · 기기 현지 시간', 'Finished at · device local time')} required><Input type="datetime-local" value={fields.finishedAt} disabled={locked} onChange={event => update('finishedAt', event.target.value)} required /></Field>
    </div>
    <Field id={`${fieldId}-summary`} label={text('결과 요약', 'Result summary')} required><textarea id={`${fieldId}-summary`} rows={3} value={fields.summary} disabled={locked} onChange={event => update('summary', event.target.value)} required /></Field>
    <Field id={`${fieldId}-log`} label={text('실행 로그 · 최대 512 KiB', 'Execution log · up to 512 KiB')} required><textarea id={`${fieldId}-log`} rows={6} value={fields.textLog} disabled={locked} onChange={event => update('textLog', event.target.value)} required /></Field>
    <Field id={`${fieldId}-capture`} label={text('실행 캡처 · 최대 512 KiB', 'Execution capture · up to 512 KiB')} required><input id={`${fieldId}-capture`} type="file" accept="image/png,image/jpeg,image/webp" disabled={locked} onChange={event => { void chooseCapture(event.target.files?.[0]); }} /></Field>
    {capture && <img className="planning-workspace__evidence-capture" src={`data:${capture.mimeType};base64,${capture.dataBase64}`} alt={text('첨부할 실행 캡처', 'Execution capture to attach')} />}
    <p className="planning-workspace__muted">{text('로그와 인코딩한 캡처를 포함한 전체 요청은 700 KiB까지 저장할 수 있습니다.', 'The complete request, including the log and encoded capture, must be no larger than 700 KiB.')}</p>
    <label className="planning-workspace__checkbox"><input type="checkbox" checked={attest} disabled={locked} onChange={event => setAttest(event.target.checked)} />{text('위 결과 revision을 명시한 기기에서 직접 실행했고 첨부한 로그와 캡처가 그 실행 결과임을 확인합니다.', 'I performed this check on the stated device using the exact result revision, and the attached log and capture came from that check.')}</label>
    {error && <p className="planning-workspace__notice" role="alert">{error}</p>}
    <div className="planning-workspace__actions"><Button type="submit" variant="primary" disabled={locked || !attest || !capture}>{busy ? text('저장 중…', 'Saving…') : text('증빙 저장하고 다시 검토', 'Save evidence and review again')}</Button><Button type="button" disabled={busy} onClick={onCancel}>{text('취소', 'Cancel')}</Button></div>
  </form>;
}
