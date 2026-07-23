import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Clipboard } from '@capacitor/clipboard';
import { ArrowLeft, ClipboardCopy, ClipboardPaste, Keyboard, Monitor, MousePointer2, Power, Touchpad } from 'lucide-react';

import { useAppTranslation } from '../../src/renderer/i18n';
import {
  INITIAL_DESKTOP_PRESENTATION_SNAPSHOT,
  RemoteDesktopPresentationAdapter,
  type DesktopControlCommand,
  type DesktopKeyModifier,
  type DesktopPresentationAdapter,
  type DesktopPresentationDetail,
  type DesktopPointerCommand,
} from './remote-desktop-presentation-adapter';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';

type InputMode = 'trackpad' | 'direct';

interface PointerRecord {
  x: number;
  y: number;
  startX: number;
  startY: number;
  startedAt: number;
  moved: boolean;
  buttonDown: boolean;
  longPressTriggered: boolean;
  dragCandidate: boolean;
  suppressTap: boolean;
  absoluteX: number;
  absoluteY: number;
}

const INPUT_MODE_STORAGE_KEY = 'ezterminal.pcControl.inputMode';
const TAP_MAX_MS = 350;
const TAP_MOVE_PX = 8;
const LONG_PRESS_MS = 550;
const DOUBLE_TAP_MS = 350;

interface TwoFingerGesture {
  readonly startedAt: number;
  readonly startCenterX: number;
  readonly startCenterY: number;
  readonly startDistance: number;
  lastCenterX: number;
  lastCenterY: number;
  lastDistance: number;
  moved: boolean;
  pinching: boolean;
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Maps through object-fit:contain and the centered client-side zoom. */
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

function createPresentationAdapter(
  transport: WsEzTerminalTransport,
): DesktopPresentationAdapter {
  return new RemoteDesktopPresentationAdapter(transport, {
    clipboard: {
      readText: async () => (await Clipboard.read()).value,
      writeText: async (text) => {
        await Clipboard.write({ string: text });
      },
    },
    visibility: {
      isHidden: () => document.visibilityState === 'hidden',
      subscribe: (listener) => {
        document.addEventListener('visibilitychange', listener);
        return () => document.removeEventListener('visibilitychange', listener);
      },
    },
    createPeerConnection: () => {
      if (typeof RTCPeerConnection !== 'function') {
        throw new Error('WebRTC is unavailable');
      }
      return new RTCPeerConnection({ iceServers: [] });
    },
  });
}

export interface MobileRemoteDesktopViewProps {
  readonly transport: WsEzTerminalTransport;
  readonly onClose: () => void;
  readonly presentationAdapterFactory?: (
    transport: WsEzTerminalTransport,
  ) => DesktopPresentationAdapter;
}

export function MobileRemoteDesktopView({
  transport,
  onClose,
  presentationAdapterFactory = createPresentationAdapter,
}: MobileRemoteDesktopViewProps): JSX.Element {
  const { t } = useAppTranslation();
  const presentationAdapter = useMemo(
    () => presentationAdapterFactory(transport),
    [presentationAdapterFactory, transport],
  );
  const [presentation, setPresentation] = useState(
    INITIAL_DESKTOP_PRESENTATION_SNAPSHOT,
  );
  const presentationAdapterRef = useRef<DesktopPresentationAdapter | null>(null);
  const {
    capabilities,
    displays,
    phase,
    selectedDisplayId,
    status,
  } = presentation;
  const [mode, setMode] = useState<InputMode>(() => (
    window.localStorage.getItem(INPUT_MODE_STORAGE_KEY) === 'direct' ? 'direct' : 'trackpad'
  ));
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pointersRef = useRef(new Map<number, PointerRecord>());
  const twoFingerRef = useRef<TwoFingerGesture | null>(null);
  const holdTimersRef = useRef(new Map<number, number>());
  const lastTrackpadTapRef = useRef<{ at: number; x: number; y: number } | null>(null);

  let detail = '';
  const detailState: DesktopPresentationDetail = presentation.detail;
  if (detailState?.kind === 'busy') {
    detail = t('mobile.pcControl.busy', {
      device: detailState.controllerName ?? t('common.unavailable'),
    });
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

  useEffect(() => {
    window.localStorage.setItem(INPUT_MODE_STORAGE_KEY, mode);
  }, [mode]);

  const sendControl = useCallback(
    (payload: DesktopControlCommand): boolean => (
      presentationAdapterRef.current?.sendControl(payload) ?? false
    ),
    [],
  );

  const sendPointer = useCallback(
    (payload: DesktopPointerCommand): boolean => (
      presentationAdapterRef.current?.sendPointer(payload) ?? false
    ),
    [],
  );

  const clearHoldTimer = useCallback((pointerId: number): void => {
    const timer = holdTimersRef.current.get(pointerId);
    if (timer !== undefined) window.clearTimeout(timer);
    holdTimersRef.current.delete(pointerId);
  }, []);

  const pointFor = useCallback((
    clientX: number,
    clientY: number,
    viewport: HTMLDivElement,
  ): { x: number; y: number } => {
    const selected = displays.find((display) => display.id === selectedDisplayId)
      ?? displays[0];
    const video = videoRef.current;
    return mapVideoPoint(
      clientX,
      clientY,
      viewport.getBoundingClientRect(),
      video?.videoWidth || selected?.width || viewport.clientWidth,
      video?.videoHeight || selected?.height || viewport.clientHeight,
      zoom,
    );
  }, [displays, selectedDisplayId, zoom]);

  useEffect(() => {
    const holdTimers = holdTimersRef.current;
    presentationAdapterRef.current = presentationAdapter;
    const publishSnapshot = (): void => {
      setPresentation(presentationAdapter.getSnapshot());
    };
    const unsubscribe = presentationAdapter.subscribe(publishSnapshot);
    presentationAdapter.attachVideo(videoRef.current);
    presentationAdapter.start();
    publishSnapshot();
    return () => {
      unsubscribe();
      if (presentationAdapterRef.current === presentationAdapter) {
        presentationAdapterRef.current = null;
      }
      presentationAdapter.attachVideo(null);
      presentationAdapter.dispose();
      for (const timer of holdTimers.values()) window.clearTimeout(timer);
      holdTimers.clear();
    };
  }, [presentationAdapter]);

  useEffect(() => {
    if (keyboardOpen) inputRef.current?.focus();
  }, [keyboardOpen]);

  const close = (): void => {
    presentationAdapterRef.current?.stop('client-stop');
    onClose();
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const absolute = pointFor(event.clientX, event.clientY, event.currentTarget);
    const previousTap = lastTrackpadTapRef.current;
    const dragCandidate = mode === 'trackpad'
      && previousTap !== null
      && performance.now() - previousTap.at <= DOUBLE_TAP_MS
      && Math.hypot(event.clientX - previousTap.x, event.clientY - previousTap.y) <= 24;
    const record: PointerRecord = {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: performance.now(),
      moved: false,
      buttonDown: false,
      longPressTriggered: false,
      dragCandidate,
      suppressTap: false,
      absoluteX: absolute.x,
      absoluteY: absolute.y,
    };
    pointersRef.current.set(event.pointerId, record);

    const pointers = [...pointersRef.current.values()];
    if (pointers.length === 2) {
      for (const pointer of pointers) {
        pointer.suppressTap = true;
        if (pointer.buttonDown) {
          sendControl({ type: 'pointer-button', button: 'left', down: false });
          pointer.buttonDown = false;
        }
      }
      for (const pointerId of pointersRef.current.keys()) clearHoldTimer(pointerId);
      const centerX = (pointers[0].x + pointers[1].x) / 2;
      const centerY = (pointers[0].y + pointers[1].y) / 2;
      const distance = Math.hypot(pointers[0].x - pointers[1].x, pointers[0].y - pointers[1].y);
      twoFingerRef.current = {
        startedAt: performance.now(),
        startCenterX: centerX,
        startCenterY: centerY,
        startDistance: distance,
        lastCenterX: centerX,
        lastCenterY: centerY,
        lastDistance: distance,
        moved: false,
        pinching: false,
      };
      return;
    }

    if (event.pointerType === 'mouse') {
      sendControl({
        type: 'pointer-button',
        button: event.button === 2 ? 'right' : 'left',
        down: true,
        x: absolute.x,
        y: absolute.y,
      });
      record.buttonDown = true;
      return;
    }

    if (mode === 'direct') {
      sendPointer({ type: 'pointer-absolute', x: absolute.x, y: absolute.y });
      const timer = window.setTimeout(() => {
        const current = pointersRef.current.get(event.pointerId);
        if (!current || current.moved || current.suppressTap || pointersRef.current.size !== 1) return;
        current.longPressTriggered = true;
        sendControl({ type: 'pointer-click', button: 'right', count: 1 });
      }, LONG_PRESS_MS);
      holdTimersRef.current.set(event.pointerId, timer);
    } else if (dragCandidate) {
      const timer = window.setTimeout(() => {
        const current = pointersRef.current.get(event.pointerId);
        if (!current || current.suppressTap || pointersRef.current.size !== 1 || current.buttonDown) return;
        current.buttonDown = sendControl({ type: 'pointer-button', button: 'left', down: true });
      }, 180);
      holdTimersRef.current.set(event.pointerId, timer);
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const record = pointersRef.current.get(event.pointerId);
    if (!record) return;
    const dx = event.clientX - record.x;
    const dy = event.clientY - record.y;
    record.x = event.clientX;
    record.y = event.clientY;
    if (Math.hypot(event.clientX - record.startX, event.clientY - record.startY) >= TAP_MOVE_PX) {
      record.moved = true;
    }
    const points = [...pointersRef.current.values()];
    if (points.length === 2) {
      const gesture = twoFingerRef.current;
      if (!gesture) return;
      const centerX = (points[0].x + points[1].x) / 2;
      const centerY = (points[0].y + points[1].y) / 2;
      const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      const distanceDelta = distance - gesture.lastDistance;
      if (Math.abs(distanceDelta) > 3) {
        gesture.pinching = true;
        if (gesture.lastDistance > 0) {
          setZoom((value) => Math.min(3, Math.max(1, value * (distance / gesture.lastDistance))));
        }
      } else if (!gesture.pinching) {
        const centerDx = centerX - gesture.lastCenterX;
        const centerDy = centerY - gesture.lastCenterY;
        if (Math.hypot(centerDx, centerDy) >= 1) {
          sendControl({ type: 'wheel', deltaX: centerDx * 8, deltaY: centerDy * 8 });
        }
      }
      gesture.moved = gesture.moved
        || Math.hypot(centerX - gesture.startCenterX, centerY - gesture.startCenterY) >= TAP_MOVE_PX
        || Math.abs(distance - gesture.startDistance) >= TAP_MOVE_PX;
      gesture.lastCenterX = centerX;
      gesture.lastCenterY = centerY;
      gesture.lastDistance = distance;
      return;
    }
    if (mode === 'direct') {
      const absolute = pointFor(event.clientX, event.clientY, event.currentTarget);
      record.absoluteX = absolute.x;
      record.absoluteY = absolute.y;
      sendPointer({
        type: 'pointer-absolute',
        x: absolute.x,
        y: absolute.y,
      });
      if (record.moved && !record.longPressTriggered && !record.buttonDown && event.pointerType !== 'mouse') {
        clearHoldTimer(event.pointerId);
        record.buttonDown = sendControl({
          type: 'pointer-button',
          button: 'left',
          down: true,
          x: absolute.x,
          y: absolute.y,
        });
      }
    } else {
      if (record.dragCandidate && record.moved && !record.buttonDown) {
        clearHoldTimer(event.pointerId);
        record.buttonDown = sendControl({ type: 'pointer-button', button: 'left', down: true });
      }
      sendPointer({ type: 'pointer-relative', dx, dy });
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const record = pointersRef.current.get(event.pointerId);
    const gesture = twoFingerRef.current;
    const wasTwoFinger = pointersRef.current.size >= 2 || record?.suppressTap === true;
    clearHoldTimer(event.pointerId);
    pointersRef.current.delete(event.pointerId);
    if (!record) return;
    if (wasTwoFinger) {
      if (gesture
        && !gesture.moved
        && performance.now() - gesture.startedAt <= TAP_MAX_MS) {
        sendControl({ type: 'pointer-click', button: 'right', count: 1 });
      }
      twoFingerRef.current = null;
      return;
    }

    const absolute = pointFor(event.clientX, event.clientY, event.currentTarget);
    if (record.buttonDown) {
      sendControl({
        type: 'pointer-button',
        button: event.button === 2 ? 'right' : 'left',
        down: false,
        ...(mode === 'direct' || event.pointerType === 'mouse'
          ? { x: absolute.x, y: absolute.y }
          : {}),
      });
      return;
    }
    if (record.longPressTriggered) return;
    const moved = Math.hypot(event.clientX - record.startX, event.clientY - record.startY);
    if (moved < TAP_MOVE_PX && performance.now() - record.startedAt < TAP_MAX_MS) {
      if (mode === 'direct' || event.pointerType === 'mouse') {
        sendPointer({ type: 'pointer-absolute', x: absolute.x, y: absolute.y });
      }
      sendControl({ type: 'pointer-click', button: event.button === 2 ? 'right' : 'left', count: 1 });
      if (mode === 'trackpad') {
        lastTrackpadTapRef.current = record.dragCandidate
          ? null
          : { at: performance.now(), x: event.clientX, y: event.clientY };
      }
    }
  };

  const onPointerCancel = (event: React.PointerEvent<HTMLDivElement>): void => {
    const record = pointersRef.current.get(event.pointerId);
    clearHoldTimer(event.pointerId);
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) twoFingerRef.current = null;
    if (record?.buttonDown) {
      // Cancellation is never a click; always release a held remote button.
      sendControl({
        type: 'pointer-button',
        button: event.button === 2 ? 'right' : 'left',
        down: false,
      });
    }
  };

  const sendMobileClipboard = async (): Promise<void> => {
    await presentationAdapterRef.current?.sendLocalClipboard();
  };

  const copyPcClipboard = (): void => {
    presentationAdapterRef.current?.copyRemoteClipboard();
  };

  const sendKey = (code: string, modifiers?: readonly DesktopKeyModifier[]): void => {
    sendControl({ type: 'key', code, down: true, modifiers: modifiers ?? [] });
    sendControl({ type: 'key', code, down: false, modifiers: modifiers ?? [] });
  };

  return (
    <div className="mobile-pc-control" data-testid="mobile-pc-control">
      <header className="mobile-pc-toolbar" aria-label={t('mobile.pcControl.toolbar')}>
        <button type="button" onClick={close} aria-label={t('common.back')}><ArrowLeft /></button>
        <span className={`mobile-pc-state mobile-pc-state--${phase}`} role="status" aria-live="polite">
          {t(`mobile.pcControl.state.${phase}`)}
        </span>
        {displays.length > 1 ? (
          <label className="mobile-pc-display-select">
            <Monitor aria-hidden="true" />
            <span className="sr-only">{t('mobile.pcControl.monitor')}</span>
            <select
              value={selectedDisplayId ?? displays[0]?.id ?? ''}
              onChange={(event) => {
                presentationAdapterRef.current?.selectDisplay(event.target.value);
                setZoom(1);
              }}
            >
              {displays.map((display) => <option key={display.id} value={display.id}>{display.name}</option>)}
            </select>
          </label>
        ) : <Monitor className="mobile-pc-toolbar-icon" aria-hidden="true" />}
        <button
          type="button"
          aria-pressed={mode === 'direct'}
          onClick={() => setMode((current) => current === 'trackpad' ? 'direct' : 'trackpad')}
          aria-label={mode === 'trackpad' ? t('mobile.pcControl.trackpad') : t('mobile.pcControl.direct')}
        >
          {mode === 'trackpad' ? <Touchpad /> : <MousePointer2 />}
        </button>
        <button type="button" aria-pressed={keyboardOpen} onClick={() => setKeyboardOpen((open) => !open)} aria-label={t('mobile.pcControl.keyboard')}>
          <Keyboard />
        </button>
        <button type="button" className="mobile-pc-disconnect" onClick={close} aria-label={t('mobile.pcControl.disconnect')}>
          <Power />
        </button>
      </header>

      <div
        className="mobile-pc-video-viewport"
        role="application"
        aria-label={t('mobile.pcControl.videoLabel')}
        aria-describedby="mobile-pc-gesture-help"
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onWheel={(event) => {
          event.preventDefault();
          sendControl({ type: 'wheel', deltaX: event.deltaX, deltaY: event.deltaY });
        }}
      >
        <video
          ref={videoRef}
          className="mobile-pc-video"
          style={{ transform: `scale(${zoom})` }}
          playsInline
          muted
          data-testid="mobile-pc-video"
        />
        {phase !== 'active' && (
          <div className="mobile-pc-overlay">
            <strong>{t(`mobile.pcControl.state.${phase}`)}</strong>
            {detail && <p>{detail}</p>}
          </div>
        )}
        <span id="mobile-pc-gesture-help" className="sr-only">
          {mode === 'trackpad' ? t('mobile.pcControl.trackpadHelp') : t('mobile.pcControl.directHelp')}
        </span>
      </div>

      <footer className="mobile-pc-actions">
        <button type="button" onClick={() => void sendMobileClipboard()}><ClipboardPaste />{t('mobile.pcControl.sendClipboard')}</button>
        <button type="button" onClick={copyPcClipboard}><ClipboardCopy />{t('mobile.pcControl.copyClipboard')}</button>
        <button type="button" onClick={() => sendKey('Escape')}>Esc</button>
        <button type="button" onClick={() => sendKey('Tab')}>Tab</button>
        <button type="button" onClick={() => sendKey('Enter')}>Enter</button>
        <button
          type="button"
          disabled={!capabilities?.ctrlAltDelete}
          title={!capabilities?.ctrlAltDelete ? t('mobile.pcControl.cadUnavailable') : undefined}
          onClick={() => sendControl({ type: 'secure-attention' })}
        >Ctrl+Alt+Del</button>
      </footer>
      {(clipboardStatus || status) && (
        <div className="mobile-pc-metrics" aria-live="polite">
          {clipboardStatus || [
            status?.framesPerSecond !== undefined ? `${Math.round(status.framesPerSecond)} fps` : null,
            status?.roundTripTimeMs !== undefined ? `${status.roundTripTimeMs} ms` : null,
            status?.qualityTier,
          ].filter(Boolean).join(' · ')}
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
          if (input.value) sendControl({ type: 'text', text: input.value });
          input.value = '';
        }}
        onKeyDown={(event) => {
          if (event.key.length === 1 || event.nativeEvent.isComposing) return;
          event.preventDefault();
          const modifiers: DesktopKeyModifier[] = [];
          if (event.ctrlKey) modifiers.push('control');
          if (event.altKey) modifiers.push('alt');
          if (event.shiftKey) modifiers.push('shift');
          if (event.metaKey) modifiers.push('meta');
          sendKey(event.code || event.key, modifiers);
        }}
      />
    </div>
  );
}
