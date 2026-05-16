import type { ReactElement } from "react";
import { TerminalView } from "./components/Terminal";

function App(): ReactElement {
  return (
    <div className="app-root">
      <TerminalView sessionId={null} />
    </div>
  );
}

export default App;
