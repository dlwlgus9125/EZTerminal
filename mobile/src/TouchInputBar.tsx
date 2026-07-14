import { useEffect, useRef, useSyncExternalStore } from "react";

import type { BlockController } from "../../src/renderer/block-controller";
import { useAppTranslation } from "../../src/renderer/i18n";
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
}: {
  controller: BlockController | null;
  connected?: boolean;
}): JSX.Element | null {
  const { t } = useAppTranslation();
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
      className="touch-input-bar"
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
          className="btn touch-key"
          aria-label={key.accessibleLabel}
          disabled={!canSend}
          onPointerDown={(event) => {
            if (!canSend || event.button !== 0) return;
            event.preventDefault();
            repeatController.start(key.bytes, key.repeatable);
          }}
          onPointerUp={() => repeatController.stop()}
          onPointerCancel={() => repeatController.stop()}
          onPointerLeave={() => repeatController.stop()}
          onClick={(event) => {
            // Pointer activation already sent on pointerdown. A synthetic
            // click with detail=0 is keyboard/assistive-tech activation.
            if (!canSend || event.detail !== 0) return;
            repeatController.start(key.bytes, false);
          }}
          onContextMenu={(event) => event.preventDefault()}
          data-testid={`touch-key-${key.id}`}
        >
          {key.label}
        </button>
      ))}
      {!canSend && (
        <span className="touch-input-state" role="status">
          {connected
            ? t("mobile.terminalKeys.viewingOnly")
            : t("state.offline")}
        </span>
      )}
      <button
        type="button"
        className="btn touch-key touch-key-manage"
        onClick={() =>
          window.dispatchEvent(new Event(OPEN_TERMINAL_KEY_SETTINGS_EVENT))
        }
        aria-label={t("mobile.terminalKeys.manageAria")}
        data-testid="touch-key-manage"
      >
        {t("mobile.terminalKeys.manage")}
      </button>
    </div>
  );
}
