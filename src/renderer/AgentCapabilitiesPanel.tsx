import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import type { AgentCapabilitiesClient, AgentCapabilityCatalog, AgentCapabilityItem, AgentExtensionAction, AgentExtensionCommand, AgentExtensionReceipt } from '../shared/agent-capabilities';
import { useAppTranslation } from './i18n';
import { Button, Field, Select, Input as TextInput } from './ui';
import './agent-capabilities.css';
import type { CapabilityDiscoveryState } from './use-agent-completion';

export interface AgentCapabilitiesPanelProps {
  readonly client: AgentCapabilitiesClient;
  readonly providerId: 'codex' | 'claude';
  readonly workspaceId: string;
  readonly sessionId?: string;
  readonly onCatalog?: (catalog: AgentCapabilityCatalog) => void;
  readonly onDiscoveryState?: (state: CapabilityDiscoveryState) => void;
  readonly onInsert?: (item: AgentCapabilityItem) => void;
  readonly disabled?: boolean;
  readonly remote?: boolean;
}
const LABELS: Readonly<Record<AgentExtensionAction, readonly [string, string]>> = {
  'plugin-install': ['플러그인 설치', 'Install plugin'], 'plugin-remove': ['플러그인 제거', 'Remove plugin'],
  'plugin-enable': ['플러그인 활성화', 'Enable plugin'], 'plugin-disable': ['플러그인 비활성화', 'Disable plugin'],
  'plugin-update': ['플러그인 업데이트', 'Update plugin'], 'marketplace-add': ['마켓 추가', 'Add marketplace'],
  'marketplace-remove': ['마켓 제거', 'Remove marketplace'], 'marketplace-update': ['마켓 갱신', 'Refresh marketplace'],
  'skill-enable': ['스킬 활성화', 'Enable skill'], 'skill-disable': ['스킬 비활성화', 'Disable skill'],
  'mcp-add': ['MCP 추가', 'Add MCP server'], 'mcp-remove': ['MCP 제거', 'Remove MCP server'],
};
// Keep exact requests across panel close/reopen and scope changes. Credential-like
// MCP arguments never enter localStorage; the host owns durable command receipts.
const pendingByClient = new WeakMap<AgentCapabilitiesClient, Map<string, AgentExtensionCommand>>();
const commandId = (): string => `extension-${Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, '0')).join('')}`;
const KIND_LABELS = { skill: '스킬', plugin: '플러그인', mcp: 'MCP', 'app-skill': '앱 스킬', models: '모델', skills: '스킬', plugins: '플러그인' };
const STATUS_LABELS: Record<string, string> = { connected: '연결됨', ready: '준비됨', failed: '연결 실패', 'needs-auth': 'PC 인증 필요', notLoggedIn: 'PC 인증 필요', unsupported: '상태 조회 미지원', pending: '연결 대기', disabled: '비활성', configured: '설정됨', oAuth: 'OAuth 설정', bearerToken: '토큰 설정' };

export function AgentCapabilitiesPanel({ client, providerId, workspaceId, sessionId, onCatalog, onDiscoveryState, onInsert, disabled, remote }: AgentCapabilitiesPanelProps): JSX.Element {
  const { i18n } = useAppTranslation();
  const ko = i18n.language.startsWith('ko');
  const [catalog, setCatalog] = useState<AgentCapabilityCatalog>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [search, setSearch] = useState('');
  const [action, setAction] = useState<AgentExtensionAction>('plugin-install');
  const [target, setTarget] = useState('');
  const [scope, setScope] = useState<'user' | 'project' | 'local'>('user');
  const [mcpUrl, setMcpUrl] = useState('');
  const [mcpTransport, setMcpTransport] = useState<'http' | 'stdio'>('http');
  const [mcpArgs, setMcpArgs] = useState('[]');
  const [managing, setManaging] = useState(false);
  const managementDetails = useRef<HTMLDetailsElement>(null);
  const scopeKey = `${providerId}:${workspaceId}:${sessionId ?? ''}`;
  const activeScope = useRef({ client, scopeKey });
  activeScope.current = { client, scopeKey };
  const [pending, setPending] = useState<AgentExtensionCommand>();
  const remember = (command: AgentExtensionCommand | undefined): void => {
    let entries = pendingByClient.get(client);
    if (!entries) { entries = new Map(); pendingByClient.set(client, entries); }
    if (command) entries.set(scopeKey, command); else entries.delete(scopeKey);
    if (activeScope.current.client === client && activeScope.current.scopeKey === scopeKey) setPending(command);
  };
  const generation = useRef(0);
  const catalogCallback = useRef(onCatalog);
  catalogCallback.current = onCatalog;
  const discoveryCallback = useRef(onDiscoveryState);
  discoveryCallback.current = onDiscoveryState;
  useEffect(() => discoveryCallback.current?.({ loading, error }), [loading, error]);
  const refresh = useCallback(async () => {
    if (activeScope.current.client !== client || activeScope.current.scopeKey !== scopeKey) return;
    const current = ++generation.current;
    setLoading(true); setError(undefined);
    try {
      const result = await client.list({ providerId, workspaceId, ...(sessionId ? { sessionId } : {}) });
      if (current !== generation.current || activeScope.current.client !== client || activeScope.current.scopeKey !== scopeKey) return;
      if (result.ok) { setCatalog(result.value); catalogCallback.current?.(result.value); }
      else setError(result.message);
    } catch { if (current === generation.current) setError(ko ? '연결된 PC에서 목록을 읽을 수 없습니다. 다시 조회해 주세요.' : 'Could not read extensions from the connected PC. Retry discovery.'); }
    finally { if (current === generation.current) setLoading(false); }
  }, [client, providerId, workspaceId, sessionId, scopeKey, ko]);
  useEffect(() => {
    setCatalog(undefined); setMessage(undefined); setTarget('');
    setPending(pendingByClient.get(client)?.get(scopeKey)); setManaging(false);
    void refresh();
    return () => { generation.current += 1; };
  }, [refresh, client, scopeKey]);
  const items = catalog?.items.filter((item) => `${item.name} ${item.description ?? ''} ${item.source ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ?? [];
  const recoveredPending = catalog?.extensionReceipts?.find((receipt) => receipt.state === 'uncertain' && receipt.commandId !== pending?.commandId);
  const recoverReceipt = async (receipt: Pick<AgentExtensionReceipt, 'commandId' | 'action'>, recovery: 'inspect' | 'acknowledge'): Promise<void> => {
    if (!catalog || managing) return;
    setManaging(true); setError(undefined);
    try {
      const result = await client.manage({ providerId, workspaceId, ...(sessionId ? { sessionId } : {}), commandId: receipt.commandId, action: receipt.action, target: 'receipt', scope: 'user', expectedRevision: catalog.revision, recovery });
      if (activeScope.current.client !== client || activeScope.current.scopeKey !== scopeKey) return;
      if (!result.ok) setError(result.message);
      else {
        if (recovery === 'acknowledge' && pending?.commandId === receipt.commandId) remember(undefined);
        setMessage(result.value.state === 'applied' ? (ko ? '저장된 결과: PC 설정에 적용됐습니다.' : 'Saved result: applied to PC settings.') : (ko ? '저장된 결과가 불명확합니다. PC 설정을 확인한 후 확인 완료를 선택하세요.' : 'The saved outcome is uncertain. Inspect PC settings, then acknowledge the receipt.'));
      }
      await refresh();
    } catch { if (activeScope.current.client === client && activeScope.current.scopeKey === scopeKey) setError(ko ? '저장된 결과를 조회할 수 없습니다. 다시 연결해 주세요.' : 'Could not read the saved result. Reconnect and check again.'); }
    finally { if (activeScope.current.client === client && activeScope.current.scopeKey === scopeKey) setManaging(false); }
  };
  const apply = async (reconcile = false): Promise<void> => {
    if (!catalog || disabled || managing || (!reconcile && (!target.trim() || pending || recoveredPending))) return;
    let mcp: { type: 'http'; url: string } | { type: 'stdio'; command: string; args: string[] } | undefined;
    if (!reconcile && action === 'mcp-add') {
      try {
        if (mcpTransport === 'http') mcp = { type: 'http', url: new URL(mcpUrl).href };
        else { const args: unknown = JSON.parse(mcpArgs); if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new Error(); mcp = { type: 'stdio', command: mcpUrl, args }; }
      } catch { setError(ko ? 'MCP URL 또는 명령 인수를 확인해 주세요.' : 'Check the MCP URL or command arguments.'); return; }
    }
    setManaging(true); setError(undefined); setMessage(undefined);
    const command = reconcile ? pending : { providerId, workspaceId, ...(sessionId ? { sessionId } : {}), commandId: commandId(), expectedRevision: catalog.revision, action, target: target.trim(), scope: providerId === 'codex' ? 'user' as const : scope, ...(mcp ? { mcp } : {}) };
    if (!command) { setManaging(false); return; }
    remember(command);
    try {
      const result = await client.manage(command);
      if ((result.ok && result.value.state === 'applied') || (!result.ok && result.code !== 'uncertain')) remember(undefined);
      if (activeScope.current.client !== client || activeScope.current.scopeKey !== scopeKey) return;
      if (!result.ok) setError(result.message);
      else setMessage(result.value.state === 'applied'
        ? (ko ? 'PC의 기본 설정에 적용했습니다. 새 대화부터 사용하며 현재 대화는 유지됩니다.' : 'Applied to the PC’s native settings. New conversations use the change; this conversation is preserved.')
        : (ko ? '적용 결과를 확인하지 못했습니다. 자동 재시도하지 않습니다. 목록과 PC 설정을 확인해 주세요.' : 'The outcome is unconfirmed. It will not retry automatically. Check the list and PC settings.'));
      await refresh();
    } catch { if (activeScope.current.client === client && activeScope.current.scopeKey === scopeKey) setError(ko ? '연결이 끊어져 결과를 확인할 수 없습니다. 같은 요청 결과를 확인해 주세요.' : 'The connection was lost. Check the result of this same request.'); }
    finally { if (activeScope.current.client === client && activeScope.current.scopeKey === scopeKey) setManaging(false); }
  };
  return <details className="agent-capabilities" data-testid="agent-capabilities">
    <summary><Sparkles size={14} aria-hidden="true" />{ko ? '스킬 · 플러그인 · MCP' : 'Skills · plugins · MCP'} <span>{loading ? (ko ? '조회 중' : 'Loading') : catalog ? `${catalog.items.length}` : (ko ? '조회 필요' : 'Unavailable')}</span></summary>
    <div className="agent-capabilities__body">
      <div className="agent-capabilities__heading"><p>{ko ? '첫 메시지 없이 조회합니다.' : 'Discovery does not send a message.'} {catalog && <>{remote ? (ko ? '연결된 PC' : 'Connected PC') : 'PC'}: {catalog.hostId} · {catalog.workspaceRoot}</>}</p><Button size="sm" onClick={() => void refresh()} disabled={loading || managing}><RefreshCw size={14} aria-hidden="true" />{ko ? '새로고침' : 'Refresh'}</Button></div>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {pending && <div role="status"><p>{ko ? '확인 중인 변경' : 'Pending change'}: {LABELS[pending.action][ko ? 0 : 1]} · {pending.target}</p><Button size="sm" disabled={managing || loading} onClick={() => void apply(true)}>{ko ? '같은 요청 결과 확인' : 'Check same request'}</Button><Button size="sm" disabled={managing || loading} onClick={() => void recoverReceipt(pending, 'acknowledge')}>{ko ? 'PC 설정 확인 완료' : 'I checked the PC settings'}</Button></div>}
      {recoveredPending && <div role="status"><p>{ko ? 'PC에 저장된 미확인 변경' : 'Unconfirmed change saved on PC'}: {LABELS[recoveredPending.action][ko ? 0 : 1]} · {recoveredPending.observedAt}</p><Button size="sm" disabled={managing || loading} onClick={() => void recoverReceipt(recoveredPending, 'inspect')}>{ko ? '저장된 결과 확인' : 'Check saved result'}</Button><Button size="sm" disabled={managing || loading} onClick={() => void recoverReceipt(recoveredPending, 'acknowledge')}>{ko ? 'PC 설정 확인 완료' : 'I checked the PC settings'}</Button></div>}
      {catalog?.extensionReceipts?.some((receipt) => receipt.state === 'applied') && <details><summary>{ko ? 'PC에 저장된 최근 변경 결과' : 'Recent changes saved on PC'}</summary>{catalog.extensionReceipts.filter((receipt) => receipt.state === 'applied').slice(0, 3).map((receipt) => <p key={receipt.commandId}>{LABELS[receipt.action][ko ? 0 : 1]} · {ko ? '적용 완료' : 'Applied'} · {receipt.observedAt}</p>)}</details>}
      {catalog && <>
        <p className="agent-capabilities__note">{ko ? '설치 목록과 현재 대화의 적용 상태는 다를 수 있습니다. 변경 사항은 새 대화에 적용됩니다.' : 'Installed extensions may differ from the active conversation. Changes apply to new conversations.'}</p>
        {catalog.issues.map((issue) => <p role="status" key={`${issue.section}:${issue.message}`}>{ko ? `${KIND_LABELS[issue.section]} 목록 일부를 확인할 수 없습니다. 새로고침하거나 PC의 제공자 설정을 확인해 주세요.` : `${issue.section}: ${issue.message}`}</p>)}
        <Field label={ko ? '확장 검색' : 'Search extensions'}><TextInput value={search} onChange={(event) => setSearch(event.target.value)} /></Field>
        <ul className="agent-capabilities__items">{items.map((item) => <li key={`${item.kind}:${item.id}:${item.scope}`}>
          <div><strong>{item.name}</strong><span>{ko ? KIND_LABELS[item.kind] : item.kind} · {item.enabled ? (ko ? '활성' : 'Enabled') : (ko ? '비활성' : 'Disabled')} {item.status ? `· ${ko ? STATUS_LABELS[item.status] ?? '설정 확인 필요' : item.status}` : ''}</span><p>{item.description}</p><small>{item.scope} {item.version} {item.source}</small></div>
          {item.invocation && <Button size="sm" disabled={disabled || !item.enabled || !onInsert} onClick={() => onInsert?.(item)}>{ko ? '입력에 추가' : 'Insert'}</Button>}
          {catalog.canManage && item.actions.length > 0 && <Button size="sm" disabled={disabled || managing} onClick={() => { setTarget(item.id); setScope(['user', 'project', 'local'].includes(item.scope ?? '') ? item.scope as 'user' | 'project' | 'local' : 'user'); setAction(item.actions.find((candidate) => item.enabled ? candidate.endsWith('disable') : candidate.endsWith('enable')) ?? item.actions[0]); if (managementDetails.current) { managementDetails.current.open = true; managementDetails.current.querySelector('input')?.focus(); } }}>{ko ? '관리 선택' : 'Manage'}</Button>}
        </li>)}</ul>
        {!items.length && !loading && <p>{ko ? '조회된 확장이 없습니다.' : 'No extensions found.'}</p>}
        {catalog.canManage ? <details ref={managementDetails} className="agent-capabilities__manage"><summary>{ko ? 'PC 확장 관리' : 'Manage PC extensions'}</summary>
          <form onSubmit={(event) => { event.preventDefault(); void apply(); }}>
            <Field label={ko ? '동작' : 'Action'}><Select value={action} onChange={(event) => setAction(event.target.value as AgentExtensionAction)}>{catalog.actions.map((value) => <option key={value} value={value}>{LABELS[value][ko ? 0 : 1]}</option>)}</Select></Field>
            <Field label={ko ? '대상 / 마켓 주소·PC 경로' : 'Target / marketplace URL or PC path'}><TextInput value={target} onChange={(event) => setTarget(event.target.value)} placeholder="plugin@marketplace" required /></Field>
            {providerId === 'claude' && <Field label={ko ? '설정 범위' : 'Settings scope'}><Select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="user">{ko ? 'PC 사용자' : 'PC user'}</option><option value="project">{ko ? '프로젝트' : 'Project'}</option><option value="local">{ko ? '프로젝트 로컬' : 'Project local'}</option></Select></Field>}
            {action === 'mcp-add' && <><Field label="MCP transport"><Select value={mcpTransport} onChange={(event) => setMcpTransport(event.target.value as 'http' | 'stdio')}><option value="http">HTTP</option><option value="stdio">stdio</option></Select></Field><Field label={mcpTransport === 'http' ? 'URL' : (ko ? 'PC에서 실행할 명령' : 'Command on PC')}><TextInput value={mcpUrl} onChange={(event) => setMcpUrl(event.target.value)} required /></Field>{mcpTransport === 'stdio' && <Field label={ko ? '인수 (JSON 배열)' : 'Arguments (JSON array)'}><TextInput value={mcpArgs} onChange={(event) => setMcpArgs(event.target.value)} /></Field>}</>}
            <p>{ko ? '연결된 PC의 기본 Codex/Claude 설정을 변경합니다. 인증이 필요한 MCP는 PC에서 인증한 후 다시 조회하세요.' : 'Changes the connected PC’s native Codex/Claude settings. Authenticate MCP servers on that PC, then refresh.'}</p>
            <Button type="submit" disabled={disabled || managing || loading || Boolean(pending || recoveredPending) || !target.trim()}>{managing ? (ko ? '적용 중' : 'Applying') : (ko ? 'PC 설정에 적용' : 'Apply to PC settings')}</Button>
          </form>
        </details> : <p>{ko ? '이 연결에서는 확장 조회만 가능합니다.' : 'This connection can only read extensions.'}</p>}
      </>}
    </div>
  </details>;
}
