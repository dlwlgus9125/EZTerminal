import type { ReactElement, ReactNode } from "react";
import { SplitContainer } from "./components/SplitContainer";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import { TerminalView } from "./components/Terminal";
import { TitleBar } from "./components/TitleBar";
import { useStore } from "./store";
import type { LayoutNode } from "./store/layout-slice";

function App(): ReactElement {
  const activeTabId = useStore((s) => s.activeTabId);
  const tabs = useStore((s) => s.tabs);

  const activeTab = activeTabId ? tabs[activeTabId] : null;
  const layout: LayoutNode = activeTab?.layout ?? { type: "leaf", paneId: "fallback" };

  function renderLeaf(paneId: string): ReactNode {
    return <TerminalView sessionId={null} key={paneId} />;
  }

  return (
    <div className="app-root" data-theme="dark">
      <TitleBar />
      <TabBar />
      <SplitContainer node={layout} renderLeaf={renderLeaf} />
      <StatusBar />
    </div>
  );
}

export default App;
