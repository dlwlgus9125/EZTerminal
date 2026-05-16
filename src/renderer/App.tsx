import type { ReactElement, ReactNode } from "react";
import { useState } from "react";
import { CommandPalette, buildAppCommands } from "./components/CommandPalette";
import { Rail } from "./components/Rail";
import { SplitContainer } from "./components/SplitContainer";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import { TerminalView } from "./components/Terminal";
import { TitleBar } from "./components/TitleBar";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useStore } from "./store";
import type { LayoutNode } from "./store/layout-slice";

const PANEL_WIDTH = 300;

function App(): ReactElement {
  const [paletteOpen, setPaletteOpen] = useState(false);

  const addTab = useStore((s) => s.addTab);
  const closeTab = useStore((s) => s.closeTab);
  const switchTab = useStore((s) => s.switchTab);
  const splitPane = useStore((s) => s.splitPane);
  const closePane = useStore((s) => s.closePane);
  const openPanel = useStore((s) => s.openPanel);

  function getActiveTabId(): string | null {
    return useStore.getState().activeTabId;
  }
  function getActivePaneId(): string | null {
    const tabId = getActiveTabId();
    if (!tabId) return null;
    return useStore.getState().tabs[tabId]?.activePaneId ?? null;
  }

  const paletteCommands = buildAppCommands({
    onNewTab: () => addTab(),
    onCloseTab: () => {
      const t = getActiveTabId();
      if (t) closeTab(t);
    },
    onSplitRight: () => {
      const t = getActiveTabId();
      const p = getActivePaneId();
      if (t && p) splitPane(t, p, "horizontal");
    },
    onSplitDown: () => {
      const t = getActiveTabId();
      const p = getActivePaneId();
      if (t && p) splitPane(t, p, "vertical");
    },
    onClosePane: () => {
      const t = getActiveTabId();
      const p = getActivePaneId();
      if (t && p) closePane(t, p);
    },
    onNextTab: () => {
      const tabs = useStore.getState().tabs;
      const activeTabId = getActiveTabId();
      if (!activeTabId) return;
      const ids = Object.keys(tabs);
      const idx = ids.indexOf(activeTabId);
      const next = ids[(idx + 1) % ids.length];
      if (next && next !== activeTabId) switchTab(next);
    },
    onFind: () => {},
    onSaveScrollback: () => {
      window.electronAPI.scrollback.save("");
    },
    onToggleFiles: () => openPanel("files"),
    onToggleStatus: () => openPanel("status"),
    onToggleNetwork: () => openPanel("network"),
    onToggleSettings: () => openPanel("settings"),
    onToggleCommandPalette: () => setPaletteOpen((v) => !v),
  });

  useKeyboardShortcuts({
    onToggleCommandPalette: () => setPaletteOpen((v) => !v),
  });

  const activeTabId = useStore((s) => s.activeTabId);
  const tabs = useStore((s) => s.tabs);
  const activePanelId = useStore((s) => s.activePanelId);

  const activeTab = activeTabId ? tabs[activeTabId] : null;
  const layout: LayoutNode = activeTab?.layout ?? { type: "leaf", paneId: "fallback" };

  function renderLeaf(paneId: string): ReactNode {
    return <TerminalView sessionId={null} key={paneId} />;
  }

  return (
    <div className="app-root" data-theme="dark">
      <TitleBar />
      <TabBar />
      <div className="app-body">
        <Rail />
        <SplitContainer node={layout} renderLeaf={renderLeaf} />
        {activePanelId !== null && (
          <div className="app-panel" data-panel-id={activePanelId} style={{ width: PANEL_WIDTH }} />
        )}
      </div>
      <StatusBar />
      {paletteOpen && (
        <CommandPalette commands={paletteCommands} onClose={() => setPaletteOpen(false)} />
      )}
    </div>
  );
}

export default App;
