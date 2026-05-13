import type { ReactElement } from "react";

/**
 * App root component.
 * Sets data-theme='dark' on the document element to activate Phosphor tokens.
 * The html element already has data-theme='dark' from index.html.
 */
function App(): ReactElement {
  return (
    <div className="app-root">
      <div className="app-placeholder">
        <span>EZTerminal</span>
      </div>
    </div>
  );
}

export default App;
