const auxiliaryWindows = new Set<Window>();
const listeners = new Set<(windows: readonly Window[]) => void>();
const MIRRORED_STYLE_IDS = ['ez-theme-vars', 'ez-fx-keyframes'] as const;

let sourceObserver: MutationObserver | null = null;
let sourceHeadObserver: MutationObserver | null = null;
let lastFocusedWindow: Window | null = typeof window === 'undefined' ? null : window;
const ACTIVITY_EVENTS = ['focus', 'focusin', 'pointerdown'] as const;

function rememberWindow(targetWindow: Window): void {
  if (!targetWindow.closed) lastFocusedWindow = targetWindow;
}

if (typeof window !== 'undefined') {
  const rememberMain = (): void => rememberWindow(window);
  for (const type of ACTIVITY_EVENTS) window.addEventListener(type, rememberMain, true);
}

function syncStyleElement(targetDocument: Document, id: string): void {
  const source = document.getElementById(id);
  const existing = targetDocument.getElementById(id);
  if (!(source instanceof HTMLStyleElement)) {
    existing?.remove();
    return;
  }
  let target = existing;
  if (!(target instanceof targetDocument.defaultView!.HTMLStyleElement)) {
    existing?.remove();
    target = targetDocument.createElement('style');
    target.id = id;
    targetDocument.head.appendChild(target);
  }
  target.textContent = source.textContent;
}

function syncWindow(targetWindow: Window): void {
  if (targetWindow.closed) return;
  const sourceRoot = document.documentElement;
  const targetRoot = targetWindow.document.documentElement;
  const auxiliaryMarker = targetRoot.dataset.ezWindow;

  for (const attribute of [...targetRoot.attributes]) {
    if (attribute.name === 'data-ez-window') continue;
    if (!sourceRoot.hasAttribute(attribute.name)) targetRoot.removeAttribute(attribute.name);
  }
  for (const attribute of [...sourceRoot.attributes]) {
    targetRoot.setAttribute(attribute.name, attribute.value);
  }
  if (auxiliaryMarker) targetRoot.dataset.ezWindow = auxiliaryMarker;
  for (const id of MIRRORED_STYLE_IDS) syncStyleElement(targetWindow.document, id);
}

function syncAll(): void {
  for (const target of [...auxiliaryWindows]) {
    if (target.closed) {
      auxiliaryWindows.delete(target);
      continue;
    }
    syncWindow(target);
  }
}

function notify(): void {
  const snapshot = [...auxiliaryWindows].filter((candidate) => !candidate.closed);
  for (const listener of listeners) listener(snapshot);
}

function ensureObserver(): void {
  if (sourceObserver || typeof MutationObserver === 'undefined') return;
  sourceObserver = new MutationObserver(syncAll);
  sourceObserver.observe(document.documentElement, {
    attributes: true,
  });
  sourceHeadObserver = new MutationObserver(syncAll);
  sourceHeadObserver.observe(document.head, {
    childList: true,
    characterData: true,
    subtree: true,
  });
}

export function registerAuxiliaryWindow(targetWindow: Window): () => void {
  if (targetWindow === window || targetWindow.closed) return () => undefined;
  auxiliaryWindows.add(targetWindow);
  ensureObserver();
  syncWindow(targetWindow);
  notify();
  const markFocused = (): void => rememberWindow(targetWindow);
  for (const type of ACTIVITY_EVENTS) targetWindow.addEventListener(type, markFocused, true);
  try {
    if (targetWindow.document.hasFocus()) rememberWindow(targetWindow);
  } catch {
    // A just-opened window can close before its document focus can be read.
  }
  const remove = (): void => {
    if (!auxiliaryWindows.delete(targetWindow)) return;
    targetWindow.removeEventListener('unload', remove);
    for (const type of ACTIVITY_EVENTS) targetWindow.removeEventListener(type, markFocused, true);
    if (lastFocusedWindow === targetWindow) lastFocusedWindow = window;
    notify();
  };
  targetWindow.addEventListener('unload', remove, { once: true });
  return remove;
}

export function subscribeAuxiliaryWindows(
  listener: (windows: readonly Window[]) => void,
): () => void {
  listeners.add(listener);
  listener([...auxiliaryWindows].filter((candidate) => !candidate.closed));
  return () => listeners.delete(listener);
}

export function getAppWindows(): readonly Window[] {
  if (typeof window === 'undefined') return [];
  return [window, ...[...auxiliaryWindows].filter((candidate) => !candidate.closed)];
}

export function pointIsInsideAppWindow(screenX: number, screenY: number): boolean {
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return false;
  return getAppWindows().some((candidate) => {
    const left = candidate.screenX;
    const top = candidate.screenY;
    const width = Math.max(candidate.outerWidth, candidate.innerWidth);
    const height = Math.max(candidate.outerHeight, candidate.innerHeight);
    return (
      screenX >= left
      && screenX < left + width
      && screenY >= top
      && screenY < top + height
    );
  });
}

export function getActiveAppDocument(): Document {
  const candidates = getAppWindows();
  if (lastFocusedWindow && candidates.includes(lastFocusedWindow) && !lastFocusedWindow.closed) {
    try {
      return lastFocusedWindow.document;
    } catch {
      // A closing popout can become inaccessible between enumeration and use.
    }
  }
  for (const candidate of candidates) {
    try {
      if (!candidate.document.hasFocus()) continue;
      rememberWindow(candidate);
      return candidate.document;
    } catch {
      // A closing popout can become inaccessible between enumeration and use.
    }
  }
  if (typeof document === 'undefined') {
    throw new Error('An active app document is only available in a renderer process.');
  }
  return !lastFocusedWindow || lastFocusedWindow.closed
    ? document
    : lastFocusedWindow.document;
}

export function getAppDocumentByWindowName(windowName: string | null): Document | null {
  if (typeof document === 'undefined') return null;
  if (windowName === null) return document;
  for (const candidate of getAppWindows()) {
    try {
      if (candidate !== window && candidate.name === windowName) return candidate.document;
    } catch {
      // Ignore a popout that closed while resolving its stable frame name.
    }
  }
  return null;
}

export function addAppWindowEventListener(
  type: string,
  listener: EventListener,
  options?: boolean | AddEventListenerOptions,
): () => void {
  const attached = new Set<Window>();
  const sync = (windows: readonly Window[]): void => {
    const desired = new Set([window, ...windows]);
    for (const candidate of [...attached]) {
      if (desired.has(candidate)) continue;
      candidate.removeEventListener(type, listener, options);
      attached.delete(candidate);
    }
    for (const candidate of desired) {
      if (attached.has(candidate) || candidate.closed) continue;
      candidate.addEventListener(type, listener, options);
      attached.add(candidate);
    }
  };
  const unsubscribe = subscribeAuxiliaryWindows(sync);
  return () => {
    unsubscribe();
    for (const candidate of attached) {
      candidate.removeEventListener(type, listener, options);
    }
    attached.clear();
  };
}
