import type { ReactElement } from "react";
import { useStore } from "../../store";
import styles from "./Rail.module.css";

export const PANEL_IDS = ["files", "status", "network", "settings"] as const;
export type PanelId = (typeof PANEL_IDS)[number];

const ICONS: Record<PanelId, string> = {
  files: "F",
  status: "S",
  network: "N",
  settings: "G",
};

const LABELS: Record<PanelId, string> = {
  files: "Files",
  status: "Status",
  network: "Network",
  settings: "Settings",
};

export function Rail(): ReactElement {
  const activePanelId = useStore((s) => s.activePanelId);
  const openPanel = useStore((s) => s.openPanel);

  return (
    <nav className={styles.rail} data-testid="rail" aria-label="Side panel navigation">
      {PANEL_IDS.map((id) => (
        <button
          type="button"
          key={id}
          className={`${styles.icon} ${activePanelId === id ? styles.active : ""}`}
          data-panel-id={id}
          data-active={activePanelId === id ? "true" : undefined}
          aria-label={LABELS[id]}
          aria-pressed={activePanelId === id}
          onClick={() => openPanel(id)}
        >
          {ICONS[id]}
        </button>
      ))}
    </nav>
  );
}
