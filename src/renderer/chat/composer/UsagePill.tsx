import { useMemo, useState, type CSSProperties, type SyntheticEvent } from 'react';

import { agentUsageLevel, formatUsageCountdown, type AgentUsage } from '../../../shared/agent-usage';
import { AgentRelativeAge, useCoarseNow } from '../../AgentTime';
import { Popover } from '../../ui';
import { placementFor } from './SettingPill';

type UsageKey = 'fiveHour' | 'weekly' | 'context';

export interface UsagePillCopy {
  /** Heading of the details, e.g. `Claude 사용량`. */
  readonly title: (provider: string) => string;
  readonly names: Readonly<Record<UsageKey, string>>;
  /** Beside each gauge, as the CLI HUDs label them: `5h`, `wk`, `ctx`. */
  readonly short: Readonly<Record<UsageKey, string>>;
  readonly resetIn: (time: string) => string;
  /** Before the age of the reading, e.g. `갱신` → `갱신 3분 전`. */
  readonly updated: string;
  /** What a screen reader hears for the pill. */
  readonly summary: (provider: string, parts: readonly string[]) => string;
  readonly windowPart: (window: 'fiveHour' | 'weekly', percent: number, resetIn?: string) => string;
  readonly contextPart: (percent: number) => string;
}

interface UsageItem {
  readonly key: UsageKey;
  readonly percent: number;
  readonly resetIn?: string;
}

/** Windows whose reset has passed are left out: their value is no longer known. */
function usageItems(usage: AgentUsage, now: number): UsageItem[] {
  const items: UsageItem[] = [];
  for (const key of ['fiveHour', 'weekly'] as const) {
    const window = usage[key];
    if (!window || (window.resetsAt !== undefined && window.resetsAt <= now)) continue;
    items.push({
      key,
      percent: window.usedPercent,
      ...(window.resetsAt !== undefined ? { resetIn: formatUsageCountdown(window.resetsAt - now) } : {}),
    });
  }
  if (usage.contextPercent !== undefined) items.push({ key: 'context', percent: usage.contextPercent });
  return items;
}

const meterStyle = (percent: number): CSSProperties => ({ '--chat-usage-percent': `${percent}%` } as CSSProperties);

/**
 * The AI's plan limits and this conversation's context as small gauges in the
 * composer's settings row; the details (percent, time until reset, how old the
 * reading is) open from it, as the CLI HUDs show them.
 */
export function UsagePill({ usage, providerName, copy, locale }: {
  readonly usage: AgentUsage;
  readonly providerName: string;
  readonly copy: UsagePillCopy;
  readonly locale: string;
}): JSX.Element | null {
  const now = useCoarseNow();
  const [placement, setPlacement] = useState<'top-start' | 'top-end'>('top-start');
  const formatter = useMemo(() => new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'narrow' }), [locale]);
  const items = usageItems(usage, now);
  if (items.length === 0) return null;
  const summary = copy.summary(providerName, items.map((item) => (
    item.key === 'context' ? copy.contextPart(item.percent) : copy.windowPart(item.key, item.percent, item.resetIn)
  )));
  const observedAt = usage.limitsObservedAt ?? usage.contextObservedAt;
  const place = (event: SyntheticEvent<HTMLButtonElement>): void => setPlacement(placementFor(event.currentTarget));
  return (
    <Popover
      ariaLabel={copy.title(providerName)}
      placement={placement}
      className="chat-usage"
      contentClassName="chat-usage__details"
      initialFocus
      trigger={(
        <button type="button" className="chat-pill chat-pill--usage" aria-label={summary} title={summary}
          data-testid="structured-agent-usage" onClick={place} onKeyDown={place}>
          {items.map((item) => (
            <span key={item.key} className="chat-usage-item" aria-hidden="true">
              <span className="chat-usage-item__label">{copy.short[item.key]}</span>
              <span className="chat-usage-meter" data-level={agentUsageLevel(item.percent)}
                data-testid={`structured-agent-usage-${item.key}`} style={meterStyle(item.percent)} />
            </span>
          ))}
        </button>
      )}
    >
      <p className="chat-usage__title">{copy.title(providerName)}</p>
      <dl className="chat-usage__rows" data-testid="structured-agent-usage-details">
        {items.map((item) => (
          <div key={item.key} className="chat-usage__row" data-level={agentUsageLevel(item.percent)}>
            <dt>{copy.names[item.key]}</dt>
            <dd>
              <span className="chat-usage-meter chat-usage-meter--wide" style={meterStyle(item.percent)} aria-hidden="true" />
              <strong>{item.percent}%</strong>
              {item.resetIn && <small>{copy.resetIn(item.resetIn)}</small>}
            </dd>
          </div>
        ))}
      </dl>
      {observedAt !== undefined && (
        <p className="chat-usage__updated">
          {copy.updated} <AgentRelativeAge updatedAt={observedAt} formatter={formatter} currentTime={now} />
        </p>
      )}
    </Popover>
  );
}
