import { SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";

import type { BlockController } from "../../src/renderer/block-controller";
import { useAppTranslation } from "../../src/renderer/i18n";
import { useMobileToast } from "./MobileToast";
import { getTerminalAccessoryKey } from "./terminal-accessory-keys";
import {
  ACTIVE_MOBILE_TAB_CHANGE_EVENT,
  OPEN_TERMINAL_KEY_SETTINGS_EVENT,
  useTerminalAccessoryLayout,
} from "./terminal-accessory-layout";
import { createTerminalKeyRepeatController } from "./terminal-key-repeat";

const noopSubscribe = (): (() => void) => () => undefined;
const nullSnapshot = (): null => null;

export function TouchInputBar({
  controller,
  connected = true,
  ctrlLatched = false,
  onToggleCtrl,
}: {
  controller: BlockController | null;
  connected?: boolean;
  /** Handoff §3's Ctrl latch. Owned by MobileSessionView because the composer's
   * plain-PTY keystroke path is what actually consumes it. */
  ctrlLatched?: boolean;
  onToggleCtrl?: () => void;
}): JSX.Element | null {
  const { t } = useAppTranslation();
  const showToast = useMobileToast();
  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getSnapshot ?? nullSnapshot,
  );
  const accessorySnapshot = useTerminalAccessoryLayout();
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const repeatControllerRef = useRef<ReturnType<
    typeof createTerminalKeyRepeatController
  > | null>(null);
  repeatControllerRef.current ??= createTerminalKeyRepeatController((bytes) => {
    controllerRef.current?.sendPtyInput(bytes);
  });
  const repeatController = repeatControllerRef.current;

  const runningPty = Boolean(
    controller && snapshot?.shape === "pty" && snapshot.status === "running",
  );
  const canSend = connected && runningPty && snapshot?.hasControl === true;

  useEffect(() => {
    if (!canSend) repeatController.stop();
  }, [canSend, repeatController]);

  useEffect(() => {
    const stop = (): void => repeatController.stop();
    const stopWhenHidden = (): void => {
      if (document.visibilityState !== "visible") stop();
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
    window.addEventListener(ACTIVE_MOBILE_TAB_CHANGE_EVENT, stop);
    document.addEventListener("visibilitychange", stopWhenHidden);
    return () => {
      stop();
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
      window.removeEventListener(ACTIVE_MOBILE_TAB_CHANGE_EVENT, stop);
      document.removeEventListener("visibilitychange", stopWhenHidden);
    };
  }, [repeatController]);

  if (!runningPty) return null;

  const visibleKeys = accessorySnapshot.layout.order
    .filter((id) => accessorySnapshot.layout.visible.includes(id))
    .map(getTerminalAccessoryKey);

  return (
    <div
      className="touch-input-bar mob-keybar"
      role="toolbar"
      aria-label={t("mobile.terminalKeys.toolbar")}
      data-testid="touch-input-bar"
    >
      {visibleKeys.length === 0 && (
        <span className="touch-input-empty" data-testid="touch-input-empty">
          {t("mobile.terminalKeys.emptySelection")}
        </span>
      )}
      {visibleKeys.map((key) => (
        <button
          key={key.id}
          type="button"
          className="touch-key mob-key"
          aria-label={key.accessibleLabel}
          disabled={!canSend}
          onPointerDown={(event) => {
            if (!canSend || event.button !== 0) return;
            event.preventDefault();
            repeatController.start(key.bytes, key.repeatable);
            showToast(t("mobile.terminalKeys.sent", { key: key.label }));
          }}
          onPointerUp={() => repeatController.stop()}
          onPointerCancel={() => repeatController.stop()}
          onPointerLeave={() => repeatController.stop()}
          onClick={(event) => {
            // Pointer activation already sent on pointerdown. A synthetic
            // click with detail=0 is keyboard/assistive-tech activation.
            if (!canSend || event.detail !== 0) return;
            repeatController.start(key.bytes, false);
            showToast(t("mobile.terminalKeys.sent", { key: key.label }));
          }}
          onContextMenu={(event) => event.preventDefault()}
          data-testid={`touch-key-${key.id}`}
        >
          {key.label}
        </button>
      ))}
      {onToggleCtrl && (
        <button
          type="button"
          className={ctrlLatched ? "touch-key mob-key mob-key--latched" : "touch-key mob-key"}
          aria-pressed={ctrlLatched}
          disabled={!canSend}
          onClick={onToggleCtrl}
          data-testid="touch-key-ctrl-latch"
        >
          Ctrl
          {ctrlLatched && <span className="mob-key__dot" aria-hidden="true" />}
        </button>
      )}
      {!canSend && (
        <span className="touch-input-state" role="status">
          {connected
            ? t("mobile.terminalKeys.viewingOnly")
            : t("state.offline")}
        </span>
      )}
      <button
        type="button"
        className="touch-key mob-key mob-key--manage"
        onClick={() =>
          window.dispatchEvent(new Event(OPEN_TERMINAL_KEY_SETTINGS_EVENT))
        }
        aria-label={t("mobile.terminalKeys.manageAria")}
        data-testid="touch-key-manage"
      >
        <SlidersHorizontal aria-hidden="true" />
      </button>
    </div>
  );
}
