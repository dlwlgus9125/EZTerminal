import {
  createContext,
  useContext,
  useId,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { classNames } from './utils';

type TabsOrientation = 'horizontal' | 'vertical';
type TabsActivationMode = 'automatic' | 'manual';

interface TabsContextValue {
  readonly baseId: string;
  readonly value: string;
  readonly orientation: TabsOrientation;
  readonly activationMode: TabsActivationMode;
  readonly onValueChange: (value: string) => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const value = useContext(TabsContext);
  if (!value) throw new Error(`${component} must be used inside Tabs`);
  return value;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}

export interface TabsProps extends HTMLAttributes<HTMLDivElement> {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly orientation?: TabsOrientation;
  readonly activationMode?: TabsActivationMode;
}

export function Tabs({
  activationMode = 'automatic',
  children,
  className,
  onValueChange,
  orientation = 'horizontal',
  value,
  ...props
}: TabsProps): JSX.Element {
  const generatedId = useId();
  const context: TabsContextValue = {
    baseId: `ez-ui-tabs-${generatedId}`,
    value,
    orientation,
    activationMode,
    onValueChange,
  };
  return (
    <TabsContext.Provider value={context}>
      <div className={classNames('ez-ui-tabs', className)} data-orientation={orientation} {...props}>
        {children}
      </div>
    </TabsContext.Provider>
  );
}

export interface TabListProps extends HTMLAttributes<HTMLDivElement> {
  readonly label: string;
}

export function TabList({ children, className, label, onKeyDown, ...props }: TabListProps): JSX.Element {
  const tabs = useTabsContext('TabList');

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const isPrevious =
      event.key === 'Home' ||
      (tabs.orientation === 'horizontal' && event.key === 'ArrowLeft') ||
      (tabs.orientation === 'vertical' && event.key === 'ArrowUp');
    const isNext =
      event.key === 'End' ||
      (tabs.orientation === 'horizontal' && event.key === 'ArrowRight') ||
      (tabs.orientation === 'vertical' && event.key === 'ArrowDown');
    if (!isPrevious && !isNext) return;

    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'),
    );
    if (items.length === 0) return;
    event.preventDefault();
    const currentIndex = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (currentIndex + (isNext ? 1 : -1) + items.length) % items.length;
    const next = items[nextIndex];
    next.focus();
    if (tabs.activationMode === 'automatic') {
      const nextValue = next.dataset.value;
      if (nextValue) tabs.onValueChange(nextValue);
    }
  };

  return (
    <div
      className={classNames('ez-ui-tab-list', className)}
      role="tablist"
      aria-label={label}
      aria-orientation={tabs.orientation}
      onKeyDown={handleKeyDown}
      {...props}
    >
      {children}
    </div>
  );
}

export interface TabProps extends Omit<HTMLAttributes<HTMLButtonElement>, 'onClick'> {
  readonly value: string;
  readonly disabled?: boolean;
  readonly children: ReactNode;
}

export function Tab({ children, className, disabled = false, value, ...props }: TabProps): JSX.Element {
  const tabs = useTabsContext('Tab');
  const selected = tabs.value === value;
  const valueId = safeId(value);
  return (
    <button
      type="button"
      id={`${tabs.baseId}-tab-${valueId}`}
      className={classNames('ez-ui-tab', className)}
      role="tab"
      data-value={value}
      aria-selected={selected}
      aria-controls={`${tabs.baseId}-panel-${valueId}`}
      tabIndex={selected ? 0 : -1}
      disabled={disabled}
      onClick={() => tabs.onValueChange(value)}
      {...props}
    >
      {children}
    </button>
  );
}

export interface TabPanelProps extends HTMLAttributes<HTMLDivElement> {
  readonly value: string;
}

export function TabPanel({ children, className, value, ...props }: TabPanelProps): JSX.Element {
  const tabs = useTabsContext('TabPanel');
  const selected = tabs.value === value;
  const valueId = safeId(value);
  return (
    <div
      id={`${tabs.baseId}-panel-${valueId}`}
      className={classNames('ez-ui-tab-panel', className)}
      role="tabpanel"
      aria-labelledby={`${tabs.baseId}-tab-${valueId}`}
      tabIndex={0}
      hidden={!selected}
      {...props}
    >
      {children}
    </div>
  );
}
