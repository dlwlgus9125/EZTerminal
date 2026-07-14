import { BellRing, ChevronDown, Command, PanelsTopLeft, Plus } from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

import type { EffectProfileId, ResolvedEffectProfileId } from '../effect-profiles';
import { useAppTranslation } from '../i18n';
import { Badge, Button } from '../ui';
import { BrandMark } from './BrandMark';
import { EffectProfileMenu } from './EffectProfileMenu';

export function AppHeader({
  attentionCount,
  activeThemeEffects,
  commandCenterOpen,
  effectProfile,
  motionEffectsRequested,
  onNewTerminal,
  onOpenAttention,
  onOpenCommandCenter,
  onOpenEffectSettings,
  onSelectEffectProfile,
  onWorkspaceOpenChange,
  workspaceMenu,
  workspaceOpen,
}: {
  readonly attentionCount: number;
  readonly activeThemeEffects: readonly string[];
  readonly commandCenterOpen: boolean;
  readonly effectProfile: ResolvedEffectProfileId;
  readonly motionEffectsRequested: boolean;
  readonly onNewTerminal: () => void;
  readonly onOpenAttention: () => void;
  readonly onOpenCommandCenter: () => void;
  readonly onOpenEffectSettings: () => void;
  readonly onSelectEffectProfile: (profile: EffectProfileId) => void;
  readonly onWorkspaceOpenChange: (open: boolean) => void;
  readonly workspaceMenu?: ReactNode;
  readonly workspaceOpen: boolean;
}): JSX.Element {
  const { t } = useAppTranslation();
  const workspaceRootRef = useRef<HTMLDivElement>(null);
  const workspaceButtonRef = useRef<HTMLButtonElement>(null);
  const workspaceOpenChangeRef = useRef(onWorkspaceOpenChange);
  workspaceOpenChangeRef.current = onWorkspaceOpenChange;

  useEffect(() => {
    if (!workspaceOpen) return;
    requestAnimationFrame(() => {
      workspaceRootRef.current
        ?.querySelector<HTMLElement>('#workspace-menu button:not(:disabled), #workspace-menu input:not(:disabled)')
        ?.focus();
    });
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !workspaceRootRef.current?.contains(event.target)) {
        workspaceOpenChangeRef.current(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [workspaceOpen]);

  const onWorkspaceKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!workspaceOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onWorkspaceOpenChange(false);
      requestAnimationFrame(() => workspaceButtonRef.current?.focus());
      return;
    }
    if (event.target instanceof HTMLInputElement) return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('#workspace-menu button:not(:disabled)'),
    );
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || items.length === 0) return;
    event.preventDefault();
    const current = Math.max(0, items.indexOf(document.activeElement as HTMLElement));
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  };
  return (
    <header className="workbench-header" data-testid="workbench-header">
      <div className="workbench-header-zone workbench-header-zone--new">
        <BrandMark />
        <Button
          variant="primary"
          className="workbench-new-terminal"
          leadingIcon={<Plus />}
          onClick={onNewTerminal}
          data-testid="btn-new-tab"
          title={t('header.newTerminal')}
        >
          {t('header.newTerminal')}
        </Button>
        <EffectProfileMenu
          activeThemeEffects={activeThemeEffects}
          motionEffectsRequested={motionEffectsRequested}
          profile={effectProfile}
          onSelectProfile={onSelectEffectProfile}
          onOpenAdvanced={onOpenEffectSettings}
        />
      </div>
      <div className="workbench-header-zone">
        <Button
          variant="ghost"
          leadingIcon={<Command />}
          aria-expanded={commandCenterOpen}
          aria-haspopup="dialog"
          onClick={onOpenCommandCenter}
          data-testid="btn-command-center"
          title={t('header.commandCenter')}
        >
          {t('header.commandCenter')}
          <kbd className="workbench-shortcut">Ctrl P</kbd>
        </Button>
      </div>
      <div
        ref={workspaceRootRef}
        className="workbench-header-zone workbench-workspace-menu"
        onKeyDown={onWorkspaceKeyDown}
      >
        <Button
          ref={workspaceButtonRef}
          variant="ghost"
          leadingIcon={<PanelsTopLeft />}
          trailingIcon={<ChevronDown />}
          aria-expanded={workspaceOpen}
          aria-haspopup="dialog"
          aria-controls={workspaceOpen ? 'workspace-menu' : undefined}
          onClick={() => onWorkspaceOpenChange(!workspaceOpen)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown') return;
            event.preventDefault();
            onWorkspaceOpenChange(true);
          }}
          data-testid="btn-workspace-menu"
          title={t('header.workspace')}
        >
          {t('header.workspace')}
        </Button>
        {workspaceMenu}
      </div>
      <div className="workbench-header-zone workbench-header-zone--attention">
        <Button
          variant={attentionCount > 0 ? 'secondary' : 'ghost'}
          leadingIcon={<BellRing />}
          onClick={onOpenAttention}
          data-testid="btn-toggle-agents"
          aria-label={`${t('header.agentAttention')}: ${attentionCount}`}
        >
          {t('header.agentAttention')}
          {attentionCount > 0 && <Badge variant="danger">{attentionCount > 99 ? '99+' : attentionCount}</Badge>}
        </Button>
      </div>
    </header>
  );
}
