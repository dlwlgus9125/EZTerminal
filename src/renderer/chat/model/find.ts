import type { ChatRow } from './types';

/** Text a reader sees on a row without expanding anything. */
export function rowSearchText(row: ChatRow): string {
  switch (row.kind) {
    case 'user':
    case 'assistant':
    case 'notice':
    case 'error':
    case 'child':
      return row.text;
    case 'plan':
      return row.markdown;
    case 'question':
      return row.questions.map((question) => [question.header, question.question, ...question.options].filter(Boolean).join('\n')).join('\n');
    case 'todo':
      return row.items.map((item) => item.text).join('\n');
    case 'changes':
      return row.files.map((file) => file.path).join('\n');
    case 'activity':
      return row.entries.map((entry) => (entry.kind === 'tool'
        ? [entry.tool.name, entry.tool.target, entry.tool.command, entry.tool.query].filter(Boolean).join(' ')
        : '')).join('\n');
    case 'turn-status':
      return '';
    case 'review':
      return [
        row.review.overall,
        row.review.reason,
        row.review.focus,
        ...row.review.findings.map((finding) => `${finding.file}${finding.line ? `:${String(finding.line)}` : ''} ${finding.title}`),
      ].filter(Boolean).join('\n');
    case 'task-suggestions':
      return row.suggestions.tasks.map((task) => `${task.title}\n${task.rationale}`).join('\n');
    case 'recap':
      return row.recap.text ?? '';
    case 'usage-limit':
      return '';
    case 'browser-run':
    case 'browser-blocked':
    case 'browser-waiting':
      return row.kind === 'browser-run' ? row.run.origin : row.origin;
    case 'browser-check':
      return row.check.summary ?? '';
  }
}

/** Ids of rows containing `query` (case-insensitive), in transcript order. */
export function findRows(rows: readonly ChatRow[], query: string): string[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  return rows.filter((row) => rowSearchText(row).toLocaleLowerCase().includes(needle)).map((row) => row.id);
}
