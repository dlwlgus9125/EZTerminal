import { ArrowLeft, History, MessageSquare, RefreshCw, SquareTerminal } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import type { AgentTranscriptPage } from '../shared/agent-history';
import type {
  ConversationEntry,
  ConversationHistoryClient,
  ConversationHistoryFailureReason,
  ConversationQuery,
  HistoryResumePreparation,
  HistoryResumeRequest,
} from '../shared/conversation-history';
import { useAppTranslation } from './i18n';
import { Badge, Button, Dialog, Field, Input, Select } from './ui';
import './conversation-history.css';

export interface ConversationHistoryPickerProps {
  readonly onOpenConversation?: (entry: ConversationEntry) => void | Promise<void>;
  readonly client?: ConversationHistoryClient;
  readonly currentProjectId?: string;
  readonly initialConversationId?: string;
  readonly projects?: readonly { readonly id: string; readonly name: string }[];
  readonly variant?: 'desktop' | 'mobile';
  readonly disconnected?: boolean;
  /** Lets a mobile shell put preview Back above the history sheet in its own stack. */
  readonly onPreviewBackChange?: (onBack: (() => void) | undefined) => void;
  readonly onOpenSession: (input: { readonly sessionId: string; readonly title?: string; readonly providerLabel?: string }) => void | Promise<void>;
  readonly onOpenCliHistory?: (entry: ConversationEntry) => void | Promise<void>;
}

/** Closing a picker does not turn an unconfirmed write into a fresh request. */
const pendingByClient = new WeakMap<ConversationHistoryClient, Map<string, HistoryResumeRequest>>();
const clientScopes = new WeakMap<ConversationHistoryClient, number>();
let nextClientScope = 1;
const providerLabel = (provider: string): string => provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude' : provider;

function failureText(reason: ConversationHistoryFailureReason, ko: boolean): string {
  const messages: Record<ConversationHistoryFailureReason, readonly [string, string]> = {
    invalid: ['대화 요청을 확인할 수 없습니다. 목록을 새로고침하세요.', 'This conversation request is invalid. Refresh the list.'],
    'not-found': ['이 대화를 더 이상 찾을 수 없습니다. 목록을 새로고침하세요.', 'This conversation is no longer available. Refresh the list.'],
    unavailable: ['PC에 연결하여 다시 확인하세요. 기존 대화와 초안은 유지됩니다.', 'Reconnect to the PC and retry. Your conversation and draft are preserved.'],
    unsupported: ['연결된 PC의 EZTerminal을 업데이트하면 통합 기록을 사용할 수 있습니다.', 'Update EZTerminal on the connected PC to use unified history.'],
    stale: ['기록이 변경됐습니다. 최신 상태를 다시 확인한 뒤 이어가세요.', 'This record changed. Check its latest state before continuing.'],
    'missing-root': ['기록의 작업 폴더를 찾을 수 없습니다. PC에서 폴더를 복구한 뒤 다시 확인하세요.', 'The recorded working folder is missing. Restore it on the PC and retry.'],
    'root-mismatch': ['기록과 현재 작업 위치가 다릅니다. 프로젝트의 작업 위치를 확인하세요.', 'The recorded and current working locations differ. Check the project workspace.'],
    'provider-unavailable': ['PC의 Agent 설정에서 이 제공자를 준비한 뒤 다시 확인하세요.', 'Prepare this provider in the PC Agent settings, then retry.'],
    conflict: ['다른 작업에서 이 대화의 상태를 바꿨습니다. 최신 상태를 다시 확인하세요.', 'Another operation changed this conversation. Check its latest state.'],
    'archived-project': ['이 프로젝트 또는 단계가 보관되어 있습니다. 복원한 뒤 이어갈 수 있습니다.', 'This project or stage is archived. Restore it before continuing.'],
    'transcript-unavailable': ['이전 메시지를 읽을 수 없어 이어가기를 준비하지 못했습니다. 기록을 다시 확인하세요.', 'The previous messages could not be read. Check the record before continuing.'],
  };
  return messages[reason][ko ? 0 : 1];
}

/** One history surface for app conversations and opaque native CLI records. */
export function ConversationHistoryPicker(props: ConversationHistoryPickerProps): JSX.Element {
  let scope = props.client ? clientScopes.get(props.client) : 0;
  if (props.client && scope === undefined) { scope = nextClientScope++; clientScopes.set(props.client, scope); }
  return <ConversationHistoryPickerView key={`${scope}:${props.currentProjectId ?? ''}`} {...props} />;
}

function ConversationHistoryPickerView({
  client,
  currentProjectId,
  initialConversationId,
  projects = [],
  variant = 'desktop',
  disconnected = false,
  onPreviewBackChange,
  onOpenSession,
  onOpenCliHistory,
  onOpenConversation,
}: ConversationHistoryPickerProps): JSX.Element {
  const { i18n } = useAppTranslation();
  const ko = (i18n.resolvedLanguage ?? i18n.language).startsWith('ko');
  const text = (korean: string, english: string): string => ko ? korean : english;
  const headingId = useId();
  const [projectId, setProjectId] = useState(currentProjectId ?? '');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [providerId, setProviderId] = useState('');
  const [source, setSource] = useState<'' | 'app' | 'native'>('');
  const [archived, setArchived] = useState<'exclude' | 'include' | 'only'>('include');
  const [items, setItems] = useState<readonly ConversationEntry[]>([]);
  const [discoveredProjects, setDiscoveredProjects] = useState<readonly { readonly id: string; readonly name: string }[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<ConversationHistoryFailureReason>();
  const [listRevision, setListRevision] = useState(0);
  const [selectedId, setSelectedId] = useState(initialConversationId);
  const [selected, setSelected] = useState<ConversationEntry>();
  const [transcript, setTranscript] = useState<AgentTranscriptPage>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<ConversationHistoryFailureReason>();
  const [previewRevision, setPreviewRevision] = useState(0);
  const [preparation, setPreparation] = useState<Extract<HistoryResumePreparation, { ok: true }>>();
  const [preparing, setPreparing] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<ConversationHistoryFailureReason>();
  const [uncertain, setUncertain] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const listGeneration = useRef(0);
  const previewGeneration = useRef(0);
  const actionLock = useRef(false);
  const mounted = useRef(true);
  const activeClient = useRef(client);
  activeClient.current = client;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    setProjectId(currentProjectId ?? '');
    setSelectedId(initialConversationId);
  }, [currentProjectId, initialConversationId, client]);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 180);
    return () => clearTimeout(timer);
  }, [search]);

  const filters = useMemo<ConversationQuery>(() => ({
    ...(projectId ? { projectId } : {}), ...(providerId ? { providerId } : {}),
    ...(source ? { source } : {}), archived, ...(query ? { query } : {}), limit: 40,
  }), [projectId, providerId, source, archived, query]);
  const loadList = useCallback(async (nextCursor?: string): Promise<void> => {
    if (!client || disconnected) return;
    const generation = ++listGeneration.current;
    setListLoading(true); setListError(undefined);
    try {
      const result = await client.listConversations({ ...filters, ...(nextCursor ? { cursor: nextCursor } : {}) });
      if (!mounted.current || generation !== listGeneration.current) return;
      if (result.ok) {
        setItems((previous) => nextCursor ? [...previous, ...result.items.filter((item) => !previous.some((entry) => entry.conversationId === item.conversationId))] : result.items);
        setDiscoveredProjects((previous) => [...new Map([...previous, ...result.items.map((entry) => ({ id: entry.projectId, name: entry.projectTitle }))].map((project) => [project.id, project])).values()]);
        setCursor(result.nextCursor);
      } else setListError(result.reason);
    } catch { if (mounted.current && generation === listGeneration.current) setListError('unavailable'); }
    finally { if (mounted.current && generation === listGeneration.current) setListLoading(false); }
  }, [client, disconnected, filters]);
  useEffect(() => {
    setItems([]); setCursor(null);
    void loadList();
    return () => { listGeneration.current += 1; };
  }, [loadList, listRevision]);

  useEffect(() => {
    const generation = ++previewGeneration.current;
    setSelected(undefined); setTranscript(undefined); setPreparation(undefined);
    setPreviewError(undefined); setActionError(undefined); setPreparing(false); setLoadingEarlier(false);
    setUncertain(Boolean(client && selectedId && pendingByClient.get(client)?.has(selectedId)));
    if (!client || !selectedId || disconnected || onOpenConversation) { setPreviewLoading(false); return; }
    setPreviewLoading(true);
    const current = (): boolean => mounted.current && generation === previewGeneration.current;
    void (async () => {
      try {
        const result = await client.readConversation(selectedId, undefined, 20);
        if (!current()) return;
        if (!result.ok) { setPreviewError(result.reason); return; }
        setSelected(result.entry); setTranscript(result.transcript); setPreviewLoading(false);
        if (result.entry.action === 'open') return;
        setPreparing(true);
        const prepared = await client.prepareHistoryResume({ conversationId: selectedId });
        if (!current()) return;
        if (prepared.ok) { setPreparation(prepared); setSelected(prepared.entry); }
        else setActionError(prepared.reason);
      } catch { if (current()) setPreviewError('unavailable'); }
      finally { if (current()) { setPreviewLoading(false); setPreparing(false); } }
    })();
    return () => { previewGeneration.current += 1; };
  }, [client, disconnected, selectedId, previewRevision, onOpenConversation]);

  const changeFilter = (change: () => void): void => { change(); setSelectedId(undefined); };
  const selectedListEntry = items.find((entry) => entry.conversationId === selectedId);
  const entry = selected ?? selectedListEntry;
  const action = preparation?.action ?? entry?.action;
  const linkedSessionId = preparation?.linkedSessionId ?? entry?.linkedSessionId;
  const showMobilePreview = !onOpenConversation && variant === 'mobile' && Boolean(selectedId);
  const closePreview = useCallback(() => setSelectedId(undefined), []);
  useEffect(() => { onPreviewBackChange?.(showMobilePreview ? closePreview : undefined); }, [showMobilePreview, closePreview, onPreviewBackChange]);
  const unavailable = disconnected ? 'unavailable' : !client ? 'unsupported' : listError;

  const openSession = async (sessionId: string, current: ConversationEntry): Promise<void> => {
    await onOpenSession({ sessionId, title: current.title, providerLabel: providerLabel(current.providerId) });
  };
  const continueConversation = async (): Promise<void> => {
    if (!client || !entry || disconnected || actionLock.current) return;
    const current = entry;
    const ownerClient = client;
    actionLock.current = true; setActionBusy(true); setActionError(undefined);
    try {
      if (action === 'open' && linkedSessionId) { await openSession(linkedSessionId, current); return; }
      let requests = pendingByClient.get(client);
      const pending = requests?.get(current.conversationId);
      if (!pending && (!preparation?.canResume || preparation.action !== 'resume')) return;
      const request = pending ?? {
        conversationId: current.conversationId,
        ...(preparation?.workspaceId ? { workspaceId: preparation.workspaceId } : {}),
        ...(preparation?.model ? { model: preparation.model } : {}),
        permissionPreset: preparation!.permissionPreset,
        revision: preparation!.revision,
        commandId: `history-${crypto.randomUUID()}`,
      };
      if (!requests) { requests = new Map(); pendingByClient.set(client, requests); }
      requests.set(current.conversationId, request);
      const result = await client.resumeHistory(request);
      if (result.ok) requests.delete(current.conversationId);
      else if (result.reason !== 'unavailable') requests.delete(current.conversationId);
      if (!mounted.current || activeClient.current !== ownerClient || selectedIdRef.current !== current.conversationId) return;
      if (result.ok) { setUncertain(false); await openSession(result.sessionId, current); }
      else {
        setActionError(result.reason); setUncertain(result.reason === 'unavailable');
        if (result.reason === 'stale' || result.reason === 'conflict') setPreparation(undefined);
      }
    } catch {
      if (mounted.current && activeClient.current === ownerClient && selectedIdRef.current === current.conversationId) {
        setActionError('unavailable'); setUncertain(Boolean(pendingByClient.get(client)?.has(current.conversationId)));
      }
    } finally { actionLock.current = false; if (mounted.current) setActionBusy(false); }
  };

  const earlier = async (): Promise<void> => {
    if (!client || !selectedId || !transcript?.nextCursor || loadingEarlier || disconnected) return;
    const generation = previewGeneration.current;
    setLoadingEarlier(true);
    try {
      const result = await client.readConversation(selectedId, transcript.nextCursor, 20);
      if (!mounted.current || generation !== previewGeneration.current) return;
      if (result.ok) setTranscript((previous) => previous ? { ...result.transcript, turns: [...result.transcript.turns, ...previous.turns] } : result.transcript);
      else setPreviewError(result.reason);
    } catch { if (mounted.current && generation === previewGeneration.current) setPreviewError('unavailable'); }
    finally { if (mounted.current && generation === previewGeneration.current) setLoadingEarlier(false); }
  };
  const date = (value: number): string => Number.isFinite(value) ? new Intl.DateTimeFormat(ko ? 'ko-KR' : 'en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value) : '';
  const location = (item: ConversationEntry): string => [item.projectTitle, item.subprojectTitle, item.nodeTitle].filter(Boolean).join(' › ');
  const knownProjects = new Map([...discoveredProjects, ...projects].map((project) => [project.id, project.name]));
  if (currentProjectId && !knownProjects.has(currentProjectId)) knownProjects.set(currentProjectId, text('현재 프로젝트', 'Current project'));

  return <section className="conversation-history" data-picker-only={!!onOpenConversation || undefined} data-variant={variant} data-preview={showMobilePreview || undefined} data-testid="conversation-history-picker" aria-labelledby={headingId}>
    <h3 id={headingId} className="ez-ui-visually-hidden">{text('이전 대화 선택', 'Choose a previous conversation')}</h3>
    <div className="conversation-history__browser" hidden={showMobilePreview}>
      <div className="conversation-history__search">
        <Field label={text('대화 검색', 'Search conversations')} labelHidden><Input value={search} maxLength={500} placeholder={text('제목 · 최근 내용 검색', 'Search titles and recent text')} onChange={(event) => changeFilter(() => setSearch(event.target.value))} /></Field>
        <Button size="sm" variant="ghost" aria-label={text('대화 목록 새로고침', 'Refresh conversations')} disabled={!client || disconnected || listLoading} onClick={() => setListRevision((value) => value + 1)}><RefreshCw size={16} aria-hidden="true" /></Button>
      </div>
      <div className="conversation-history__filters">
        <Field label={text('프로젝트', 'Project')}><Select value={projectId} onChange={(event) => changeFilter(() => setProjectId(event.target.value))}><option value="">{text('모든 프로젝트', 'All projects')}</option>{[...knownProjects].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</Select></Field>
        <Field label={text('제공자', 'Provider')}><Select value={providerId} onChange={(event) => changeFilter(() => setProviderId(event.target.value))}><option value="">{text('모든 제공자', 'All providers')}</option><option value="codex">Codex</option><option value="claude">Claude</option></Select></Field>
        <Field label={text('출처', 'Source')}><Select value={source} onChange={(event) => changeFilter(() => setSource(event.target.value as typeof source))}><option value="">{text('모든 출처', 'All sources')}</option><option value="app">{text('Agent 대화', 'Agent conversations')}</option><option value="native">{text('CLI 기록', 'CLI history')}</option></Select></Field>
        <Field label={text('보관 상태', 'Archive state')}><Select value={archived} onChange={(event) => changeFilter(() => setArchived(event.target.value as typeof archived))}><option value="include">{text('보관 포함', 'Include archived')}</option><option value="exclude">{text('보관 제외', 'Exclude archived')}</option><option value="only">{text('보관된 대화', 'Archived only')}</option></Select></Field>
      </div>
      {unavailable && <div className="conversation-history__notice" role="status"><p>{failureText(unavailable, ko)}</p>{client && !disconnected && <Button size="sm" onClick={() => setListRevision((value) => value + 1)}>{text('다시 조회', 'Retry')}</Button>}</div>}
      <div className="conversation-history__list" aria-busy={listLoading}>
        {listLoading && !items.length && <p role="status" className="conversation-history__notice">{text('PC의 대화를 불러오는 중…', 'Loading conversations from the PC…')}</p>}
        {!listLoading && !items.length && !unavailable && <p className="conversation-history__notice">{query || providerId || source || archived === 'only' ? text('조건에 맞는 대화가 없습니다. 검색 조건을 바꿔보세요.', 'No conversations match these filters. Try another search.') : text('이 범위에 저장된 대화가 없습니다.', 'There are no saved conversations in this scope.')}</p>}
        <ol>{items.map((item) => <li key={item.conversationId}><button type="button" className="conversation-history__row" aria-current={item.conversationId === selectedId ? 'true' : undefined} onClick={() => { if (onOpenConversation) void Promise.resolve(onOpenConversation(item)).catch(() => setListError('unavailable')); else setSelectedId(item.conversationId); }}>
          <span className="conversation-history__row-heading">{item.source === 'native' ? <SquareTerminal size={16} aria-hidden="true" /> : <MessageSquare size={16} aria-hidden="true" />}<strong>{item.title}</strong>{item.archived && <Badge>{text('보관', 'Archived')}</Badge>}</span>
          {item.preview && <span className="conversation-history__snippet">{item.preview}</span>}
          <span className="conversation-history__metadata">{providerLabel(item.providerId)} · {item.source === 'native' ? text('CLI 기록', 'CLI history') : text('Agent 대화', 'Agent conversation')}{item.linkedSessionId && item.source === 'native' ? text(' · Agent 연결됨', ' · Linked to Agent') : ''}</span>
          <span className="conversation-history__metadata"><span>{location(item)}</span><time dateTime={new Date(item.updatedAt).toISOString()}>{date(item.updatedAt)}</time></span>
        </button></li>)}</ol>
        {cursor && <Button size="sm" variant="ghost" disabled={listLoading || disconnected} onClick={() => void loadList(cursor)}>{listLoading ? text('불러오는 중…', 'Loading…') : text('더 보기', 'Load more')}</Button>}
      </div>
    </div>
    <div className="conversation-history__preview" hidden={!!onOpenConversation || variant === 'mobile' && !showMobilePreview}>
      {variant === 'mobile' && selectedId && <Button size="sm" variant="ghost" leadingIcon={<ArrowLeft size={16} />} onClick={closePreview}>{text('대화 목록', 'Conversation list')}</Button>}
      {!selectedId ? <div className="conversation-history__empty"><History size={28} aria-hidden="true" /><p>{text('대화를 선택하면 이전 내용을 확인할 수 있습니다.', 'Select a conversation to preview its previous messages.')}</p><small>{text('기록을 열거나 미리 보는 동안 메시지는 전송되지 않습니다.', 'Opening or previewing history does not send a message.')}</small></div> : <>
        {entry && <header className="conversation-history__preview-heading"><h3>{entry.title}</h3><p>{providerLabel(entry.providerId)} · {location(entry)}</p>{entry.roots.map((root) => <small key={root}>{root}</small>)}</header>}
        <div className="conversation-history__transcript" aria-busy={previewLoading}>
          {previewLoading && <p role="status">{text('이전 메시지를 읽는 중…', 'Reading previous messages…')}</p>}
          {previewError && <div role="alert"><p>{failureText(previewError, ko)}</p><Button size="sm" disabled={disconnected} onClick={() => setPreviewRevision((value) => value + 1)}>{text('다시 읽기', 'Retry preview')}</Button></div>}
          {transcript?.nextCursor && <Button variant="ghost" size="sm" disabled={loadingEarlier || disconnected} onClick={() => void earlier()}>{loadingEarlier ? text('읽는 중…', 'Loading…') : text('이전 메시지 더 보기', 'Load earlier messages')}</Button>}
          {transcript && !transcript.turns.length && <p>{text('아직 메시지가 없는 대화입니다.', 'This conversation has no messages yet.')}</p>}
          {transcript?.turns.map((turn) => <section key={turn.id} className="conversation-history__turn">{turn.entries.map((message) => message.type === 'message'
            ? <article className="conversation-history__message" data-role={message.role} key={message.id}><strong>{message.role === 'user' ? text('나', 'You') : providerLabel(transcript.provider)}</strong><p>{message.markdown}</p></article>
            : <details className="conversation-history__activity" key={message.id}><summary>{message.kind}</summary><p>{message.summary}</p></details>)}</section>)}
        </div>
        {entry && <footer className="conversation-history__actions">
          {preparing && <p role="status">{text('이어갈 수 있는지 확인하는 중…', 'Checking whether this conversation can continue…')}</p>}
          {preparation && preparation.action === 'resume' && <p>{preparation.model ? `${preparation.model} · ` : ''}{preparation.permissionPreset === 'plan' ? 'Plan' : preparation.permissionPreset === 'full-access' ? 'Full access' : 'Standard'}{entry.source === 'app' && entry.archived ? text(' · 원래 기록을 보존하고 이어갑니다.', ' · The original record is preserved.') : ''}</p>}
          {preparation?.blockedReason && <p role="status">{failureText(preparation.blockedReason, ko)}</p>}
          {actionError && <p role="alert">{failureText(actionError, ko)}</p>}
          {uncertain && <p role="status">{text('이어가기 결과를 확인하지 못했습니다. 같은 요청의 결과를 확인하세요.', 'The continuation result is unconfirmed. Check the same request.')}</p>}
          {!preparing && action === 'unavailable' && !preparation?.blockedReason && !actionError && <p role="status">{text('현재 이 대화는 읽기만 가능합니다.', 'This conversation is currently read-only.')}</p>}
          <div className="conversation-history__action-buttons">
            <Button disabled={disconnected || actionBusy || preparing || (!uncertain && (action === 'open' ? !linkedSessionId : !preparation?.canResume))} onClick={() => void continueConversation()}>{actionBusy ? text('여는 중…', 'Opening…') : uncertain ? text('같은 요청 결과 확인', 'Check same request') : action === 'open' ? text('대화 열기', 'Open conversation') : text('Agent로 이어가기', 'Continue in Agent')}</Button>
            {entry.historyId && onOpenCliHistory && <Button variant="ghost" disabled={disconnected || actionBusy || uncertain} onClick={() => { void Promise.resolve(onOpenCliHistory(entry)).catch(() => setActionError('unavailable')); }}>{text('CLI에서 이어가기', 'Continue in CLI')}</Button>}
            {(actionError || preparation?.blockedReason) && !uncertain && <Button variant="ghost" size="sm" disabled={disconnected || actionBusy || preparing} onClick={() => setPreviewRevision((value) => value + 1)}>{text('상태 다시 확인', 'Check again')}</Button>}
          </div>
        </footer>}
      </>}
    </div>
  </section>;
}

export interface ConversationHistoryDialogProps extends ConversationHistoryPickerProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** Desktop modal shell; Android uses its native history-aware full-height sheet. */
export function ConversationHistoryDialog({ open, onOpenChange, ...props }: ConversationHistoryDialogProps): JSX.Element {
  const { i18n } = useAppTranslation();
  const ko = (i18n.resolvedLanguage ?? i18n.language).startsWith('ko');
  return <Dialog open={open} onOpenChange={onOpenChange} title={ko ? '이전 대화' : 'Previous conversations'} closeLabel={ko ? '이전 대화 닫기' : 'Close previous conversations'} size="lg" className="conversation-history-dialog" testId="conversation-history-dialog">
    {open && <ConversationHistoryPicker {...props} />}
  </Dialog>;
}
