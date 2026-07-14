import {
  Activity,
  Bot,
  FolderTree,
  RadioTower,
  Settings,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

import { useAppTranslation } from '../i18n';
import { Badge, IconButton, Tooltip } from '../ui';
import type { SidebarDestination } from './types';

interface RailItem {
  readonly id: SidebarDestination;
  readonly labelKey: 'rail.explorer' | 'rail.agents' | 'rail.monitor' | 'rail.remote' | 'rail.openClaw' | 'rail.settings';
  readonly icon: LucideIcon;
  readonly testId: string;
  readonly bottom?: boolean;
}

const RAIL_ITEMS: readonly RailItem[] = [
  { id: 'explorer', labelKey: 'rail.explorer', icon: FolderTree, testId: 'btn-toggle-files' },
  { id: 'agents', labelKey: 'rail.agents', icon: Bot, testId: 'rail-agents' },
  { id: 'monitor', labelKey: 'rail.monitor', icon: Activity, testId: 'btn-toggle-stats' },
  { id: 'remote', labelKey: 'rail.remote', icon: RadioTower, testId: 'rail-remote' },
  { id: 'openclaw', labelKey: 'rail.openClaw', icon: Wrench, testId: 'btn-toggle-openclaw' },
  { id: 'settings', labelKey: 'rail.settings', icon: Settings, testId: 'btn-toggle-settings', bottom: true },
];

export function ActivityRail({
  active,
  attentionCount,
  openclawVisible,
  onSelect,
}: {
  readonly active: SidebarDestination | null;
  readonly attentionCount: number;
  readonly openclawVisible: boolean;
  readonly onSelect: (destination: SidebarDestination) => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <nav className="activity-rail" aria-label={t('workbench.landmark')}>
      {RAIL_ITEMS.map((item) => {
        if (item.id === 'openclaw' && !openclawVisible) return null;
        const label = t(item.labelKey);
        const button = (
          <IconButton
            key={item.id}
            icon={item.icon}
            className="activity-rail-button"
            data-destination={item.id}
            data-bottom={item.bottom || undefined}
            aria-label={label}
            aria-pressed={active === item.id}
            onClick={() => onSelect(item.id)}
            data-testid={item.testId}
          />
        );
        return (
          <div key={item.id} className="activity-rail-item" data-bottom={item.bottom || undefined}>
            <Tooltip content={label} side="right">{button}</Tooltip>
            {item.id === 'agents' && attentionCount > 0 && (
              <Badge className="activity-rail-badge" variant="danger">
                {attentionCount > 99 ? '99+' : attentionCount}
              </Badge>
            )}
          </div>
        );
      })}
    </nav>
  );
}
