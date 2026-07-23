import { useCallback, useEffect, useRef, useState } from 'react';
import { Clipboard } from '@capacitor/clipboard';
import { ArrowLeft, ClipboardCopy, ClipboardPaste, Keyboard, Monitor, MousePointer2, Power, Touchpad } from 'lucide-react';

import type {
  DesktopControlCapabilities,
  DesktopControlStatusMessage,
  DesktopDisplay,
} from '../../src/shared/remote-protocol';
import { useAppTranslation } from '../../src/renderer/i18n';
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

const MAX_CLIPBOARD_BYTES = 256 * 1024;
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

export function MobileRemoteDesktopView({
  transport,
  onClose,
}: {
  readonly transport: WsEzTerminalTransport;
  readonly onClose: () => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const [phase, setPhase] = useState<'starting' | 'active' | 'reconnecting' | 'busy' | 'error'>('starting');
  const [detail, setDetail] = useState('');
  const [mode, setMode] = useState<InputMode>(() => (
    window.localStorage.getItem(INPUT_MODE_STORAGE_KEY) === 'direct' ? 'direct' : 'trackpad'
  ));
  const [displays, setDisplays] = useState<readonly DesktopDisplay[]>([]);
  const [selectedDisplayId, setSelectedDisplayId] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<DesktopControlCapabilities | null>(null);
  const [status, setStatus] = useState<DesktopControlStatusMessage | null>(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [clipboardStatus, setClipboardStatus] = useState('');
  const [zoom, setZoom] = useState(1);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const controlRef = useRef<RTCDataChannel | null>(null);
  const pointerRef = useRef<RTCDataChannel | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const sequenceRef = useRef(0);
  const pointersRef = useRef(new Map<number, PointerRecord>());
  const twoFingerRef = useRef<TwoFingerGesture | null>(null);
  const holdTimersRef = useRef(new Map<number, number>());
  const lastTrackpadTapRef = useRef<{ at: number; x: number; y: number } | null>(null);
  const clipboardCopyPendingRef = useRef(false);

  useEffect(() => {
    window.localStorage.setItem(INPUT_MODE_STORAGE_KEY, mode);
  }, [mode]);

  const sendControl = useCallback((payload: Record<string, unknown>): boolean => {
    const channel = controlRef.current;
    const sessionId = sessionIdRef.current;
    if (!channel || channel.readyState !== 'open' || !sessionId) return false;
    channel.send(JSON.stringify({
      ...payload,
      sessionId,
      sequence: ++sequenceRef.current,
    }));
    return true;
  }, []);

  const sendPointer = useCallback((payload: Record<string, unknown>): boolean => {
    const channel = pointerRef.current;
    const sessionId = sessionIdRef.current;
    if (!channel || channel.readyState !== 'open' || !sessionId) return false;
    channel.send(JSON.stringify({
      ...payload,
      sessionId,
      sequence: ++sequenceRef.current,
    }));
    return true;
  }, []);

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
    let disposed = false;
    let negotiating = false;
    let resumePending = false;
    let peerGeneration = 0;
    const holdTimers = holdTimersRef.current;
    const closePeer = (): void => {
      controlRef.current?.close();
      pointerRef.current?.close();
      pcRef.current?.close();
      controlRef.current = null;
      pointerRef.current = null;
      pcRef.current = null;
    };
    const unsubscribeSignal = transport.onDesktopSignal((message) => {
      if (message.sessionId !== sessionIdRef.current) return;
      const pc = pcRef.current;
      if (!pc) return;
      if (message.signal.type === 'answer') {
        void pc.setRemoteDescription({ type: 'answer', sdp: message.signal.sdp }).catch(() => {
          if (!disposed) {
            setPhase('error');
            setDetail(t('mobile.pcControl.negotiationFailed'));
          }
        });
      } else if (message.signal.type === 'ice') {
        void pc.addIceCandidate(message.signal.candidate).catch(() => undefined);
      }
    });
    const unsubscribeStatus = transport.onDesktopStatus((next) => {
      if (next.sessionId !== sessionIdRef.current || disposed) return;
      setStatus(next);
      if (next.displays) setDisplays(next.displays);
      if (next.selectedDisplayId !== undefined) setSelectedDisplayId(next.selectedDisplayId);
      if (next.state === 'active') setPhase('active');
      else if (next.state === 'reconnecting') setPhase('reconnecting');
      else if (next.state === 'error') setPhase('error');
    });
    const unsubscribeEnded = transport.onDesktopEnded((message) => {
      if (message.sessionId !== sessionIdRef.current || disposed) return;
      setPhase('error');
      setDetail(t(`mobile.pcControl.endReason.${message.reason}`));
      closePeer();
    });

    const beginDesktop = async (): Promise<void> => {
      if (disposed || negotiating) return;
      negotiating = true;
      const generation = ++peerGeneration;
      try {
        const result = await transport.startDesktopControl();
        if (disposed || generation !== peerGeneration) return;
        if (!result.ok) {
          setPhase(result.reason === 'busy' ? 'busy' : 'error');
          setDetail(result.reason === 'busy'
            ? t('mobile.pcControl.busy', { device: result.controllerName ?? t('common.unavailable') })
            : t(startErrorKey(result.errorCode)));
          return;
        }

        resumePending = false;
        sessionIdRef.current = result.sessionId;
        setDisplays(result.displays);
        setSelectedDisplayId(result.selectedDisplayId);
        setCapabilities(result.capabilities);
        closePeer();

        const pc = new RTCPeerConnection({ iceServers: [] });
        pcRef.current = pc;
        pc.addTransceiver('video', { direction: 'recvonly' });
        const control = pc.createDataChannel('ez-control-v1', { ordered: true });
        const pointer = pc.createDataChannel('ez-pointer-v1', { ordered: false, maxRetransmits: 0 });
        controlRef.current = control;
        pointerRef.current = pointer;
        control.addEventListener('message', (event) => {
          try {
            const message = JSON.parse(String(event.data)) as { type?: unknown; text?: unknown };
            if (message.type === 'clipboard-text' && typeof message.text === 'string') {
              const text = message.text.slice(0, MAX_CLIPBOARD_BYTES);
              if (!clipboardCopyPendingRef.current) return;
              clipboardCopyPendingRef.current = false;
              void Clipboard.write({ string: text }).then(() => {
                if (!disposed) setClipboardStatus(t('mobile.pcControl.clipboardCopied'));
              }).catch(() => {
                if (!disposed) setClipboardStatus(t('mobile.pcControl.clipboardPermission'));
              });
            } else if (message.type === 'input-error') {
              clipboardCopyPendingRef.current = false;
              setClipboardStatus(t('mobile.pcControl.inputUnavailable'));
            }
          } catch {
            // Closed protocol surface: malformed control frames are ignored.
          }
        });
        pc.addEventListener('track', (event) => {
          if (videoRef.current && event.streams[0]) {
            videoRef.current.srcObject = event.streams[0];
            void videoRef.current.play().catch(() => undefined);
          }
        });
        pc.addEventListener('icecandidate', (event) => {
          if (!event.candidate || pcRef.current !== pc) return;
          const candidate = event.candidate.toJSON();
          if (!candidate.candidate) return;
          transport.sendDesktopSignal(result.sessionId, {
            type: 'ice',
            candidate: {
              candidate: candidate.candidate,
              sdpMid: candidate.sdpMid,
              sdpMLineIndex: candidate.sdpMLineIndex,
            },
          });
        });
        pc.addEventListener('connectionstatechange', () => {
          if (disposed || pcRef.current !== pc) return;
          if (pc.connectionState === 'connected') setPhase('active');
          else if (pc.connectionState === 'disconnected') setPhase('reconnecting');
          else if (pc.connectionState === 'failed') setPhase('error');
        });
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (!disposed && pcRef.current === pc) {
          transport.sendDesktopSignal(result.sessionId, { type: 'offer', sdp: offer.sdp ?? '' });
        }
      } catch {
        if (!disposed) {
          setPhase('error');
          setDetail(t('mobile.pcControl.startFailed'));
        }
      } finally {
        negotiating = false;
      }
    };
    void beginDesktop();
    const unsubscribeConnection = transport.onConnectionStateChange((state) => {
      if (disposed || !sessionIdRef.current) return;
      if (state === 'reconnecting' || state === 'connecting') {
        resumePending = true;
        setPhase('reconnecting');
        closePeer();
      } else if (state === 'connected' && resumePending) {
        void beginDesktop();
      } else if (state === 'auth-rejected' || state === 'protocol-incompatible' || state === 'disconnected') {
        resumePending = false;
        setPhase('error');
        closePeer();
      }
    });

    const onVisibility = (): void => {
      if (document.visibilityState !== 'hidden' || !sessionIdRef.current) return;
      transport.stopDesktopControl(sessionIdRef.current, 'background');
      sessionIdRef.current = null;
      resumePending = false;
      closePeer();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      unsubscribeSignal();
      unsubscribeStatus();
      unsubscribeEnded();
      unsubscribeConnection();
      const sessionId = sessionIdRef.current;
      if (sessionId) transport.stopDesktopControl(sessionId, 'navigation');
      closePeer();
      sessionIdRef.current = null;
      clipboardCopyPendingRef.current = false;
      for (const timer of holdTimers.values()) window.clearTimeout(timer);
      holdTimers.clear();
    };
  }, [t, transport]);

  useEffect(() => {
    if (keyboardOpen) inputRef.current?.focus();
  }, [keyboardOpen]);

  const close = (): void => {
    const sessionId = sessionIdRef.current;
    if (sessionId) transport.stopDesktopControl(sessionId, 'client-stop');
    sessionIdRef.current = null;
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
    setClipboardStatus('');
    try {
      const { value: text } = await Clipboard.read();
      if (!text || new TextEncoder().encode(text).byteLength > MAX_CLIPBOARD_BYTES) {
        setClipboardStatus(t('mobile.pcControl.clipboardInvalid'));
        return;
      }
      setClipboardStatus(sendControl({ type: 'clipboard-write', text })
        ? t('mobile.pcControl.clipboardSent')
        : t('mobile.pcControl.inputUnavailable'));
    } catch {
      setClipboardStatus(t('mobile.pcControl.clipboardPermission'));
    }
  };

  const copyPcClipboard = (): void => {
    clipboardCopyPendingRef.current = true;
    setClipboardStatus('');
    if (!sendControl({ type: 'clipboard-read' })) {
      clipboardCopyPendingRef.current = false;
      setClipboardStatus(t('mobile.pcControl.inputUnavailable'));
    }
  };

  const sendKey = (code: string, modifiers?: readonly string[]): void => {
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
                setSelectedDisplayId(event.target.value);
                sendControl({ type: 'set-display', displayId: event.target.value });
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
          sendKey(event.code || event.key, [
            ...(event.ctrlKey ? ['control'] : []),
            ...(event.altKey ? ['alt'] : []),
            ...(event.shiftKey ? ['shift'] : []),
            ...(event.metaKey ? ['meta'] : []),
          ]);
        }}
      />
    </div>
  );
}
