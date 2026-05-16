import type { ReactElement, ReactNode } from "react";
import styles from "./FloatingPanel.module.css";

export interface FloatingPanelProps {
  panelId: string;
  title: string;
  children: ReactNode;
  isFloating?: boolean;
  onPopOut: (panelId: string) => void;
  onDock: (panelId: string) => void;
  onMinimize?: (panelId: string) => void;
  onClose?: (panelId: string) => void;
}

/**
 * FloatingPanel — wrapper for side panels supporting pop-out to child BrowserWindow.
 *
 * When isFloating=false (default): renders inline panel chrome with a pop-out button.
 * When isFloating=true: renders the floated variant (used inside the child window's renderer).
 *
 * Pop-out/dock is handled by main process via float:popout / float:dock IPC.
 */
export function FloatingPanel({
  panelId,
  title,
  children,
  isFloating = false,
  onPopOut,
  onDock,
  onMinimize,
  onClose,
}: FloatingPanelProps): ReactElement {
  return (
    <div
      className={`${styles.panel} ${isFloating ? styles.floating : ""}`}
      data-testid="floating-panel"
      data-panel-id={panelId}
      data-floating={isFloating ? "true" : "false"}
    >
      <div className={styles.header}>
        <span className={styles.title}>{title}</span>
        <div className={styles.controls}>
          {isFloating ? (
            <>
              {onMinimize && (
                <button
                  type="button"
                  className={styles.btn}
                  aria-label="Minimize"
                  data-testid="float-minimize"
                  onClick={() => onMinimize(panelId)}
                >
                  —
                </button>
              )}
              <button
                type="button"
                className={styles.btn}
                aria-label="Dock panel"
                data-testid="float-dock"
                onClick={() => onDock(panelId)}
              >
                ⬛
              </button>
              {onClose && (
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnClose}`}
                  aria-label="Force close"
                  data-testid="float-close"
                  onClick={() => onClose(panelId)}
                >
                  ✕
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              className={styles.btn}
              aria-label="Pop out panel"
              data-testid="float-popout"
              onClick={() => onPopOut(panelId)}
            >
              ⤢
            </button>
          )}
        </div>
      </div>
      <div className={styles.content}>{children}</div>
    </div>
  );
}
