import { ChevronDown, type LucideIcon } from 'lucide-react';
import { useState, type SyntheticEvent } from 'react';

import { Menu, MenuLabel, MenuRadioItem, MenuSeparator } from '../../ui';

export interface SettingPillOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

/** A choice the setting depends on, listed first in its menu (e.g. the AI whose models follow). */
export interface SettingPillLeading {
  readonly label: string;
  readonly value: string;
  readonly options: readonly SettingPillOption<string>[];
  readonly onChange: (value: string) => void;
}

/** The menu's width in rem; it opens toward the side that has this much room in the pane. */
const MENU_WIDTH_REM = 18;

/** Opens the menu leftward when it would run past the conversation pane's right edge, where it is clipped. */
export function placementFor(trigger: HTMLElement): 'top-start' | 'top-end' {
  const fontSize = Number.parseFloat(getComputedStyle(trigger.ownerDocument.documentElement).fontSize) || 16;
  const width = MENU_WIDTH_REM * fontSize;
  const pane = (trigger.closest('.structured-agent') ?? trigger.ownerDocument.documentElement).getBoundingClientRect();
  const rect = trigger.getBoundingClientRect();
  return rect.left + width > pane.right && rect.right - width >= pane.left ? 'top-end' : 'top-start';
}

/** Compact composer setting (model, effort, permissions) as a pill that opens a menu. */
export function SettingPill<T extends string>({ label, value, options, onChange, disabled = false, icon: Icon, testId, placeholder, hint, prefix, status, leading }: {
  readonly label: string;
  readonly value: T | '';
  readonly options: readonly SettingPillOption<T>[];
  readonly onChange: (value: T) => void;
  readonly disabled?: boolean;
  readonly icon?: LucideIcon;
  readonly testId?: string;
  /** Shown when no option is selected (e.g. the provider default model). */
  readonly placeholder?: string;
  /** Tooltip instead of the label, e.g. why the pill is disabled. */
  readonly hint?: string;
  /** Whose setting this is, before the value (e.g. the AI a model belongs to). */
  readonly prefix?: string;
  /** A line under the options while they are incomplete (e.g. still loading). */
  readonly status?: string;
  readonly leading?: SettingPillLeading;
}): JSX.Element {
  const [placement, setPlacement] = useState<'top-start' | 'top-end'>('top-start');
  const current = options.find((option) => option.value === value);
  const shown = current?.label ?? placeholder ?? label;
  const place = (event: SyntheticEvent<HTMLButtonElement>): void => setPlacement(placementFor(event.currentTarget));
  return (
    <Menu
      label={label}
      placement={placement}
      className="chat-pill-menu"
      trigger={(
        <button type="button" className="chat-pill" disabled={disabled} data-testid={testId} aria-label={`${label}: ${shown}`} title={hint ?? label}
          onClick={place} onKeyDown={place}>
          {Icon && <Icon aria-hidden="true" />}
          {prefix && <span className="chat-pill__prefix">{prefix}</span>}
          <span className="chat-pill__value">{shown}</span>
          <ChevronDown className="chat-pill__chevron" aria-hidden="true" />
        </button>
      )}
    >
      {leading && (
        <>
          <MenuLabel>{leading.label}</MenuLabel>
          {leading.options.map((option) => (
            <MenuRadioItem key={option.value} checked={option.value === leading.value} disabled={option.disabled}
              onSelect={() => leading.onChange(option.value)}>
              <span className="chat-pill__option">
                <span>{option.label}</span>
                {option.description && <small>{option.description}</small>}
              </span>
            </MenuRadioItem>
          ))}
          <MenuSeparator />
        </>
      )}
      <MenuLabel>{label}</MenuLabel>
      {options.map((option) => (
        <MenuRadioItem key={option.value} checked={option.value === value} disabled={option.disabled} onSelect={() => onChange(option.value)}>
          <span className="chat-pill__option">
            <span>{option.label}</span>
            {option.description && <small>{option.description}</small>}
          </span>
        </MenuRadioItem>
      ))}
      {status && <MenuLabel className="chat-pill__status" role="status">{status}</MenuLabel>}
    </Menu>
  );
}
