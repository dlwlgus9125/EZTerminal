export interface RecentPanelSwitcherItem {
  readonly panelId: string;
  readonly title: string;
  readonly detail: string;
  readonly statuses: readonly string[];
}

export interface RecentPanelSwitcherProps {
  readonly items: readonly RecentPanelSwitcherItem[];
  readonly selectedPanelId: string;
}

function optionId(panelId: string): string {
  return `recent-panel-option-${panelId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

export function RecentPanelSwitcher({
  items,
  selectedPanelId,
}: RecentPanelSwitcherProps): JSX.Element {
  const selected = items.find((item) => item.panelId === selectedPanelId) ?? items[0];
  const selectedId = selected ? optionId(selected.panelId) : undefined;
  const announcement = selected
    ? `${selected.title}, ${selected.detail}${selected.statuses.length > 0 ? `, ${selected.statuses.join(', ')}` : ''}`
    : 'No pane selected';

  return (
    <div className="recent-panel-switcher-overlay" data-testid="recent-panel-switcher">
      <div className="recent-panel-switcher" aria-label="Recent panes">
        <div className="recent-panel-switcher-head">
          <span>Recent panes</span>
          <kbd>Ctrl+Tab</kbd>
        </div>
        <div
          className="recent-panel-switcher-list"
          role="listbox"
          aria-label="Recent terminal panes"
          aria-activedescendant={selectedId}
          tabIndex={-1}
        >
          {items.map((item) => {
            const isSelected = item.panelId === selectedPanelId;
            return (
              <div
                id={optionId(item.panelId)}
                key={item.panelId}
                className={`recent-panel-switcher-row${isSelected ? ' recent-panel-switcher-row--selected' : ''}`}
                role="option"
                aria-selected={isSelected}
                data-testid={`recent-panel-option-${item.panelId}`}
              >
                <div className="recent-panel-switcher-copy">
                  <span className="recent-panel-switcher-title" title={item.title}>{item.title}</span>
                  <span className="recent-panel-switcher-detail" title={item.detail}>{item.detail}</span>
                </div>
                {item.statuses.length > 0 && (
                  <span className="recent-panel-switcher-statuses" aria-label={item.statuses.join(', ')}>
                    {item.statuses.map((status) => (
                      <span key={status} className="recent-panel-switcher-status">{status}</span>
                    ))}
                  </span>
                )}
              </div>
            );
          })}
        </div>
        <div className="recent-panel-switcher-foot">
          Release Ctrl to switch <span aria-hidden="true">·</span> Escape to cancel
        </div>
      </div>
      <div
        className="recent-panel-switcher-sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </div>
    </div>
  );
}
