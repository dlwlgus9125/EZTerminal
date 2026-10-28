import { glyphIcon, type GlyphIcon } from './ui/Glyph';
import { memo } from 'react';

import type { AgentTranscriptEntry } from '../shared/agent-history';

type ActivityEntry = Extract<AgentTranscriptEntry, { readonly type: 'activity' }>;

const ICONS: Record<ActivityEntry['kind'], GlyphIcon> = {
  command: glyphIcon('term'),
  tool: glyphIcon('set'),
  'file-change': glyphIcon('edit'),
  'web-search': glyphIcon('search'),
  plan: glyphIcon('list'),
  subagent: glyphIcon('kids'),
  image: glyphIcon('image'),
  reasoning: glyphIcon('spark'),
};

export const AgentActivityEntry = memo(function AgentActivityEntry({
  entry,
  label,
  onActivate,
}: {
  readonly entry: ActivityEntry;
  readonly label: string;
  readonly onActivate?: (changedPath?: string) => void;
}): JSX.Element {
  const Icon = ICONS[entry.kind];
  const contents = (
    <>
      <Icon aria-hidden="true" />
      <div>
        <span className="agent-work-activity__type">{label}</span>
        <p>{entry.summary}</p>
      </div>
      {entry.status && <small>{entry.status}</small>}
    </>
  );
  if (entry.kind === 'file-change' && onActivate) {
    return (
      <button
        type="button"
        className="agent-work-activity agent-work-activity--action"
        data-kind={entry.kind}
        data-status={entry.status}
        onClick={() => onActivate(entry.changedPaths?.[0])}
      >
        {contents}
      </button>
    );
  }
  return (
    <div className="agent-work-activity" data-kind={entry.kind} data-status={entry.status}>
      {contents}
    </div>
  );
});
