import {
  AlertTriangle,
  Bot,
  Check,
  ChevronRight,
  Circle,
  Clock3,
  Code2,
  FileCheck2,
  LoaderCircle,
  Send,
  ShieldAlert,
  Square,
  Wrench,
} from 'lucide-react';
import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import type {
  DaemonApproval,
  DaemonTranscriptItem,
  ManagedAgentState,
  PermissionPreset,
  WorkspaceKind,
} from '../shared/daemon-protocol';
import { ProgressiveSafeMarkdown } from './ProgressiveSafeMarkdown';
import { useAppTranslation } from './i18n';
import { Button, Field, Select } from './ui';

export type StructuredAgentUiResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export interface StructuredAgentModelOption {
  readonly id: string;
  readonly label: string;
}

export interface StructuredAgentProviderOption {
  readonly id: string;
  readonly label: string;
  readonly models: readonly StructuredAgentModelOption[];
  readonly disabled?: boolean;
  readonly description?: string;
}

export interface StructuredAgentWorkspaceOption {
  readonly id: string;
  readonly label: string;
  readonly kind: WorkspaceKind;
  readonly path?: string;
}

export interface StructuredAgentDraftInput {
  readonly providerId: string;
  readonly model?: string;
  readonly workspaceId: string;
  readonly permissionPreset: PermissionPreset;
  readonly initialPrompt: string;
}

interface StructuredAgentCopy {
  readonly newSession: string;
  readonly draftEyebrow: string;
  readonly draftDescription: string;
  readonly provider: string;
  readonly model: string;
  readonly providerDefault: string;
  readonly workspace: string;
  readonly workspaceHint: string;
  readonly noProviders: string;
  readonly noWorkspaces: string;
  readonly required: string;
  readonly permission: string;
  readonly permissionPlan: string;
  readonly permissionPlanHint: string;
  readonly permissionStandard: string;
  readonly permissionStandardHint: string;
  readonly permissionFull: string;
  readonly permissionFullHint: string;
  readonly firstPrompt: string;
  readonly firstPromptPlaceholder: string;
  readonly send: string;
  readonly creating: string;
  readonly retry: string;
  readonly transcript: string;
  readonly transcriptLoading: string;
  readonly transcriptEmpty: string;
  readonly sensitive: string;
  readonly you: string;
  readonly assistant: string;
  readonly reasoning: string;
  readonly toolCall: string;
  readonly toolResult: string;
  readonly approval: string;
  readonly childSummary: string;
  readonly notice: string;
  readonly error: string;
  readonly streaming: string;
  readonly openChild: string;
  readonly allow: string;
  readonly deny: string;
  readonly pending: string;
  readonly allowed: string;
  readonly denied: string;
  readonly expired: string;
  readonly message: string;
  readonly messagePlaceholder: string;
  readonly queue: string;
  readonly interruptSend: string;
  readonly sending: string;
  readonly queued: string;
  readonly busyHint: string;
  readonly settings: string;
  readonly status: string;
  readonly childTrack: string;
}

const COPY: Readonly<Record<'en' | 'ko', StructuredAgentCopy>> = {
  en: {
    newSession: 'New Agent session',
    draftEyebrow: 'SESSION DRAFT',
    draftDescription: 'Choose the workspace and safety boundary, then send the first prompt. Nothing is created before Send.',
    provider: 'Provider',
    model: 'Model',
    providerDefault: 'Provider default',
    workspace: 'Workspace',
    workspaceHint: 'The Agent reads and changes files only in this workspace.',
    noProviders: 'No ready Agent provider is available.',
    noWorkspaces: 'No active workspace is available for this project.',
    required: 'Choose an option to continue.',
    permission: 'Permission preset',
    permissionPlan: 'Plan',
    permissionPlanHint: 'Inspect and propose a plan without changing files.',
    permissionStandard: 'Standard',
    permissionStandardHint: 'Work in the selected workspace and ask before sensitive actions.',
    permissionFull: 'Full access',
    permissionFullHint: 'Allow broad workspace actions without routine confirmation.',
    firstPrompt: 'First prompt',
    firstPromptPlaceholder: 'Describe the outcome you want from this Agent…',
    send: 'Send',
    creating: 'Creating session',
    retry: 'Retry',
    transcript: 'Agent transcript',
    transcriptLoading: 'Loading transcript…',
    transcriptEmpty: 'No messages yet. Send a prompt to begin.',
    sensitive: 'Sensitive output hidden',
    you: 'You',
    assistant: 'Agent',
    reasoning: 'Reasoning',
    toolCall: 'Tool call',
    toolResult: 'Tool result',
    approval: 'Approval required',
    childSummary: 'Child Agent update',
    notice: 'Notice',
    error: 'Error',
    streaming: 'Streaming',
    openChild: 'Open child session',
    allow: 'Allow',
    deny: 'Deny',
    pending: 'Pending',
    allowed: 'Allowed',
    denied: 'Denied',
    expired: 'Expired',
    message: 'Message Agent',
    messagePlaceholder: 'Send a follow-up…',
    queue: 'Queue message',
    interruptSend: 'Interrupt & Send',
    sending: 'Sending',
    queued: '{{count}} queued',
    busyHint: 'Send adds this message to the FIFO queue. Interrupt & Send stops the current turn first.',
    settings: 'Session settings',
    status: 'Status',
    childTrack: 'Child Agents',
  },
  ko: {
    newSession: '새 Agent 세션',
    draftEyebrow: '세션 초안',
    draftDescription: 'Workspace와 권한 범위를 정한 뒤 첫 프롬프트를 보내세요. Send 전에는 세션이 생성되지 않습니다.',
    provider: 'Provider',
    model: 'Model',
    providerDefault: 'Provider 기본값',
    workspace: 'Workspace',
    workspaceHint: 'Agent는 선택한 Workspace 안에서만 파일을 읽고 변경합니다.',
    noProviders: '사용 가능한 Agent provider가 없습니다.',
    noWorkspaces: '이 프로젝트에 활성 Workspace가 없습니다.',
    required: '계속하려면 항목을 선택하세요.',
    permission: '권한 프리셋',
    permissionPlan: 'Plan',
    permissionPlanHint: '파일을 바꾸지 않고 조사한 뒤 계획을 제안합니다.',
    permissionStandard: 'Standard',
    permissionStandardHint: '선택한 Workspace에서 작업하며 민감한 동작은 승인받습니다.',
    permissionFull: 'Full access',
    permissionFullHint: '일상적인 확인 없이 Workspace의 폭넓은 동작을 허용합니다.',
    firstPrompt: '첫 프롬프트',
    firstPromptPlaceholder: 'Agent에게 원하는 결과를 설명하세요…',
    send: 'Send',
    creating: '세션 생성 중',
    retry: '다시 시도',
    transcript: 'Agent 대화',
    transcriptLoading: '대화를 불러오는 중…',
    transcriptEmpty: '아직 메시지가 없습니다. 프롬프트를 보내 시작하세요.',
    sensitive: '민감한 출력이 숨겨졌습니다',
    you: '나',
    assistant: 'Agent',
    reasoning: '추론',
    toolCall: '도구 호출',
    toolResult: '도구 결과',
    approval: '승인 필요',
    childSummary: '하위 Agent 업데이트',
    notice: '알림',
    error: '오류',
    streaming: '응답 중',
    openChild: '하위 세션 열기',
    allow: '허용',
    deny: '거부',
    pending: '대기 중',
    allowed: '허용됨',
    denied: '거부됨',
    expired: '만료됨',
    message: 'Agent에게 메시지',
    messagePlaceholder: '후속 메시지를 보내세요…',
    queue: '메시지 대기열 추가',
    interruptSend: '중단 후 보내기',
    sending: '보내는 중',
    queued: '{{count}}개 대기 중',
    busyHint: 'Send는 FIFO 대기열에 추가합니다. 중단 후 보내기는 현재 턴을 먼저 멈춥니다.',
    settings: '세션 설정',
    status: '상태',
    childTrack: '하위 Agent',
  },
};

function useStructuredAgentCopy(): StructuredAgentCopy {
  const { i18n } = useAppTranslation();
  return COPY[(i18n.resolvedLanguage ?? i18n.language).startsWith('ko') ? 'ko' : 'en'];
}

function formatTemplate(template: string, values: Readonly<Record<string, string | number>>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replace(`{{${key}}}`, String(value)),
    template,
  );
}

const PERMISSION_ORDER: readonly PermissionPreset[] = ['plan', 'standard', 'full-access'];

function permissionCopy(copy: StructuredAgentCopy, preset: PermissionPreset): {
  readonly label: string;
  readonly hint: string;
} {
  if (preset === 'plan') return { label: copy.permissionPlan, hint: copy.permissionPlanHint };
  if (preset === 'full-access') return { label: copy.permissionFull, hint: copy.permissionFullHint };
  return { label: copy.permissionStandard, hint: copy.permissionStandardHint };
}

export interface StructuredAgentDraftPanelProps {
  readonly providers: readonly StructuredAgentProviderOption[];
  readonly workspaces: readonly StructuredAgentWorkspaceOption[];
  readonly initialProviderId?: string;
  readonly initialModel?: string;
  readonly initialWorkspaceId?: string;
  readonly initialPermissionPreset?: PermissionPreset;
  readonly initialPrompt?: string;
  readonly loading?: boolean;
  readonly loadError?: string | null;
  readonly onRetry?: () => void;
  readonly onCreate: (input: StructuredAgentDraftInput) => Promise<StructuredAgentUiResult>;
  readonly variant?: 'desktop' | 'mobile';
}

export function StructuredAgentDraftPanel({
  providers,
  workspaces,
  initialProviderId,
  initialModel = '',
  initialWorkspaceId,
  initialPermissionPreset = 'standard',
  initialPrompt = '',
  loading = false,
  loadError = null,
  onRetry,
  onCreate,
  variant = 'desktop',
}: StructuredAgentDraftPanelProps): JSX.Element {
  const copy = useStructuredAgentCopy();
  const promptId = useId();
  const draftTitleId = useId();
  const permissionName = useId();
  const firstProvider = providers.find((provider) => !provider.disabled)?.id ?? '';
  const [providerId, setProviderId] = useState(initialProviderId ?? firstProvider);
  const [model, setModel] = useState(initialModel);
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId ?? workspaces[0]?.id ?? '');
  const [permissionPreset, setPermissionPreset] = useState<PermissionPreset>(initialPermissionPreset);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const selectedProvider = providers.find((provider) => provider.id === providerId);
  const models = selectedProvider?.models ?? [];

  useEffect(() => {
    if (firstProvider && !providers.some((provider) => provider.id === providerId && !provider.disabled)) {
      setProviderId(firstProvider);
      setModel('');
    }
  }, [firstProvider, providerId, providers]);

  useEffect(() => {
    const preferred = initialWorkspaceId
      ? workspaces.find((workspace) => workspace.id === initialWorkspaceId)
      : undefined;
    if (!workspaceId && preferred) {
      setWorkspaceId(preferred.id);
      return;
    }
    if (workspaces[0] && !workspaces.some((workspace) => workspace.id === workspaceId)) {
      setWorkspaceId(preferred?.id ?? workspaces[0].id);
    }
  }, [initialWorkspaceId, workspaceId, workspaces]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setAttempted(true);
    setSubmitError(null);
    const firstPrompt = prompt.trim();
    if (!providerId || !workspaceId || !firstPrompt || submitting || loading) return;
    setSubmitting(true);
    const result = await onCreate({
      providerId,
      ...(model ? { model } : {}),
      workspaceId,
      permissionPreset,
      initialPrompt: firstPrompt,
    }).catch((): StructuredAgentUiResult => ({
      ok: false,
      message: 'The Agent session could not be created.',
    }));
    setSubmitting(false);
    if (!result.ok) setSubmitError(result.message);
  };

  return (
    <section
      className="structured-agent structured-agent--draft"
      data-variant={variant}
      data-testid="structured-agent-draft"
      aria-labelledby={draftTitleId}
    >
      <header className="structured-agent__draft-header">
        <span className="structured-agent__eyebrow">{copy.draftEyebrow}</span>
        <h1 id={draftTitleId}>{copy.newSession}</h1>
        <p>{copy.draftDescription}</p>
      </header>

      {loadError && (
        <div className="structured-agent__banner structured-agent__banner--error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <span>{loadError}</span>
          {onRetry && <Button variant="ghost" size="sm" onClick={onRetry}>{copy.retry}</Button>}
        </div>
      )}

      <form className="structured-agent-draft-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="structured-agent-draft-form__grid">
          <Field
            label={copy.provider}
            required
            error={attempted && !providerId ? copy.required : undefined}
          >
            <Select
              value={providerId}
              disabled={loading || submitting || providers.length === 0}
              onChange={(event) => {
                setProviderId(event.currentTarget.value);
                setModel('');
                setSubmitError(null);
              }}
              data-testid="structured-agent-provider"
            >
              <option value="">{providers.length === 0 ? copy.noProviders : copy.provider}</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id} disabled={provider.disabled}>
                  {provider.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={copy.model}>
            <Select
              value={model}
              disabled={loading || submitting || !providerId}
              onChange={(event) => {
                setModel(event.currentTarget.value);
                setSubmitError(null);
              }}
              data-testid="structured-agent-model"
            >
              <option value="">{copy.providerDefault}</option>
              {models.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </Select>
          </Field>

          <Field
            className="structured-agent-draft-form__workspace"
            label={copy.workspace}
            description={copy.workspaceHint}
            required
            error={attempted && !workspaceId ? copy.required : undefined}
          >
            <Select
              value={workspaceId}
              disabled={loading || submitting || workspaces.length === 0}
              onChange={(event) => {
                setWorkspaceId(event.currentTarget.value);
                setSubmitError(null);
              }}
              data-testid="structured-agent-workspace"
            >
              <option value="">{workspaces.length === 0 ? copy.noWorkspaces : copy.workspace}</option>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.label} · {workspace.kind === 'worktree' ? 'Worktree' : 'Local'}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <fieldset className="structured-agent-permissions" disabled={loading || submitting}>
          <legend>{copy.permission}</legend>
          <div className="structured-agent-permissions__grid">
            {PERMISSION_ORDER.map((preset) => {
              const option = permissionCopy(copy, preset);
              return (
                <label
                  key={preset}
                  className="structured-agent-permission"
                  data-preset={preset}
                  data-selected={permissionPreset === preset || undefined}
                >
                  <input
                    type="radio"
                    name={permissionName}
                    value={preset}
                    checked={permissionPreset === preset}
                    onChange={() => {
                      setPermissionPreset(preset);
                      setSubmitError(null);
                    }}
                  />
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.hint}</small>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <Field
          id={promptId}
          label={copy.firstPrompt}
          required
          error={attempted && !prompt.trim() ? copy.required : undefined}
        >
          <textarea
            id={promptId}
            className="structured-agent-textarea structured-agent-textarea--draft"
            rows={6}
            maxLength={65_536}
            value={prompt}
            placeholder={copy.firstPromptPlaceholder}
            disabled={loading || submitting}
            onChange={(event) => {
              setPrompt(event.currentTarget.value);
              setSubmitError(null);
            }}
            data-testid="structured-agent-first-prompt"
          />
        </Field>

        {submitError && <p className="structured-agent__form-error" role="alert">{submitError}</p>}
        <div className="structured-agent-draft-form__actions">
          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={submitting}
            loadingLabel={copy.creating}
            disabled={loading || providers.length === 0 || workspaces.length === 0}
            leadingIcon={<Send />}
            data-testid="structured-agent-create"
          >
            {copy.send}
          </Button>
        </div>
      </form>
    </section>
  );
}

interface DisplayTranscriptItem extends DaemonTranscriptItem {
  readonly sourceIds: readonly string[];
}

/** Coalesces adjacent streaming chunks without changing authoritative ordering. */
export function coalesceStructuredAgentTranscript(
  items: readonly DaemonTranscriptItem[],
): readonly DisplayTranscriptItem[] {
  const ordered = items.slice().sort((left, right) => left.sequence - right.sequence);
  const result: DisplayTranscriptItem[] = [];
  for (const item of ordered) {
    const previous = result.at(-1);
    const sameLogicalItem = previous && previous.id === item.id;
    const adjacentDelta = previous
      && item.isDelta
      && previous.isDelta
      && previous.kind === item.kind
      && previous.turnId === item.turnId
      && previous.sessionId === item.sessionId;
    if (sameLogicalItem) {
      if (item.isDelta) {
        result[result.length - 1] = {
          ...item,
          text: `${previous.text}${item.text}`,
          sourceIds: [...previous.sourceIds, item.id],
        };
      } else {
        result[result.length - 1] = { ...item, sourceIds: previous.sourceIds };
      }
    } else if (adjacentDelta) {
      result[result.length - 1] = {
        ...previous,
        sequence: item.sequence,
        text: `${previous.text}${item.text}`,
        sourceIds: [...previous.sourceIds, item.id],
      };
    } else {
      result.push({ ...item, sourceIds: [item.id] });
    }
  }
  return result;
}

const APPROVAL_STATE_ICON = {
  pending: Clock3,
  allowed: Check,
  denied: Square,
  expired: Circle,
} as const;

export interface StructuredAgentTranscriptProps {
  readonly items: readonly DaemonTranscriptItem[];
  readonly approvals?: readonly DaemonApproval[];
  readonly providerLabel: string;
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly onRetry?: () => void;
  readonly onResolveApproval?: (
    approvalId: string,
    decision: 'allow' | 'deny',
  ) => Promise<StructuredAgentUiResult>;
  readonly onOpenRelatedSession?: (sessionId: string) => void;
}

export const StructuredAgentTranscript = memo(function StructuredAgentTranscript({
  items,
  approvals = [],
  providerLabel,
  loading = false,
  error = null,
  onRetry,
  onResolveApproval,
  onOpenRelatedSession,
}: StructuredAgentTranscriptProps): JSX.Element {
  const copy = useStructuredAgentCopy();
  const viewportRef = useRef<HTMLDivElement>(null);
  const followTailRef = useRef(true);
  const displayItems = useMemo(() => {
    const representedApprovals = new Set(
      items.filter((item) => item.kind === 'approval').map((item) => item.id),
    );
    const lastSequence = items.reduce((maximum, item) => Math.max(maximum, item.sequence), 0);
    const synthesized = approvals
      .filter((approval) => !representedApprovals.has(approval.id))
      .map((approval, index): DaemonTranscriptItem => ({
        id: approval.id,
        sessionId: approval.sessionId,
        ...(approval.turnId ? { turnId: approval.turnId } : {}),
        sequence: lastSequence + index + 1,
        kind: 'approval',
        text: approval.title,
        isDelta: false,
        isSensitive: false,
        createdAt: approval.createdAt,
      }));
    return coalesceStructuredAgentTranscript([...items, ...synthesized]);
  }, [approvals, items]);
  const approvalById = useMemo(
    () => new Map(approvals.map((approval) => [approval.id, approval])),
    [approvals],
  );
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && followTailRef.current) viewport.scrollTop = viewport.scrollHeight;
  }, [displayItems]);

  const resolveApproval = async (approvalId: string, decision: 'allow' | 'deny'): Promise<void> => {
    if (!onResolveApproval || resolvingId) return;
    setResolvingId(approvalId);
    setApprovalError(null);
    const result = await onResolveApproval(approvalId, decision).catch((): StructuredAgentUiResult => ({
      ok: false,
      message: 'The approval could not be delivered.',
    }));
    setResolvingId(null);
    if (!result.ok) setApprovalError(result.message);
  };

  return (
    <div
      ref={viewportRef}
      className="structured-agent-transcript"
      data-testid="structured-agent-transcript"
      onScroll={(event) => {
        const target = event.currentTarget;
        followTailRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 80;
      }}
    >
      {error && (
        <div className="structured-agent__banner structured-agent__banner--error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <span>{error}</span>
          {onRetry && <Button variant="ghost" size="sm" onClick={onRetry}>{copy.retry}</Button>}
        </div>
      )}
      {loading && displayItems.length === 0 && (
        <p className="structured-agent-transcript__state" role="status">
          <LoaderCircle className="structured-agent__spinner" aria-hidden="true" />
          {copy.transcriptLoading}
        </p>
      )}
      {!loading && !error && displayItems.length === 0 && (
        <p className="structured-agent-transcript__state" data-testid="structured-agent-empty">
          <Bot aria-hidden="true" />
          {copy.transcriptEmpty}
        </p>
      )}
      {displayItems.length > 0 && (
        <ol className="structured-agent-transcript__list" aria-label={copy.transcript}>
          {displayItems.map((item, index) => {
            const content = item.isSensitive ? copy.sensitive : item.text;
            const isAssistant = item.kind === 'assistant-message';
            const approval = item.kind === 'approval' ? approvalById.get(item.id) : undefined;
            const ApprovalIcon = approval ? APPROVAL_STATE_ICON[approval.state] : ShieldAlert;
            const label = item.kind === 'user-message'
              ? copy.you
              : item.kind === 'assistant-message'
                ? providerLabel || copy.assistant
                : item.kind === 'reasoning'
                  ? copy.reasoning
                  : item.kind === 'tool-call'
                    ? copy.toolCall
                    : item.kind === 'tool-result'
                      ? copy.toolResult
                      : item.kind === 'approval'
                        ? copy.approval
                        : item.kind === 'child-summary'
                          ? copy.childSummary
                          : item.kind === 'error'
                            ? copy.error
                            : copy.notice;
            return (
              <li key={`${item.id}-${item.sequence}`} className="structured-agent-transcript__item">
                <article
                  className="structured-agent-message"
                  data-kind={item.kind}
                  data-streaming={item.isDelta || undefined}
                  aria-label={label}
                  aria-live={item.isDelta ? 'polite' : undefined}
                  aria-atomic={item.isDelta ? 'false' : undefined}
                  {...(item.kind === 'error' ? { role: 'alert' } : {})}
                >
                  <header className="structured-agent-message__header">
                    <span className="structured-agent-message__kind">
                      {item.kind === 'tool-call' ? <Wrench aria-hidden="true" />
                        : item.kind === 'tool-result' ? <FileCheck2 aria-hidden="true" />
                          : item.kind === 'reasoning' ? <Code2 aria-hidden="true" />
                            : item.kind === 'approval' ? <ApprovalIcon aria-hidden="true" />
                              : item.kind === 'error' ? <AlertTriangle aria-hidden="true" />
                                : <Bot aria-hidden="true" />}
                      {label}
                    </span>
                    <time dateTime={item.createdAt}>{item.createdAt.slice(11, 16)}</time>
                  </header>

                  {item.kind === 'reasoning' ? (
                    <details className="structured-agent-message__reasoning" open={item.isDelta}>
                      <summary>{copy.reasoning}</summary>
                      <p>{content}</p>
                    </details>
                  ) : item.kind === 'tool-call' || item.kind === 'tool-result' ? (
                    <pre className="structured-agent-message__tool"><code>{content}</code></pre>
                  ) : item.kind === 'approval' ? (
                    <div className="structured-agent-approval" data-risk={approval?.risk ?? 'write'}>
                      <strong>{approval?.title ?? content}</strong>
                      {approval?.detail && <p>{approval.detail}</p>}
                      <span className="structured-agent-approval__state">
                        {approval?.state === 'allowed' ? copy.allowed
                          : approval?.state === 'denied' ? copy.denied
                            : approval?.state === 'expired' ? copy.expired
                              : copy.pending}
                      </span>
                      {(!approval || approval.state === 'pending') && onResolveApproval && (
                        <div className="structured-agent-approval__actions">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={resolvingId !== null}
                            onClick={() => void resolveApproval(approval?.id ?? item.id, 'deny')}
                          >
                            {copy.deny}
                          </Button>
                          <Button
                            variant="primary"
                            size="sm"
                            disabled={resolvingId !== null && resolvingId !== (approval?.id ?? item.id)}
                            loading={resolvingId === (approval?.id ?? item.id)}
                            onClick={() => void resolveApproval(approval?.id ?? item.id, 'allow')}
                          >
                            {copy.allow}
                          </Button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <ProgressiveSafeMarkdown
                      className="structured-agent-message__markdown"
                      markdown={content}
                      priority={index}
                    />
                  )}

                  {item.kind === 'child-summary' && item.relatedSessionId && onOpenRelatedSession && (
                    <Button
                      className="structured-agent-message__child-link"
                      variant="ghost"
                      size="sm"
                      trailingIcon={<ChevronRight />}
                      onClick={() => onOpenRelatedSession(item.relatedSessionId!)}
                    >
                      {copy.openChild}
                    </Button>
                  )}
                  {isAssistant && item.isDelta && (
                    <span className="structured-agent-message__streaming" role="status" aria-live="polite">
                      <span aria-hidden="true" />{copy.streaming}
                    </span>
                  )}
                </article>
              </li>
            );
          })}
        </ol>
      )}
      {approvalError && <p className="structured-agent__form-error" role="alert">{approvalError}</p>}
    </div>
  );
});

export interface StructuredAgentComposerProps {
  readonly busy: boolean;
  readonly queuedCount?: number;
  readonly disabled?: boolean;
  readonly initialDraft?: string;
  readonly onSend: (prompt: string) => Promise<StructuredAgentUiResult>;
  readonly onInterruptAndSend?: (prompt: string) => Promise<StructuredAgentUiResult>;
  readonly variant?: 'desktop' | 'mobile';
}

/** Owns the draft below the transcript so streamed items never disturb typing. */
export const StructuredAgentComposer = memo(function StructuredAgentComposer({
  busy,
  queuedCount = 0,
  disabled = false,
  initialDraft = '',
  onSend,
  onInterruptAndSend,
  variant = 'desktop',
}: StructuredAgentComposerProps): JSX.Element {
  const copy = useStructuredAgentCopy();
  const composerId = useId();
  const [draft, setDraft] = useState(initialDraft);
  const [submitting, setSubmitting] = useState<'send' | 'interrupt' | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deliver = async (mode: 'send' | 'interrupt'): Promise<void> => {
    setAttempted(true);
    setError(null);
    const prompt = draft.trim();
    if (!prompt || disabled || submitting) return;
    const action = mode === 'interrupt' ? onInterruptAndSend : onSend;
    if (!action) return;
    setSubmitting(mode);
    const result = await action(prompt).catch((): StructuredAgentUiResult => ({
      ok: false,
      message: 'The message could not be delivered.',
    }));
    setSubmitting(null);
    if (result.ok) {
      setDraft('');
      setAttempted(false);
    } else {
      setError(result.message);
    }
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void deliver('send');
  };

  return (
    <form
      className="structured-agent-composer"
      data-variant={variant}
      data-busy={busy || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        void deliver('send');
      }}
    >
      <Field
        id={composerId}
        label={copy.message}
        labelHidden
        error={attempted && !draft.trim() ? copy.required : undefined}
      >
        <textarea
          id={composerId}
          className="structured-agent-textarea structured-agent-textarea--composer"
          rows={2}
          maxLength={65_536}
          value={draft}
          placeholder={copy.messagePlaceholder}
          disabled={disabled}
          onKeyDown={keyDown}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setError(null);
          }}
          data-testid="structured-agent-composer-input"
        />
      </Field>
      <div className="structured-agent-composer__meta">
        <span aria-live="polite">
          {queuedCount > 0 ? formatTemplate(copy.queued, { count: queuedCount }) : busy ? copy.busyHint : ''}
        </span>
        <div className="structured-agent-composer__actions">
          {busy && onInterruptAndSend && (
            <Button
              type="button"
              variant="danger"
              size="sm"
              disabled={disabled || !draft.trim() || submitting !== null}
              loading={submitting === 'interrupt'}
              loadingLabel={copy.sending}
              onClick={() => void deliver('interrupt')}
              data-testid="structured-agent-interrupt-send"
            >
              {copy.interruptSend}
            </Button>
          )}
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={disabled || !draft.trim() || submitting !== null}
            loading={submitting === 'send'}
            loadingLabel={copy.sending}
            leadingIcon={<Send />}
            data-testid="structured-agent-send"
          >
            {busy ? copy.queue : copy.send}
          </Button>
        </div>
      </div>
      {error && <p className="structured-agent__form-error" role="alert">{error}</p>}
    </form>
  );
});

export interface StructuredAgentSessionPanelProps {
  readonly sessionId: string;
  readonly title: string;
  readonly providerId: string;
  readonly providerLabel: string;
  readonly workspace: StructuredAgentWorkspaceOption;
  readonly model?: string;
  readonly modelOptions?: readonly StructuredAgentModelOption[];
  readonly permissionPreset: PermissionPreset;
  readonly state: ManagedAgentState;
  readonly queuedCount?: number;
  readonly items: readonly DaemonTranscriptItem[];
  readonly approvals?: readonly DaemonApproval[];
  readonly transcriptLoading?: boolean;
  readonly transcriptError?: string | null;
  readonly disabled?: boolean;
  readonly childTrack?: ReactNode;
  readonly onRetryTranscript?: () => void;
  readonly onSend: (prompt: string) => Promise<StructuredAgentUiResult>;
  readonly onInterruptAndSend?: (prompt: string) => Promise<StructuredAgentUiResult>;
  readonly onChangeSettings?: (settings: {
    readonly model?: string;
    readonly permissionPreset: PermissionPreset;
  }) => Promise<StructuredAgentUiResult>;
  readonly onResolveApproval?: (
    approvalId: string,
    decision: 'allow' | 'deny',
  ) => Promise<StructuredAgentUiResult>;
  readonly onOpenRelatedSession?: (sessionId: string) => void;
  readonly variant?: 'desktop' | 'mobile';
}

const BUSY_AGENT_STATES = new Set<ManagedAgentState>(['starting', 'queued', 'working']);

export function StructuredAgentSessionPanel({
  sessionId,
  title,
  providerId,
  providerLabel,
  workspace,
  model,
  modelOptions = [],
  permissionPreset,
  state,
  queuedCount = 0,
  items,
  approvals = [],
  transcriptLoading = false,
  transcriptError = null,
  disabled = false,
  childTrack,
  onRetryTranscript,
  onSend,
  onInterruptAndSend,
  onChangeSettings,
  onResolveApproval,
  onOpenRelatedSession,
  variant = 'desktop',
}: StructuredAgentSessionPanelProps): JSX.Element {
  const copy = useStructuredAgentCopy();
  const titleId = useId();
  const [selectedModel, setSelectedModel] = useState(model ?? '');
  const [selectedPermission, setSelectedPermission] = useState(permissionPreset);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const busy = BUSY_AGENT_STATES.has(state);

  useEffect(() => setSelectedModel(model ?? ''), [model]);
  useEffect(() => setSelectedPermission(permissionPreset), [permissionPreset]);

  const updateSettings = async (nextModel: string, nextPermission: PermissionPreset): Promise<void> => {
    const previousModel = selectedModel;
    const previousPermission = selectedPermission;
    setSelectedModel(nextModel);
    setSelectedPermission(nextPermission);
    setSettingsError(null);
    if (!onChangeSettings) return;
    setSettingsBusy(true);
    const result = await onChangeSettings({
      ...(nextModel ? { model: nextModel } : {}),
      permissionPreset: nextPermission,
    }).catch((): StructuredAgentUiResult => ({
      ok: false,
      message: 'The session settings could not be updated.',
    }));
    setSettingsBusy(false);
    if (!result.ok) {
      setSelectedModel(previousModel);
      setSelectedPermission(previousPermission);
      setSettingsError(result.message);
    }
  };

  return (
    <section
      className="structured-agent structured-agent--live"
      data-variant={variant}
      data-session-id={sessionId}
      data-provider={providerId}
      data-state={state}
      data-testid="structured-agent-session"
      aria-labelledby={titleId}
    >
      <header className="structured-agent-session-header">
        <div className="structured-agent-session-header__identity">
          <span className="structured-agent__eyebrow">{providerLabel}</span>
          <h1 id={titleId}>{title}</h1>
          <p title={workspace.path}>{workspace.label} · {workspace.kind === 'worktree' ? 'Worktree' : 'Local'}</p>
        </div>
        <div className="structured-agent-session-header__status">
          <span className="structured-agent-state" data-state={state}>
            <span aria-hidden="true" />
            <span className="ez-ui-visually-hidden">{copy.status}: </span>{state}
          </span>
        </div>
        <div className="structured-agent-session-settings" role="group" aria-label={copy.settings}>
          <Field label={copy.model} labelHidden>
            <Select
              uiSize="sm"
              value={selectedModel}
              disabled={disabled || settingsBusy || !onChangeSettings}
              aria-label={copy.model}
              onChange={(event) => void updateSettings(event.currentTarget.value, selectedPermission)}
              data-testid="structured-agent-live-model"
            >
              {!model && <option value="">{copy.providerDefault}</option>}
              {modelOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </Select>
          </Field>
          <Field label={copy.permission} labelHidden>
            <Select
              uiSize="sm"
              value={selectedPermission}
              disabled={disabled || settingsBusy || !onChangeSettings}
              aria-label={copy.permission}
              onChange={(event) => void updateSettings(
                selectedModel,
                event.currentTarget.value as PermissionPreset,
              )}
              data-testid="structured-agent-live-permission"
            >
              {PERMISSION_ORDER.map((preset) => (
                <option key={preset} value={preset}>{permissionCopy(copy, preset).label}</option>
              ))}
            </Select>
          </Field>
        </div>
        {settingsError && <p className="structured-agent__form-error" role="alert">{settingsError}</p>}
      </header>

      {childTrack !== undefined && (
        <section className="structured-agent-child-track" aria-label={copy.childTrack} data-testid="structured-agent-child-track">
          {childTrack}
        </section>
      )}

      <StructuredAgentTranscript
        items={items}
        approvals={approvals}
        providerLabel={providerLabel}
        loading={transcriptLoading}
        error={transcriptError}
        onRetry={onRetryTranscript}
        onResolveApproval={onResolveApproval}
        onOpenRelatedSession={onOpenRelatedSession}
      />
      <StructuredAgentComposer
        busy={busy}
        queuedCount={queuedCount}
        disabled={disabled}
        onSend={onSend}
        onInterruptAndSend={onInterruptAndSend}
        variant={variant}
      />
    </section>
  );
}
