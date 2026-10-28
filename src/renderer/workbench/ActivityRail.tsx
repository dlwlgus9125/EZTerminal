import { glyphIcon, type GlyphIcon } from '../ui/Glyph';
import { useRef } from 'react';

import { useAppTranslation } from '../i18n';
import { Badge, IconButton, Menu, MenuItem, Tooltip, VisuallyHidden } from '../ui';
import { ACTIVITY_RAIL_ID } from '../shell/shell-ids';
import type { SidebarDestination } from './types';

interface RailItem {
  readonly id: SidebarDestination;
  readonly labelKey: 'rail.explorer' | 'rail.agents' | 'rail.monitor' | 'rail.remote' | 'rail.openClaw' | 'rail.settings';
  readonly icon: GlyphIcon;
  readonly testId: string;
  readonly bottom?: boolean;
}

const RAIL_ITEMS: readonly RailItem[] = [
  { id: 'agents', labelKey: 'rail.agents', icon: glyphIcon('bot'), testId: 'rail-agents' },
  { id: 'monitor', labelKey: 'rail.monitor', icon: glyphIcon('mon'), testId: 'btn-toggle-stats' },
  { id: 'remote', labelKey: 'rail.remote', icon: glyphIcon('phone'), testId: 'rail-remote' },
  { id: 'explorer', labelKey: 'rail.explorer', icon: glyphIcon('proj'), testId: 'btn-toggle-files' },
  { id: 'openclaw', labelKey: 'rail.openClaw', icon: glyphIcon('set'), testId: 'btn-toggle-openclaw' },
  { id: 'settings', labelKey: 'rail.settings', icon: glyphIcon('set'), testId: 'btn-toggle-settings', bottom: true },
];

/** Runtime destination registry used by navigation and design-surface
 * coverage. Keep optional visibility policy in ActivityRail; the destination
 * itself remains active even while OpenClaw is hidden. */
export const ACTIVITY_RAIL_DESTINATIONS: readonly SidebarDestination[] = RAIL_ITEMS.map((item) => item.id);

export { ACTIVITY_RAIL_ID };

export function ActivityRail({
  active,
  attentionCount,
  updateAvailable = false,
  openclawVisible,
  onIntent,
  onSelect,
  projectNavigation = false,
  inboxActive = false,
  onOpenInbox,
}: {
  readonly active: SidebarDestination | null;
  readonly attentionCount: number;
  readonly updateAvailable?: boolean;
  readonly openclawVisible: boolean;
  readonly onIntent?: (destination: SidebarDestination) => void;
  readonly onSelect: (destination: SidebarDestination) => void;
  readonly projectNavigation?: boolean;
  readonly inboxActive?: boolean;
  readonly onOpenInbox?: () => void;
}): JSX.Element {
  const { t, i18n } = useAppTranslation();
  const toolsTriggerRef = useRef<HTMLButtonElement>(null);
  if (projectNavigation) {
    const korean = (i18n.resolvedLanguage ?? i18n.language).startsWith('ko');
    const projectLabel = korean ? '프로젝트' : 'Projects';
    const inboxLabel = korean ? '받은 요청' : 'Inbox';
    const toolsLabel = korean ? '도구' : 'Tools';
    return <nav id={ACTIVITY_RAIL_ID} className="activity-rail" aria-label={t('workbench.landmark')}>
      <div className="activity-rail-item"><Tooltip content={projectLabel} side="right"><IconButton icon={glyphIcon('proj')} className="activity-rail-button" aria-label={projectLabel} aria-pressed={active === 'agents' && !inboxActive} onClick={() => onSelect('agents')} onPointerEnter={() => onIntent?.('agents')} data-testid="rail-agents" /></Tooltip></div>
      <div className="activity-rail-item"><Tooltip content={inboxLabel} side="right"><IconButton icon={glyphIcon('req')} className="activity-rail-button" aria-label={inboxLabel} aria-pressed={active === 'agents' && inboxActive} onClick={onOpenInbox} data-testid="rail-inbox" /></Tooltip>{attentionCount > 0 && <Badge className="activity-rail-badge" variant="danger">{attentionCount > 99 ? '99+' : attentionCount}</Badge>}</div>
      <div className="activity-rail-item"><Menu label={toolsLabel} trigger={<IconButton ref={toolsTriggerRef} icon={glyphIcon('set')} className="activity-rail-button" aria-label={toolsLabel} aria-pressed={active !== null && active !== 'agents' && active !== 'settings'} data-testid="rail-tools" />}>
        {RAIL_ITEMS.filter((item) => item.id !== 'agents' && item.id !== 'settings' && (item.id !== 'openclaw' || openclawVisible)).map((item) => <MenuItem key={item.id} icon={item.icon} onSelect={() => {
          // SidebarShell captures its invoker after this menu unmounts. Retain
          // the stable trigger before committing the destination change.
          toolsTriggerRef.current?.focus();
          onSelect(item.id);
        }} data-testid={item.testId}>{t(item.labelKey)}</MenuItem>)}
      </Menu></div>
      <div className="activity-rail-item" data-bottom><Tooltip content={t('rail.settings')} side="right"><IconButton icon={glyphIcon('set')} className="activity-rail-button" aria-label={t('rail.settings')} aria-pressed={active === 'settings'} onClick={() => onSelect('settings')} data-testid="btn-toggle-settings" /></Tooltip>{updateAvailable && <span className="activity-rail-update-dot" data-testid="settings-update-badge"><VisuallyHidden>{t('settings.update.badge')}</VisuallyHidden></span>}</div>
    </nav>;
  }
  return (
    <nav id={ACTIVITY_RAIL_ID} className="activity-rail" aria-label={t('workbench.landmark')}>
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
            onFocus={() => onIntent?.(item.id)}
            onPointerEnter={() => onIntent?.(item.id)}
            onPointerDown={() => onIntent?.(item.id)}
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
            {item.id === 'settings' && updateAvailable && (
              <span className="activity-rail-update-dot" data-testid="settings-update-badge">
                <VisuallyHidden>{t('settings.update.badge')}</VisuallyHidden>
              </span>
            )}
          </div>
        );
      })}
    </nav>
  );
}
