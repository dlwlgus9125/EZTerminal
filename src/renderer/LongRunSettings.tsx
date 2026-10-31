import { useEffect, useId, useState } from 'react';

import type { LongRunSettings as Settings } from '../shared/long-run';
import type { LongRunAccess } from './capability-access';
import { useAppTranslation } from './i18n';
import { Status, Switch } from './ui';
import './chat/long-run/long-run.css';

/** 시안: 한도가 풀리면 자동으로 이어서 하기, with what it sends and where it applies. */
export function LongRunSwitch({ access }: { readonly access: LongRunAccess }): JSX.Element {
  const { i18n } = useAppTranslation();
  const ko = (i18n.resolvedLanguage ?? i18n.language).startsWith('ko');
  const text = (korean: string, english: string): string => (ko ? korean : english);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    void access.load().then((state) => { if (alive) setSettings(state); }, () => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [access]);
  const save = (next: Settings): void => {
    const previous = settings;
    setSettings(next);
    setFailed(false);
    void access.save(next).then(setSettings, () => { setSettings(previous); setFailed(true); });
  };
  return (
    <>
      {settings && (
        <Switch
          checked={settings.autoResume}
          onChange={(event) => save({ ...settings, autoResume: event.target.checked })}
          label={text('한도가 풀리면 자동으로 이어서 하기', 'Continue by itself when a limit lifts')}
          description={text(
            '앱이 그 대화에 "Continue."를 보냅니다. 멈춘 요청은 다시 보내지 않습니다. 사람이 보낸 최상위 대화에만, 리셋 시각을 아는 몇 시간 안의 한도에만 적용합니다. 주간 한도와 시각을 모르는 한도는 먼저 묻고, 하위 대화는 카드에서 이어서 합니다',
            'The app sends “Continue.” to that conversation. Your stopped request is not sent again. This applies only to top-level conversations a person sent, and only to limits that reset within hours at a known time. A weekly limit or an unknown reset asks first, and a sub-conversation continues from its card',
          )}
          data-testid="long-run-auto-resume"
        />
      )}
      {failed && <Status variant="danger" live="assertive">{text('이어서 하기 설정을 읽거나 저장하지 못했습니다.', 'The setting could not be read or saved.')}</Status>}
    </>
  );
}

/**
 * 시안: Settings › 에이전트 › 이어서 하기, right after 턴 마무리 (D9). Not inside it: that section promises nothing goes
 * out until the person presses a button, and this switch is the one thing that does.
 */
export function LongRunSettings({ access }: { readonly access: LongRunAccess }): JSX.Element {
  const { i18n } = useAppTranslation();
  const ko = (i18n.resolvedLanguage ?? i18n.language).startsWith('ko');
  const titleId = useId();
  return (
    <section className="status-section long-run-settings" aria-labelledby={titleId} data-testid="long-run-settings">
      <div>
        <h2 className="status-section-title" id={titleId}>{ko ? '이어서 하기' : 'Continuing'}</h2>
        <p className="settings-hint">{ko
          ? '사용량 한도로 멈춘 턴을 앱이 이어서 합니다. 사람이 누르지 않아도 메시지가 나가는 유일한 곳입니다.'
          : 'The app continues a turn that stopped at a usage limit. This is the one place a message goes out without a press.'}</p>
      </div>
      <LongRunSwitch access={access} />
    </section>
  );
}
