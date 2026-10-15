import type { ToolCategory } from '../../../shared/transcript-payload';
import type { ChatActivity, ChatTool } from './types';

export type ChatLocale = 'ko' | 'en';

/** `3s`, `1m 20s`, `2h 5m` / `3초`, `1분 20초`. */
export function formatDuration(ms: number, locale: ChatLocale): string {
  const total = Math.max(0, Math.round(ms / 1_000));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  if (locale === 'ko') {
    if (hours) return minutes ? `${hours}시간 ${minutes}분` : `${hours}시간`;
    if (minutes) return seconds ? `${minutes}분 ${seconds}초` : `${minutes}분`;
    return `${seconds}초`;
  }
  if (hours) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

type Phrase = (count: number, live: boolean) => string;

const EN: Readonly<Record<ToolCategory | 'fetch', Phrase>> = {
  read: (n, live) => `${live ? 'Reading' : 'Read'} ${n} ${n === 1 ? 'file' : 'files'}`,
  search: (n, live) => (live ? `Searching${n > 1 ? ` (${n})` : ''}` : `Searched ${n} ${n === 1 ? 'time' : 'times'}`),
  list: (n, live) => `${live ? 'Listing' : 'Listed'} ${n} ${n === 1 ? 'folder' : 'folders'}`,
  command: (n, live) => `${live ? 'Running' : 'Ran'} ${n} ${n === 1 ? 'command' : 'commands'}`,
  edit: (n, live) => `${live ? 'Editing' : 'Edited'} ${n} ${n === 1 ? 'file' : 'files'}`,
  write: (n, live) => `${live ? 'Creating' : 'Created'} ${n} ${n === 1 ? 'file' : 'files'}`,
  web: (n, live) => (live ? 'Searching the web' : `Searched the web${n > 1 ? ` ${n} times` : ''}`),
  fetch: (n, live) => `${live ? 'Fetching' : 'Fetched'} ${n} ${n === 1 ? 'page' : 'pages'}`,
  mcp: (n, live) => `${live ? 'Calling' : 'Called'} ${n} ${n === 1 ? 'tool' : 'tools'}`,
  agent: (n, live) => `${live ? 'Running' : 'Ran'} ${n} ${n === 1 ? 'subagent' : 'subagents'}`,
  todo: (_n, live) => (live ? 'Updating tasks' : 'Updated tasks'),
  question: (_n, live) => (live ? 'Asking a question' : 'Asked a question'),
  plan: (_n, live) => (live ? 'Proposing a plan' : 'Proposed a plan'),
  other: (n, live) => `${live ? 'Using' : 'Used'} ${n} ${n === 1 ? 'tool' : 'tools'}`,
};

const KO: Readonly<Record<ToolCategory | 'fetch', Phrase>> = {
  read: (n, live) => `파일 ${n}개 ${live ? '읽는 중' : '읽음'}`,
  search: (n, live) => (live ? '검색 중' : `${n}번 검색함`),
  list: (n, live) => `폴더 ${n}개 ${live ? '확인 중' : '확인함'}`,
  command: (n, live) => `명령 ${n}개 ${live ? '실행 중' : '실행함'}`,
  edit: (n, live) => `파일 ${n}개 ${live ? '수정 중' : '수정함'}`,
  write: (n, live) => `파일 ${n}개 ${live ? '만드는 중' : '만듦'}`,
  web: (n, live) => (live ? '웹 검색 중' : `웹 검색 ${n}번`),
  fetch: (n, live) => `페이지 ${n}개 ${live ? '가져오는 중' : '가져옴'}`,
  mcp: (n, live) => `도구 ${n}개 ${live ? '호출 중' : '호출함'}`,
  agent: (n, live) => `하위 에이전트 ${n}개 ${live ? '실행 중' : '실행함'}`,
  todo: (_n, live) => (live ? '작업 목록 갱신 중' : '작업 목록 갱신'),
  question: (_n, live) => (live ? '질문하는 중' : '질문함'),
  plan: (_n, live) => (live ? '계획 제안 중' : '계획 제안'),
  other: (n, live) => `도구 ${n}개 ${live ? '사용 중' : '사용함'}`,
};

const ORDER: readonly (ToolCategory | 'fetch')[] = [
  'read', 'search', 'list', 'command', 'edit', 'write', 'web', 'fetch', 'mcp', 'agent', 'todo', 'question', 'plan', 'other',
];

function bucket(tool: ChatTool): ToolCategory | 'fetch' {
  if (tool.category === 'web' && tool.name === 'WebFetch') return 'fetch';
  return tool.category;
}

export interface ActivitySummary {
  /** One-sentence header, e.g. "Read 3 files, searched 2 times, and ran 1 command". */
  readonly text: string;
  /** A run that is exactly one command shows the command itself. */
  readonly singleCommand?: string;
  readonly failed: number;
  readonly denied: number;
  readonly interrupted: number;
  readonly thoughtMs?: number;
}

function joinEnglish(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  const [first, ...rest] = parts;
  const lowered = rest.map((part) => part.charAt(0).toLowerCase() + part.slice(1));
  return lowered.length === 1 ? `${first} and ${lowered[0]}` : `${first}, ${lowered.slice(0, -1).join(', ')}, and ${lowered.at(-1)}`;
}

export function summarizeActivity(entries: readonly ChatActivity[], live: boolean, locale: ChatLocale): ActivitySummary {
  const tools = entries.flatMap((entry) => (entry.kind === 'tool' ? [entry.tool] : []));
  const thoughts = entries.flatMap((entry) => (entry.kind === 'thought' ? [entry] : []));
  const thoughtMs = thoughts.some((thought) => thought.durationMs !== undefined)
    ? thoughts.reduce((total, thought) => total + (thought.durationMs ?? 0), 0)
    : undefined;
  const counts = new Map<ToolCategory | 'fetch', { total: number; running: number; targets: Set<string> }>();
  const count = (key: ToolCategory | 'fetch', running: boolean, target: string | undefined): void => {
    const entry = counts.get(key) ?? { total: 0, running: 0, targets: new Set<string>() };
    entry.total += 1;
    if (running) entry.running += 1;
    if (target) entry.targets.add(target.toLowerCase());
    counts.set(key, entry);
  };
  for (const tool of tools) {
    const running = tool.status === 'running';
    // One change set (Codex fileChange) can create some files and edit others.
    if ((tool.category === 'edit' || tool.category === 'write') && tool.files && tool.files.length > 1) {
      for (const file of tool.files) count(file.kind === 'add' ? 'write' : 'edit', running, file.path);
    } else {
      count(bucket(tool), running, tool.target);
    }
  }
  // Reading or editing the same file twice is still "1 file".
  const FILE_BUCKETS = new Set<ToolCategory | 'fetch'>(['read', 'edit', 'write']);
  for (const [key, entry] of counts) {
    if (FILE_BUCKETS.has(key) && entry.targets.size > 0 && entry.targets.size < entry.total) entry.total = entry.targets.size;
  }
  const phrases = locale === 'ko' ? KO : EN;
  const parts = ORDER.flatMap((key) => {
    const entry = counts.get(key);
    return entry ? [phrases[key](entry.total, live && entry.running > 0)] : [];
  });
  const failed = tools.filter((tool) => tool.status === 'failed').length;
  const denied = tools.filter((tool) => tool.status === 'denied').length;
  const interrupted = tools.filter((tool) => tool.status === 'interrupted').length;
  const single = tools.length === 1 && tools[0].category === 'command' ? tools[0].command ?? tools[0].target : undefined;
  let text: string;
  if (parts.length) {
    text = locale === 'ko' ? parts.join(', ') : joinEnglish(parts);
  } else if (live && thoughts.some((thought) => thought.streaming)) {
    text = locale === 'ko' ? '생각 중' : 'Thinking';
  } else {
    text = thoughtMs !== undefined
      ? (locale === 'ko' ? `${formatDuration(thoughtMs, locale)} 동안 생각함` : `Thought for ${formatDuration(thoughtMs, locale)}`)
      : (locale === 'ko' ? '생각함' : 'Thought');
  }
  return { text, ...(single ? { singleCommand: single } : {}), failed, denied, interrupted, ...(thoughtMs !== undefined ? { thoughtMs } : {}) };
}

/** Verb for one tool line: "Read", "Ran", "Edited"… and failures as "Tried to …". */
export function toolVerb(tool: ChatTool, locale: ChatLocale): string {
  const failed = tool.status === 'failed' || tool.status === 'denied';
  if (locale === 'ko') {
    const map: Readonly<Record<string, string>> = {
      read: '읽기', search: '검색', list: '목록', command: '실행', edit: '수정', write: '생성', web: tool.name === 'WebFetch' ? '가져오기' : '웹 검색',
      fetch: '가져오기', mcp: '도구', agent: '하위 에이전트', todo: '작업 목록', question: '질문', plan: '계획', other: '도구',
    };
    const verb = map[tool.category] ?? '도구';
    if (tool.awaitingApproval) return `${verb} 승인 대기`;
    return tool.status === 'running' ? `${verb} 중` : failed ? `${verb} 실패` : verb;
  }
  const done: Readonly<Record<string, string>> = {
    read: 'Read', search: 'Searched', list: 'Listed', command: 'Ran', edit: 'Edited', write: 'Created',
    web: tool.name === 'WebFetch' ? 'Fetched' : 'Searched the web', mcp: 'Called', agent: 'Subagent', todo: 'Updated tasks',
    question: 'Asked', plan: 'Proposed plan', other: 'Used',
  };
  const running: Readonly<Record<string, string>> = {
    read: 'Reading', search: 'Searching', list: 'Listing', command: 'Running', edit: 'Editing', write: 'Creating',
    web: tool.name === 'WebFetch' ? 'Fetching' : 'Searching the web', mcp: 'Calling', agent: 'Subagent', todo: 'Updating tasks',
    question: 'Asking', plan: 'Proposing plan', other: 'Using',
  };
  if (tool.awaitingApproval) return 'Awaiting approval';
  if (tool.status === 'running') return running[tool.category] ?? 'Using';
  const verb = done[tool.category] ?? 'Used';
  return failed ? `Tried to ${verb.charAt(0).toLowerCase()}${verb.slice(1)}` : verb;
}

/** Short display target: a path collapses to its tail; commands stay one line. */
export function toolDisplayTarget(tool: ChatTool, workspaceRoot?: string): string {
  const raw = tool.command ?? tool.target ?? tool.query ?? (tool.server ? `${tool.server} / ${tool.name}` : tool.name);
  let value = raw.split(/\r?\n/u, 1)[0] ?? raw;
  value = value.replace(/<WORKSPACE>[\\/]+/gu, '');
  if (workspaceRoot) {
    const root = workspaceRoot.replace(/[\\/]+$/u, '');
    if (value.toLowerCase().startsWith(root.toLowerCase())) value = value.slice(root.length).replace(/^[\\/]+/u, '');
  }
  return value.replace(/\\\\/gu, '\\');
}
