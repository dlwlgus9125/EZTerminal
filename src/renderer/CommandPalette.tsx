import { useEffect, useMemo, useRef, useState } from 'react';

import { subsequenceMatch } from './fuzzy';

export interface PaletteAction {
  readonly id: string;
  readonly title: string;
  readonly run: () => void;
}

interface CommandPaletteProps {
  readonly actions: readonly PaletteAction[];
  readonly onClose: () => void;
}

// A centered overlay (Ctrl+Shift+P) that filters `actions` by a case-insensitive
// subsequence match on the typed query. While open it owns keyboard input: its
// own keydown handler stops propagation so the underlying xterm/cmd-input never
// see the keystrokes (autofocus also moves DOM focus off whatever was focused
// beneath it).
export function CommandPalette({ actions, onClose }: CommandPaletteProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo(
    () => actions.filter((action) => subsequenceMatch(action.title, query)),
    [actions, query],
  );

  // Re-typing narrows or widens the list; always re-anchor selection to the top
  // rather than carry a now-meaningless index over.
  useEffect(() => {
    setSelected(0);
  }, [query]);

  const run = (action: PaletteAction | undefined): void => {
    action?.run();
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(filtered[selected]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="palette-overlay">
      <div className="command-palette" data-testid="command-palette">
        <input
          ref={inputRef}
          className="palette-input"
          data-testid="palette-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type a command…"
          aria-label="command palette"
        />
        <div className="palette-list">
          {filtered.length === 0 && <div className="palette-empty">No matching commands</div>}
          {filtered.map((action, i) => (
            <div
              key={action.id}
              className={`palette-item${i === selected ? ' palette-item--selected' : ''}`}
              data-testid={`palette-item-${action.id}`}
              onMouseDown={(e) => e.preventDefault()} // keep the input focused
              onClick={() => run(action)}
            >
              {action.title}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
