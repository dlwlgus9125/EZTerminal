import type { AgentCapabilityCatalog } from '../shared/agent-capabilities';
import type { ChatComposerDraft, ChatSkillReference } from '../shared/chat-message';

export interface CompletionToken { start: number; end: number; trigger: '/' | '$' | '@'; query: string }
export interface AgentCompletion {
  id: string; label: string; description?: string; group: 'app' | 'skill' | 'provider' | 'file';
  invocation?: string; skill?: ChatSkillReference; action?: 'history' | 'app'; disabledReason?: string;
}
/** An EZTerminal command typed as `/name`; it acts on the conversation and is never sent to the model. */
export interface AppCommand {
  readonly name: string;
  readonly description: string;
  readonly disabledReason?: string;
  /** Text after the command is handed to `run` instead of turning the input into a prompt. */
  readonly takesText?: boolean;
  /** `false`: the command did not take the text, so the message box keeps it. */
  readonly run: (text?: string) => void | boolean;
}
/** A token at the caret, never a URL, path, code span, or selected passage. */
export function completionToken(text: string, start = text.length, end = start): CompletionToken | undefined {
  if (start !== end) return;
  const before = text.slice(0, start);
  if ((before.match(/`/gu)?.length ?? 0) % 2 !== 0) return;
  // `@` mentions a workspace file; its query may contain path separators.
  const mention = before.match(/(?:^|\s)@([^\s`@]*)$/u);
  if (mention) {
    const tail = text.slice(start).match(/^[^\s`@]*/u)?.[0] ?? '';
    return { start: start - mention[1].length - 1, end: start + tail.length, trigger: '@', query: mention[1] };
  }
  const match = /(?:^|\s)([$/])([^\s$/`]*)$/u.exec(before);
  if (!match) return;
  const tokenStart = start - match[2].length - 1;
  const tail = /^[^\s$/`]*/u.exec(text.slice(start))?.[0] ?? '';
  // Do not offer /tmp or /resume inside a longer filesystem path.
  if (text[start + tail.length] === '/' || text[start + tail.length] === '\\') return;
  return { start: tokenStart, end: start + tail.length, trigger: match[1] as '/' | '$', query: match[2] };
}

export function agentCompletions(catalog: AgentCapabilityCatalog | undefined, filter: 'skills' | 'commands' | CompletionToken,
  historyAvailable: boolean, ko: boolean, appCommands: readonly AppCommand[] = []): AgentCompletion[] {
  if (typeof filter !== 'string' && filter.trigger === '@') return [];
  const query = typeof filter === 'string' ? '' : filter.query.toLocaleLowerCase();
  const skillsOnly = filter === 'skills' || (typeof filter !== 'string' && filter.trigger === '$');
  const items: AgentCompletion[] = skillsOnly ? [] : [{ id: 'app:resume', label: '/resume', group: 'app', action: 'history',
    description: ko ? '이전 대화 찾기 · 목록 열기' : 'Find previous conversations · Open history',
    ...(!historyAvailable ? { disabledReason: ko ? '이 화면에서는 기록을 열 수 없습니다.' : 'History is unavailable in this view.' } : {}) },
    ...appCommands.map((command): AgentCompletion => ({ id: `app:${command.name}`, label: `/${command.name}`, group: 'app', action: 'app',
      description: command.description, ...(command.disabledReason ? { disabledReason: command.disabledReason } : {}) }))];
  for (const item of catalog?.items ?? []) {
    if (!item.invocation || !['skill', 'app-skill'].includes(item.kind) || item.invocation === '/resume'
      || appCommands.some((command) => item.invocation === `/${command.name}`)) continue;
    const isSkill = item.kind === 'skill';
    items.push({ id: `${item.kind}:${item.id}`, label: item.invocation, description: item.description,
      group: isSkill ? (catalog!.providerId === 'claude' ? 'provider' : 'skill') : 'skill', invocation: item.invocation,
      ...(isSkill ? { skill: { providerId: catalog!.providerId, id: item.id, name: item.name, invocation: item.invocation } } : {}),
      ...(!item.enabled || item.status === 'unsupported' ? { disabledReason: !item.enabled
        ? (ko ? '비활성 · 확장 관리에서 활성화하세요.' : 'Disabled · Enable in extension management.')
        : (ko ? '현재 Agent에서 지원하지 않습니다.' : 'Unsupported in this Agent.') } : {}) });
  }
  return items.filter(item => `${item.label} ${item.group === 'app' ? '' : item.description ?? ''}`.toLocaleLowerCase().includes(query));
}

/** Replace the whole current token (including its suffix), preserving draft context. */
export function insertCompletion(draft: ChatComposerDraft, insertion: string, token?: CompletionToken, skill?: ChatSkillReference): ChatComposerDraft {
  const start = token?.start ?? draft.selectionStart ?? draft.text.length;
  const end = token?.end ?? draft.selectionEnd ?? start;
  const suffix = draft.text.slice(end);
  const spacer = insertion && !/^\s/u.test(suffix) ? ' ' : '';
  const text = `${draft.text.slice(0, start)}${insertion}${spacer}${suffix}`;
  const caret = start + insertion.length + spacer.length;
  return { ...draft, text, selectionStart: caret, selectionEnd: caret,
    ...(skill ? { skills: [...(draft.skills ?? []).filter(entry => entry.id !== skill.id || entry.providerId !== skill.providerId), skill] } : {}) };
}
