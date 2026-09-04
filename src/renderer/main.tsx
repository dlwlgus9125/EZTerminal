import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppErrorBoundary } from './AppErrorBoundary';
import { AuxiliaryShell } from './AuxiliaryShell';
import { BootIntroOverlay } from './BootIntroOverlay';
import { useAppTranslation } from './i18n';
import { DesktopUiPreferencesProvider } from './ui-preferences';
import { ToastProvider } from './ui';
import './index.css';
import './structured-agent.css';
import './ui/styles.css';
import './workbench/workbench.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found in index.html');
}

function DesktopApplication(): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <ToastProvider viewportLabel={t('common.notifications')}>
      <App />
      {/* Sibling of the app, not a wrapper: the workbench mounts, paints, and
          becomes interactive on its own schedule and the intro simply covers
          it. Placed here so it can use the resolved locale. */}
      <BootIntroOverlay />
    </ToastProvider>
  );
}

const auxiliaryWindow = new URLSearchParams(window.location.search).get('ez-popout') === '1';

createRoot(container).render(
  <StrictMode>
    <AppErrorBoundary>
      {auxiliaryWindow ? (
        <AuxiliaryShell />
      ) : (
        <DesktopUiPreferencesProvider>
          <DesktopApplication />
        </DesktopUiPreferencesProvider>
      )}
    </AppErrorBoundary>
  </StrictMode>,
);
