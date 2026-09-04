import { Activity, ChevronDown, Play, Save } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

import type { DaemonHeartbeat } from '../shared/daemon-protocol';
import { useAppTranslation } from './i18n';
import type { StructuredAgentUiResult } from './StructuredAgentSession';
import { Button, Field, Input, Switch } from './ui';

interface HeartbeatCopy {
  readonly title: string;
  readonly description: string;
  readonly off: string;
  readonly on: string;
  readonly paused: string;
  readonly pending: string;
  readonly next: string;
  readonly prompt: string;
  readonly promptPlaceholder: string;
  readonly cron: string;
  readonly cronHint: string;
  readonly timezone: string;
  readonly enabled: string;
  readonly enabledHint: string;
  readonly save: string;
  readonly saving: string;
  readonly runNow: string;
  readonly running: string;
  readonly required: string;
  readonly hostTitle: string;
  readonly hostDescription: string;
  readonly cancel: string;
  readonly enableHost: string;
  readonly enablingHost: string;
  readonly saveFailed: string;
  readonly runFailed: string;
  readonly hostFailed: string;
  readonly defaultPrompt: string;
}

const COPY: Readonly<Record<'en' | 'ko', HeartbeatCopy>> = {
  en: {
    title: 'Heartbeat',
    description: 'Send a recurring check-in to this Agent session.',
    off: 'Off',
    on: 'Active',
    paused: 'Host paused',
    pending: 'One check-in is waiting for the current turn.',
    next: 'Next: {{time}}',
    prompt: 'Check-in prompt',
    promptPlaceholder: 'Describe what this Agent should check each time…',
    cron: 'Schedule',
    cronHint: 'Five-field cron, for example */15 * * * *',
    timezone: 'Timezone',
    enabled: 'Enable heartbeat',
    enabledHint: 'Busy sessions coalesce repeated ticks into one pending check-in.',
    save: 'Save heartbeat',
    saving: 'Saving heartbeat',
    runNow: 'Run now',
    running: 'Starting heartbeat',
    required: 'Prompt, five-field cron, and timezone are required.',
    hostTitle: 'Keep automation available?',
    hostDescription: 'Heartbeat needs Keep running and Start at login. EZTerminal will enable both before saving.',
    cancel: 'Not now',
    enableHost: 'Enable & save',
    enablingHost: 'Enabling background host',
    saveFailed: 'The heartbeat could not be saved.',
    runFailed: 'The heartbeat could not be started.',
    hostFailed: 'The background Agent host could not be enabled.',
    defaultPrompt: 'Check this workspace for meaningful changes or blockers and report only what needs attention.',
  },
  ko: {
    title: '하트비트',
    description: '이 Agent 세션에 정기 확인 메시지를 보냅니다.',
    off: '꺼짐',
    on: '실행 중',
    paused: '호스트 일시 중지',
    pending: '현재 작업이 끝나면 실행할 확인 메시지 1개가 대기 중입니다.',
    next: '다음 실행: {{time}}',
    prompt: '확인 메시지',
    promptPlaceholder: '매번 Agent가 확인할 내용을 입력하세요…',
    cron: '일정',
    cronHint: '5필드 cron 형식. 예: */15 * * * *',
    timezone: '시간대',
    enabled: '하트비트 사용',
    enabledHint: '세션이 작업 중이면 여러 실행 시점을 대기 메시지 1개로 합칩니다.',
    save: '하트비트 저장',
    saving: '하트비트 저장 중',
    runNow: '지금 실행',
    running: '하트비트 시작 중',
    required: '확인 메시지, 5필드 cron, 시간대를 모두 입력하세요.',
    hostTitle: '자동화를 계속 실행할까요?',
    hostDescription: '하트비트에는 창을 닫아도 계속 실행과 로그인할 때 시작이 필요합니다. 저장 전에 두 설정을 켭니다.',
    cancel: '나중에',
    enableHost: '호스트 켜고 저장',
    enablingHost: '백그라운드 호스트 켜는 중',
    saveFailed: '하트비트를 저장하지 못했습니다.',
    runFailed: '하트비트를 시작하지 못했습니다.',
    hostFailed: '백그라운드 Agent 호스트를 켜지 못했습니다.',
    defaultPrompt: '이 workspace의 의미 있는 변경이나 막힌 점을 확인하고 주의가 필요한 내용만 보고하세요.',
  },
};

export interface StructuredAgentHeartbeatInput {
  readonly prompt: string;
  readonly cron: string;
  readonly timezone: string;
  readonly enabled: boolean;
}

export interface StructuredAgentHeartbeatProps {
  readonly sessionId: string;
  readonly value?: DaemonHeartbeat;
  readonly automationReady: boolean;
  readonly disabled?: boolean;
  readonly onSave: (input: StructuredAgentHeartbeatInput) => Promise<StructuredAgentUiResult>;
  readonly onRunNow: () => Promise<StructuredAgentUiResult>;
  readonly onEnableHost: () => Promise<StructuredAgentUiResult>;
}

function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function displayTime(value: string, locale: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
  } catch {
    return value;
  }
}

function template(value: string, key: string, replacement: string): string {
  return value.replace(`{{${key}}}`, replacement);
}

export function StructuredAgentHeartbeat({
  sessionId,
  value,
  automationReady,
  disabled = false,
  onSave,
  onRunNow,
  onEnableHost,
}: StructuredAgentHeartbeatProps): JSX.Element {
  const { i18n } = useAppTranslation();
  const language = (i18n.resolvedLanguage ?? i18n.language).startsWith('ko') ? 'ko' : 'en';
  const copy = COPY[language];
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState(value?.prompt ?? copy.defaultPrompt);
  const [cron, setCron] = useState(value?.cron ?? '*/15 * * * *');
  const [timezone, setTimezone] = useState(value?.timezone ?? localTimezone());
  const [enabled, setEnabled] = useState(value?.enabled ?? false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<'save' | 'run' | 'host' | null>(null);
  const [confirmHost, setConfirmHost] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latestValueRef = useRef(value);
  const latestDefaultPromptRef = useRef(copy.defaultPrompt);
  latestValueRef.current = value;
  latestDefaultPromptRef.current = copy.defaultPrompt;

  useEffect(() => {
    const sessionValue = latestValueRef.current;
    setOpen(false);
    setPrompt(sessionValue?.prompt ?? latestDefaultPromptRef.current);
    setCron(sessionValue?.cron ?? '*/15 * * * *');
    setTimezone(sessionValue?.timezone ?? localTimezone());
    setEnabled(sessionValue?.enabled ?? false);
    setDirty(false);
    setBusy(null);
    setConfirmHost(false);
    setError(null);
  }, [sessionId]);

  useEffect(() => {
    if (dirty || busy !== null) return;
    setPrompt(value?.prompt ?? copy.defaultPrompt);
    setCron(value?.cron ?? '*/15 * * * *');
    setTimezone(value?.timezone ?? localTimezone());
    setEnabled(value?.enabled ?? false);
  }, [
    busy,
    copy.defaultPrompt,
    dirty,
    value?.cron,
    value?.enabled,
    value?.prompt,
    value?.revision,
    value?.timezone,
  ]);

  const input = (): StructuredAgentHeartbeatInput => ({
    prompt: prompt.trim(),
    cron: cron.trim(),
    timezone: timezone.trim(),
    enabled,
  });

  const valid = prompt.trim().length > 0 && cron.trim().split(/\s+/u).length === 5 && timezone.trim().length > 0;

  const persist = async (): Promise<void> => {
    if (!valid || busy !== null || disabled) {
      if (!valid) setError(copy.required);
      return;
    }
    setConfirmHost(false);
    setError(null);
    setBusy('save');
    const result = await onSave(input()).catch((): StructuredAgentUiResult => ({
      ok: false,
      message: copy.saveFailed,
    }));
    setBusy(null);
    if (result.ok) setDirty(false);
    else setError(result.message);
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!valid) {
      setError(copy.required);
      return;
    }
    if (enabled && !automationReady) {
      setError(null);
      setConfirmHost(true);
      return;
    }
    void persist();
  };

  const enableHostAndPersist = async (): Promise<void> => {
    if (busy !== null || disabled) return;
    setError(null);
    setBusy('host');
    const hostResult = await onEnableHost().catch((): StructuredAgentUiResult => ({
      ok: false,
      message: copy.hostFailed,
    }));
    if (!hostResult.ok) {
      setBusy(null);
      setError(hostResult.message);
      return;
    }
    const result = await onSave(input()).catch((): StructuredAgentUiResult => ({
      ok: false,
      message: copy.saveFailed,
    }));
    setBusy(null);
    setConfirmHost(false);
    if (result.ok) setDirty(false);
    else setError(result.message);
  };

  const runNow = async (): Promise<void> => {
    if (busy !== null || disabled || !value?.enabled || !automationReady) return;
    setError(null);
    setBusy('run');
    const result = await onRunNow().catch((): StructuredAgentUiResult => ({
      ok: false,
      message: copy.runFailed,
    }));
    setBusy(null);
    if (!result.ok) setError(result.message);
  };

  const status = value?.enabled
    ? automationReady ? copy.on : copy.paused
    : copy.off;

  return (
    <section className="structured-agent-heartbeat" data-enabled={value?.enabled || undefined} data-testid="structured-agent-heartbeat">
      <button
        type="button"
        className="structured-agent-heartbeat__summary"
        aria-expanded={open}
        aria-controls={formId}
        onClick={() => setOpen((current) => !current)}
      >
        <Activity aria-hidden="true" />
        <span className="structured-agent-heartbeat__identity">
          <strong>{copy.title}</strong>
          <small>{copy.description}</small>
        </span>
        <span className="structured-agent-heartbeat__status">
          <strong>{status}</strong>
          {value?.pending
            ? <small>{copy.pending}</small>
            : value?.nextRunAt
              ? <small>{template(copy.next, 'time', displayTime(value.nextRunAt, i18n.language))}</small>
              : null}
        </span>
        <ChevronDown aria-hidden="true" />
      </button>

      {open && (
        <form id={formId} className="structured-agent-heartbeat__form" onSubmit={submit} noValidate>
          <Field label={copy.prompt} className="structured-agent-heartbeat__prompt">
            <textarea
              className="structured-agent-textarea"
              rows={2}
              maxLength={65_536}
              value={prompt}
              disabled={disabled || busy !== null}
              placeholder={copy.promptPlaceholder}
              onChange={(event) => {
                setPrompt(event.currentTarget.value);
                setDirty(true);
                setError(null);
              }}
              data-testid="structured-agent-heartbeat-prompt"
            />
          </Field>
          <Field label={copy.cron} description={copy.cronHint}>
            <Input
              value={cron}
              disabled={disabled || busy !== null}
              spellCheck={false}
              onChange={(event) => {
                setCron(event.currentTarget.value);
                setDirty(true);
                setError(null);
              }}
              data-testid="structured-agent-heartbeat-cron"
            />
          </Field>
          <Field label={copy.timezone}>
            <Input
              value={timezone}
              disabled={disabled || busy !== null}
              spellCheck={false}
              onChange={(event) => {
                setTimezone(event.currentTarget.value);
                setDirty(true);
                setError(null);
              }}
              data-testid="structured-agent-heartbeat-timezone"
            />
          </Field>
          <Switch
            checked={enabled}
            disabled={disabled || busy !== null}
            label={copy.enabled}
            description={copy.enabledHint}
            onChange={(event) => {
              setEnabled(event.currentTarget.checked);
              setDirty(true);
              setConfirmHost(false);
              setError(null);
            }}
            data-testid="structured-agent-heartbeat-enabled"
          />

          {confirmHost && (
            <div className="structured-agent-heartbeat__host-confirm" role="alert" data-testid="structured-agent-heartbeat-host-confirm">
              <div>
                <strong>{copy.hostTitle}</strong>
                <p>{copy.hostDescription}</p>
              </div>
              <div>
                <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirmHost(false)}>
                  {copy.cancel}
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  loading={busy === 'host'}
                  loadingLabel={copy.enablingHost}
                  disabled={busy !== null}
                  onClick={() => void enableHostAndPersist()}
                  data-testid="structured-agent-heartbeat-enable-host"
                >
                  {copy.enableHost}
                </Button>
              </div>
            </div>
          )}

          {error && <p className="structured-agent__form-error" role="alert">{error}</p>}
          <div className="structured-agent-heartbeat__actions">
            {value?.enabled && automationReady && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                leadingIcon={<Play />}
                loading={busy === 'run'}
                loadingLabel={copy.running}
                disabled={disabled || busy !== null}
                onClick={() => void runNow()}
                data-testid="structured-agent-heartbeat-run"
              >
                {copy.runNow}
              </Button>
            )}
            <Button
              type="submit"
              variant="primary"
              size="sm"
              leadingIcon={<Save />}
              loading={busy === 'save'}
              loadingLabel={copy.saving}
              disabled={disabled || busy !== null || (!dirty && value !== undefined)}
              data-testid="structured-agent-heartbeat-save"
            >
              {copy.save}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
