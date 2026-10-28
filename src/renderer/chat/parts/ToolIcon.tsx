import { glyphIcon, type GlyphIcon } from '../../ui/Glyph';

import type { ToolCategory } from '../../../shared/transcript-payload';

const ICONS: Readonly<Record<ToolCategory | 'thought', GlyphIcon>> = {
  read: glyphIcon('eye'),
  search: glyphIcon('search'),
  list: glyphIcon('proj'),
  command: glyphIcon('term'),
  edit: glyphIcon('edit'),
  write: glyphIcon('plus'),
  web: glyphIcon('globe'),
  mcp: glyphIcon('plug'),
  agent: glyphIcon('bot'),
  todo: glyphIcon('list'),
  question: glyphIcon('q'),
  plan: glyphIcon('edit'),
  other: glyphIcon('set'),
  thought: glyphIcon('spark'),
};

export function ToolIcon({ category }: { readonly category: ToolCategory | 'thought' }): JSX.Element {
  const Icon = ICONS[category] ?? glyphIcon('set');
  return <Icon className="chat-tool-icon" aria-hidden="true" />;
}
