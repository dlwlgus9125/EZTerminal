import type { ReactElement } from "react";
import { useStore } from "../../store";
import styles from "./TabBar.module.css";

export function TabBar(): ReactElement {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const switchTab = useStore((s) => s.switchTab);
  const addTab = useStore((s) => s.addTab);

  const tabList = Object.values(tabs);

  return (
    <div className={styles.tabBar} data-testid="tab-bar">
      <div className={styles.tabs}>
        {tabList.map((tab, index) => (
          <button
            key={tab.id}
            className={`${styles.tab} ${tab.id === activeTabId ? styles.active : ""}`}
            data-tab-id={tab.id}
            data-active={tab.id === activeTabId ? "true" : undefined}
            onClick={() => switchTab(tab.id)}
            aria-label={`Tab ${index + 1}`}
          >
            {`Tab ${index + 1}`}
          </button>
        ))}
      </div>
      <button
        className={styles.addBtn}
        data-add-tab
        onClick={addTab}
        aria-label="Add tab"
      >
        +
      </button>
    </div>
  );
}
