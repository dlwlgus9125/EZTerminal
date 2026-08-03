import {
  Brain,
  FilePenLine,
  Image,
  ListChecks,
  Search,
  SquareTerminal,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

import type { AgentTranscriptEntry } from '../shared/agent-history';

type ActivityEntry = Extract<AgentTranscriptEntry, { readonly type: 'activity' }>;

const ICONS: Record<ActivityEntry['kind'], LucideIcon> = {
  command: SquareTerminal,
  tool: Wrench,
  'file-change': FilePenLine,
  'web-search': Search,
  plan: ListChecks,
  subagent: Users,
  image: Image,
  reasoning: Brain,
};

export function AgentActivityEntry({
  entry,
  label,
}: {
  readonly entry: ActivityEntry;
  readonly label: string;
}): JSX.Element {
  const Icon = ICONS[entry.kind];
  return (
    <div className="agent-work-activity" data-kind={entry.kind} data-status={entry.status}>
      <Icon aria-hidden="true" />
      <div>
        <span className="agent-work-activity__type">{label}</span>
        <p>{entry.summary}</p>
      </div>
      {entry.status && <small>{entry.status}</small>}
    </div>
  );
}
