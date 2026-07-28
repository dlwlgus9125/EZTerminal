import jsQR from 'jsqr';
import { useEffect, useRef, useState } from 'react';

import { parsePairingUri, type ParsedPairingUri } from '../../src/shared/pairing';
import { useAppTranslation } from '../../src/renderer/i18n';
import { MobileActionSheet } from './MobileActionSheet';

/** Fast enough to feel instant when the code is in frame, slow enough that a
 * mid-range phone is not decoding every single frame it renders. */
const DECODE_INTERVAL_MS = 200;
/** Decoding a full-resolution frame buys nothing; a QR at arm's length is
 * legible far below the camera's native size. */
const DECODE_EDGE_PX = 480;

type ScannerError = 'denied' | 'unavailable' | 'unreadable';

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
}: {
  readonly onDetected: (result: ParsedPairingUri) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stopRef = useRef<() => void>(() => undefined);
  const [error, setError] = useState<ScannerError | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let stopped = false;

    const stop = (): void => {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      for (const track of stream?.getTracks() ?? []) track.stop();
      const video = videoRef.current;
      if (video && video.srcObject === stream) video.srcObject = null;
      stream = null;
    };
    stopRef.current = stop;

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });

    const decode = (): void => {
      const video = videoRef.current;
      if (!video || !context || video.readyState < 2) return;
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
      onDetected(parsed);
    };

    void (async () => {
      if (!context || !navigator.mediaDevices?.getUserMedia) {
        setError('unavailable');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
      } catch {
        if (!stopped) setError('denied');
        return;
      }
      if (stopped) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const video = videoRef.current;
      if (!video) {
        setError('unavailable');
        stop();
        return;
      }
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        if (!stopped) setError('unavailable');
        stop();
        return;
      }
      if (stopped) return;
      timer = setInterval(decode, DECODE_INTERVAL_MS);
    })();

    return () => {
      stop();
      if (stopRef.current === stop) stopRef.current = () => undefined;
    };
  }, [onDetected]);

  return (
    <MobileActionSheet
      title={t('pairing.scanTitle')}
      onClose={() => {
        stopRef.current();
        onClose();
      }}
      variant="fullscreen"
      testId="pairing-scanner"
    >
      {error ? (
        <p className="mob-empty" role="alert" data-testid="pairing-scan-error">
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
