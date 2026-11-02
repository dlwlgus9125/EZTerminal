import { memo } from 'react';

import { useChatContext } from './ChatContext';
import type { ChatRow } from './model/types';
import {
  BubbleActivity, BubbleAssistant, BubbleChanges, BubbleError, BubbleNotice, BubblePlan, BubbleQuestion, BubbleTodo,
  BubbleTurnStatus, BubbleUser,
} from './rows/BubbleRows';
import {
  CliActivity, CliAssistant, CliChanges, CliNotice, CliPlan, CliQuestion, CliTodo, CliTurnStatus, CliUser,
} from './rows/CliRows';
import { BrowserBlockedRow, BrowserCheckCard, BrowserRunRow, BrowserWaitingRow } from './rows/BrowserRows';
import { RecapCard } from './rows/RecapCard';
import { ReviewCard } from './rows/ReviewCard';
import { TaskSuggestionsCard } from './rows/TaskSuggestionsCard';
import { UsageLimitCard } from './rows/UsageLimitCard';

/** One transcript row in the active skin. Both skins render the same rows and offer the same actions. */
export const ChatRowView = memo(function ChatRowView({ row, providerLabel }: {
  readonly row: ChatRow;
  readonly providerLabel: string;
}): JSX.Element | null {
  const { skin } = useChatContext();
  if (skin === 'cli') {
    switch (row.kind) {
      case 'user': return <CliUser row={row} />;
      case 'assistant': return <CliAssistant row={row} providerLabel={providerLabel} />;
      case 'activity': return <CliActivity row={row} />;
      case 'turn-status': return <CliTurnStatus row={row} />;
      case 'plan': return <CliPlan row={row} />;
      case 'question': return <CliQuestion row={row} />;
      case 'todo': return <CliTodo row={row} />;
      case 'changes': return <CliChanges row={row} />;
      case 'review': return <ReviewCard row={row} />;
      case 'task-suggestions': return <TaskSuggestionsCard row={row} />;
      case 'recap': return <RecapCard row={row} />;
      case 'usage-limit': return <UsageLimitCard row={row} />;
      case 'browser-run': return <BrowserRunRow row={row} />;
      case 'browser-blocked': return <BrowserBlockedRow row={row} />;
      case 'browser-check': return <BrowserCheckCard row={row} />;
      case 'browser-waiting': return <BrowserWaitingRow row={row} />;
      case 'notice':
      case 'child':
      case 'error': return <CliNotice row={row} />;
    }
  }
  switch (row.kind) {
    case 'user': return <BubbleUser row={row} />;
    case 'assistant': return <BubbleAssistant row={row} providerLabel={providerLabel} />;
    case 'activity': return <BubbleActivity row={row} />;
    case 'turn-status': return <BubbleTurnStatus row={row} />;
    case 'plan': return <BubblePlan row={row} />;
    case 'question': return <BubbleQuestion row={row} />;
    case 'todo': return <BubbleTodo row={row} />;
    case 'changes': return <BubbleChanges row={row} />;
    case 'review': return <ReviewCard row={row} />;
    case 'task-suggestions': return <TaskSuggestionsCard row={row} />;
    case 'recap': return <RecapCard row={row} />;
    case 'usage-limit': return <UsageLimitCard row={row} />;
    case 'browser-run': return <BrowserRunRow row={row} />;
    case 'browser-blocked': return <BrowserBlockedRow row={row} />;
    case 'browser-check': return <BrowserCheckCard row={row} />;
    case 'browser-waiting': return <BrowserWaitingRow row={row} />;
    case 'notice':
    case 'child': return <BubbleNotice row={row} />;
    case 'error': return <BubbleError row={row} />;
  }
  return null;
});
