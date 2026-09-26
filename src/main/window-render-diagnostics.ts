import { app, type BrowserWindow, type Input, type Event } from 'electron';

// Temporary local instrumentation for the black-window incident. Diagnostic
// installers enable it at build time; ordinary builds leave it off.
// Does not capture terminal text, screenshots, paths, commands, or credentials.
const RENDER_STATE_PROBE = `(() => {
  const summarize = (element) => {
    if (!element) return null;
    const style = getComputedStyle(element);
    return {
      children: element.childElementCount,
      display: style.display, visibility: style.visibility, opacity: style.opacity,
      backgroundColor: style.backgroundColor, transform: style.transform,
      animationName: style.animationName, animationPlayState: style.animationPlayState
    };
  };
  return {
    visibility: document.visibilityState, focused: document.hasFocus(),
    ready: document.readyState, theme: document.documentElement.dataset.theme,
    tier: document.documentElement.dataset.runtimeTier,
    html: summarize(document.documentElement), body: summarize(document.body),
    root: summarize(document.getElementById('root')),
    bootOverlay: summarize(document.querySelector('.boot-intro')),
    dialogs: document.querySelectorAll('.ez-ui-dialog-backdrop').length,
    liveTerminals: document.querySelectorAll('[data-presentation-mode="live"]').length,
    parkedTerminals: document.querySelectorAll('[data-presentation-mode="parked"]').length,
    webglTerminals: document.querySelectorAll('[data-xterm-renderer="webgl"]').length,
    domTerminals: document.querySelectorAll('[data-xterm-renderer="dom"]').length,
    animations: document.getAnimations().slice(0, 16).map((animation) => ({
      state: animation.playState, time: animation.currentTime
    }))
  };
})()`;

export function installWindowRenderDiagnostics(
  window: BrowserWindow,
  writeLine: (message: string) => void,
): void {
  const enabled = process.env.EZTERMINAL_RENDER_DIAGNOSTICS
    ?? process.env.EZTERMINAL_RENDER_DIAGNOSTICS_DEFAULT;
  if (enabled !== '1') return;
  let disposed = false;
  let queryPending = false;
  let querySequence = 0;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const log = (record: unknown): void => {
    try {
      writeLine(`[render-diagnostics] ${JSON.stringify(record)}`);
    } catch {
      // A diagnostic write must never disrupt the window it observes.
    }
  };
  const capture = (reason: string): void => {
    if (disposed || window.isDestroyed() || window.webContents.isDestroyed()) return;
    log({ reason, phase: 'native', visible: window.isVisible(), minimized: window.isMinimized(),
      focused: window.isFocused(), bounds: window.getBounds(),
      rendererPid: window.webContents.getOSProcessId(), gpu: app.getGPUFeatureStatus(), queryPending });
    if (queryPending) return;
    queryPending = true;
    const sequence = ++querySequence;
    deadline = setTimeout(() => {
      if (!disposed) log({ reason, phase: 'renderer-probe-timeout', sequence });
    }, 1500);
    deadline.unref();
    // Keep the pending guard set after timeout: a hung renderer must not build a probe queue.
    // Normalize synchronous bridge failures as well as rejected probes.
    void Promise.resolve().then(() => {
      if (disposed || window.webContents.isDestroyed()) return null;
      return window.webContents.executeJavaScript(RENDER_STATE_PROBE);
    }).then(
      (state: unknown) => { if (!disposed) log({ reason, phase: 'renderer', sequence, state }); },
      () => { if (!disposed) log({ reason, phase: 'renderer-probe-failed', sequence }); },
    ).finally(() => {
      if (deadline) clearTimeout(deadline);
      deadline = undefined;
      queryPending = false;
    });
  };
  const onGpuGone = (_event: Event, details: Electron.Details): void => {
    if (details.type !== 'GPU') return;
    log({ reason: 'gpu-process-gone', exitReason: details.reason, exitCode: details.exitCode });
    capture('gpu-process-gone');
  };
  const onInput = (event: Event, input: Input): void => {
    if (input.type !== 'keyDown' || input.isAutoRepeat || !input.control || !input.shift || input.key !== 'F12') return;
    event.preventDefault();
    capture('user-black-screen-marker');
  };
  app.on('child-process-gone', onGpuGone);
  window.webContents.on('before-input-event', onInput);
  window.webContents.on('did-finish-load', () => capture('did-finish-load'));
  window.on('focus', () => capture('focus'));
  window.on('blur', () => capture('blur'));
  window.on('minimize', () => capture('minimize'));
  window.on('restore', () => capture('restore'));
  window.on('unresponsive', () => capture('unresponsive'));
  window.on('responsive', () => capture('responsive'));
  window.webContents.on('render-process-gone', (_event, details) => {
    log({ reason: 'render-process-gone', exitReason: details.reason, exitCode: details.exitCode });
  });
  log({ reason: 'enabled', version: app.getVersion(), buildSha: process.env.EZTERMINAL_BUILD_SHA ?? 'dev',
    electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform });
  window.once('closed', () => {
    disposed = true;
    if (deadline) clearTimeout(deadline);
    app.removeListener('child-process-gone', onGpuGone);
  });
}
