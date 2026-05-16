import type { ReactElement, ReactNode } from "react";
import { SplitContainer } from "./components/SplitContainer";
import { TerminalView } from "./components/Terminal";
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
      <SplitContainer node={layout} renderLeaf={renderLeaf} />
    </div>
  );
}

export default App;
