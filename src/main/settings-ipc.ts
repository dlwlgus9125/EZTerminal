import {
  TerminalRendererPreferenceSchema,
  type EffectParamsSettings,
  type RollbarSettings,
  type StartupPref,
  type ThemeName,
} from '../shared/layout-schema';
import { isTerminalPastePreferences } from '../shared/terminal-clipboard';
import { UiPreferencesPatchSchema, type UiLocalePreference } from '../shared/ui-preferences';
import { IpcRegistration, type FeatureIpc } from './ipc-registration';
import { LayoutStore } from './layout-store';
import { SystemStatsService } from './system-stats-service';
import { getAvailableThemes, importTheme } from './theme-store';

interface InstallLayoutIpcOptions {
  readonly ipc: FeatureIpc;
  readonly storeReady: Promise<void>;
  readonly layoutStore: LayoutStore;
}

export function installLayoutIpc(dependencies: InstallLayoutIpcOptions): () => void {
  const ipcMain = new IpcRegistration(dependencies.ipc);
  try {
    ipcMain.handle('layout:load', async () => {
      await dependencies.storeReady;
      return dependencies.layoutStore.loadLayout();
    });
    ipcMain.handle('layout:save', async (_event, rawLayout: unknown) => {
      await dependencies.storeReady;
      dependencies.layoutStore.saveLayout(rawLayout);
    });
    ipcMain.handle('layout:flush', async () => {
      await dependencies.storeReady;
      await dependencies.layoutStore.flush();
    });
    ipcMain.handle('layout:quarantine', async () => {
      await dependencies.storeReady;
      await dependencies.layoutStore.quarantineLayout();
    });
    ipcMain.handle('presets:list', async () => {
      await dependencies.storeReady;
      return dependencies.layoutStore.listPresets();
    });
    ipcMain.handle('presets:get', async (_event, name: string) => {
      await dependencies.storeReady;
      return typeof name === 'string' ? dependencies.layoutStore.getPreset(name) : null;
    });
    ipcMain.handle('presets:save', async (_event, name: string, rawLayout: unknown) => {
      await dependencies.storeReady;
      return typeof name === 'string' ? dependencies.layoutStore.savePreset(name, rawLayout) : false;
    });
    ipcMain.handle('presets:delete', async (_event, name: string) => {
      await dependencies.storeReady;
      if (typeof name === 'string') await dependencies.layoutStore.deletePreset(name);
    });
    ipcMain.handle('settings:get-startup', async () => {
      await dependencies.storeReady;
      return dependencies.layoutStore.getStartup();
    });
    ipcMain.handle('settings:set-startup', async (_event, pref: StartupPref) => {
      await dependencies.storeReady;
      await dependencies.layoutStore.setStartup(pref);
    });
  } catch (error) {
    ipcMain.dispose();
    throw error;
  }
  return ipcMain.dispose;
}

interface InstallPreferencesIpcOptions {
  readonly ipc: FeatureIpc;
  readonly storeReady: Promise<void>;
  readonly layoutStore: LayoutStore;
  readonly applyNativeMenuLocale: (preference: UiLocalePreference) => void;
  readonly systemStatsService: SystemStatsService | null;
}

export function installPreferencesIpc(dependencies: InstallPreferencesIpcOptions): () => void {
  const ipcMain = new IpcRegistration(dependencies.ipc);
  try {
    ipcMain.handle('settings:get-ui-preferences', async () => {
      await dependencies.storeReady;
      return dependencies.layoutStore.getUiPreferences();
    });
    ipcMain.handle('settings:set-ui-preferences', async (_event, preferences: unknown) => {
      await dependencies.storeReady;
      const parsed = UiPreferencesPatchSchema.safeParse(preferences);
      if (!parsed.success) return dependencies.layoutStore.getUiPreferences();
      const persisted = await dependencies.layoutStore.setUiPreferences(parsed.data);
      dependencies.applyNativeMenuLocale(persisted.locale);
      dependencies.systemStatsService?.setResourceProfile(persisted.resourceProfile);
      return persisted;
    });
    ipcMain.handle('settings:refresh-native-menu-locale', async () => {
      await dependencies.storeReady;
      const preferences = await dependencies.layoutStore.getUiPreferences();
      dependencies.applyNativeMenuLocale(preferences.locale);
    });
    ipcMain.handle('settings:get-theme', async () => {
      await dependencies.storeReady;
      return dependencies.layoutStore.getTheme();
    });
    ipcMain.handle('settings:set-theme', async (_event, theme: ThemeName) => {
      await dependencies.storeReady;
      await dependencies.layoutStore.setTheme(theme);
    });
    ipcMain.handle('settings:get-ui-scale', async () => {
      await dependencies.storeReady;
      return dependencies.layoutStore.getUiScale();
    });
    ipcMain.handle('settings:set-ui-scale', async (_event, uiScale: number) => {
      await dependencies.storeReady;
      if (typeof uiScale === 'number') await dependencies.layoutStore.setUiScale(uiScale);
    });
    ipcMain.handle('settings:get-scrollback', async () => {
      await dependencies.storeReady;
      return dependencies.layoutStore.getScrollback();
    });
    ipcMain.handle('settings:set-scrollback', async (_event, scrollback: number) => {
      await dependencies.storeReady;
      if (typeof scrollback === 'number') await dependencies.layoutStore.setScrollback(scrollback);
    });
    ipcMain.handle('settings:get-terminal-renderer', async () => {
      await dependencies.storeReady;
      return dependencies.layoutStore.getTerminalRenderer();
    });
    ipcMain.handle('settings:set-terminal-renderer', async (_event, preference: unknown) => {
      const parsed = TerminalRendererPreferenceSchema.safeParse(preference);
      if (!parsed.success) return;
      await dependencies.storeReady;
      await dependencies.layoutStore.setTerminalRenderer(parsed.data);
    });
    ipcMain.handle('settings:get-confirm-risky-pane-close', async () => {
      await dependencies.storeReady;
      return dependencies.layoutStore.getConfirmRiskyPaneClose();
    });
    ipcMain.handle('settings:set-confirm-risky-pane-close', async (_event, enabled: unknown) => {
      if (typeof enabled !== 'boolean') return;
      await dependencies.storeReady;
      await dependencies.layoutStore.setConfirmRiskyPaneClose(enabled);
    });
    ipcMain.handle('settings:get-boot-intro', async () => {
      await dependencies.storeReady;
      return dependencies.layoutStore.getBootIntro();
    });
    ipcMain.handle('settings:set-boot-intro', async (_event, enabled: unknown) => {
      if (typeof enabled !== 'boolean') return;
      await dependencies.storeReady;
      await dependencies.layoutStore.setBootIntro(enabled);
    });
    ipcMain.handle('settings:get-allow-osc52-clipboard', async () => {
      await dependencies.storeReady;
      return dependencies.layoutStore.getAllowOsc52Clipboard();
    });
    ipcMain.handle('settings:set-allow-osc52-clipboard', async (_event, enabled: unknown) => {
      if (typeof enabled !== 'boolean') return;
      await dependencies.storeReady;
      await dependencies.layoutStore.setAllowOsc52Clipboard(enabled);
    });
    ipcMain.handle('settings:get-terminal-paste-preferences', async () => {
      await dependencies.storeReady;
      return dependencies.layoutStore.getTerminalPastePreferences();
    });
    ipcMain.handle('settings:set-terminal-paste-preferences', async (_event, preferences: unknown) => {
      if (!isTerminalPastePreferences(preferences)) return;
      await dependencies.storeReady;
      await dependencies.layoutStore.setTerminalPastePreferences(preferences);
    });
  } catch (error) {
    ipcMain.dispose();
    throw error;
  }
  return ipcMain.dispose;
}

interface InstallThemeIpcOptions {
  readonly ipc: FeatureIpc;
  readonly storeReady: Promise<void>;
  readonly layoutStore: LayoutStore;
}

export function installThemeIpc(dependencies: InstallThemeIpcOptions): () => void {
  const ipcMain = new IpcRegistration(dependencies.ipc);
  try {
    ipcMain.handle('theme:get-available', () => getAvailableThemes());
    ipcMain.handle('theme:import', (_event, json: string) => importTheme(json));
    ipcMain.handle('settings:get-font', async () => {
      await dependencies.storeReady;
      return dependencies.layoutStore.getFont();
    });
    ipcMain.handle('settings:set-font', async (_event, id: string) => {
      await dependencies.storeReady;
      if (typeof id === 'string') await dependencies.layoutStore.setFont(id);
    });
    ipcMain.handle('settings:get-effect-toggles', async () => {
      await dependencies.storeReady;
      return dependencies.layoutStore.getEffectToggles();
    });
    ipcMain.handle('settings:set-effect-toggles', async (_event, toggles: Record<string, boolean>) => {
      await dependencies.storeReady;
      if (toggles && typeof toggles === 'object') await dependencies.layoutStore.setEffectToggles(toggles);
    });
    ipcMain.handle('settings:get-rollbar', async () => {
      await dependencies.storeReady;
      return dependencies.layoutStore.getRollbar();
    });
    ipcMain.handle('settings:set-rollbar', async (_event, params: RollbarSettings) => {
      await dependencies.storeReady;
      if (params && typeof params === 'object') await dependencies.layoutStore.setRollbar(params);
    });
    ipcMain.handle('settings:get-effect-params', async () => {
      await dependencies.storeReady;
      return dependencies.layoutStore.getEffectParams();
    });
    ipcMain.handle('settings:set-effect-params', async (_event, params: EffectParamsSettings) => {
      await dependencies.storeReady;
      if (params && typeof params === 'object') await dependencies.layoutStore.setEffectParams(params);
    });
  } catch (error) {
    ipcMain.dispose();
    throw error;
  }
  return ipcMain.dispose;
}
