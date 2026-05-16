import type { ReactElement, ReactNode } from "react";
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
  useKeyboardShortcuts();

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
          <div
            className="app-panel"
            data-panel-id={activePanelId}
            style={{ width: PANEL_WIDTH }}
          />
        )}
      </div>
      <StatusBar />
    </div>
  );
}

export default App;
