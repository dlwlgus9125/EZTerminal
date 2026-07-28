import { BellRing, ChevronDown, PanelsTopLeft, Plus, ScanLine, Search } from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

import { useAppTranslation } from '../i18n';
import { Badge, Button } from '../ui';
import { BrandMark } from './BrandMark';

const COMMAND_CENTER_KEYS = ['Ctrl', 'K'] as const;

export function AppHeader({
  appVersion,
  attentionCount,
  commandCenterOpen,
  effectIntensity,
  onNewTerminal,
  onOpenAttention,
  onOpenCommandCenter,
  onOpenEffectSettings,
  onWorkspaceOpenChange,
  workspaceMenu,
  workspaceOpen,
}: {
  readonly appVersion?: string | null;
  readonly attentionCount: number;
  readonly commandCenterOpen: boolean;
  readonly effectIntensity: number;
  readonly onNewTerminal: () => void;
  readonly onOpenAttention: () => void;
  readonly onOpenCommandCenter: () => void;
  readonly onOpenEffectSettings: () => void;
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
        {appVersion ? (
          <span className="workbench-version-chip" data-testid="workbench-version">
            {`v${appVersion}`}
          </span>
        ) : null}
        <span className="workbench-header-divider" aria-hidden="true" />
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
      </div>
      <div className="workbench-header-zone workbench-header-zone--search">
        {/* Still the Command Center zone, just widened into its search anchor.
            It owns no query state: clicking hands straight over to the modal,
            which remains the single implementation. */}
        <button
          type="button"
          className="workbench-command-field"
          aria-expanded={commandCenterOpen}
          aria-haspopup="dialog"
          aria-keyshortcuts="Control+K Meta+K Control+Shift+P Meta+Shift+P"
          onClick={onOpenCommandCenter}
          data-testid="btn-command-center"
          title={t('header.commandCenter')}
        >
          <Search className="workbench-command-field__icon" aria-hidden="true" />
          <span className="workbench-command-field__label">{t('header.commandCenterPlaceholder')}</span>
          <span className="workbench-command-field__keys" aria-hidden="true">
            {COMMAND_CENTER_KEYS.map((key) => (
              <kbd key={key}>{key}</kbd>
            ))}
          </span>
        </button>
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
          size="sm"
          variant="ghost"
          className="effect-profile-trigger"
          leadingIcon={<ScanLine />}
          onClick={onOpenEffectSettings}
          aria-label={t('header.effectIntensity', { value: effectIntensity })}
          data-testid="btn-effect-profile"
          data-effect-intensity={effectIntensity}
        >
          <span className="effect-profile-trigger__fx" aria-hidden="true">FX</span>
          <span className="effect-profile-trigger__separator" aria-hidden="true">·</span>
          <span className="effect-profile-trigger__value">{`NEON ${effectIntensity}`}</span>
        </Button>
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
