import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

import { useAppTranslation } from '../i18n';
import { Glyph } from '../ui';

/**
 * Work mode's one place for layout: work sets, quick layouts, saved layouts and
 * splits (the old header workspace menu, workbench bar and quick-layout chips).
 * The popover content is the existing WorkspaceMenu; this owns the button and
 * the open/close keyboard and pointer behaviour.
 */
export function ShellLayoutMenu({ open, onOpenChange, menu }: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly menu?: ReactNode;
}): JSX.Element {
  const { t } = useAppTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const changeRef = useRef(onOpenChange);
  changeRef.current = onOpenChange;

  useEffect(() => {
    if (!open) return undefined;
    requestAnimationFrame(() => {
      rootRef.current?.querySelector<HTMLElement>('#workspace-menu button:not(:disabled), #workspace-menu input:not(:disabled)')?.focus();
    });
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) changeRef.current(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
      requestAnimationFrame(() => buttonRef.current?.focus());
      return;
    }
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('#workspace-menu button:not(:disabled)'));
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || items.length === 0) return;
    event.preventDefault();
    const current = Math.max(0, items.indexOf(document.activeElement as HTMLElement));
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div ref={rootRef} className="ez-shell-layout" onKeyDown={onKeyDown}>
      <button ref={buttonRef} type="button" className="ez-shell-iconbtn ez-shell-layout__button" aria-expanded={open} aria-haspopup="dialog"
        aria-controls={open ? 'workspace-menu' : undefined} aria-label={t('header.workspace')} title={t('header.workspace')}
        onClick={() => onOpenChange(!open)}
        onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); onOpenChange(true); } }}
        data-testid="btn-workspace-menu">
        <Glyph name="diff" />
      </button>
      {open && menu}
    </div>
  );
}
