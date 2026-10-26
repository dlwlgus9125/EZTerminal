import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { AgentCapabilityCatalog } from '../shared/agent-capabilities';
import type { ChatComposerDraft } from '../shared/chat-message';
import { agentCompletions, completionToken, insertCompletion, type AgentCompletion } from './agent-completion';
import { useAppTranslation } from './i18n';
import type { AppCommand } from './agent-completion';
import { Button } from './ui';
import './agent-completion.css';

export interface CapabilityDiscoveryState { loading: boolean; error?: string }

/** Workspace-relative paths matching a query, best first. */
export type ComposerFileSearch = (query: string) => Promise<readonly string[]>;

export function useAgentCompletion({ value, onChange, inputRef, catalog, discovery, onOpenHistory, disabled, mobile = false, fileSearch, appCommands = [] }:
  { value: ChatComposerDraft; onChange: (next: ChatComposerDraft) => void; inputRef: RefObject<HTMLTextAreaElement>;
    catalog?: AgentCapabilityCatalog; discovery?: CapabilityDiscoveryState; onOpenHistory?: () => void; disabled?: boolean; mobile?: boolean;
    fileSearch?: ComposerFileSearch; appCommands?: readonly AppCommand[] }) {
  const { i18n } = useAppTranslation();
  const ko = i18n.language.startsWith('ko');
  const listId = useId();
  const [manual, setManual] = useState<'skills' | 'commands'>();
  const [dismissed, setDismissed] = useState<string>();
  const [activeIndex, setActiveIndex] = useState(0);
  const [composing, setComposing] = useState(false);
  const compositionRef = useRef(false);
  const fingerprint = `${value.text}:${value.selectionStart}:${value.selectionEnd}`;
  const token = completionToken(value.text, value.selectionStart, value.selectionEnd);
  const filter = manual ?? token;
  const mentioning = !manual && token?.trigger === '@';
  const [files, setFiles] = useState<{ query: string; paths: readonly string[]; loading: boolean }>({ query: '', paths: [], loading: false });
  useEffect(() => {
    if (!mentioning || !fileSearch || disabled) return undefined;
    const query = token!.query;
    let cancelled = false;
    setFiles((current) => ({ ...current, loading: true }));
    const timer = setTimeout(() => {
      void fileSearch(query).then(
        (paths) => { if (!cancelled) setFiles({ query, paths: paths.slice(0, 20), loading: false }); },
        () => { if (!cancelled) setFiles({ query, paths: [], loading: false }); },
      );
    }, 120);
    return () => { cancelled = true; clearTimeout(timer); };
    // The token query is the only input that changes the search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentioning, token?.query, fileSearch, disabled]);
  const open = !disabled && !composing && dismissed !== fingerprint && !!filter && (!mentioning || !!fileSearch);
  const items: AgentCompletion[] = !open ? [] : mentioning
    ? files.paths.map((path) => ({ id: `file:${path}`, label: path, group: 'file' as const, invocation: `@${path}` }))
    : agentCompletions(catalog, filter!, !!onOpenHistory, ko, appCommands);
  const active = Math.min(activeIndex, Math.max(0, items.length - 1));
  useEffect(() => setActiveIndex(0), [fingerprint, manual, catalog?.revision]);
  useEffect(() => setManual(undefined), [fingerprint]);
  useEffect(() => {
    if (!open) return;
    const list = document.getElementById(listId);
    const option = document.getElementById(`${listId}-${active}`);
    if (!list || !option) return;
    const boundary = list.getBoundingClientRect();
    const selected = option.getBoundingClientRect();
    if (selected.top < boundary.top) list.scrollTop -= boundary.top - selected.top;
    else if (selected.bottom > boundary.bottom) list.scrollTop += selected.bottom - boundary.bottom;
  }, [open, active, items.length, listId]);
  const close = (): void => { setManual(undefined); setDismissed(fingerprint); };
  const select = (item: AgentCompletion): void => {
    if (item.disabledReason) return;
    const next = insertCompletion(value, item.invocation ?? '', token, item.skill);
    onChange(next);
    setManual(undefined); setDismissed(`${next.text}:${next.selectionStart}:${next.selectionEnd}`);
    inputRef.current?.focus();
    if (item.action === 'history') onOpenHistory?.();
    if (item.action === 'app') appCommands.find((command) => `/${command.name}` === item.label)?.run();
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (compositionRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return false;
    if (!open) return false;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return true; }
    if (event.key === 'Tab') { close(); return false; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); setActiveIndex(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + Math.max(items.length, 1)) % Math.max(items.length, 1)); return true;
    }
    if (!mobile && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault(); if (items[active]) select(items[active]); return true;
    }
    return false;
  };
  const buttons = <><Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => { setManual('skills'); setDismissed(undefined); inputRef.current?.focus(); }}>{ko ? '스킬' : 'Skills'}</Button>
    <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => { setManual('commands'); setDismissed(undefined); inputRef.current?.focus(); }}>{ko ? '명령' : 'Commands'}</Button></>;
  const openManual = (kind: 'skills' | 'commands'): void => { setManual(kind); setDismissed(undefined); inputRef.current?.focus(); };
  const groupName = (group: AgentCompletion['group']): string => group === 'file' ? (ko ? '파일' : 'Files') : group === 'app' ? 'EZTerminal' : group === 'provider'
    ? (ko ? '제공자 명령·스킬' : 'Provider commands and skills') : (ko ? '스킬' : 'Skills');
  const menu = open ? <div className="agent-completion" data-testid="agent-completion">
    <div className="agent-completion__heading"><strong>{mentioning ? (ko ? '파일 참조' : 'Mention a file') : manual === 'skills' || token?.trigger === '$' ? (ko ? '스킬' : 'Skills') : (ko ? '명령·스킬' : 'Commands and skills')}</strong>
      <Button type="button" size="sm" variant="ghost" onMouseDown={event => event.preventDefault()} onClick={close}>{ko ? '닫기' : 'Close'}</Button></div>
    <div id={listId} role="listbox" aria-label={ko ? '입력 자동완성' : 'Input suggestions'} className="agent-completion__list">
      {items.map((item, index) => <div key={item.id}>
        {(index === 0 || items[index - 1].group !== item.group) && <p className="agent-completion__group" aria-hidden="true">{groupName(item.group)}</p>}
        <div id={`${listId}-${index}`} role="option" aria-selected={active === index} aria-disabled={!!item.disabledReason}
          className="agent-completion__item" onMouseDown={event => event.preventDefault()} onMouseMove={() => setActiveIndex(index)} onClick={() => select(item)}>
          <strong>{item.label}</strong><span>{item.disabledReason ?? item.description}</span>
        </div>
      </div>)}
    </div>
    <p className="agent-completion__status" role="status">{mentioning ? (files.loading ? (ko ? '파일을 찾는 중…' : 'Searching files…')
      : items.length === 0 ? (ko ? '일치하는 파일이 없습니다.' : 'No matching files.') : (ko ? '↑↓ 이동 · Enter 선택 · Esc 닫기' : '↑↓ Navigate · Enter Select · Esc Close'))
      : discovery?.loading ? (ko ? 'PC의 목록을 조회 중입니다.' : 'Discovering on the connected PC…')
      : discovery?.error ? `${catalog ? (ko ? '이전 목록 · ' : 'Previous catalog · ') : ''}${discovery.error}`
      : !catalog ? (ko ? '이 연결에서는 제공자 목록을 확인할 수 없습니다.' : 'Provider discovery is unavailable for this connection.')
      : items.length === 0 ? ((typeof filter === 'object' && filter.query) ? (ko ? '일치하는 항목이 없습니다.' : 'No matching suggestions.') : (ko ? '설치된 스킬이 없습니다.' : 'No installed skills.'))
      : catalog.issues.length ? (ko ? '일부 목록을 확인하지 못했습니다. 확장 관리에서 다시 조회하세요.' : 'Some extensions could not be read. Refresh in extension management.')
      : (mobile ? (ko ? '항목을 눌러 입력에 추가' : 'Tap a suggestion to insert') : (ko ? '↑↓ 이동 · Enter 선택 · Esc 닫기' : '↑↓ Navigate · Enter Select · Esc Close'))}</p>
  </div> : null;
  return { menu, buttons, keyDown, composing: compositionRef, open, openManual,
    inputProps: { 'aria-autocomplete': 'list' as const, 'aria-controls': open ? listId : undefined,
      'aria-activedescendant': open && items.length ? `${listId}-${active}` : undefined,
      onCompositionStart: () => { compositionRef.current = true; setComposing(true); },
      onCompositionEnd: () => { compositionRef.current = false; setComposing(false); } },
    // Reserved app command also works after Escape or explicit Send; it is never a model prompt.
    runAppCommand: (): boolean => {
      // `/plan`, `/model` and `/new` stand alone; anything after them would be a prompt. A command
      // that takes text (`/clear`) is never a prompt, with or without text after it.
      const typed = /^\s*\/([a-z]+)(?:\s+([\s\S]*?))?\s*$/u.exec(value.text);
      const rest = typed?.[2] ?? '';
      const command = typed ? appCommands.find((entry) => entry.name === typed[1] && (!rest || entry.takesText)) : undefined;
      if (command) {
        if (command.disabledReason) { setManual('commands'); setDismissed(undefined); return true; }
        onChange({ ...value, text: '', selectionStart: 0, selectionEnd: 0 }); close(); command.run(rest || undefined);
        return true;
      }
      // /btw is never a prompt, even where no surface offers it: show the commands instead.
      if (typed?.[1] === 'btw') { setManual('commands'); setDismissed(undefined); return true; }
      const match = /^\s*\/resume(?:\s|$)/u.exec(value.text);
      if (!match) return false;
      if (onOpenHistory) { onChange({ ...value, text: value.text.slice(match[0].length), selectionStart: 0, selectionEnd: 0 }); close(); onOpenHistory(); }
      else { setManual('commands'); setDismissed(undefined); }
      return true;
    } };
}
