import type { ReactElement } from "react";
import styles from "./StatusBar.module.css";

interface StatusBarProps {
  shellName?: string;
  cols?: number;
  rows?: number;
  encoding?: string;
}

export function StatusBar({
  shellName = "PowerShell",
  cols = 80,
  rows = 24,
  encoding = "UTF-8",
}: StatusBarProps): ReactElement {
  return (
    <div className={styles.statusBar} data-testid="status-bar">
      <span className={styles.segment} data-segment="shell">
        {shellName}
      </span>
      <span className={styles.divider}>|</span>
      <span className={styles.segment} data-segment="size">
        {cols}x{rows}
      </span>
      <span className={styles.divider}>|</span>
      <span className={styles.segment} data-segment="encoding">
        {encoding}
      </span>
    </div>
  );
}
