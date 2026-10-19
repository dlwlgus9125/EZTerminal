import { ChevronDown, type LucideIcon } from 'lucide-react';

import { Menu, MenuLabel, MenuRadioItem } from '../../ui';

export interface SettingPillOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly description?: string;
}

/** Compact composer setting (model, effort, permissions) as a pill that opens a menu. */
export function SettingPill<T extends string>({ label, value, options, onChange, disabled = false, icon: Icon, testId, placeholder, hint }: {
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
}): JSX.Element {
  const current = options.find((option) => option.value === value);
  const shown = current?.label ?? placeholder ?? label;
  return (
    <Menu
      label={label}
      placement="top-start"
      trigger={(
        <button type="button" className="chat-pill" disabled={disabled} data-testid={testId} aria-label={`${label}: ${shown}`} title={hint ?? label}>
          {Icon && <Icon aria-hidden="true" />}
          <span className="chat-pill__value">{shown}</span>
          <ChevronDown className="chat-pill__chevron" aria-hidden="true" />
        </button>
      )}
    >
      <MenuLabel>{label}</MenuLabel>
      {options.map((option) => (
        <MenuRadioItem key={option.value} checked={option.value === value} onSelect={() => onChange(option.value)}>
          <span className="chat-pill__option">
            <span>{option.label}</span>
            {option.description && <small>{option.description}</small>}
          </span>
        </MenuRadioItem>
      ))}
    </Menu>
  );
}
