import type { TFunction } from 'i18next';

import type { QuickOpenRow } from './QuickOpenModal';

export type QuickOpenBuiltinAction =
  | 'new-tab'
  | 'split-right'
  | 'split-down'
  | 'cycle-theme'
  | 'save-preset'
  | 'open-explorer'
  | 'open-agents'
  | 'open-monitor'
  | 'open-remote'
  | 'open-openclaw'
  | 'open-settings'
  | 'toggle-locale';

export interface QuickOpenActionRow extends QuickOpenRow {
  readonly kind: 'action';
  readonly target: {
    readonly type: 'action';
    readonly action: QuickOpenBuiltinAction;
  };
}

/**
 * Product-owned command-center destinations.
 *
 * Both App and deterministic handoff stories consume this builder so the
 * handoff cannot silently drift into a second, manually maintained command
 * catalog.
 */
export function buildCommandCenterActionRows(
  t: TFunction,
  openclawVisible: boolean,
): readonly QuickOpenActionRow[] {
  return [
    {
      id: 'new-tab',
      kind: 'action',
      title: t('commandCenter.actions.newTab'),
      detail: t('commandCenter.actions.newTabDetail'),
      target: { type: 'action', action: 'new-tab' },
    },
    {
      id: 'split-right',
      kind: 'action',
      title: t('workspace.splitRight'),
      detail: t('commandCenter.actions.splitRightDetail'),
      target: { type: 'action', action: 'split-right' },
    },
    {
      id: 'split-down',
      kind: 'action',
      title: t('workspace.splitBelow'),
      detail: t('commandCenter.actions.splitBelowDetail'),
      target: { type: 'action', action: 'split-down' },
    },
    {
      id: 'cycle-theme',
      kind: 'action',
      title: t('commandCenter.actions.cycleTheme'),
      detail: t('commandCenter.actions.cycleThemeDetail'),
      target: { type: 'action', action: 'cycle-theme' },
    },
    {
      id: 'save-preset',
      kind: 'action',
      title: t('commandCenter.actions.savePreset'),
      detail: t('commandCenter.actions.savePresetDetail'),
      target: { type: 'action', action: 'save-preset' },
    },
    {
      id: 'open-explorer',
      kind: 'action',
      title: t('rail.explorer'),
      detail: t('commandCenter.actions.openDestinationDetail', { destination: t('rail.explorer') }),
      target: { type: 'action', action: 'open-explorer' },
    },
    {
      id: 'open-agents',
      kind: 'action',
      title: t('rail.agents'),
      detail: t('commandCenter.actions.openDestinationDetail', { destination: t('rail.agents') }),
      target: { type: 'action', action: 'open-agents' },
    },
    {
      id: 'open-monitor',
      kind: 'action',
      title: t('rail.monitor'),
      detail: t('commandCenter.actions.openDestinationDetail', { destination: t('rail.monitor') }),
      target: { type: 'action', action: 'open-monitor' },
    },
    {
      id: 'open-remote',
      kind: 'action',
      title: t('rail.remote'),
      detail: t('commandCenter.actions.openDestinationDetail', { destination: t('rail.remote') }),
      target: { type: 'action', action: 'open-remote' },
    },
    ...(openclawVisible
      ? [{
        id: 'open-openclaw',
        kind: 'action' as const,
        title: t('rail.openClaw'),
        detail: t('commandCenter.actions.openDestinationDetail', { destination: t('rail.openClaw') }),
        target: { type: 'action' as const, action: 'open-openclaw' as const },
      }]
      : []),
    {
      id: 'open-settings',
      kind: 'action',
      title: t('rail.settings'),
      detail: t('commandCenter.actions.openDestinationDetail', { destination: t('rail.settings') }),
      target: { type: 'action', action: 'open-settings' },
    },
    {
      id: 'toggle-locale',
      kind: 'action',
      title: t('commandCenter.actions.toggleLocale'),
      detail: t('commandCenter.actions.toggleLocaleDetail'),
      target: { type: 'action', action: 'toggle-locale' },
    },
  ];
}
