import { App as CapacitorApp } from '@capacitor/app';
import jsQR from 'jsqr';
import { useEffect, useRef, useState, type RefObject } from 'react';

import { parsePairingUri, type ParsedPairingUri } from '../../src/shared/pairing';
import { useAppTranslation } from '../../src/renderer/i18n';
import { MobileActionSheet } from './MobileActionSheet';

/** Fast enough to feel instant when the code is in frame, slow enough that a
 * mid-range phone is not decoding every single frame it renders. */
const DECODE_INTERVAL_MS = 200;
/** Decoding a full-resolution frame buys nothing; a QR at arm's length is
 * legible far below the camera's native size. */
const DECODE_EDGE_PX = 480;
/** A camera that starts but never yields a frame must not leave a permanently
 * black preview holding the hardware. */
const PREVIEW_READY_TIMEOUT_MS = 10_000;

type ScannerError = 'denied' | 'unavailable' | 'unreadable';

function classifyCameraStartError(error: unknown): ScannerError {
  const name = (
    error
    && typeof error === 'object'
    && 'name' in error
    && typeof error.name === 'string'
  ) ? error.name : '';
  return name === 'NotAllowedError' || name === 'SecurityError'
    ? 'denied'
    : 'unavailable';
}

/**
 * Camera scanner for the desktop's pairing QR.
 *
 * Decoding happens entirely on-device with a bundled decoder — the frames
 * never leave the phone and nothing is uploaded. The sheet closes the stream
 * on every exit path, including an unmount from Android Back, because a camera
 * left running is the one failure here a user would notice and distrust.
 */
export function PairingScanner({
  onDetected,
  onClose,
  returnFocusRef,
  requestCamera = requestDeviceCamera,
}: {
  readonly onDetected: (result: ParsedPairingUri) => void;
  readonly onClose: () => void;
  readonly returnFocusRef?: RefObject<HTMLElement>;
  readonly requestCamera?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
}): JSX.Element {
  const { t } = useAppTranslation();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stopRef = useRef<() => void>(() => undefined);
  const onDetectedRef = useRef(onDetected);
  const onCloseRef = useRef(onClose);
  const returnFocusTargetRef = useRef(returnFocusRef);
  const [error, setError] = useState<ScannerError | null>(null);
  onDetectedRef.current = onDetected;
  onCloseRef.current = onClose;
  returnFocusTargetRef.current = returnFocusRef;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let readinessTimer: ReturnType<typeof setTimeout> | null = null;
    let cameraTracks: MediaStreamTrack[] = [];
    let playbackStarted = false;
    let stopped = false;

    const clearReadinessTimer = (): void => {
      if (readinessTimer !== null) clearTimeout(readinessTimer);
      readinessTimer = null;
    };
    function handleTrackEnded(): void {
      if (stopped) return;
      setError('unavailable');
      stop();
    }
    const stop = (): void => {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      clearReadinessTimer();
      for (const track of cameraTracks) {
        track.removeEventListener?.('ended', handleTrackEnded);
        track.stop();
      }
      cameraTracks = [];
      const video = videoRef.current;
      if (video && video.srcObject === stream) video.srcObject = null;
      stream = null;
    };
    stopRef.current = stop;

    const closeForAppDeactivation = (): void => {
      if (stopped) return;
      stop();
      onCloseRef.current();
      requestAnimationFrame(() => returnFocusTargetRef.current?.current?.focus());
    };
    const appStateHandle = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) closeForAppDeactivation();
    }).catch((listenerError: unknown) => {
      console.error('[pairing-scanner] App state listener failed:', listenerError);
      closeForAppDeactivation();
      return null;
    });
    const pauseHandle = CapacitorApp.addListener('pause', () => {
      // Android also emits pause while the camera permission dialog is open.
      // Ignore that pre-acquisition pause, but release an owned camera
      // immediately when the activity itself moves to the background.
      if (cameraTracks.length > 0) closeForAppDeactivation();
    }).catch((listenerError: unknown) => {
      console.error('[pairing-scanner] App pause listener failed:', listenerError);
      return null;
    });

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });

    const hasUsableFrame = (video: HTMLVideoElement): boolean => (
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      && video.videoWidth > 0
      && video.videoHeight > 0
    );
    const armReadinessTimer = (): void => {
      clearReadinessTimer();
      readinessTimer = setTimeout(() => {
        if (stopped) return;
        const currentVideo = videoRef.current;
        if (playbackStarted && currentVideo && hasUsableFrame(currentVideo)) {
          clearReadinessTimer();
          return;
        }
        setError('unavailable');
        stop();
      }, PREVIEW_READY_TIMEOUT_MS);
    };
    const decode = (): void => {
      const video = videoRef.current;
      if (!video || !hasUsableFrame(video)) return;
      clearReadinessTimer();
      if (!context) return;
      try {
        const scale = Math.min(1, DECODE_EDGE_PX / Math.max(video.videoWidth, video.videoHeight || 1));
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frame = context.getImageData(0, 0, canvas.width, canvas.height);
        const found = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' });
        if (!found) return;
        const parsed = parsePairingUri(found.data);
        if (!parsed) {
          // A QR that is not ours is worth saying so about, once, rather than
          // silently continuing to look like nothing is happening.
          setError('unreadable');
          stop();
          return;
        }
        stop();
        onDetectedRef.current(parsed);
      } catch {
        if (stopped) return;
        setError('unavailable');
        stop();
      }
    };

    void (async () => {
      if (!context) {
        setError('unavailable');
        return;
      }
      try {
        stream = await requestCamera({
          video: { facingMode: 'environment' },
          audio: false,
        });
      } catch (cameraError: unknown) {
        if (!stopped) setError(classifyCameraStartError(cameraError));
        return;
      }
      if (stopped) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      cameraTracks = stream.getTracks();
      for (const track of cameraTracks) {
        track.addEventListener?.('ended', handleTrackEnded);
      }
      const video = videoRef.current;
      if (!video) {
        setError('unavailable');
        stop();
        return;
      }
      video.srcObject = stream;
      armReadinessTimer();
      try {
        await video.play();
        playbackStarted = true;
      } catch {
        if (!stopped) setError('unavailable');
        stop();
        return;
      }
      if (stopped) return;
      if (hasUsableFrame(video)) clearReadinessTimer();
      timer = setInterval(decode, DECODE_INTERVAL_MS);
    })();

    return () => {
      stop();
      void appStateHandle.then((handle) => handle?.remove()).catch(() => undefined);
      void pauseHandle.then((handle) => handle?.remove()).catch(() => undefined);
      if (stopRef.current === stop) stopRef.current = () => undefined;
    };
  }, [requestCamera]);

  return (
    <MobileActionSheet
      title={t('pairing.scanTitle')}
      returnFocusRef={returnFocusRef}
      onClose={() => {
        stopRef.current();
        onCloseRef.current();
      }}
      variant="fullscreen"
      testId="pairing-scanner"
    >
      {error ? (
        <p
          className="mob-empty"
          role="alert"
          data-testid="pairing-scan-error"
          data-camera-error={error}
        >
          {error === 'denied'
            ? t('pairing.cameraDenied')
            : error === 'unavailable'
              ? t('pairing.cameraUnavailable')
              : t('pairing.scanFailed')}
        </p>
      ) : (
        <>
          <video
            ref={videoRef}
            className="mob-scanner__video"
            playsInline
            muted
            data-testid="pairing-scan-video"
          />
          <p className="mob-scanner__hint">{t('pairing.scanHint')}</p>
        </>
      )}
    </MobileActionSheet>
  );
}

function requestDeviceCamera(constraints: MediaStreamConstraints): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return Promise.reject(new Error('Camera API unavailable'));
  }
  return navigator.mediaDevices.getUserMedia(constraints);
}
