import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppErrorBoundary } from './AppErrorBoundary';
import { useAppTranslation } from './i18n';
import { DesktopUiPreferencesProvider } from './ui-preferences';
import { ToastProvider } from './ui';
import './index.css';
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
    </ToastProvider>
  );
}

createRoot(container).render(
  <StrictMode>
    <AppErrorBoundary>
      <DesktopUiPreferencesProvider>
        <DesktopApplication />
      </DesktopUiPreferencesProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
