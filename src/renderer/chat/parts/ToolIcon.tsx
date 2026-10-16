import {
  Bot,
  Brain,
  Eye,
  FilePen,
  FilePlus2,
  FolderOpen,
  Globe,
  ListChecks,
  MessageCircleQuestion,
  NotebookPen,
  Plug,
  Search,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

import type { ToolCategory } from '../../../shared/transcript-payload';

const ICONS: Readonly<Record<ToolCategory | 'thought', LucideIcon>> = {
  read: Eye,
  search: Search,
  list: FolderOpen,
  command: SquareTerminal,
  edit: FilePen,
  write: FilePlus2,
  web: Globe,
  mcp: Plug,
  agent: Bot,
  todo: ListChecks,
  question: MessageCircleQuestion,
  plan: NotebookPen,
  other: Wrench,
  thought: Brain,
};

export function ToolIcon({ category }: { readonly category: ToolCategory | 'thought' }): JSX.Element {
  const Icon = ICONS[category] ?? Wrench;
  return <Icon className="chat-tool-icon" aria-hidden="true" />;
}
