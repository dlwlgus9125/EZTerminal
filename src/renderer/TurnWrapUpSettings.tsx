import { useEffect, useId, useState } from 'react';

import type { TurnWrapUpPause, TurnWrapUpSettings as WrapUpSettings } from '../shared/turn-wrap-up';
import type { TurnWrapUpAccess } from './capability-access';
import { useAppTranslation } from './i18n';
import { Status, Switch } from './ui';
import { Glyph } from './ui/Glyph';
import './chat/wrap-up/wrap-up.css';

/** When automatic calls come back: the time for a 5-hour window, the day and time for a weekly one. */
function resumeText(pause: TurnWrapUpPause & { readonly resetsAt: number }, ko: boolean): string {
  const date = new Date(pause.resetsAt);
  const locale = ko ? 'ko-KR' : 'en-US';
  return pause.window === 'five-hour'
    ? date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false })
    : date.toLocaleString(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}

function pauseText(pause: TurnWrapUpPause, ko: boolean): string {
  const provider = pause.providerId === 'codex' ? 'Codex' : pause.providerId === 'claude' ? 'Claude' : pause.providerId;
  const window = pause.window === 'weekly' ? (ko ? '주간' : 'weekly') : (ko ? '5시간' : '5-hour');
  const resetsAt = pause.resetsAt;
  const again = resetsAt === undefined ? '' : ko
    ? ` (${resumeText({ ...pause, resetsAt }, ko)}에 다시)` : ` (again at ${resumeText({ ...pause, resetsAt }, ko)})`;
  return ko
    ? `지금 ${provider} ${window} 사용량 ${String(pause.usedPercent)}% — 자동 호출을 멈췄습니다${again}`
    : `${provider}’s ${window} usage is at ${String(pause.usedPercent)}% — automatic calls are paused${again}`;
}

/**
 * Settings › 에이전트 › 턴 마무리: what the app asks the AI for when a turn ends — next-prompt
 * suggestions per AI (Claude sends its own with the answer; Codex needs one more read-only call), recap cards and
 * suggested tasks — and the pause of the automatic calls near a usage limit, with a pause in force said in words.
 * The AI only proposes: nothing here runs anything on its own.
 */
export function TurnWrapUpSettings({ access }: { readonly access: TurnWrapUpAccess }): JSX.Element {
  const { i18n } = useAppTranslation();
  const ko = (i18n.resolvedLanguage ?? i18n.language).startsWith('ko');
  const text = (korean: string, english: string): string => (ko ? korean : english);
  const titleId = useId();
  const [settings, setSettings] = useState<WrapUpSettings | null>(null);
  const [paused, setPaused] = useState<readonly TurnWrapUpPause[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    void access.load().then((state) => {
      if (!alive) return;
      setSettings(state.settings);
      setPaused(state.paused);
    }, () => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [access]);
  const save = (next: WrapUpSettings): void => {
    const previous = settings;
    setSettings(next);
    setFailed(false);
    void access.save(next).then(setSettings, () => { setSettings(previous); setFailed(true); });
  };
  return (
    <section className="status-section turn-wrap-up-settings" aria-labelledby={titleId} data-testid="turn-wrap-up-settings">
      <div>
        <h2 className="status-section-title" id={titleId}>{text('턴 마무리', 'Turn wrap-up')}</h2>
        <p className="settings-hint">{text(
          '턴이 끝나면 AI가 다음에 할 말과 할 일을 제안합니다. 누르기 전에는 아무것도 보내거나 실행하지 않습니다.',
          'When a turn ends, the AI suggests what to say or do next. Nothing is sent or run until you press it.',
        )}</p>
      </div>
      {settings && (
        <>
          <fieldset className="turn-wrap-up-settings__group">
            <legend>{text('다음 입력 제안', 'Next-prompt suggestion')}</legend>
            <Switch
              checked={settings.suggestions.claude}
              onChange={(event) => save({ ...settings, suggestions: { ...settings.suggestions, claude: event.target.checked } })}
              label="Claude"
              description={text(
                '턴이 끝나고 몇 초 뒤 · 대화 캐시를 다시 쓰는 작은 호출 · 첫 턴과 계획 모드에는 없음',
                'Shows a few seconds after a turn ends · a small call that reuses the conversation’s cache · none after the first turn or in plan mode',
              )}
              data-testid="turn-wrap-up-suggestions-claude"
            />
            <Switch
              checked={settings.suggestions.codex}
              onChange={(event) => save({ ...settings, suggestions: { ...settings.suggestions, codex: event.target.checked } })}
              label="Codex"
              description={text(
                '턴이 끝나고 10초쯤 뒤 · 대화 캐시를 다시 쓰는 읽기 전용 호출 · 절반쯤은 제안 없음',
                'Shows about 10 s after a turn ends · a read-only call that reuses the conversation’s cache · about half the time none',
              )}
              data-testid="turn-wrap-up-suggestions-codex"
            />
          </fieldset>
          <Switch
            checked={settings.recaps}
            onChange={(event) => save({ ...settings, recaps: event.target.checked })}
            label={text('요약 카드', 'Recap card')}
            description={text(
              '아무 화면도 그 대화를 보지 않을 때 턴이 끝나거나 AI가 멈춰 기다리면 3–4줄로 정리합니다. 턴마다 한 번만, 작은 호출 한 번',
              'When no screen shows the conversation and a turn ends or the AI stops to wait, it sums the turn up in 3–4 lines. Once per turn, one small call',
            )}
            data-testid="turn-wrap-up-recaps"
          />
          <Switch
            checked={settings.tasks}
            onChange={(event) => save({ ...settings, tasks: event.target.checked })}
            label={text('제안 작업', 'Suggested tasks')}
            description={text(
              'AI가 맡은 일 밖에서 본 일을 카드로 제안합니다. AI 턴 안에서 제안하므로 따로 부르는 호출이 없습니다. 누르기 전에는 아무것도 실행하지 않습니다',
              'The AI suggests, as a card, work it noticed outside its task. It does so within its own turn, so there is no separate call. Nothing runs until you press it',
            )}
            data-testid="turn-wrap-up-tasks"
          />
          <Switch
            checked={settings.pauseNearLimit}
            onChange={(event) => save({ ...settings, pauseNearLimit: event.target.checked })}
            label={text('한도 근처 멈춤', 'Pause near the limit')}
            description={text(
              '사용량이 90% 이상이면 자동 호출(다음 입력 제안·요약)을 멈춥니다',
              'At 90% usage or more, the automatic calls (next-prompt suggestions, recaps) stop',
            )}
            data-testid="turn-wrap-up-pause"
          />
          {settings.pauseNearLimit && paused.map((pause) => (
            <p key={`${pause.providerId}:${pause.window}`} className="turn-wrap-up-settings__paused" role="status" data-testid="turn-wrap-up-paused">
              <Glyph name="pause" />
              <span>{pauseText(pause, ko)}</span>
            </p>
          ))}
        </>
      )}
      {failed && <Status variant="danger" live="assertive">{text('턴 마무리 설정을 읽거나 저장하지 못했습니다.', 'The turn wrap-up settings could not be read or saved.')}</Status>}
    </section>
  );
}
