import { Bot, Home, LayoutGrid, Monitor, Settings, SquareTerminal, type LucideIcon } from 'lucide-react';

import { useAppTranslation } from '../../src/renderer/i18n';
import { MobileSignalMark } from './MobileSignalMark';

/** Tab roots the shell can be parked on. `pc` and `more` are actions, not
 * roots — PC Control opens an immersive screen and More opens a sheet — but
 * they share the bar so the five-item IA stays literal. */
export type MobileShellTab = 'home' | 'terminal' | 'agents';

interface TabItem {
  readonly id: string;
  readonly icon: LucideIcon;
  readonly label: string;
  readonly testId: string;
  readonly selected: boolean;
  readonly badge?: number;
  readonly updateDot?: boolean;
  readonly updateLabel?: string;
  readonly onSelect: () => void;
}

function TabButton({ item, railOnly = false }: { readonly item: TabItem; readonly railOnly?: boolean }): JSX.Element {
  const Icon = item.icon;
  return (
    <button
      type="button"
      // Not a tablist: PC Control and More are actions (immersive screen /
      // sheet), not panels, so `aria-current` marks the parked root instead.
      aria-current={item.selected ? 'page' : undefined}
      // Rail-only items render icon-first with the label hidden, so the name
      // has to come from aria-label rather than the (invisible) text node.
      aria-label={
        item.updateDot
          ? `${item.label}. ${item.updateLabel ?? ''}`.trim()
          : railOnly ? item.label : undefined
      }
      className={railOnly ? 'mobile-shell-tab mobile-shell-nav__rail-only' : 'mobile-shell-tab'}
      onClick={item.onSelect}
      data-testid={item.testId}
    >
      {item.selected && !railOnly && <span className="mobile-shell-tab__indicator" aria-hidden="true" />}
      {item.badge !== undefined && item.badge > 0 && (
        <span className="mobile-shell-tab__badge">{item.badge}</span>
      )}
      {item.updateDot && <span className="mobile-shell-tab__update-dot" aria-hidden="true" />}
      <Icon aria-hidden="true" />
      <span className="mobile-shell-tab__label">{item.label}</span>
    </button>
  );
}

/**
 * The shell's primary navigation: a five-item bottom bar on a cover/phone
 * display, and the same five items — same order — as a 72px left rail from
 * 600dp up (handoff 2b). One component, one DOM order; the bar/rail switch is
 * pure CSS so JS and layout can never disagree about the breakpoint.
 */
export function MobileTabBar({
  tab,
  agentAttention,
  updateAvailable = false,
  onSelectTab,
  onOpenPcControl,
  onOpenMore,
  onOpenSettings,
}: {
  readonly tab: MobileShellTab;
  readonly agentAttention: number;
  readonly updateAvailable?: boolean;
  readonly onSelectTab: (next: MobileShellTab) => void;
  readonly onOpenPcControl: () => void;
  readonly onOpenMore: () => void;
  readonly onOpenSettings: () => void;
}): JSX.Element {
  const { t } = useAppTranslation();

  const items: readonly TabItem[] = [
    {
      id: 'home',
      icon: Home,
      label: t('mobile.tabs.home'),
      testId: 'shell-tab-home',
      selected: tab === 'home',
      onSelect: () => onSelectTab('home'),
    },
    {
      id: 'terminal',
      icon: SquareTerminal,
      label: t('mobile.terminal'),
      testId: 'shell-tab-terminal',
      selected: tab === 'terminal',
      onSelect: () => onSelectTab('terminal'),
    },
    {
      id: 'pc',
      icon: Monitor,
      label: t('mobile.tabs.pc'),
      testId: 'shell-tab-pc',
      selected: false,
      onSelect: onOpenPcControl,
    },
    {
      id: 'agents',
      icon: Bot,
      label: t('mobile.agents'),
      testId: 'shell-tab-agents',
      selected: tab === 'agents',
      badge: agentAttention,
      onSelect: () => onSelectTab('agents'),
    },
    {
      id: 'more',
      icon: LayoutGrid,
      label: t('mobile.tabs.more'),
      testId: 'shell-tab-more',
      selected: false,
      onSelect: onOpenMore,
    },
  ];

  return (
    <nav
      className="mobile-shell-nav"
      aria-label={t('mobile.tabs.label')}
      data-testid="mobile-shell-nav"
    >
      <span className="mobile-shell-nav__brand">
        <MobileSignalMark />
      </span>
      {items.map((item) => <TabButton key={item.id} item={item} />)}
      <span className="mobile-shell-nav__spacer" aria-hidden="true" />
      <TabButton
        railOnly
        item={{
          id: 'settings',
          icon: Settings,
          label: t('common.settings'),
          testId: 'shell-rail-settings',
          selected: false,
          updateDot: updateAvailable,
          updateLabel: t('settings.update.badge'),
          onSelect: onOpenSettings,
        }}
      />
    </nav>
  );
}
