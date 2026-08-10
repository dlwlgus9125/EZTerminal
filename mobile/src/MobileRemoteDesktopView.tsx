import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Clipboard } from '@capacitor/clipboard';
import {
  ArrowLeft,
  ClipboardCopy,
  ClipboardPaste,
  Keyboard,
  Maximize2,
  Monitor,
  MoreHorizontal,
  MousePointer2,
  Power,
  RefreshCw,
  Settings2,
  Touchpad,
  WifiOff,
} from 'lucide-react';

import { useAppTranslation } from '../../src/renderer/i18n';
import {
  MAX_DESKTOP_VIEWPORT_PIXELS,
  MIN_DESKTOP_VIEWPORT_PIXELS,
  type DesktopNormalizedRegion,
  type DesktopQualityPreference,
  type DesktopVideoViewport,
} from '../../src/shared/remote-protocol';
import { MobileActionSheet } from './MobileActionSheet';
import { useMobileToast } from './MobileToast';
import {
  INITIAL_DESKTOP_PRESENTATION_SNAPSHOT,
  RemoteDesktopPresentationAdapter,
  type DesktopControlCommand,
  type DesktopKeyModifier,
  type DesktopMouseButton,
  type DesktopPresentationAdapter,
  type DesktopPresentationDetail,
  type DesktopPointerCommand,
} from './remote-desktop-presentation-adapter';
import {
  FIT_REMOTE_VIEW,
  clampRemoteView,
  mapRemotePoint,
  panRemoteView,
  relativeRemoteDelta,
  remoteVideoLayout,
  visibleRegionForView,
  zoomRemoteViewAt,
  type RemoteSurfaceSize,
  type RemoteViewState,
} from './remote-desktop-view-state';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';

type InputMode = 'trackpad' | 'direct';
type HandleEdge = 'left' | 'right';

interface PointerRecord {
  x: number;
  y: number;
  startX: number;
  startY: number;
  startedAt: number;
  pointerType: string;
  button: DesktopMouseButton;
  moved: boolean;
  buttonDown: boolean;
  longPressTriggered: boolean;
  dragCandidate: boolean;
  suppressTap: boolean;
}

interface MultiGesture {
  kind: 'two' | 'three';
  startedAt: number;
  startCenterX: number;
  startCenterY: number;
  lastCenterX: number;
  lastCenterY: number;
  startDistance: number;
  startView: RemoteViewState;
  moved: boolean;
  pinching: boolean;
}

interface StoredPreferences {
  readonly version: 2;
  readonly inputMode: InputMode;
  readonly qualityPreference: DesktopQualityPreference;
  readonly handleEdge: HandleEdge;
  readonly handleY: number;
}

const LEGACY_INPUT_MODE_STORAGE_KEY = 'ezterminal.pcControl.inputMode';
const PREFERENCES_STORAGE_KEY = 'ezterminal.pcControl.preferences.v2';
const TAP_MAX_MS = 250;
const TAP_MOVE_PX = 10;
const LONG_PRESS_MS = 500;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DISTANCE_PX = 24;
const VIEWPORT_UPDATE_DELAY_MS = 500;
const FULL_REGION: DesktopNormalizedRegion = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });

const MODIFIER_CODES: Readonly<Record<DesktopKeyModifier, string>> = {
  control: 'ControlLeft',
  alt: 'AltLeft',
  shift: 'ShiftLeft',
  meta: 'MetaLeft',
};

const SUPPORTED_REMOTE_KEY_CODES: ReadonlySet<string> = new Set([
  'Escape',
  ...Array.from({ length: 10 }, (_, index) => `Digit${index}`),
  'Minus',
  'Equal',
  'Backspace',
  'Tab',
  ...Array.from({ length: 26 }, (_, index) => `Key${String.fromCharCode(65 + index)}`),
  'BracketLeft',
  'BracketRight',
  'Enter',
  'ControlLeft',
  'ControlRight',
  'Semicolon',
  'Quote',
  'Backquote',
  'ShiftLeft',
  'ShiftRight',
  'Backslash',
  'Comma',
  'Period',
  'Slash',
  'AltLeft',
  'AltRight',
  'Space',
  'CapsLock',
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
  'Home',
  'ArrowUp',
  'PageUp',
  'ArrowLeft',
  'ArrowRight',
  'End',
  'ArrowDown',
  'PageDown',
  'Insert',
  'Delete',
  'MetaLeft',
  'MetaRight',
]);

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function validQualityPreference(value: unknown): value is DesktopQualityPreference {
  return value === 'balanced' || value === 'clarity' || value === 'responsiveness';
}

function loadPreferences(): StoredPreferences {
  const legacyMode = window.localStorage.getItem(LEGACY_INPUT_MODE_STORAGE_KEY) === 'direct'
    ? 'direct'
    : 'trackpad';
  try {
    const value = JSON.parse(window.localStorage.getItem(PREFERENCES_STORAGE_KEY) ?? '') as Partial<StoredPreferences>;
    return {
      version: 2,
      inputMode: value.inputMode === 'direct' ? 'direct' : value.inputMode === 'trackpad'
        ? 'trackpad'
        : legacyMode,
      qualityPreference: validQualityPreference(value.qualityPreference)
        ? value.qualityPreference
        : 'balanced',
      handleEdge: value.handleEdge === 'left' ? 'left' : 'right',
      handleY: typeof value.handleY === 'number' && Number.isFinite(value.handleY)
        ? Math.min(0.92, Math.max(0.08, value.handleY))
        : 0.5,
    };
  } catch {
    return {
      version: 2,
      inputMode: legacyMode,
      qualityPreference: 'balanced',
      handleEdge: 'right',
      handleY: 0.5,
    };
  }
}

export function measureVideoViewport(
  element: Pick<HTMLElement, 'getBoundingClientRect'>,
  devicePixelRatio: number,
): DesktopVideoViewport | null {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const bounded = (value: number): number => Math.min(
    MAX_DESKTOP_VIEWPORT_PIXELS,
    Math.max(MIN_DESKTOP_VIEWPORT_PIXELS, Math.round(value * ratio)),
  );
  return { pixelWidth: bounded(rect.width), pixelHeight: bounded(rect.height) };
}

/** Compatibility helper retained for consumers that use the centered contain geometry. */
export function mapVideoPoint(
  clientX: number,
  clientY: number,
  viewport: DOMRect,
  sourceWidth: number,
  sourceHeight: number,
  zoom: number,
): { x: number; y: number } {
  const safeWidth = Math.max(1, sourceWidth || viewport.width);
  const safeHeight = Math.max(1, sourceHeight || viewport.height);
  const fit = Math.min(viewport.width / safeWidth, viewport.height / safeHeight);
  const contentWidth = safeWidth * fit * zoom;
  const contentHeight = safeHeight * fit * zoom;
  const left = viewport.left + (viewport.width - contentWidth) / 2;
  const top = viewport.top + (viewport.height - contentHeight) / 2;
  return {
    x: clampUnit((clientX - left) / contentWidth),
    y: clampUnit((clientY - top) / contentHeight),
  };
}

function startErrorKey(code: string | undefined):
  | 'mobile.pcControl.startError.DESKTOP_CONTROL_UNAVAILABLE'
  | 'mobile.pcControl.startError.SERVICE_UNAVAILABLE'
  | 'mobile.pcControl.startError.UNSUPPORTED'
  | 'mobile.pcControl.startError.OFFLINE'
  | 'mobile.pcControl.startError.unknown' {
  switch (code) {
    case 'DESKTOP_CONTROL_UNAVAILABLE': return 'mobile.pcControl.startError.DESKTOP_CONTROL_UNAVAILABLE';
    case 'SERVICE_UNAVAILABLE': return 'mobile.pcControl.startError.SERVICE_UNAVAILABLE';
    case 'UNSUPPORTED': return 'mobile.pcControl.startError.UNSUPPORTED';
    case 'OFFLINE': return 'mobile.pcControl.startError.OFFLINE';
    default: return 'mobile.pcControl.startError.unknown';
  }
}

function createPresentationAdapter(transport: WsEzTerminalTransport): DesktopPresentationAdapter {
  return new RemoteDesktopPresentationAdapter(transport, {
    clipboard: {
      readText: async () => (await Clipboard.read()).value,
      writeText: async (text) => Clipboard.write({ string: text }),
    },
    visibility: {
      isHidden: () => document.visibilityState === 'hidden',
      subscribe: (listener) => {
        document.addEventListener('visibilitychange', listener);
        return () => document.removeEventListener('visibilitychange', listener);
      },
    },
    createPeerConnection: () => {
      if (typeof RTCPeerConnection !== 'function') throw new Error('WebRTC is unavailable');
      return new RTCPeerConnection({ iceServers: [] });
    },
  });
}

function mouseButton(button: number): DesktopMouseButton | null {
  if (button === 0) return 'left';
  if (button === 2) return 'right';
  if (button === 1) return 'middle';
  return null;
}

export interface MobileRemoteDesktopViewProps {
  readonly transport: WsEzTerminalTransport;
  readonly hostLabel?: string;
  readonly onClose: () => void;
  readonly presentationAdapterFactory?: (transport: WsEzTerminalTransport) => DesktopPresentationAdapter;
}

export function MobileRemoteDesktopView({
  transport,
  hostLabel = '',
  onClose,
  presentationAdapterFactory = createPresentationAdapter,
}: MobileRemoteDesktopViewProps): JSX.Element {
  const { t } = useAppTranslation();
  const showToast = useMobileToast();
  const initialPreferences = useMemo(loadPreferences, []);
  const presentationAdapter = useMemo(
    () => presentationAdapterFactory(transport),
    [presentationAdapterFactory, transport],
  );
  const [presentation, setPresentation] = useState(INITIAL_DESKTOP_PRESENTATION_SNAPSHOT);
  const [started, setStarted] = useState(false);
  const [needsResume, setNeedsResume] = useState(false);
  const [mode, setMode] = useState<InputMode>(initialPreferences.inputMode);
  const [qualityPreference, setQualityPreference] = useState<DesktopQualityPreference>(
    initialPreferences.qualityPreference,
  );
  const [handleEdge, setHandleEdge] = useState<HandleEdge>(initialPreferences.handleEdge);
  const [handleY, setHandleY] = useState(initialPreferences.handleY);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [extrasOpen, setExtrasOpen] = useState(false);
  const [stickyModifiers, setStickyModifiers] = useState<ReadonlySet<DesktopKeyModifier>>(new Set());
  const [view, setView] = useState<RemoteViewState>(FIT_REMOTE_VIEW);
  const [surfaceSize, setSurfaceSize] = useState<RemoteSurfaceSize>({ width: 1, height: 1 });
  const [latestRequestedRevision, setLatestRequestedRevision] = useState(0);

  const presentationAdapterRef = useRef<DesktopPresentationAdapter | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const handleRef = useRef<HTMLButtonElement | null>(null);
  const viewRef = useRef<RemoteViewState>(view);
  const stickyModifiersRef = useRef<ReadonlySet<DesktopKeyModifier>>(stickyModifiers);
  const pointersRef = useRef(new Map<number, PointerRecord>());
  const mousePositionRef = useRef<{ x: number; y: number } | null>(null);
  const pressedHardwareKeysRef = useRef(new Set<string>());
  const multiGestureRef = useRef<MultiGesture | null>(null);
  const holdTimersRef = useRef(new Map<number, number>());
  const lastTapRef = useRef<{ at: number; x: number; y: number } | null>(null);
  const lastTwoFingerTapRef = useRef<{ at: number; x: number; y: number } | null>(null);
  const revisionRef = useRef(0);
  const lastPublishedViewportRef = useRef<Omit<DesktopVideoViewport, 'revision'> | null>(null);
  const handleDragRef = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);

  const { capabilities, displays, phase, selectedDisplayId, status, appliedView } = presentation;
  const selectedDisplay = displays.find((display) => display.id === selectedDisplayId)
    ?? displays[0]
    ?? { width: 1_920, height: 1_080 };
  const displaySize = useMemo(() => ({
    width: selectedDisplay.width,
    height: selectedDisplay.height,
  }), [selectedDisplay.height, selectedDisplay.width]);

  const updateView = useCallback((next: RemoteViewState): void => {
    viewRef.current = next;
    setView(next);
  }, []);

  const sendControl = useCallback((command: DesktopControlCommand): boolean => (
    presentationAdapterRef.current?.sendControl(command) ?? false
  ), []);
  const sendPointer = useCallback((command: DesktopPointerCommand): boolean => (
    presentationAdapterRef.current?.sendPointer(command) ?? false
  ), []);

  const clearHoldTimer = useCallback((pointerId: number): void => {
    const timer = holdTimersRef.current.get(pointerId);
    if (timer !== undefined) window.clearTimeout(timer);
    holdTimersRef.current.delete(pointerId);
  }, []);

  const releasePointerButtons = useCallback((): void => {
    for (const record of pointersRef.current.values()) {
      if (record.buttonDown) {
        sendControl({ type: 'pointer-button', button: record.button, down: false });
      }
    }
    for (const timer of holdTimersRef.current.values()) window.clearTimeout(timer);
    holdTimersRef.current.clear();
    pointersRef.current.clear();
    mousePositionRef.current = null;
    multiGestureRef.current = null;
  }, [sendControl]);

  const releaseHardwareKeys = useCallback((): void => {
    const pressedCodes = [...pressedHardwareKeysRef.current];
    pressedHardwareKeysRef.current.clear();
    for (const code of pressedCodes) {
      sendControl({ type: 'key', code, down: false, modifiers: [] });
    }
  }, [sendControl]);

  const releaseAllInput = useCallback((): void => {
    releasePointerButtons();
    releaseHardwareKeys();
    for (const modifier of stickyModifiersRef.current) {
      sendControl({ type: 'key', code: MODIFIER_CODES[modifier], down: false, modifiers: [] });
    }
    if (stickyModifiersRef.current.size > 0) {
      stickyModifiersRef.current = new Set();
      setStickyModifiers(new Set());
    }
  }, [releaseHardwareKeys, releasePointerButtons, sendControl]);

  const publishView = useCallback((nextView: RemoteViewState = viewRef.current): void => {
    const element = viewportRef.current;
    if (!element) return;
    const viewport = measureVideoViewport(element, window.devicePixelRatio);
    if (!viewport) return;
    const rect = element.getBoundingClientRect();
    const nextSurface = { width: rect.width, height: rect.height };
    const boundedView = clampRemoteView(nextView, nextSurface, displaySize);
    if (
      boundedView.zoom !== nextView.zoom
      || boundedView.centerX !== nextView.centerX
      || boundedView.centerY !== nextView.centerY
    ) updateView(boundedView);
    const nextViewportBase: Omit<DesktopVideoViewport, 'revision'> = {
      ...viewport,
      ...(boundedView.zoom > 1
        ? { visibleRegion: visibleRegionForView(boundedView, nextSurface, displaySize) }
        : {}),
    };
    const previous = lastPublishedViewportRef.current;
    if (
      previous?.pixelWidth === nextViewportBase.pixelWidth
      && previous.pixelHeight === nextViewportBase.pixelHeight
      && (
        previous.visibleRegion === nextViewportBase.visibleRegion
        || Boolean(previous.visibleRegion && nextViewportBase.visibleRegion
          && previous.visibleRegion.x === nextViewportBase.visibleRegion.x
          && previous.visibleRegion.y === nextViewportBase.visibleRegion.y
          && previous.visibleRegion.width === nextViewportBase.visibleRegion.width
          && previous.visibleRegion.height === nextViewportBase.visibleRegion.height)
      )
    ) return;
    lastPublishedViewportRef.current = nextViewportBase;
    const revision = revisionRef.current + 1;
    revisionRef.current = revision;
    const nextViewport: DesktopVideoViewport = { ...nextViewportBase, revision };
    presentationAdapter.setViewport(nextViewport);
    setLatestRequestedRevision(revision);
  }, [displaySize, presentationAdapter, updateView]);

  useEffect(() => {
    viewRef.current = view;
    const timer = window.setTimeout(() => publishView(view), VIEWPORT_UPDATE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [publishView, surfaceSize.height, surfaceSize.width, view]);

  useEffect(() => {
    presentationAdapterRef.current = presentationAdapter;
    const publishSnapshot = (): void => setPresentation(presentationAdapter.getSnapshot());
    const unsubscribe = presentationAdapter.subscribe(publishSnapshot);
    presentationAdapter.attachVideo(videoRef.current);
    publishSnapshot();

    const updateSurface = (): void => {
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      setSurfaceSize({ width: rect.width, height: rect.height });
    };
    updateSurface();
    const resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(updateSurface)
      : null;
    if (viewportRef.current) resizeObserver?.observe(viewportRef.current);
    window.addEventListener('resize', updateSurface);
    window.visualViewport?.addEventListener('resize', updateSurface);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateSurface);
      window.visualViewport?.removeEventListener('resize', updateSurface);
      unsubscribe();
      releasePointerButtons();
      releaseHardwareKeys();
      for (const modifier of stickyModifiersRef.current) {
        sendControl({ type: 'key', code: MODIFIER_CODES[modifier], down: false, modifiers: [] });
      }
      stickyModifiersRef.current = new Set();
      if (presentationAdapterRef.current === presentationAdapter) presentationAdapterRef.current = null;
      presentationAdapter.attachVideo(null);
      presentationAdapter.dispose();
    };
  }, [presentationAdapter, releaseHardwareKeys, releasePointerButtons, sendControl]);

  useEffect(() => {
    presentationAdapter.setQualityPreference(qualityPreference);
  }, [presentationAdapter, qualityPreference]);

  useEffect(() => {
    const preferences: StoredPreferences = {
      version: 2,
      inputMode: mode,
      qualityPreference,
      handleEdge,
      handleY,
    };
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
    window.localStorage.removeItem(LEGACY_INPUT_MODE_STORAGE_KEY);
  }, [handleEdge, handleY, mode, qualityPreference]);

  useEffect(() => {
    if (keyboardOpen) {
      inputRef.current?.focus();
      return;
    }
    if (started && phase === 'active' && !needsResume && !sheetOpen) {
      viewportRef.current?.focus({ preventScroll: true });
    }
  }, [keyboardOpen, needsResume, phase, sheetOpen, started]);

  useEffect(() => {
    const onWindowBlur = (): void => releaseAllInput();
    window.addEventListener('blur', onWindowBlur);
    return () => window.removeEventListener('blur', onWindowBlur);
  }, [releaseAllInput]);

  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState !== 'hidden') return;
      releaseAllInput();
      setNeedsResume(started);
      setSheetOpen(false);
      setKeyboardOpen(false);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [releaseAllInput, started]);

  useEffect(() => {
    if (started && phase !== 'active') releaseAllInput();
  }, [phase, releaseAllInput, started]);

  let detail = '';
  const detailState: DesktopPresentationDetail = presentation.detail;
  if (detailState?.kind === 'busy') {
    detail = t('mobile.pcControl.busy', { device: detailState.controllerName ?? t('common.unavailable') });
  } else if (detailState?.kind === 'start-error') {
    detail = t(startErrorKey(detailState.errorCode));
  } else if (detailState?.kind === 'start-failed') {
    detail = t('mobile.pcControl.startFailed');
  } else if (detailState?.kind === 'negotiation-failed') {
    detail = t('mobile.pcControl.negotiationFailed');
  } else if (detailState?.kind === 'ended') {
    detail = t(`mobile.pcControl.endReason.${detailState.reason}`);
  }

  const clipboardStatus = presentation.clipboardFeedback === 'sent'
    ? t('mobile.pcControl.clipboardSent')
    : presentation.clipboardFeedback === 'copied'
      ? t('mobile.pcControl.clipboardCopied')
      : presentation.clipboardFeedback === 'permission'
        ? t('mobile.pcControl.clipboardPermission')
        : presentation.clipboardFeedback === 'invalid'
          ? t('mobile.pcControl.clipboardInvalid')
          : presentation.clipboardFeedback === 'input-unavailable'
            ? t('mobile.pcControl.inputUnavailable')
            : '';

  const startSession = (): void => {
    publishView(viewRef.current);
    presentationAdapter.setQualityPreference(qualityPreference);
    setStarted(true);
    setNeedsResume(false);
    presentationAdapter.start();
  };

  const resumeSession = (): void => {
    releaseAllInput();
    publishView(viewRef.current);
    setNeedsResume(false);
    presentationAdapter.resume();
  };

  const close = (): void => {
    releaseAllInput();
    presentationAdapterRef.current?.stop('client-stop');
    if (started) showToast(t('mobile.pcControl.endedToast'));
    onClose();
  };

  const selectMode = (next: InputMode): void => {
    releaseAllInput();
    setMode(next);
    showToast(next === 'trackpad'
      ? t('mobile.pcControl.trackpadToast')
      : t('mobile.pcControl.directToast'));
  };

  const pointFor = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return mapRemotePoint(
      clientX - rect.left,
      clientY - rect.top,
      viewRef.current,
      { width: rect.width, height: rect.height },
      displaySize,
    );
  };

  const directInputPending = capabilities?.adaptiveRegion === true
    && view.zoom > 1
    && (appliedView?.revision ?? 0) < latestRequestedRevision;

  const beginLongPress = (pointerId: number): void => {
    const timer = window.setTimeout(() => {
      const record = pointersRef.current.get(pointerId);
      if (!record || record.moved || record.suppressTap || pointersRef.current.size !== 1) return;
      const point = pointFor(record.x, record.y);
      if (mode === 'direct' && (!point || directInputPending)) return;
      if (point && mode === 'direct') sendPointer({ type: 'pointer-absolute', ...point });
      record.longPressTriggered = true;
      sendControl({ type: 'pointer-click', button: 'right', count: 1 });
    }, LONG_PRESS_MS);
    holdTimersRef.current.set(pointerId, timer);
  };

  const startMultiGesture = (): void => {
    const records = [...pointersRef.current.values()];
    for (const record of records) {
      record.suppressTap = true;
      if (record.buttonDown) {
        sendControl({ type: 'pointer-button', button: record.button, down: false });
        record.buttonDown = false;
      }
    }
    for (const pointerId of pointersRef.current.keys()) clearHoldTimer(pointerId);
    const centerX = records.reduce((sum, record) => sum + record.x, 0) / records.length;
    const centerY = records.reduce((sum, record) => sum + record.y, 0) / records.length;
    const distance = records.length >= 2
      ? Math.hypot(records[0].x - records[1].x, records[0].y - records[1].y)
      : 0;
    multiGestureRef.current = {
      kind: records.length >= 3 ? 'three' : 'two',
      startedAt: performance.now(),
      startCenterX: centerX,
      startCenterY: centerY,
      lastCenterX: centerX,
      lastCenterY: centerY,
      startDistance: distance,
      startView: viewRef.current,
      moved: false,
      pinching: false,
    };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!started || phase !== 'active' || needsResume || sheetOpen) return;
    const button = mouseButton(event.button);
    if (!button) return;
    if (!keyboardOpen) event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const previousTap = lastTapRef.current;
    const dragCandidate = previousTap !== null
      && performance.now() - previousTap.at <= DOUBLE_TAP_MS
      && Math.hypot(event.clientX - previousTap.x, event.clientY - previousTap.y)
        <= DOUBLE_TAP_DISTANCE_PX;
    const record: PointerRecord = {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: performance.now(),
      pointerType: event.pointerType,
      button,
      moved: false,
      buttonDown: false,
      longPressTriggered: false,
      dragCandidate,
      suppressTap: false,
    };
    pointersRef.current.set(event.pointerId, record);
    if (pointersRef.current.size >= 2) {
      startMultiGesture();
      return;
    }

    const point = pointFor(event.clientX, event.clientY);
    if (event.pointerType === 'mouse') {
      mousePositionRef.current = { x: event.clientX, y: event.clientY };
      if (mode === 'direct') {
        if (!point || directInputPending) return;
        sendPointer({ type: 'pointer-absolute', ...point });
        record.buttonDown = sendControl({
          type: 'pointer-button',
          button,
          down: true,
          x: point.x,
          y: point.y,
        });
      } else {
        record.buttonDown = sendControl({
          type: 'pointer-button',
          button,
          down: true,
        });
      }
      return;
    }
    if (mode === 'direct' && point && !directInputPending) {
      sendPointer({ type: 'pointer-absolute', ...point });
    }
    beginLongPress(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!started || phase !== 'active' || needsResume || sheetOpen) return;
    const record = pointersRef.current.get(event.pointerId);
    if (!record && event.pointerType === 'mouse') {
      const previous = mousePositionRef.current;
      mousePositionRef.current = { x: event.clientX, y: event.clientY };
      if (mode === 'direct') {
        const point = pointFor(event.clientX, event.clientY);
        if (point && !directInputPending) sendPointer({ type: 'pointer-absolute', ...point });
      } else if (previous) {
        const delta = relativeRemoteDelta(
          event.clientX - previous.x,
          event.clientY - previous.y,
          viewRef.current,
          surfaceSize,
          displaySize,
        );
        if (delta.dx !== 0 || delta.dy !== 0) sendPointer({ type: 'pointer-relative', ...delta });
      }
      return;
    }
    if (!record) return;
    const dx = event.clientX - record.x;
    const dy = event.clientY - record.y;
    record.x = event.clientX;
    record.y = event.clientY;
    if (Math.hypot(event.clientX - record.startX, event.clientY - record.startY) >= TAP_MOVE_PX) {
      record.moved = true;
      clearHoldTimer(event.pointerId);
    }

    const multi = multiGestureRef.current;
    if (multi) {
      const records = [...pointersRef.current.values()];
      if (records.length < 2) return;
      const centerX = records.reduce((sum, item) => sum + item.x, 0) / records.length;
      const centerY = records.reduce((sum, item) => sum + item.y, 0) / records.length;
      if (records.length >= 3 || multi.kind === 'three') {
        multi.kind = 'three';
        const centerDx = centerX - multi.lastCenterX;
        const centerDy = centerY - multi.lastCenterY;
        if (Math.hypot(centerDx, centerDy) >= 1) {
          sendControl({
            type: 'wheel',
            deltaX: (centerDx / 48) * 120,
            deltaY: (centerDy / 48) * 120,
          });
          multi.moved = true;
        }
      } else {
        const distance = Math.hypot(records[0].x - records[1].x, records[0].y - records[1].y);
        if (Math.abs(distance - multi.startDistance) >= 6 || multi.pinching) {
          multi.pinching = true;
          const rect = viewportRef.current?.getBoundingClientRect();
          if (rect && multi.startDistance > 0) {
            updateView(zoomRemoteViewAt(
              multi.startView,
              multi.startView.zoom * (distance / multi.startDistance),
              centerX - rect.left,
              centerY - rect.top,
              { width: rect.width, height: rect.height },
              displaySize,
            ));
          }
        } else if (viewRef.current.zoom > 1) {
          const rect = viewportRef.current?.getBoundingClientRect();
          if (rect) {
            updateView(panRemoteView(
              viewRef.current,
              centerX - multi.lastCenterX,
              centerY - multi.lastCenterY,
              { width: rect.width, height: rect.height },
              displaySize,
            ));
          }
        }
        multi.moved = multi.moved
          || Math.hypot(centerX - multi.startCenterX, centerY - multi.startCenterY) >= TAP_MOVE_PX
          || Math.abs(distance - multi.startDistance) >= TAP_MOVE_PX;
      }
      multi.lastCenterX = centerX;
      multi.lastCenterY = centerY;
      return;
    }

    const point = pointFor(event.clientX, event.clientY);
    if (record.pointerType === 'mouse') {
      mousePositionRef.current = { x: event.clientX, y: event.clientY };
      if (mode === 'direct') {
        if (point && !directInputPending) sendPointer({ type: 'pointer-absolute', ...point });
      } else {
        const delta = relativeRemoteDelta(dx, dy, viewRef.current, surfaceSize, displaySize);
        if (delta.dx !== 0 || delta.dy !== 0) sendPointer({ type: 'pointer-relative', ...delta });
      }
      return;
    }
    if (record.dragCandidate && record.moved && !record.buttonDown) {
      if (mode === 'direct' && (!point || directInputPending)) return;
      if (mode === 'direct' && point) sendPointer({ type: 'pointer-absolute', ...point });
      record.buttonDown = sendControl({
        type: 'pointer-button',
        button: 'left',
        down: true,
        ...(mode === 'direct' && point ? { x: point.x, y: point.y } : {}),
      });
    }
    if (mode === 'direct') {
      if (point && !directInputPending) sendPointer({ type: 'pointer-absolute', ...point });
    } else {
      const delta = relativeRemoteDelta(dx, dy, viewRef.current, surfaceSize, displaySize);
      sendPointer({ type: 'pointer-relative', ...delta });
    }
  };

  const finishMultiGesture = (): void => {
    const gesture = multiGestureRef.current;
    if (!gesture) return;
    if (
      gesture.kind === 'two'
      && !gesture.moved
      && performance.now() - gesture.startedAt <= TAP_MAX_MS
    ) {
      const previous = lastTwoFingerTapRef.current;
      const centerX = gesture.startCenterX;
      const centerY = gesture.startCenterY;
      if (
        previous
        && performance.now() - previous.at <= DOUBLE_TAP_MS
        && Math.hypot(centerX - previous.x, centerY - previous.y) <= DOUBLE_TAP_DISTANCE_PX
      ) {
        const rect = viewportRef.current?.getBoundingClientRect();
        if (rect) {
          const next = viewRef.current.zoom > 1
            ? FIT_REMOTE_VIEW
            : zoomRemoteViewAt(
                viewRef.current,
                2,
                centerX - rect.left,
                centerY - rect.top,
                { width: rect.width, height: rect.height },
                displaySize,
              );
          updateView(next);
          publishView(next);
        }
        lastTwoFingerTapRef.current = null;
      } else {
        lastTwoFingerTapRef.current = { at: performance.now(), x: centerX, y: centerY };
      }
    } else if (gesture.kind === 'two') {
      publishView(viewRef.current);
    }
    multiGestureRef.current = null;
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const record = pointersRef.current.get(event.pointerId);
    clearHoldTimer(event.pointerId);
    pointersRef.current.delete(event.pointerId);
    if (!record) return;
    if (record.pointerType === 'mouse') {
      mousePositionRef.current = { x: event.clientX, y: event.clientY };
    }
    if (record.suppressTap || multiGestureRef.current) {
      if (pointersRef.current.size === 0) finishMultiGesture();
      return;
    }
    const point = pointFor(event.clientX, event.clientY);
    if (record.buttonDown) {
      sendControl({
        type: 'pointer-button',
        button: record.button,
        down: false,
        ...(mode === 'direct' && point ? { x: point.x, y: point.y } : {}),
      });
      lastTapRef.current = null;
      return;
    }
    if (record.longPressTriggered) return;
    const isTap = Math.hypot(event.clientX - record.startX, event.clientY - record.startY) < TAP_MOVE_PX
      && performance.now() - record.startedAt <= TAP_MAX_MS;
    if (!isTap || (mode === 'direct' && (!point || directInputPending))) return;
    if (mode === 'direct' && point) sendPointer({ type: 'pointer-absolute', ...point });
    sendControl({ type: 'pointer-click', button: record.button, count: 1 });
    lastTapRef.current = record.dragCandidate
      ? null
      : { at: performance.now(), x: event.clientX, y: event.clientY };
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const record = pointersRef.current.get(event.pointerId);
    clearHoldTimer(event.pointerId);
    pointersRef.current.delete(event.pointerId);
    if (record?.buttonDown) {
      sendControl({ type: 'pointer-button', button: record.button, down: false });
    }
    if (record?.pointerType === 'mouse') mousePositionRef.current = null;
    if (pointersRef.current.size === 0) multiGestureRef.current = null;
  };

  const remoteKeyCode = (event: ReactKeyboardEvent<HTMLElement>): string | null => {
    const code = event.code && event.code !== 'Unidentified' ? event.code : event.key;
    return SUPPORTED_REMOTE_KEY_CODES.has(code) ? code : null;
  };

  const onRemoteKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (!started || phase !== 'active' || needsResume || sheetOpen || event.nativeEvent.isComposing) return;
    const code = remoteKeyCode(event);
    if (!code) return;
    event.preventDefault();
    if (sendControl({ type: 'key', code, down: true, modifiers: [] })) {
      pressedHardwareKeysRef.current.add(code);
    }
  };

  const onRemoteKeyUp = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (!started || phase !== 'active' || needsResume || sheetOpen || event.nativeEvent.isComposing) return;
    const code = remoteKeyCode(event);
    if (!code) return;
    event.preventDefault();
    sendControl({ type: 'key', code, down: false, modifiers: [] });
    pressedHardwareKeysRef.current.delete(code);
  };

  const sendKey = (code: string): void => {
    sendControl({ type: 'key', code, down: true, modifiers: [] });
    sendControl({ type: 'key', code, down: false, modifiers: [] });
  };

  const toggleModifier = (modifier: DesktopKeyModifier): void => {
    const next = new Set(stickyModifiers);
    const down = !next.has(modifier);
    if (down) next.add(modifier);
    else next.delete(modifier);
    if (sendControl({ type: 'key', code: MODIFIER_CODES[modifier], down, modifiers: [] })) {
      stickyModifiersRef.current = next;
      setStickyModifiers(next);
    }
  };

  const fitView = (): void => {
    updateView(FIT_REMOTE_VIEW);
    publishView(FIT_REMOTE_VIEW);
  };

  const sourceRegion = appliedView?.sourceRegion ?? FULL_REGION;
  const layout = remoteVideoLayout(sourceRegion, view, surfaceSize, displaySize);
  const videoStyle: CSSProperties = {
    left: `${layout.left}px`,
    top: `${layout.top}px`,
    width: `${layout.width}px`,
    height: `${layout.height}px`,
  };
  const stateLabel = !started
    ? t('mobile.pcControl.readyToStart')
    : t(`mobile.pcControl.state.${phase}`);
  const metrics = [
    status?.streamWidth && status.streamHeight ? `${status.streamWidth}×${status.streamHeight}` : null,
    status?.framesPerSecond !== undefined ? `${Math.round(status.framesPerSecond)} fps` : null,
    status?.roundTripTimeMs !== undefined ? `${status.roundTripTimeMs} ms` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="mobile-pc-control mobile-pc-control--immersive" data-testid="mobile-pc-control">
      <div
        ref={viewportRef}
        className="mobile-pc-video-viewport"
        role="application"
        aria-label={t('mobile.pcControl.videoLabel')}
        aria-describedby="mobile-pc-gesture-help"
        tabIndex={started && phase === 'active' && !needsResume ? 0 : -1}
        onBlur={() => releaseAllInput()}
        onKeyDown={onRemoteKeyDown}
        onKeyUp={onRemoteKeyUp}
        onContextMenu={(event) => {
          if (started && phase === 'active' && !needsResume && !sheetOpen) event.preventDefault();
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={(event) => {
          if (event.pointerType === 'mouse' && !pointersRef.current.has(event.pointerId)) {
            mousePositionRef.current = null;
          }
        }}
        onWheel={(event) => {
          if (!started || phase !== 'active' || needsResume || sheetOpen) return;
          event.preventDefault();
          sendControl({ type: 'wheel', deltaX: event.deltaX, deltaY: event.deltaY });
        }}
      >
        <video
          ref={videoRef}
          className="mobile-pc-video"
          style={videoStyle}
          playsInline
          muted
          data-testid="mobile-pc-video"
        />
        {(!started || phase !== 'active' || needsResume) && (
          <div className="mobile-pc-overlay">
            <span
              className={phase === 'error' || phase === 'busy' ? 'mob-pc-status mob-pc-status--error' : 'mob-pc-status'}
              role="status"
              aria-live="polite"
              data-phase={!started ? 'idle' : phase}
              data-testid="mobile-pc-state"
            >
              {phase === 'reconnecting'
                ? <RefreshCw aria-hidden="true" />
                : !started
                  ? <Monitor aria-hidden="true" />
                  : <WifiOff aria-hidden="true" />}
              {stateLabel}
            </span>
            {hostLabel && <strong>{hostLabel}</strong>}
            {detail && <p>{detail}</p>}
            {!started ? (
              <button
                type="button"
                className="mob-btn-primary mobile-pc-start"
                data-testid="mobile-pc-start"
                onClick={startSession}
              >
                {t('mobile.pcControl.start')}
              </button>
            ) : needsResume ? (
              <button type="button" className="mob-btn-primary mobile-pc-start" onClick={resumeSession}>
                {t('mobile.pcControl.resume')}
              </button>
            ) : (phase === 'error' || phase === 'busy') ? (
              <button type="button" className="mob-btn-primary mobile-pc-start" onClick={resumeSession}>
                {t('common.retry')}
              </button>
            ) : null}
            <button type="button" className="mob-pc-back" onClick={close} aria-label={t('common.back')}>
              <ArrowLeft aria-hidden="true" />
            </button>
          </div>
        )}
        <span id="mobile-pc-gesture-help" className="sr-only">
          {mode === 'trackpad' ? t('mobile.pcControl.trackpadHelp') : t('mobile.pcControl.directHelp')}
        </span>
      </div>

      {started && (phase === 'active' || phase === 'reconnecting') && (
        <button
          ref={handleRef}
          type="button"
          className={`mobile-pc-session-handle mobile-pc-session-handle--${handleEdge}`}
          style={{ '--mobile-pc-handle-y': `${handleY * 100}%` } as CSSProperties}
          aria-label={`${t('mobile.pcControl.sessionMenu')}: ${stateLabel}`}
          data-phase={phase}
          data-testid="mobile-pc-session-handle"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            handleDragRef.current = { startX: event.clientX, startY: event.clientY, moved: false };
          }}
          onPointerMove={(event) => {
            const drag = handleDragRef.current;
            if (!drag) return;
            if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= TAP_MOVE_PX) {
              drag.moved = true;
              setHandleY(Math.min(0.92, Math.max(0.08, event.clientY / window.innerHeight)));
            }
          }}
          onPointerUp={(event) => {
            const drag = handleDragRef.current;
            handleDragRef.current = null;
            if (!drag?.moved) {
              releaseAllInput();
              setSheetOpen(true);
            } else {
              setHandleEdge(event.clientX < window.innerWidth / 2 ? 'left' : 'right');
            }
          }}
        >
          <Settings2 aria-hidden="true" />
          <span className="mobile-pc-session-handle__state" aria-hidden="true" />
        </button>
      )}

      {keyboardOpen && started && phase === 'active' && (
        <div className="mobile-pc-key-accessory" role="toolbar" aria-label={t('mobile.pcControl.specialKeys')}>
          {(['control', 'alt', 'shift', 'meta'] as const).map((modifier) => (
            <button
              key={modifier}
              type="button"
              aria-pressed={stickyModifiers.has(modifier)}
              onClick={() => toggleModifier(modifier)}
            >
              {modifier === 'control' ? 'Ctrl' : modifier === 'meta' ? 'Win' : modifier[0].toUpperCase() + modifier.slice(1)}
            </button>
          ))}
          {['Escape', 'Tab', 'Enter', 'Delete', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight'].map((code) => (
            <button key={code} type="button" onClick={() => sendKey(code)}>
              {code.replace('Arrow', '')}
            </button>
          ))}
          <button type="button" aria-pressed={extrasOpen} onClick={() => setExtrasOpen((open) => !open)}>
            <MoreHorizontal aria-hidden="true" /><span className="sr-only">{t('mobile.pcControl.functionKeys')}</span>
          </button>
          {extrasOpen && Array.from({ length: 12 }, (_, index) => `F${index + 1}`).map((code) => (
            <button key={code} type="button" onClick={() => sendKey(code)}>{code}</button>
          ))}
        </div>
      )}

      <input
        ref={inputRef}
        className={keyboardOpen ? 'mobile-pc-ime' : 'mobile-pc-ime mobile-pc-ime--closed'}
        aria-label={t('mobile.pcControl.textInput')}
        autoCapitalize="none"
        autoCorrect="off"
        onInput={(event) => {
          const input = event.currentTarget;
          if (
            input.value
            && started
            && phase === 'active'
            && !needsResume
            && !sheetOpen
          ) sendControl({ type: 'text', text: input.value });
          input.value = '';
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) return;
          onRemoteKeyDown(event);
        }}
        onKeyUp={(event) => {
          if (event.nativeEvent.isComposing) return;
          const code = remoteKeyCode(event);
          if (
            event.key.length === 1
            && !event.ctrlKey
            && !event.altKey
            && !event.metaKey
            && (!code || !pressedHardwareKeysRef.current.has(code))
          ) return;
          onRemoteKeyUp(event);
        }}
        onBlur={releaseHardwareKeys}
      />

      {sheetOpen && (
        <MobileActionSheet
          title={hostLabel || t('mobile.pcControl.title')}
          description={clipboardStatus || metrics || stateLabel}
          onClose={() => setSheetOpen(false)}
          returnFocusRef={viewportRef}
          testId="mobile-pc-session-sheet"
          backdropTestId="mobile-pc-session-sheet-backdrop"
          className="mobile-pc-session-sheet"
        >
          <section className="mobile-pc-sheet-section" aria-labelledby="mobile-pc-input-heading">
            <h3 id="mobile-pc-input-heading">{t('mobile.pcControl.inputMode')}</h3>
            <div className="mobile-pc-sheet-segment">
              <button type="button" aria-pressed={mode === 'trackpad'} onClick={() => selectMode('trackpad')}>
                <Touchpad aria-hidden="true" />{t('mobile.pcControl.precisionPointer')}
              </button>
              <button
                type="button"
                aria-pressed={mode === 'direct'}
                disabled={!capabilities?.directTouch}
                onClick={() => selectMode('direct')}
              >
                <MousePointer2 aria-hidden="true" />{t('mobile.pcControl.directShort')}
              </button>
            </div>
          </section>

          <section className="mobile-pc-sheet-section" aria-labelledby="mobile-pc-view-heading">
            <h3 id="mobile-pc-view-heading">{t('mobile.pcControl.view')}</h3>
            {displays.length > 1 && (
              <label className="mobile-pc-sheet-field">
                <span><Monitor aria-hidden="true" />{t('mobile.pcControl.monitor')}</span>
                <select
                  value={selectedDisplayId ?? displays[0]?.id ?? ''}
                  onChange={(event) => {
                    releaseAllInput();
                    presentationAdapter.selectDisplay(event.target.value);
                    fitView();
                  }}
                >
                  {displays.map((display) => <option key={display.id} value={display.id}>{display.name}</option>)}
                </select>
              </label>
            )}
            <button type="button" className="mobile-action-sheet-row" onClick={fitView}>
              <span className="mobile-action-sheet-row-copy">
                <span className="mobile-action-sheet-row-label"><Maximize2 aria-hidden="true" />{t('mobile.pcControl.fit')}</span>
                <span className="mobile-action-sheet-row-hint">{Math.round(view.zoom * 100)}%</span>
              </span>
            </button>
          </section>

          <section className="mobile-pc-sheet-section" aria-labelledby="mobile-pc-quality-heading">
            <h3 id="mobile-pc-quality-heading">{t('mobile.pcControl.quality')}</h3>
            {capabilities?.qualityPreferences ? (
              <div className="mobile-pc-quality-options">
                {(['balanced', 'clarity', 'responsiveness'] as const).map((preference) => (
                  <button
                    key={preference}
                    type="button"
                    aria-pressed={qualityPreference === preference}
                    onClick={() => setQualityPreference(preference)}
                  >
                    {t(`mobile.pcControl.qualityPreference.${preference}`)}
                  </button>
                ))}
              </div>
            ) : (
              <p className="mobile-pc-sheet-note">{t('mobile.pcControl.qualityUpdateRequired')}</p>
            )}
          </section>

          <section className="mobile-pc-sheet-section" aria-labelledby="mobile-pc-tools-heading">
            <h3 id="mobile-pc-tools-heading">{t('mobile.pcControl.tools')}</h3>
            <button
              type="button"
              className="mobile-action-sheet-row"
              aria-pressed={keyboardOpen}
              onClick={() => {
                setKeyboardOpen(true);
                setSheetOpen(false);
              }}
            >
              <span className="mobile-action-sheet-row-label"><Keyboard aria-hidden="true" />{t('mobile.pcControl.keyboard')}</span>
            </button>
            <button type="button" className="mobile-action-sheet-row" onClick={() => void presentationAdapter.sendLocalClipboard()}>
              <span className="mobile-action-sheet-row-label"><ClipboardPaste aria-hidden="true" />{t('mobile.pcControl.sendClipboard')}</span>
            </button>
            <button type="button" className="mobile-action-sheet-row" onClick={() => presentationAdapter.copyRemoteClipboard()}>
              <span className="mobile-action-sheet-row-label"><ClipboardCopy aria-hidden="true" />{t('mobile.pcControl.copyClipboard')}</span>
            </button>
          </section>

          <details className="mobile-pc-connection-details">
            <summary>{t('mobile.pcControl.connectionDetails')}</summary>
            <dl>
              <div><dt>{t('mobile.pcControl.stream')}</dt><dd>{metrics || t('common.unavailable')}</dd></div>
              <div><dt>{t('mobile.pcControl.loss')}</dt><dd>{status?.packetLossPercent !== undefined ? `${status.packetLossPercent.toFixed(1)}%` : '—'}</dd></div>
              <div><dt>{t('mobile.pcControl.bitrate')}</dt><dd>{status?.bitrateKbps !== undefined ? `${Math.round(status.bitrateKbps)} kbps` : '—'}</dd></div>
              <div><dt>{t('mobile.pcControl.decoderDrops')}</dt><dd>{status?.clientDroppedFramePercent !== undefined ? `${status.clientDroppedFramePercent.toFixed(1)}%` : '—'}</dd></div>
              <div><dt>{t('mobile.pcControl.backend')}</dt><dd>{[status?.captureBackend, status?.encoderBackend].filter(Boolean).join(' / ') || '—'}</dd></div>
            </dl>
          </details>

          <button type="button" className="mobile-action-sheet-row mobile-action-sheet-row--danger mobile-pc-disconnect" onClick={close}>
            <span className="mobile-action-sheet-row-label"><Power aria-hidden="true" />{t('mobile.pcControl.disconnect')}</span>
          </button>
        </MobileActionSheet>
      )}
    </div>
  );
}
