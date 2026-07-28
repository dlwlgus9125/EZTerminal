import qrcode from 'qrcode-generator';
import { useEffect, useMemo, useState } from 'react';

import { PAIRING_CODE_TTL_MS, buildPairingUri, type PairingCode } from '../shared/pairing';
import { useAppTranslation } from './i18n';
import { Button, Dialog } from './ui';

/** Quiet zone in modules, per the QR spec. Without it a scanner cannot find
 * the symbol against whatever is behind it. */
const QUIET_ZONE = 4;

/**
 * The QR as one inline SVG path.
 *
 * Drawn rather than fetched or canvas-rasterized: the packaged CSP forbids
 * remote images, and an SVG scales to whatever the layout gives it without a
 * second resolution decision. One path with a rectangle per dark module keeps
 * the DOM to a single node instead of a few hundred.
 */
function QrSymbol({ text, label }: { readonly text: string; readonly label: string }): JSX.Element {
  const { path, size } = useMemo(() => {
    // Type number 0 = "smallest that fits". Error correction M survives a
    // fingerprint on the screen without inflating the module count.
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    let d = '';
    for (let row = 0; row < count; row += 1) {
      for (let column = 0; column < count; column += 1) {
        if (qr.isDark(row, column)) d += `M${column + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`;
      }
    }
    return { path: d, size: count + QUIET_ZONE * 2 };
  }, [text]);

  return (
    <svg
      className="pairing-qr__symbol"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      data-testid="pairing-qr-symbol"
    >
      <rect width={size} height={size} fill="#e8fff2" />
      <path d={path} fill="#04140a" />
    </svg>
  );
}

function countdownLabel(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export interface PairingQrDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** `ws://host:port` the phone should connect to. */
  readonly endpoint: string;
  readonly code: PairingCode | null;
  /** True once a device has actually redeemed the code. */
  readonly redeemed: boolean;
  readonly issuing: boolean;
  readonly issueFailed: boolean;
  readonly onIssue: () => void;
  /**
   * Deterministic clock seam for handoff/reference rendering. Production
   * omits it and receives the live one-second countdown.
   */
  readonly currentTime?: number;
}

export function PairingQrDialog({
  open,
  onOpenChange,
  endpoint,
  code,
  redeemed,
  issuing,
  issueFailed,
  onIssue,
  currentTime,
}: PairingQrDialogProps): JSX.Element {
  const { t } = useAppTranslation();
  const [now, setNow] = useState(() => currentTime ?? Date.now());

  useEffect(() => {
    if (!open || !code) return undefined;
    if (currentTime !== undefined) {
      setNow(currentTime);
      return undefined;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [open, code, currentTime]);

  const remaining = code ? Math.max(0, code.expiresAt - now) : 0;
  const expired = Boolean(code && remaining <= 0);
  const percent = Math.round((remaining / PAIRING_CODE_TTL_MS) * 100);
  const uri = code && !expired && endpoint ? buildPairingUri(endpoint, code.code) : null;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('pairing.title')}
      description={t('pairing.steps')}
      size="md"
      tone="neutral"
      closeLabel={t('common.close')}
      testId="pairing-qr-dialog"
    >
      <div className="pairing-qr">
        {redeemed ? (
          <p className="pairing-qr__detected" role="status" data-testid="pairing-redeemed">
            {t('pairing.redeemed')}
          </p>
        ) : issuing ? (
          <p className="pairing-qr__hint" role="status" data-testid="pairing-issuing">
            {t('common.loading')}
          </p>
        ) : issueFailed ? (
          <p className="pairing-qr__hint" role="alert" data-testid="pairing-error">
            {t('pairing.issueFailed')}
          </p>
        ) : expired ? (
          <p className="pairing-qr__hint" role="status" data-testid="pairing-expired">
            {t('pairing.expired')}
          </p>
        ) : uri ? (
          <>
            <QrSymbol text={uri} label={t('pairing.qrLabel')} />
            <div className="pairing-qr__side">
              <p className="pairing-qr__hint">{t('pairing.manualHint')}</p>
              <p className="pairing-qr__code" data-testid="pairing-code">{code?.code}</p>
              <div className="pairing-qr__validity">
                <span>{t('pairing.validFor')}</span>
                <b data-testid="pairing-countdown">{countdownLabel(remaining)}</b>
                <span className="pairing-qr__track" aria-hidden="true">
                  <i style={{ inlineSize: `${percent}%` }} />
                </span>
              </div>
              {/* Stated because it is load-bearing: this is the reason a photo
                  of the screen is not a lasting credential. */}
              <p className="pairing-qr__note">{t('pairing.oneTime')}</p>
            </div>
          </>
        ) : (
          <p className="pairing-qr__hint" data-testid="pairing-idle">{t('pairing.idle')}</p>
        )}
      </div>
      <div className="pairing-qr__actions">
        <Button
          variant="secondary"
          onClick={onIssue}
          disabled={issuing}
          data-testid="pairing-issue"
        >
          {issueFailed
            ? t('common.retry')
            : code && !redeemed && !expired
              ? t('pairing.reissue')
              : t('pairing.issue')}
        </Button>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('common.close')}</Button>
      </div>
    </Dialog>
  );
}
