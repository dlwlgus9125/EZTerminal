import { ChevronDown, ChevronUp, GripVertical } from 'lucide-react';
import { useRef, useState } from 'react';

import { useAppTranslation } from '../../src/renderer/i18n';

import { getTerminalAccessoryKey, type TerminalAccessoryKeyId } from './terminal-accessory-keys';
import {
  moveTerminalAccessoryKey,
  moveTerminalAccessoryKeyBefore,
  moveTerminalAccessoryKeyToIndex,
  setTerminalAccessoryKeyVisible,
  terminalAccessoryLayoutStore,
  useTerminalAccessoryLayout,
  type TerminalAccessoryMessageCode,
} from './terminal-accessory-layout';

const MESSAGE_KEY = {
  unavailable: 'mobile.terminalKeys.messageUnavailable',
  'read-failed': 'mobile.terminalKeys.messageReadFailed',
  'invalid-reset': 'mobile.terminalKeys.messageInvalidReset',
  'invalid-session': 'mobile.terminalKeys.messageInvalidSession',
  'save-failed': 'mobile.terminalKeys.messageSaveFailed',
  'retry-failed': 'mobile.terminalKeys.messageRetryFailed',
} as const satisfies Record<TerminalAccessoryMessageCode, string>;

export function TerminalAccessorySettings(): JSX.Element {
  const { t } = useAppTranslation();
  const snapshot = useTerminalAccessoryLayout();
  const { layout } = snapshot;
  const [draggingId, setDraggingId] = useState<TerminalAccessoryKeyId | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  return (
    <section className="status-section terminal-accessory-settings" aria-labelledby="terminal-accessory-heading">
      <div className="terminal-accessory-settings-head">
        <div>
          <h2 id="terminal-accessory-heading" ref={headingRef} className="status-section-title" tabIndex={-1}>
            {t('mobile.terminalKeys.title')}
          </h2>
          <p className="terminal-accessory-settings-help">
            {t('mobile.terminalKeys.help')}
          </p>
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => terminalAccessoryLayoutStore.reset()}
          data-testid="terminal-key-layout-reset"
        >
          {t('common.reset')}
        </button>
      </div>

      {snapshot.messageCode && (
        <div
          className={snapshot.persistence === 'session-only' ? 'terminal-key-settings-message terminal-key-settings-message--error' : 'terminal-key-settings-message'}
          role={snapshot.persistence === 'session-only' ? 'alert' : 'status'}
          data-testid="terminal-key-layout-message"
        >
          <span>{t(MESSAGE_KEY[snapshot.messageCode])}</span>
          {snapshot.persistence === 'session-only' && (
            <button type="button" className="btn" onClick={() => terminalAccessoryLayoutStore.retrySave()}>
              {t('mobile.terminalKeys.retrySave')}
            </button>
          )}
        </div>
      )}

      {layout.visible.length === 0 && (
        <p className="terminal-key-settings-empty" role="status" data-testid="terminal-key-layout-empty">
          {t('mobile.terminalKeys.empty')}
        </p>
      )}

      <ol className="terminal-key-settings-list" aria-label={t('mobile.terminalKeys.order')}>
        {layout.order.map((id, index) => {
          const key = getTerminalAccessoryKey(id);
          const visible = layout.visible.includes(id);
          return (
            <li
              key={id}
              className={draggingId === id ? 'terminal-key-settings-row terminal-key-settings-row--dragging' : 'terminal-key-settings-row'}
              draggable
              onDragStart={(event) => {
                setDraggingId(id);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', id);
              }}
              onDragEnd={() => setDraggingId(null)}
              onDragOver={(event) => {
                if (draggingId && draggingId !== id) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                const moving = draggingId;
                setDraggingId(null);
                if (!moving) return;
                terminalAccessoryLayoutStore.setLayout(moveTerminalAccessoryKeyBefore(layout, moving, id));
              }}
              data-terminal-key-id={id}
              data-testid={`terminal-key-setting-${id}`}
            >
              <button
                type="button"
                className="terminal-key-drag-handle"
                aria-label={t('mobile.terminalKeys.drag', { key: key.accessibleLabel })}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                  setDraggingId(id);
                }}
                onPointerMove={(event) => {
                  if (draggingId !== id) return;
                  event.preventDefault();
                  const target = document
                    .elementFromPoint(event.clientX, event.clientY)
                    ?.closest<HTMLElement>('[data-terminal-key-id]');
                  const targetId = target?.dataset.terminalKeyId as TerminalAccessoryKeyId | undefined;
                  if (!target || !targetId || targetId === id) return;
                  const current = terminalAccessoryLayoutStore.getSnapshot().layout;
                  const targetIndex = current.order.indexOf(targetId);
                  if (targetIndex < 0) return;
                  const belowMiddle = event.clientY >= target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2;
                  terminalAccessoryLayoutStore.setLayout(
                    moveTerminalAccessoryKeyToIndex(current, id, targetIndex + (belowMiddle ? 1 : 0)),
                  );
                }}
                onPointerUp={(event) => {
                  event.currentTarget.releasePointerCapture?.(event.pointerId);
                  setDraggingId(null);
                }}
                onPointerCancel={() => setDraggingId(null)}
              >
                <GripVertical aria-hidden="true" size={18} />
              </button>
              <span className="terminal-key-settings-label">{key.label}</span>
              <label className="terminal-key-visibility">
                <input
                  type="checkbox"
                  checked={visible}
                  onChange={(event) => {
                    terminalAccessoryLayoutStore.setLayout(
                      setTerminalAccessoryKeyVisible(layout, id, event.target.checked),
                    );
                  }}
                  data-testid={`terminal-key-visible-${id}`}
                />
                <span>{visible ? t('mobile.terminalKeys.shown') : t('mobile.terminalKeys.hidden')}</span>
              </label>
              <div className="terminal-key-order-actions" aria-label={t('mobile.terminalKeys.move', { key: key.accessibleLabel })}>
                <button
                  type="button"
                  className="btn"
                  disabled={index === 0}
                  aria-label={t('mobile.terminalKeys.moveUp', { key: key.accessibleLabel })}
                  onClick={() => terminalAccessoryLayoutStore.setLayout(moveTerminalAccessoryKey(layout, id, -1))}
                >
                  <ChevronUp aria-hidden="true" size={18} />
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={index === layout.order.length - 1}
                  aria-label={t('mobile.terminalKeys.moveDown', { key: key.accessibleLabel })}
                  onClick={() => terminalAccessoryLayoutStore.setLayout(moveTerminalAccessoryKey(layout, id, 1))}
                >
                  <ChevronDown aria-hidden="true" size={18} />
                </button>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
