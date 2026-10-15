import { ConversationChangeReview } from './ConversationChangeReview';
import { decodeFileChanges } from '../shared/conversation-changes';
import {
  AlertTriangle,
  Archive,
  Bot,
  Check,
  ChevronRight,
  Circle,
  Clock3,
  Code2,
  Copy,
  FileCheck2,
  LoaderCircle,
  Paperclip,
  Reply,
  RotateCcw,
  Send,
  ShieldAlert,
  Square,
  Unlink2,
  Wrench,
  X,
} from 'lucide-react';
import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { insertCompletion } from './agent-completion';
import { useAgentCompletion, type CapabilityDiscoveryState } from './use-agent-completion';

import type {
  DaemonApproval,
  DaemonTranscriptItem,
  ManagedAgentState,
  PermissionPreset,
  WorkspaceKind,
} from '../shared/daemon-protocol';
import {
  CHAT_ATTACHMENT_ACCEPT, CHAT_IMAGE_MIME_TYPES, MAX_CHAT_ATTACHMENTS, MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_REPLY_LENGTH, validateChatMessageContext,
  type ChatAttachment, type ChatMessageContext, type ChatReplyReference, type ChatSkillReference,
} from '../shared/chat-message';
import {
  captureTranscriptAnchor, restoreTranscriptAnchor, readChatSkin, writeChatSkin, subscribeChatSkin,
  type ChatComposerDraft, type ChatSkin, type TranscriptAnchor,
} from './chat-view-state';
import { ProgressiveSafeMarkdown } from './ProgressiveSafeMarkdown';
import { useAppTranslation } from './i18n';
import { readSessionViewState, saveSessionViewState, readTranscriptViewState, saveTranscriptViewState } from './session-view-state';
import { Button, Field, Select } from './ui';
import type { AgentCapabilitiesClient, AgentCapabilityCatalog, AgentCapabilityItem } from '../shared/agent-capabilities';
import { AgentCapabilitiesPanel } from './AgentCapabilitiesPanel';
import type { ConversationQueueAction, ConversationQueueItem } from './conversation-queue';
import { conversationTranscriptGroups } from './conversation-transcript-groups';

export type StructuredAgentUiResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string; readonly deliveryUncertain?: boolean };

export type { ChatComposerDraft, ChatSkin } from './chat-view-state';

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
  /** Composer text carried into the empty conversation; must not submit a turn. */
  readonly draftText?: string;
  readonly draftSkills?: readonly ChatSkillReference[];
  readonly providerId: string;
  readonly model?: string;
  readonly workspaceId: string;
  readonly permissionPreset: PermissionPreset;
  readonly initialPrompt?: string;
}

export interface StructuredAgentDraftFormState {
  readonly draft: ChatComposerDraft;
  readonly providerId: string;
  readonly model?: string;
  readonly workspaceId: string;
  readonly permissionPreset: PermissionPreset;
}

interface StructuredAgentCopy {
  readonly newSession: string;
  readonly create: string;
  readonly notStarted: string;
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
  readonly desktopSendHint: string;
  readonly mobileSendHint: string;
  readonly settings: string;
  readonly status: string;
  readonly childTrack: string;
  readonly managed: string;
  readonly providerOwned: string;
  readonly readOnly: string;
  readonly openRelated: string;
  readonly lifecycle: string;
  readonly stopAgent: string;
  readonly stoppingAgent: string;
  readonly archiveSession: string;
  readonly archivingSession: string;
  readonly detachSession: string;
  readonly detachingSession: string;
  readonly lifecycleFailed: string;
  readonly providerOwnedReadOnly: string;
  readonly archivedReadOnly: string;
  readonly endedReadOnly: string;
  readonly skin: string;
  readonly bubbleSkin: string;
  readonly cliSkin: string;
  readonly copyMessage: string;
  readonly copied: string;
  readonly copyFailed: string;
  readonly replyMessage: string;
  readonly reuseMessage: string;
  readonly removeReply: string;
  readonly attach: string;
  readonly attachmentUnsupported: string;
  readonly removeAttachment: string;
  readonly attachmentError: string;
  readonly addReference: string;
  readonly uncertain: string;
  readonly reconcile: string;
}

const COPY: Readonly<Record<'en' | 'ko', StructuredAgentCopy>> = {
  en: {
    skin: 'Conversation skin', bubbleSkin: 'Bubbles', cliSkin: 'CLI',
    copyMessage: 'Copy', copied: 'Copied', copyFailed: 'Copy failed. Select the message text to copy it.',
    replyMessage: 'Reply', reuseMessage: 'Use as draft', removeReply: 'Remove reply',
    attach: 'Attach image or text', attachmentUnsupported: 'Attachments and replies require a compatible connected host.',
    removeAttachment: 'Remove attachment', attachmentError: 'This file could not be attached. Choose a supported image or a small text file.',
    addReference: 'Insert reference', uncertain: 'Delivery is unconfirmed. Check the host receipt before sending again.', reconcile: 'Check delivery',
    desktopSendHint: 'Enter to send · Shift+Enter for a new line',
    mobileSendHint: 'Use Send to send a message',
    newSession: 'New Agent session',
    create: 'Create Agent',
    notStarted: 'Not started',
    draftEyebrow: 'SESSION DRAFT',
    draftDescription: 'Create a conversation, then send a message to start.',
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
    allow: 'Allow',
    deny: 'Deny',
    pending: 'Pending',
    allowed: 'Allowed',
    denied: 'Denied',
    expired: 'Expired',
    message: 'Message Agent',
    messagePlaceholder: 'Describe what you want to work on…',
    queue: 'Queue message',
    interruptSend: 'Interrupt & Send',
    sending: 'Sending',
    queued: '{{count}} queued',
    busyHint: 'Send adds this message to the FIFO queue. Interrupt & Send stops the current turn first.',
    settings: 'Session settings',
    status: 'Status',
    childTrack: 'Child Agents',
    managed: 'Managed',
    providerOwned: 'Provider-owned',
    readOnly: 'Read only',
    openRelated: 'Open related session',
    lifecycle: 'Session actions',
    stopAgent: 'Stop current turn',
    stoppingAgent: 'Stopping current turn',
    archiveSession: 'End & archive',
    archivingSession: 'Archiving session',
    detachSession: 'Detach',
    detachingSession: 'Detaching session',
    lifecycleFailed: 'The session action could not be completed.',
    providerOwnedReadOnly: 'This subagent is owned by the provider. You can review its transcript here, but direct messages and lifecycle changes stay with the parent provider.',
    archivedReadOnly: 'This session is archived. Its transcript remains available, but new messages are disabled.',
    endedReadOnly: 'This session has ended. Its transcript remains available, but new messages are disabled.',
  },
  ko: {
    skin: '대화 스킨', bubbleSkin: '말풍선', cliSkin: 'CLI',
    copyMessage: '복사', copied: '복사됨', copyFailed: '복사하지 못했습니다. 메시지 원문을 선택해 복사하세요.',
    replyMessage: '답장', reuseMessage: '입력에 가져오기', removeReply: '답장 취소',
    attach: '이미지·텍스트 첨부', attachmentUnsupported: '첨부와 답장은 지원하는 호스트에 연결해야 사용할 수 있습니다.',
    removeAttachment: '첨부 제거', attachmentError: '파일을 첨부하지 못했습니다. 지원하는 이미지나 작은 텍스트 파일을 선택하세요.',
    addReference: '참조 입력', uncertain: '전송 결과를 확인 중입니다. 호스트 기록을 대조한 뒤 다시 보내세요.', reconcile: '전송 결과 확인',
    desktopSendHint: 'Enter 전송 · Shift+Enter 줄바꿈',
    mobileSendHint: '전송 버튼으로 보내기',
    newSession: '새 Agent 세션',
    create: 'Agent 만들기',
    notStarted: '시작 전',
    draftEyebrow: '세션 초안',
    draftDescription: '대화창을 만든 뒤 메시지를 보내면 시작합니다.',
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
    allow: '허용',
    deny: '거부',
    pending: '대기 중',
    allowed: '허용됨',
    denied: '거부됨',
    expired: '만료됨',
    message: 'Agent에게 메시지',
    messagePlaceholder: '원하는 작업을 입력하세요…',
    queue: '메시지 대기열 추가',
    interruptSend: '중단 후 보내기',
    sending: '보내는 중',
    queued: '{{count}}개 대기 중',
    busyHint: 'Send는 FIFO 대기열에 추가합니다. 중단 후 보내기는 현재 턴을 먼저 멈춥니다.',
    settings: '세션 설정',
    status: '상태',
    childTrack: '하위 Agent',
    managed: '관리형',
    providerOwned: 'Provider 소유',
    readOnly: '읽기 전용',
    openRelated: '관련 세션 열기',
    lifecycle: '세션 동작',
    stopAgent: '현재 작업 중단',
    stoppingAgent: 'Agent 중지 중',
    archiveSession: '종료하고 보관',
    archivingSession: '세션 보관 중',
    detachSession: '분리',
    detachingSession: '세션 분리 중',
    lifecycleFailed: '세션 동작을 완료하지 못했습니다.',
    providerOwnedReadOnly: '이 하위 Agent는 provider가 소유합니다. 여기서 대화를 확인할 수 있지만 직접 메시지와 수명주기 변경은 상위 provider가 관리합니다.',
    archivedReadOnly: '보관된 세션입니다. 대화는 계속 볼 수 있지만 새 메시지는 보낼 수 없습니다.',
    endedReadOnly: '종료된 세션입니다. 대화는 계속 볼 수 있지만 새 메시지는 보낼 수 없습니다.',
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
  readonly initialFormState?: StructuredAgentDraftFormState;
  readonly onFormStateChange?: (state: StructuredAgentDraftFormState) => void;
  readonly onOpenHistory?: () => void;
  readonly capabilityClient?: AgentCapabilitiesClient;
  readonly initialDraftText?: string;
  readonly initialDraftSkills?: readonly ChatSkillReference[];
  readonly providers: readonly StructuredAgentProviderOption[];
  readonly workspaces: readonly StructuredAgentWorkspaceOption[];
  readonly initialProviderId?: string;
  readonly initialModel?: string;
  readonly initialWorkspaceId?: string;
  /** Optional controlled Workspace selection for a parent-owned session draft. */
  readonly selectedWorkspaceId?: string;
  readonly onWorkspaceChange?: (workspaceId: string) => void;
  /** The parent renders the shared location control while this form keeps validation ownership. */
  readonly hideWorkspaceField?: boolean;
  readonly initialPermissionPreset?: PermissionPreset;
  readonly initialPrompt?: string;
  /** Locks submitted values while Send reconciles an uncertain delivery. */
  readonly deliveryRecovery?: boolean;
  readonly loading?: boolean;
  readonly loadError?: string | null;
  readonly onRetry?: () => void;
  readonly onCreate: (input: StructuredAgentDraftInput) => Promise<StructuredAgentUiResult>;
  readonly variant?: 'desktop' | 'mobile';
  /** Omits the standalone title when composed inside a broader New Session surface. */
  readonly embedded?: boolean;
  readonly onBusyChange?: (busy: boolean) => void;
}

export function StructuredAgentDraftPanel({
  initialFormState,
  onFormStateChange,
  capabilityClient,
  onOpenHistory,
  initialDraftText = '',
  initialDraftSkills,
  providers,
  workspaces,
  initialProviderId,
  initialModel = '',
  initialWorkspaceId,
  selectedWorkspaceId,
  onWorkspaceChange,
  hideWorkspaceField = false,
  initialPermissionPreset = 'standard',
  initialPrompt = '',
  deliveryRecovery = false,
  loading = false,
  loadError = null,
  onRetry,
  onCreate,
  variant = 'desktop',
  embedded = false,
  onBusyChange,
}: StructuredAgentDraftPanelProps): JSX.Element {
  const copy = useStructuredAgentCopy();
  const promptId = useId();
  const { i18n } = useAppTranslation();
  const draftTitleId = useId();
  const permissionName = useId();
  const firstProvider = providers.find((provider) => !provider.disabled)?.id ?? '';
  const hasReadyProvider = firstProvider.length > 0;
  const restoredForm = deliveryRecovery ? undefined : initialFormState;
  const [providerId, setProviderId] = useState(restoredForm?.providerId ?? initialProviderId ?? firstProvider);
  const [model, setModel] = useState(restoredForm ? restoredForm.model ?? '' : initialModel);
  const [internalWorkspaceId, setInternalWorkspaceId] = useState(
    restoredForm?.workspaceId ?? initialWorkspaceId ?? workspaces[0]?.id ?? '',
  );
  const workspaceId = selectedWorkspaceId ?? internalWorkspaceId;
  const [catalog, setCatalog] = useState<AgentCapabilityCatalog>();
  const [discovery, setDiscovery] = useState<CapabilityDiscoveryState>({ loading: !!capabilityClient });
  const [draftText, setDraftText] = useState(restoredForm?.draft.text ?? initialDraftText);
  const [draftSkills, setDraftSkills] = useState<readonly ChatSkillReference[]>(restoredForm?.draft.skills ?? initialDraftSkills ?? []);
  const draftInputRef = useRef<HTMLTextAreaElement>(null);
  const [draftSelection, setDraftSelection] = useState<[number, number]>([
    restoredForm?.draft.selectionStart ?? draftText.length,
    restoredForm?.draft.selectionEnd ?? draftText.length,
  ]);
  const [permissionPreset, setPermissionPreset] = useState<PermissionPreset>(restoredForm?.permissionPreset ?? initialPermissionPreset);
  const formStateCallback = useRef(onFormStateChange);
  formStateCallback.current = onFormStateChange;
  useEffect(() => {
    formStateCallback.current?.({ providerId, model: model || undefined, workspaceId, permissionPreset,
      draft: { text: draftText, skills: draftSkills, selectionStart: draftSelection[0], selectionEnd: draftSelection[1] } });
  }, [providerId, model, workspaceId, permissionPreset, draftText, draftSkills, draftSelection]);
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const selectedProvider = providers.find((provider) => provider.id === providerId);
  const updateDraftInput = (next: ChatComposerDraft): void => {
    setDraftText(next.text); setDraftSkills(next.skills ?? []);
    setDraftSelection([next.selectionStart ?? next.text.length, next.selectionEnd ?? next.text.length]);
    // An app action may unmount this form in the same event. Preserve its draft
    // before navigation instead of waiting for the next committed render.
    formStateCallback.current?.({ providerId, model: model || undefined, workspaceId, permissionPreset, draft: next });
  };
  useLayoutEffect(() => { draftInputRef.current?.setSelectionRange(...draftSelection); }, [draftSelection]);
  const draftValue = { text: draftText, skills: draftSkills, selectionStart: draftSelection[0], selectionEnd: draftSelection[1] };
  const completion = useAgentCompletion({ value: draftValue, onChange: updateDraftInput, inputRef: draftInputRef,
    catalog: catalog?.providerId === providerId && catalog.workspaceId === workspaceId ? catalog : undefined,
    discovery, onOpenHistory, disabled: loading || submitting || deliveryRecovery, mobile: variant === 'mobile' });
  const models = catalog?.providerId === providerId && catalog.workspaceId === workspaceId && catalog.models.length
    ? catalog.models.map((entry) => ({ id: entry.id, label: entry.displayName })) : selectedProvider?.models ?? [];
  const hasUsableProvider = deliveryRecovery ? providerId.length > 0 : hasReadyProvider;
  const hasUsableWorkspace = deliveryRecovery
    ? workspaceId.length > 0
    : workspaces.some((workspace) => workspace.id === workspaceId);
  const unavailableProviderDetail = !hasReadyProvider && providers.length > 0
    ? providers
      .filter((provider) => provider.disabled)
      .map((provider) => provider.description
        ? `${provider.label}: ${provider.description}`
        : provider.label)
      .join(' · ')
    : undefined;

  const selectWorkspace = (nextWorkspaceId: string): void => {
    if (selectedWorkspaceId === undefined) setInternalWorkspaceId(nextWorkspaceId);
    onWorkspaceChange?.(nextWorkspaceId);
    setSubmitError(null);
  };

  useEffect(() => {
    if (deliveryRecovery) return;
    if (firstProvider && !providers.some((provider) => provider.id === providerId && !provider.disabled)) {
      setProviderId(firstProvider);
      setModel('');
    }
  }, [deliveryRecovery, firstProvider, providerId, providers]);

  useEffect(() => {
    if (!deliveryRecovery) return;
    setProviderId(initialProviderId ?? '');
    setModel(initialModel);
    if (selectedWorkspaceId === undefined) setInternalWorkspaceId(initialWorkspaceId ?? '');
    setPermissionPreset(initialPermissionPreset);
    setDraftText(initialDraftText);
    setDraftSkills(initialDraftSkills ?? []);
  }, [
    deliveryRecovery,
    initialModel,
    initialPermissionPreset,
    initialPrompt,
    initialDraftText,
    initialDraftSkills,
    initialProviderId,
    initialWorkspaceId,
    selectedWorkspaceId,
  ]);

  useEffect(() => {
    if (selectedWorkspaceId !== undefined) return;
    const preferred = initialWorkspaceId
      ? workspaces.find((workspace) => workspace.id === initialWorkspaceId)
      : undefined;
    if (!workspaceId && preferred) {
      setInternalWorkspaceId(preferred.id);
      return;
    }
    if (workspaces[0] && !workspaces.some((workspace) => workspace.id === workspaceId)) {
      setInternalWorkspaceId(preferred?.id ?? workspaces[0].id);
    }
  }, [initialWorkspaceId, selectedWorkspaceId, workspaceId, workspaces]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (completion.composing.current || completion.runAppCommand()) return;
    setAttempted(true);
    setSubmitError(null);
    if (!providerId || !hasUsableProvider || !hasUsableWorkspace || submittingRef.current || loading) return;
    submittingRef.current = true;
    setSubmitting(true);
    onBusyChange?.(true);
    const result = await onCreate({
      providerId,
      ...(model ? { model } : {}),
      workspaceId,
      permissionPreset,
      ...(draftText ? { draftText } : {}),
      ...(draftSkills.length ? { draftSkills: draftSkills.filter((skill) => draftText.includes(skill.invocation)) } : {}),
      ...(deliveryRecovery && initialPrompt ? { initialPrompt } : {}),
    }).catch((): StructuredAgentUiResult => ({
      ok: false,
      message: 'The Agent session could not be created.',
    }));
    setSubmitting(false);
    submittingRef.current = false;
    onBusyChange?.(false);
    if (!result.ok) setSubmitError(result.message);
  };

  return (
    <section
      className="structured-agent structured-agent--draft"
      data-variant={variant}
      data-embedded={embedded || undefined}
      data-testid="structured-agent-draft"
      {...(embedded
        ? { 'aria-label': copy.newSession }
        : { 'aria-labelledby': draftTitleId })}
    >
      {!embedded && (
        <header className="structured-agent__draft-header">
          <span className="structured-agent__eyebrow">{copy.draftEyebrow}</span>
          <h1 id={draftTitleId}>{copy.newSession}</h1>
          <p>{copy.draftDescription}</p>
        </header>
      )}

      {loadError && (
        <div className="structured-agent__banner structured-agent__banner--error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <span>{loadError}</span>
          {onRetry && <Button variant="ghost" size="sm" onClick={onRetry}>{copy.retry}</Button>}
        </div>
      )}

      <form className="structured-agent-draft-form" onSubmit={(event) => void submit(event)} noValidate>
        {onOpenHistory && <Button type="button" variant="ghost" size="sm" onClick={onOpenHistory}>{i18n.language.startsWith('ko') ? '이전 대화' : 'Previous conversations'}</Button>}
        <div className="structured-agent-draft-form__grid">
          <Field
            label={copy.provider}
            description={selectedProvider?.description ?? unavailableProviderDetail}
            required
            error={attempted && !providerId ? copy.required : undefined}
          >
            <Select
              value={providerId}
              disabled={loading || submitting || deliveryRecovery || !hasReadyProvider}
              onChange={(event) => {
                setProviderId(event.currentTarget.value);
                setModel('');
                setSubmitError(null);
              }}
              data-testid="structured-agent-provider"
            >
              <option value="">{providers.length === 0 ? copy.noProviders : copy.provider}</option>
              {deliveryRecovery && providerId && !providers.some((provider) => provider.id === providerId) && (
                <option value={providerId}>{providerId}</option>
              )}
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id} disabled={provider.disabled}>
                  {provider.label}
                </option>
              ))}
            </Select>
          </Field>



          {!hideWorkspaceField && (
            <Field
              className="structured-agent-draft-form__workspace"
              label={copy.workspace}
              description={copy.workspaceHint}
              required
              error={attempted && !workspaceId ? copy.required : undefined}
            >
              <Select
                value={workspaceId}
                disabled={loading || submitting || deliveryRecovery || workspaces.length === 0}
                onChange={(event) => selectWorkspace(event.currentTarget.value)}
                data-testid="structured-agent-workspace"
              >
                <option value="">{workspaces.length === 0 ? copy.noWorkspaces : copy.workspace}</option>
                {deliveryRecovery && workspaceId && !workspaces.some((workspace) => workspace.id === workspaceId) && (
                  <option value={workspaceId}>{workspaceId}</option>
                )}
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.label} · {workspace.kind === 'worktree' ? 'Worktree' : 'Local'}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>

        <details className="structured-agent-draft-settings">
          <summary>{copy.settings}</summary>
          <Field label={copy.model}>
            <Select
              value={model}
              disabled={loading || submitting || deliveryRecovery || !providerId}
              onChange={(event) => {
                setModel(event.currentTarget.value);
                setSubmitError(null);
              }}
              data-testid="structured-agent-model"
            >
              <option value="">{copy.providerDefault}</option>
              {deliveryRecovery && model && !models.some((option) => option.id === model) && (
                <option value={model}>{model}</option>
              )}
              {models.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </Select>
          </Field>
        <fieldset className="structured-agent-permissions" disabled={loading || submitting || deliveryRecovery}>
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
        </details>

        <div className="structured-agent-draft-input">
          {completion.menu}
          <Field label={copy.message} id={`${promptId}-draft`}><textarea {...completion.inputProps} ref={draftInputRef} id={`${promptId}-draft`} className="structured-agent-textarea" rows={2}
            value={draftText} readOnly={deliveryRecovery} maxLength={65_536} onKeyDown={event => { completion.keyDown(event); }}
            onChange={event => updateDraftInput({ ...draftValue, text: event.target.value, selectionStart: event.target.selectionStart, selectionEnd: event.target.selectionEnd })}
            onSelect={event => { const input = event.currentTarget; if (draftSelection[0] !== input.selectionStart || draftSelection[1] !== input.selectionEnd) setDraftSelection([input.selectionStart, input.selectionEnd]); }} /></Field>
          <div>{completion.buttons}</div>
        </div>
        {deliveryRecovery && initialPrompt && <Field id={promptId} label={copy.firstPrompt}>
          <textarea id={promptId} className="structured-agent-textarea" rows={3} value={initialPrompt} readOnly data-testid="structured-agent-recovery-prompt" />
        </Field>}


        {submitError && <p className="structured-agent__form-error" role="alert">{submitError}</p>}
        <div className="structured-agent-draft-form__actions">
          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={submitting}
            loadingLabel={copy.creating}
            disabled={loading || !hasUsableProvider || !hasUsableWorkspace}
            leadingIcon={<Bot />}
            data-testid="structured-agent-create"
          >
            {copy.create}
          </Button>
        </div>
      </form>
      {capabilityClient && !selectedProvider?.disabled && workspaceId && (providerId === 'codex' || providerId === 'claude') && <AgentCapabilitiesPanel
        client={capabilityClient} providerId={providerId} workspaceId={workspaceId} remote={variant === 'mobile'}
        disabled={loading || submitting || deliveryRecovery} onCatalog={setCatalog} onDiscoveryState={setDiscovery}
        onInsert={(item) => { updateDraftInput(insertCompletion(draftValue, item.invocation ?? '', undefined,
          item.kind === 'skill' && item.invocation ? { providerId, id: item.id, name: item.name, invocation: item.invocation } : undefined)); draftInputRef.current?.focus(); }}
      />}
    </section>
  );
}

interface DisplayTranscriptItem extends DaemonTranscriptItem {
  readonly sourceIds: readonly string[];
}

function transcriptMessageId(item: DisplayTranscriptItem): string {
  return item.messageId ?? item.sourceIds[0] ?? item.id;
}

/** Coalesces adjacent streaming chunks without changing authoritative ordering. */
export function coalesceStructuredAgentTranscript(
  items: readonly DaemonTranscriptItem[],
): readonly DisplayTranscriptItem[] {
  const ordered = items.slice().sort((left, right) => left.sequence - right.sequence);
  const result: DisplayTranscriptItem[] = [];
  const messageIndexes = new Map<string, number>();
  for (const item of ordered) {
    const messageKey = item.messageId ? `${item.sessionId}:${item.turnId ?? ''}:${item.kind}:${item.messageId}` : undefined;
    const messageIndex = messageKey === undefined ? undefined : messageIndexes.get(messageKey);
    if (messageIndex !== undefined) {
      const current = result[messageIndex];
      result[messageIndex] = {
        ...item,
        text: item.isDelta ? `${current.text}${item.text}` : item.text,
        sourceIds: [...current.sourceIds, item.id],
      };
      continue;
    }
    if (messageKey) messageIndexes.set(messageKey, result.length);
    const previous = result.at(-1);
    const sameLogicalItem = previous && previous.id === item.id;
    const adjacentDelta = previous
      && !item.messageId && !previous.messageId
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

function ConversationExecutionGroup({ id, stateKey, count, children }: { id: string; stateKey?: string; count: number; children: ReactNode }): JSX.Element {
  const { i18n } = useAppTranslation();
  const key = stateKey ? `${stateKey}:execution:${id}` : undefined;
  const [expanded, setExpanded] = useState(() => key ? readSessionViewState<boolean>(key) ?? false : false);
  return <li className="conversation-execution" data-message-id={id}>
    <details open={expanded} onToggle={event => {
      const open = event.currentTarget.open;
      setExpanded(open);
      if (key) saveSessionViewState(key, open);
    }}>
      <summary><Wrench aria-hidden="true" /><span>{i18n.language.startsWith('ko') ? '실행 기록' : 'Execution details'}</span><span>{count}</span><ChevronRight aria-hidden="true" /></summary>
      <ol>{children}</ol>
    </details>
  </li>;
}

export interface StructuredAgentTranscriptProps {
  readonly beforeMessages?: ReactNode;
  readonly stateKey?: string;
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
  readonly controlsDisabled?: boolean;
  readonly onReply?: (reply: ChatReplyReference) => void;
  readonly onReuse?: (text: string) => void;
}

export const StructuredAgentTranscript = memo(function StructuredAgentTranscript({
  beforeMessages,
  stateKey,
  items,
  approvals = [],
  providerLabel,
  loading = false,
  error = null,
  onRetry,
  onResolveApproval,
  onOpenRelatedSession,
  controlsDisabled = false,
  onReply,
  onReuse,
}: StructuredAgentTranscriptProps): JSX.Element {
  const copy = useStructuredAgentCopy();
  const viewportRef = useRef<HTMLDivElement>(null);
  const savedScroll = useRef(stateKey ? readTranscriptViewState(stateKey) : undefined);
  const followTailRef = useRef(savedScroll.current?.follow ?? true);
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
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [showLatest, setShowLatest] = useState(false);
  const { i18n: transcriptI18n } = useAppTranslation();

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || displayItems.length === 0) return;
    if (savedScroll.current) {
      restoreTranscriptAnchor(viewport, savedScroll.current);
      savedScroll.current = undefined;
    } else if (followTailRef.current) viewport.scrollTop = viewport.scrollHeight;
  }, [displayItems]);

  const resolveApproval = async (approvalId: string, decision: 'allow' | 'deny'): Promise<void> => {
    if (!onResolveApproval || resolvingId || controlsDisabled) return;
    setResolvingId(approvalId);
    setApprovalError(null);
    const result = await onResolveApproval(approvalId, decision).catch((): StructuredAgentUiResult => ({
      ok: false,
      message: 'The approval could not be delivered.',
    }));
    setResolvingId(null);
    if (!result.ok) setApprovalError(result.message);
  };

  const renderItem = (item: DisplayTranscriptItem, index: number): JSX.Element => {
            const recordedChanges = decodeFileChanges(item.text);
            const content = recordedChanges.length ? recordedChanges.map(change => `${change.path}\n${change.patch}`).join('\n\n') : item.text;
            const isAssistant = item.kind === 'assistant-message';
            const messageId = transcriptMessageId(item);
            const context = item.context ?? {};
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
              <li key={`${item.sessionId}:${item.turnId ?? ''}:${item.kind}:${messageId}`} className="structured-agent-transcript__item">
                <article
                  className="structured-agent-message"
                  data-kind={item.kind}
                  data-message-id={messageId}
                  data-streaming={item.isDelta || undefined}
                  aria-label={label}
                  {...(item.kind === 'error' ? { role: 'alert' } : {})}
                >
                  <header className="structured-agent-message__header">
                    <span className="structured-agent-message__kind">
                      <span className="structured-agent-message__prompt" aria-hidden="true">{item.kind === 'user-message' ? '›' : '●'}</span>
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

                  {context.replyTo && <blockquote className="structured-agent-message__reply">{context.replyTo.text}</blockquote>}
                  {context.attachments && context.attachments.length > 0 && <ul className="structured-agent-message__attachments">
                    {context.attachments.map((attachment) => <li key={attachment.id}>
                      {attachment.kind === 'image'
                        ? <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt={attachment.name} />
                        : <Paperclip aria-hidden="true" />}
                      <span>{attachment.name}</span>
                    </li>)}
                  </ul>}

                  {item.kind === 'reasoning' ? (
                    <details className="structured-agent-message__reasoning">
                      <summary>{copy.reasoning}</summary>
                      <p>{content}</p>
                    </details>
                  ) : item.kind === 'tool-call' || item.kind === 'tool-result' ? (
                    <details className="structured-agent-message__reasoning">
                      <summary>{label}</summary>
                      <pre className="structured-agent-message__tool"><code>{content}</code></pre>
                    </details>
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
                            disabled={controlsDisabled || resolvingId !== null}
                            onClick={() => void resolveApproval(approval?.id ?? item.id, 'deny')}
                          >
                            {copy.deny}
                          </Button>
                          <Button
                            variant="primary"
                            size="sm"
                            disabled={controlsDisabled || (resolvingId !== null && resolvingId !== (approval?.id ?? item.id))}
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

                  {item.relatedSessionId && onOpenRelatedSession && (
                    <Button
                      className="structured-agent-message__child-link"
                      variant="ghost"
                      size="sm"
                      trailingIcon={<ChevronRight />}
                      onClick={() => onOpenRelatedSession(item.relatedSessionId!)}
                    >
                      {copy.openRelated}
                    </Button>
                  )}
                  {isAssistant && item.isDelta && (
                    <span className="structured-agent-message__streaming" role="status" aria-live="polite">
                      <span aria-hidden="true" />{copy.streaming}
                    </span>
                  )}
                  {(item.kind === 'user-message' || isAssistant) && <div className="structured-agent-message__actions">
                    <Button variant="ghost" size="sm" leadingIcon={<Copy />} onClick={() => {
                      void navigator.clipboard?.writeText(content).then(() => setCopyStatus(copy.copied), () => setCopyStatus(copy.copyFailed));
                      if (!navigator.clipboard) setCopyStatus(copy.copyFailed);
                    }}>{copy.copyMessage}</Button>
                    {onReply && !item.isSensitive && content.length > 0 && <Button variant="ghost" size="sm" leadingIcon={<Reply />}
                      onClick={() => onReply({ messageId: item.sourceIds[0] ?? item.id, text: content.slice(0, MAX_CHAT_REPLY_LENGTH) })}>{copy.replyMessage}</Button>}
                    {item.kind === 'user-message' && onReuse && <Button variant="ghost" size="sm" leadingIcon={<RotateCcw />}
                      onClick={() => onReuse(content)}>{copy.reuseMessage}</Button>}
                  </div>}
                </article>
              </li>
            );
  };

  return (
    <div
      ref={viewportRef}
      className="structured-agent-transcript"
      data-testid="structured-agent-transcript"
      onScroll={(event) => {
        const target = event.currentTarget;
        followTailRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 80;
        setShowLatest(!followTailRef.current);
        if (stateKey) saveTranscriptViewState(stateKey, captureTranscriptAnchor(target));
      }}
    >
      {beforeMessages}
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
          {conversationTranscriptGroups(displayItems).map(group => group.execution
            ? <ConversationExecutionGroup key={group.id} id={group.id} stateKey={stateKey} count={group.items.length}>
                {group.items.map(item => renderItem(item, displayItems.indexOf(item)))}
              </ConversationExecutionGroup>
            : renderItem(group.items[0], displayItems.indexOf(group.items[0])))}
        </ol>
      )}
      {showLatest && <Button className="conversation-latest" variant="secondary" size="sm" onClick={() => {
        if (viewportRef.current) viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
        followTailRef.current = true; setShowLatest(false);
      }}>{transcriptI18n.language.startsWith('ko') ? '최신 메시지로' : 'Jump to latest'}</Button>}
      {approvalError && <p className="structured-agent__form-error" role="alert">{approvalError}</p>}
      {copyStatus && <p className="structured-agent-message__copy-status" role="status">{copyStatus}</p>}
    </div>
  );
});

export interface StructuredAgentChildTrackItem {
  readonly sessionId: string;
  readonly title: string;
  readonly providerLabel: string;
  readonly state: ManagedAgentState;
  readonly owner: 'managed' | 'provider-native';
}

export interface StructuredAgentChildTrackProps {
  readonly items: readonly StructuredAgentChildTrackItem[];
  readonly onSelectSession: (sessionId: string) => void;
}

/** A compact projection of direct children; the authoritative tree remains in the daemon snapshot. */
export function StructuredAgentChildTrack({
  items,
  onSelectSession,
}: StructuredAgentChildTrackProps): JSX.Element | null {
  const copy = useStructuredAgentCopy();
  if (items.length === 0) return null;

  return (
    <nav className="structured-agent-children" aria-label={copy.childTrack}>
      <div className="structured-agent-children__heading">
        <span>{copy.childTrack}</span>
        <span aria-label={`${items.length} ${copy.childTrack}`}>{items.length}</span>
      </div>
      <ul className="structured-agent-children__list">
        {items.map((item) => (
          <li key={item.sessionId}>
            <button
              type="button"
              className="structured-agent-child"
              data-owner={item.owner}
              data-state={item.state}
              aria-label={`${copy.openRelated}: ${item.title}`}
              onClick={() => onSelectSession(item.sessionId)}
              data-testid="structured-agent-child"
            >
              <span className="structured-agent-child__identity">
                <strong>{item.title}</strong>
                <small>{item.providerLabel}</small>
              </span>
              <span className="structured-agent-child__meta">
                <span className="structured-agent-state" data-state={item.state}>
                  <span aria-hidden="true" />
                  <span className="ez-ui-visually-hidden">{copy.status}: </span>{item.state}
                </span>
                <span className="structured-agent-child__owner">
                  {item.owner === 'provider-native' ? copy.providerOwned : copy.managed}
                  {item.owner === 'provider-native' && <> · {copy.readOnly}</>}
                </span>
              </span>
              <ChevronRight aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export interface StructuredAgentComposerProps {
  readonly toolbar?: ReactNode;
  readonly queueItems?: readonly ConversationQueueItem[];
  readonly onQueueAction?: (item: ConversationQueueItem, action: ConversationQueueAction) => Promise<StructuredAgentUiResult>;
  readonly capabilityCatalog?: AgentCapabilityCatalog;
  readonly capabilityDiscovery?: CapabilityDiscoveryState;
  readonly onOpenHistory?: () => void;
  readonly stateKey?: string;
  readonly busy: boolean;
  readonly queuedCount?: number;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly initialDraft?: string;
  readonly autoFocus?: boolean;
  readonly onSend: (prompt: string, context?: ChatMessageContext) => Promise<StructuredAgentUiResult>;
  readonly onInterruptAndSend?: (prompt: string, context?: ChatMessageContext) => Promise<StructuredAgentUiResult>;
  readonly draftState?: ChatComposerDraft;
  readonly onDraftChange?: (draft: ChatComposerDraft) => void;
  readonly sendDisabled?: boolean;
  readonly sendDisabledReason?: string;
  readonly supportsMessageContext?: boolean;
  readonly deliveryUncertain?: boolean;
  readonly onReconcileDelivery?: () => Promise<StructuredAgentUiResult>;
  readonly draftAction?: { readonly id: number; readonly text?: string; readonly insert?: string; readonly skill?: ChatSkillReference; readonly replyTo?: ChatReplyReference };
  readonly variant?: 'desktop' | 'mobile';
}

/** Owns the draft below the transcript so streamed items never disturb typing. */
export const StructuredAgentComposer = memo(function StructuredAgentComposer({
  toolbar,
  queueItems = [],
  onQueueAction,
  capabilityCatalog,
  capabilityDiscovery,
  onOpenHistory,
  stateKey,
  busy,
  queuedCount = 0,
  disabled = false,
  disabledReason,
  initialDraft = '',
  autoFocus = false,
  onSend,
  onInterruptAndSend,
  draftState,
  onDraftChange,
  sendDisabled = false,
  sendDisabledReason,
  supportsMessageContext = false,
  deliveryUncertain = false,
  onReconcileDelivery,
  draftAction,
  variant = 'desktop',
}: StructuredAgentComposerProps): JSX.Element {
  const copy = useStructuredAgentCopy();
  const { i18n } = useAppTranslation();
  const ko = i18n.language.startsWith('ko');
  const [queueBusy, setQueueBusy] = useState(false);
  const queueBusyRef = useRef(false);
  const composerId = useId();
  const disabledReasonId = `${composerId}-disabled-reason`;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState<ChatComposerDraft>(() => {
    const saved = stateKey ? readSessionViewState<ChatComposerDraft | string>(stateKey) : undefined;
    return draftState ?? (typeof saved === 'string' ? { text: saved } : saved) ?? { text: initialDraft };
  });
  const valueRef = useRef(value);
  const draft = value.text;
  const attachments = value.attachments ?? [];
  const updateDraft = (next: ChatComposerDraft): void => {
    valueRef.current = next;
    setValue(next);
    if (stateKey) saveSessionViewState(stateKey, next);
    onDraftChange?.(next);
  };
  const completion = useAgentCompletion({ value, onChange: updateDraft, inputRef, catalog: capabilityCatalog,
    discovery: capabilityDiscovery, onOpenHistory, disabled, mobile: variant === 'mobile' });
  useEffect(() => {
    if (draftState && JSON.stringify(draftState) !== JSON.stringify(valueRef.current)) {
      valueRef.current = draftState;
      setValue(draftState);
      if (stateKey) saveSessionViewState(stateKey, draftState);
    }
  }, [draftState, stateKey]);
  useLayoutEffect(() => {
    if (value.selectionStart !== undefined && inputRef.current) {
      inputRef.current.setSelectionRange(value.selectionStart, value.selectionEnd ?? value.selectionStart);
    }
  }, [value.selectionStart, value.selectionEnd]);
  useEffect(() => {
    if (!draftAction || disabled) return;
    const next = { ...valueRef.current, ...(draftAction.text !== undefined ? { text: draftAction.text } : {}),
      ...(draftAction.insert ? insertCompletion(valueRef.current, draftAction.insert, undefined, draftAction.skill) : {}),
      ...(draftAction.skill ? { skills: [...(valueRef.current.skills ?? []).filter((skill) => skill.id !== draftAction.skill!.id), draftAction.skill] } : {}),
      ...(draftAction.replyTo ? { replyTo: draftAction.replyTo } : {}) };
    updateDraft(draftAction.insert ? next : { ...next, selectionStart: next.text.length, selectionEnd: next.text.length });
    inputRef.current?.focus();
    // The action ID is issued only by an explicit transcript action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftAction?.id]);
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState<'send' | 'interrupt' | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(deliveryUncertain);
  const [readingFiles, setReadingFiles] = useState(false);
  const sentDraft = useRef<ChatComposerDraft | null>(null);
  useEffect(() => setUncertain(deliveryUncertain), [deliveryUncertain]);

  const confirmDelivery = (): void => {
    const sent = sentDraft.current;
    if (sent && valueRef.current.text === sent.text
      && JSON.stringify(valueRef.current.attachments) === JSON.stringify(sent.attachments)
      && JSON.stringify(valueRef.current.skills) === JSON.stringify(sent.skills)
      && JSON.stringify(valueRef.current.replyTo) === JSON.stringify(sent.replyTo)) {
      updateDraft(valueRef.current.parkedDraft ?? { text: '', selectionStart: 0, selectionEnd: 0 });
    }
    sentDraft.current = null;
    setAttempted(false);
    setUncertain(false);
  };

  const deliver = async (mode: 'send' | 'interrupt'): Promise<void> => {
    if (disabled || completion.composing.current) return;
    if (completion.runAppCommand()) return;
    setAttempted(true);
    setError(null);
    const prompt = draft.trim();
    if ((!prompt && attachments.length === 0) || disabled || sendDisabled || queueBusy || uncertain || readingFiles || queueBusyRef.current || submittingRef.current) return;
    if ((attachments.length > 0 || value.replyTo) && !supportsMessageContext) { setError(copy.attachmentUnsupported); return; }
    const action = mode === 'interrupt' ? onInterruptAndSend : onSend;
    if (!action) return;
    submittingRef.current = true;
    sentDraft.current = valueRef.current;
    setSubmitting(mode);
    const skills = value.skills?.filter((skill) => prompt.includes(skill.invocation));
    const context: ChatMessageContext | undefined = attachments.length > 0 || value.replyTo || skills?.length
      ? { ...(attachments.length > 0 ? { attachments: [...attachments] } : {}), ...(value.replyTo ? { replyTo: value.replyTo } : {}), ...(skills?.length ? { skills } : {}) }
      : undefined;
    const result = await (context ? action(prompt, context) : action(prompt)).catch((): StructuredAgentUiResult => ({
      ok: false,
      message: copy.uncertain,
      deliveryUncertain: true,
    }));
    submittingRef.current = false;
    setSubmitting(null);
    if (result.ok) {
      confirmDelivery();
    } else {
      setError(result.message);
      setUncertain(result.deliveryUncertain === true);
    }
  };

  const attachFiles = async (files: FileList | null): Promise<void> => {
    if (!files || disabled || !supportsMessageContext) return;
    setReadingFiles(true);
    setError(null);
    try {
      if (files.length + (valueRef.current.attachments?.length ?? 0) > MAX_CHAT_ATTACHMENTS) throw new Error('Too many files');
      const additions: ChatAttachment[] = [];
      for (const file of Array.from(files)) {
        const image = (CHAT_IMAGE_MIME_TYPES as readonly string[]).includes(file.type);
        if (file.size > MAX_CHAT_ATTACHMENT_BYTES
          || (!image && !file.type.startsWith('text/') && !/\.(?:txt|md|json|csv|log|ts|tsx|js|jsx|css|html|py|yaml|yml|toml|xml)$/iu.test(file.name))) throw new Error('Unsupported file');
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result ?? ''));
          reader.onerror = () => reject(reader.error);
          if (image) reader.readAsDataURL(file); else reader.readAsText(file);
        });
        additions.push({ id: crypto.randomUUID(), name: file.name, mimeType: image ? file.type : (file.type || 'text/plain'),
          kind: image ? 'image' : 'text', data: image ? data.slice(data.indexOf(',') + 1) : data });
      }
      const combined = [...(valueRef.current.attachments ?? []), ...additions];
      if (validateChatMessageContext({ attachments: combined, ...(valueRef.current.replyTo ? { replyTo: valueRef.current.replyTo } : {}) })) throw new Error('Invalid attachment context');
      updateDraft({ ...valueRef.current, attachments: combined });
    } catch { setError(copy.attachmentError); }
    finally { setReadingFiles(false); if (fileInputRef.current) fileInputRef.current.value = ''; }
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (completion.keyDown(event)) return;
    if (completion.composing.current) return;
    if (variant === 'mobile' || event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
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
      {queuedCount > 0 && <details className="conversation-queue" open>
        <summary><Clock3 aria-hidden="true" />{ko ? '대기 중인 요청' : 'Queued requests'} <span>{queuedCount}</span></summary>
        {queueItems.length === 0 && <p>{ko ? '요청 내용을 불러오는 중…' : 'Loading accepted requests…'}</p>}
        <ol>{queueItems.map(item => <li key={item.turnId}>
          <p>{item.text}</p>
          {!!item.context?.attachments?.length && <small>{ko ? '첨부' : 'Attachments'} {item.context.attachments.length}</small>}
          {onQueueAction && <div className="conversation-queue__actions">{(['take', 'remove', 'run-next'] as const).map(action => <Button key={action} type="button" variant="ghost" size="sm"
            disabled={disabled || sendDisabled || queueBusy || submitting !== null || uncertain || (action === 'take' && !!value.parkedDraft)} onClick={() => {
              if (queueBusyRef.current || submittingRef.current) return;
              queueBusyRef.current = true; setQueueBusy(true); setError(null);
              void onQueueAction(item, action).then(result => {
                if (!result.ok) { setError(result.message); return; }
                if (action === 'take') {
                  const current = valueRef.current;
                  updateDraft({ text: item.text, attachments: item.context?.attachments, replyTo: item.context?.replyTo, skills: item.context?.skills,
                    selectionStart: item.text.length, selectionEnd: item.text.length,
                    ...(current.text || current.attachments?.length || current.replyTo ? { parkedDraft: current } : {}) });
                  inputRef.current?.focus();
                }
              }).catch(() => setError(ko ? '결과를 확인하지 못했습니다. 대기열 상태를 새로 확인하세요.' : 'The result is unknown. Refresh the queue before trying again.')).finally(() => { queueBusyRef.current = false; setQueueBusy(false); });
            }}>{action === 'take' ? (ko ? '편집' : 'Edit') : action === 'remove' ? (ko ? '삭제' : 'Remove') : (ko ? '중단 후 실행' : 'Interrupt and run')}</Button>)}</div>}
        </li>)}</ol>
      </details>}
      {value.parkedDraft && <div className="structured-agent-composer__parked" role="status">
        <span>{ko ? '기존 초안을 보관했습니다. 이 요청을 보내면 복원합니다.' : 'Previous draft saved. It will return after you send this request.'}</span>
        <Button type="button" variant="ghost" size="sm" disabled={queueBusy || submitting !== null || uncertain} onClick={() => {
          const { parkedDraft, ...current } = valueRef.current;
          if (parkedDraft) updateDraft({ ...parkedDraft, parkedDraft: current });
        }}>{ko ? '초안 전환' : 'Switch draft'}</Button>
      </div>}
      {completion.menu}
      {value.replyTo && <div className="structured-agent-composer__reply">
        <Reply aria-hidden="true" /><blockquote>{value.replyTo.text}</blockquote>
        <Button variant="ghost" size="sm" disabled={disabled} aria-label={copy.removeReply}
          onClick={() => updateDraft({ ...valueRef.current, replyTo: undefined })}><X /></Button>
      </div>}
      {attachments.length > 0 && <ul className="structured-agent-composer__attachments">
        {attachments.map((attachment) => <li key={attachment.id}>
          <details><summary><Paperclip aria-hidden="true" /><span>{attachment.name}</span></summary>
            {attachment.kind === 'image' ? <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt={attachment.name} /> : <pre>{attachment.data}</pre>}
          </details>
          <Button variant="ghost" size="sm" disabled={disabled} aria-label={`${copy.removeAttachment}: ${attachment.name}`}
            onClick={() => updateDraft({ ...valueRef.current, attachments: (valueRef.current.attachments ?? []).filter((entry) => entry.id !== attachment.id) })}><X /></Button>
        </li>)}
      </ul>}
      <div className="structured-agent-composer__input-row"><span className="structured-agent-composer__prompt" aria-hidden="true">›</span>
      <Field
        id={composerId}
        label={copy.message}
        labelHidden
        error={attempted && !draft.trim() && attachments.length === 0 ? copy.required : undefined}
      >
        <textarea
          {...completion.inputProps}
          id={composerId}
          ref={inputRef}
          autoFocus={autoFocus}
          className="structured-agent-textarea structured-agent-textarea--composer"
          rows={2}
          maxLength={65_536}
          value={draft}
          placeholder={copy.messagePlaceholder}
          disabled={disabled}
          aria-describedby={disabledReason ? disabledReasonId : undefined}
          onKeyDown={keyDown}
          onChange={(event) => {
            updateDraft({ ...valueRef.current, text: event.currentTarget.value, selectionStart: event.currentTarget.selectionStart, selectionEnd: event.currentTarget.selectionEnd });
            setError(null);
          }}
          onSelect={(event) => {
            const input = event.currentTarget;
            if (valueRef.current.selectionStart !== input.selectionStart || valueRef.current.selectionEnd !== input.selectionEnd) {
              updateDraft({ ...valueRef.current, selectionStart: input.selectionStart, selectionEnd: input.selectionEnd });
            }
          }}
          data-testid="structured-agent-composer-input"
        />
      </Field>
      </div>
      {disabledReason && (
        <p
          id={disabledReasonId}
          className="structured-agent-composer__disabled-reason"
          role="status"
          data-testid="structured-agent-composer-disabled-reason"
        >
          {disabledReason}
        </p>
      )}
      {sendDisabledReason && !disabledReason && <p className="structured-agent-composer__disabled-reason" role="status">{sendDisabledReason}</p>}
      <div className="structured-agent-composer__meta">
        {toolbar && <div className="conversation-composer-toolbar">{toolbar}</div>}
        <span aria-live="polite">
          {queuedCount > 0 ? formatTemplate(copy.queued, { count: queuedCount }) : busy ? copy.busyHint : variant === 'mobile' ? copy.mobileSendHint : copy.desktopSendHint}
        </span>
        <div className="structured-agent-composer__actions">
          {completion.buttons}
          <input ref={fileInputRef} type="file" multiple accept={CHAT_ATTACHMENT_ACCEPT}
            hidden onChange={(event) => void attachFiles(event.currentTarget.files)} />
          <Button variant="ghost" size="sm" type="button" disabled={disabled || !supportsMessageContext || readingFiles}
            className="structured-agent-composer__attach"
            title={supportsMessageContext ? copy.attach : copy.attachmentUnsupported} aria-label={copy.attach}
            leadingIcon={<Paperclip />} onClick={() => fileInputRef.current?.click()}>{copy.attach}</Button>
          <Button variant="ghost" size="sm" type="button" disabled={disabled} aria-label={copy.addReference}
            onClick={() => { const text = valueRef.current.text; const position = inputRef.current?.selectionStart ?? text.length;
              updateDraft({ ...valueRef.current, text: `${text.slice(0, position)}@${text.slice(position)}`, selectionStart: position + 1, selectionEnd: position + 1 }); inputRef.current?.focus(); }}>@</Button>
          {busy && onInterruptAndSend && (
            <Button
              type="button"
              variant="danger"
              size="sm"
              disabled={disabled || sendDisabled || queueBusy || uncertain || readingFiles || (!draft.trim() && attachments.length === 0) || submitting !== null}
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
            disabled={disabled || sendDisabled || queueBusy || uncertain || readingFiles || (!draft.trim() && attachments.length === 0) || submitting !== null}
            loading={submitting === 'send'}
            loadingLabel={copy.sending}
            leadingIcon={<Send />}
            data-testid="structured-agent-send"
          >
            {busy ? copy.queue : copy.send}
          </Button>
        </div>
      </div>
      {uncertain && <div className="structured-agent__banner" role="status"><span>{copy.uncertain}</span>
        {onReconcileDelivery && <Button type="button" variant="ghost" size="sm" disabled={disabled || sendDisabled || submitting !== null}
          onClick={() => { setSubmitting('send'); void onReconcileDelivery().then((result) => {
            if (result.ok) confirmDelivery(); else { setError(result.message); setUncertain(result.deliveryUncertain !== false); }
          }, () => setError(copy.uncertain)).finally(() => setSubmitting(null)); }}>{copy.reconcile}</Button>}
      </div>}
      {error && <p className="structured-agent__form-error" role="alert">{error}</p>}
    </form>
  );
});

export interface StructuredAgentSessionPanelProps {
  readonly onOpenProjectFiles?: () => void;
  readonly queueItems?: readonly ConversationQueueItem[];
  readonly onQueueAction?: StructuredAgentComposerProps['onQueueAction'];
  /** null discovers workspace capabilities before a runtime session exists. */
  readonly capabilitySessionId?: string | null;
  readonly beforeMessages?: ReactNode;
  readonly headerActions?: ReactNode;
  readonly statusLabel?: string;
  readonly onOpenHistory?: () => void;
  readonly capabilityClient?: AgentCapabilitiesClient;
  readonly workflowContext?: ReactNode;
  readonly viewStateKey?: string;
  readonly sessionId: string;
  readonly title: string;
  readonly providerId: string;
  readonly providerLabel: string;
  readonly workspace: StructuredAgentWorkspaceOption;
  readonly model?: string;
  readonly modelOptions?: readonly StructuredAgentModelOption[];
  readonly permissionPreset: PermissionPreset;
  readonly state: ManagedAgentState;
  readonly awaitingFirstMessage?: boolean;
  readonly queuedCount?: number;
  readonly items: readonly DaemonTranscriptItem[];
  readonly approvals?: readonly DaemonApproval[];
  readonly transcriptLoading?: boolean;
  readonly transcriptError?: string | null;
  readonly disabled?: boolean;
  readonly allowDraftWhenDisabled?: boolean;
  readonly skin?: ChatSkin;
  readonly onSkinChange?: (skin: ChatSkin) => void;
  readonly draftState?: ChatComposerDraft;
  readonly onDraftChange?: (draft: ChatComposerDraft) => void;
  readonly sendDisabled?: boolean;
  readonly sendDisabledReason?: string;
  readonly supportsMessageContext?: boolean;
  readonly deliveryUncertain?: boolean;
  readonly onReconcileDelivery?: () => Promise<StructuredAgentUiResult>;
  /** Transcript-only history surface; unavailable mutation controls are omitted. */
  readonly historyOnly?: boolean;
  /** Provider-native sessions are inspectable, but their provider owns interaction and lifecycle. */
  readonly owner?: 'managed' | 'provider-native';
  readonly childTrack?: ReactNode;
  readonly heartbeatControl?: ReactNode;
  readonly recoveryControl?: ReactNode;
  readonly onRetryTranscript?: () => void;
  readonly onSend: (prompt: string, context?: ChatMessageContext) => Promise<StructuredAgentUiResult>;
  readonly onInterruptAndSend?: (prompt: string, context?: ChatMessageContext) => Promise<StructuredAgentUiResult>;
  readonly onChangeSettings?: (settings: {
    readonly model?: string;
    readonly permissionPreset: PermissionPreset;
  }) => Promise<StructuredAgentUiResult>;
  readonly onResolveApproval?: (
    approvalId: string,
    decision: 'allow' | 'deny',
  ) => Promise<StructuredAgentUiResult>;
  readonly onOpenRelatedSession?: (sessionId: string) => void;
  readonly onCancel?: () => Promise<StructuredAgentUiResult>;
  readonly onArchive?: () => Promise<StructuredAgentUiResult>;
  readonly onDetach?: () => Promise<StructuredAgentUiResult>;
  readonly variant?: 'desktop' | 'mobile';
}

const BUSY_AGENT_STATES = new Set<ManagedAgentState>(['starting', 'queued', 'working']);
const CANCELLABLE_AGENT_STATES = new Set<ManagedAgentState>([
  'starting',
  'queued',
  'working',
  'blocked',
  'delivery-uncertain',
]);
const ARCHIVABLE_AGENT_STATES = new Set<ManagedAgentState>([
  'idle',
  'done',
  'interrupted',
  'error',
]);
const TERMINAL_AGENT_STATES = new Set<ManagedAgentState>([
  'done',
  'interrupted',
  'error',
  'archived',
]);

type StructuredAgentLifecycleAction = 'cancel' | 'archive' | 'detach';

export function StructuredAgentSessionPanel({
  onOpenProjectFiles,
  queueItems,
  onQueueAction,
  capabilitySessionId,
  beforeMessages,
  headerActions,
  statusLabel,
  capabilityClient,
  onOpenHistory,
  workflowContext,
  sessionId,
  viewStateKey,
  title,
  providerId,
  providerLabel,
  workspace,
  model,
  modelOptions = [],
  permissionPreset,
  state,
  queuedCount = 0,
  awaitingFirstMessage = false,
  items,
  approvals = [],
  transcriptLoading = false,
  transcriptError = null,
  disabled = false,
  allowDraftWhenDisabled = false,
  skin,
  onSkinChange,
  draftState,
  onDraftChange,
  sendDisabled = false,
  sendDisabledReason,
  supportsMessageContext = false,
  deliveryUncertain,
  onReconcileDelivery,
  historyOnly = false,
  owner = 'managed',
  childTrack,
  heartbeatControl,
  recoveryControl,
  onRetryTranscript,
  onSend,
  onInterruptAndSend,
  onChangeSettings,
  onResolveApproval,
  onOpenRelatedSession,
  onCancel,
  onArchive,
  onDetach,
  variant = 'desktop',
}: StructuredAgentSessionPanelProps): JSX.Element {
  const copy = useStructuredAgentCopy();
  const { i18n } = useAppTranslation();
  const [capabilityCatalog, setCapabilityCatalog] = useState<AgentCapabilityCatalog>();
  const [capabilityDiscovery, setCapabilityDiscovery] = useState<CapabilityDiscoveryState>({ loading: !!capabilityClient });
  const [selectedCapabilities, setSelectedCapabilities] = useState<readonly AgentCapabilityItem[]>([]);
  useEffect(() => { setCapabilityCatalog(undefined); setSelectedCapabilities([]); }, [sessionId, providerId, workspace.id]);
  const availableModels = capabilityCatalog?.providerId === providerId && capabilityCatalog.workspaceId === workspace.id && capabilityCatalog.models.length
    ? capabilityCatalog.models.map((entry) => ({ id: entry.id, label: entry.displayName })) : modelOptions;
  const sendWithCapabilities = async (prompt: string, context: ChatMessageContext | undefined, send: typeof onSend): Promise<StructuredAgentUiResult> => {
    if (context?.skills?.some((skill) => skill.providerId !== providerId)) return { ok: false, message: 'The selected skills belong to another provider. Remove or select them again.' };
    const selected = [...selectedCapabilities.filter((item) => item.invocation && prompt.includes(item.invocation)),
      ...(context?.skills ?? []).map((skill) => ({ ...skill, kind: 'skill' as const, enabled: true, actions: [] }))];
    if (capabilityClient && selected.length && (providerId === 'codex' || providerId === 'claude')) {
      try {
        const result = await capabilityClient.list({ providerId, workspaceId: workspace.id, sessionId: capabilitySessionId === null ? undefined : capabilitySessionId ?? sessionId });
        if (!result.ok) return { ok: false, message: result.message };
        setCapabilityCatalog(result.value);
        const missing = selected.filter((item) => !result.value.items.some((current) => current.id === item.id && current.kind === item.kind && current.enabled));
        if (missing.length) return { ok: false, message: `Selected extensions are no longer available: ${missing.map((item) => item.name).join(', ')}. Remove or select them again.` };
      } catch { return { ok: false, message: 'Selected extensions could not be verified. Your draft is preserved; reconnect and retry.' }; }
    }
    return context ? send(prompt, context) : send(prompt);
  };
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const [wideReview, setWideReview] = useState(false);
  const [reviewAside, setReviewAside] = useState(false);
  useLayoutEffect(() => {
    const element = panelRef.current;
    if (!element) return;
    const measure = (): void => {
      const { width, height } = element.getBoundingClientRect();
      element.dataset.compact = width < 600 ? 'true' : 'false';
      element.dataset.short = height < 480 ? 'true' : 'false';
      setWideReview(width >= 1280);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  const [preferredSkin, setPreferredSkin] = useState<ChatSkin>(readChatSkin);
  const activeSkin = skin ?? preferredSkin;
  const skinTransition = useRef<{ anchor?: TranscriptAnchor; selection?: [number, number]; focused: boolean } | null>(null);
  const [draftAction, setDraftAction] = useState<(NonNullable<StructuredAgentComposerProps['draftAction']> & { sessionId: string }) | undefined>();
  const actionSequence = useRef(0);
  const captureSkinView = (): void => {
    const viewport = panelRef.current?.querySelector<HTMLElement>('[data-testid="structured-agent-transcript"]');
    const input = panelRef.current?.querySelector<HTMLTextAreaElement>('[data-testid="structured-agent-composer-input"]');
    skinTransition.current = {
      ...(viewport ? { anchor: captureTranscriptAnchor(viewport) } : {}),
      ...(input ? { selection: [input.selectionStart, input.selectionEnd] } : {}),
      focused: document.activeElement === input,
    };
  };
  useEffect(() => subscribeChatSkin((next) => { captureSkinView(); setPreferredSkin(next); }), []);
  useLayoutEffect(() => {
    const saved = skinTransition.current;
    if (!saved) return;
    const viewport = panelRef.current?.querySelector<HTMLElement>('[data-testid="structured-agent-transcript"]');
    const input = panelRef.current?.querySelector<HTMLTextAreaElement>('[data-testid="structured-agent-composer-input"]');
    if (viewport && saved.anchor) restoreTranscriptAnchor(viewport, saved.anchor);
    if (input && saved.selection) { input.setSelectionRange(...saved.selection); if (saved.focused) input.focus({ preventScroll: true }); }
    skinTransition.current = null;
  }, [activeSkin]);
  const [selectedModel, setSelectedModel] = useState(model ?? '');
  const [selectedPermission, setSelectedPermission] = useState(permissionPreset);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [lifecycleBusy, setLifecycleBusy] = useState<StructuredAgentLifecycleAction | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const busy = BUSY_AGENT_STATES.has(state);
  const providerOwned = owner === 'provider-native';
  const terminal = TERMINAL_AGENT_STATES.has(state);
  const canCancel = !providerOwned && CANCELLABLE_AGENT_STATES.has(state) && onCancel !== undefined;
  const canArchive = !providerOwned && ARCHIVABLE_AGENT_STATES.has(state) && onArchive !== undefined;
  const canDetach = !providerOwned && state !== 'archived' && onDetach !== undefined;
  const hasLifecycleActions = !historyOnly && (canCancel || canArchive || canDetach);
  const settingsReadOnly = historyOnly || providerOwned || terminal || onChangeSettings === undefined;
  const composerDisabledReason = providerOwned
    ? copy.providerOwnedReadOnly
    : state === 'archived'
      ? copy.archivedReadOnly
      : terminal
        ? copy.endedReadOnly
        : undefined;
  const lifecycleDisabledReason = lifecycleBusy === 'cancel'
    ? copy.stoppingAgent
    : lifecycleBusy === 'archive'
      ? copy.archivingSession
      : lifecycleBusy === 'detach'
        ? copy.detachingSession
        : undefined;
  const composerDisabled = (disabled && !allowDraftWhenDisabled) || composerDisabledReason !== undefined;

  useEffect(() => setSelectedModel(model ?? ''), [model]);
  useEffect(() => setSelectedPermission(permissionPreset), [permissionPreset]);
  useEffect(() => {
    setLifecycleBusy(null);
    setLifecycleError(null);
  }, [owner, sessionId, state]);
  useEffect(() => {
    if (
      (lifecycleBusy === 'cancel' && !canCancel)
      || (lifecycleBusy === 'archive' && !canArchive)
      || (lifecycleBusy === 'detach' && !canDetach)
    ) {
      setLifecycleBusy(null);
    }
  }, [canArchive, canCancel, canDetach, lifecycleBusy]);

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

  const runLifecycle = async (
    action: StructuredAgentLifecycleAction,
    callback: (() => Promise<StructuredAgentUiResult>) | undefined,
  ): Promise<void> => {
    if (!callback || disabled || settingsBusy || lifecycleBusy) return;
    setLifecycleBusy(action);
    setLifecycleError(null);
    const result = await callback().catch((): StructuredAgentUiResult => ({
      ok: false,
      message: copy.lifecycleFailed,
    }));
    if (!result.ok) {
      setLifecycleBusy(null);
      setLifecycleError(result.message);
    }
  };

  const settingsControls = (
<div className="structured-agent-session-settings" role="group" aria-label={copy.settings}>
            {settingsReadOnly ? (
              <>
                <span className="structured-agent-session-setting" data-testid="structured-agent-live-model-value">
                  <small>{copy.model}</small>
                  <strong>{selectedModel || copy.providerDefault}</strong>
                </span>
                <span className="structured-agent-session-setting" data-testid="structured-agent-live-permission-value">
                  <small>{copy.permission}</small>
                  <strong>{permissionCopy(copy, selectedPermission).label}</strong>
                </span>
              </>
            ) : (
              <>
                <Field label={copy.model} labelHidden>
                  <Select
                    uiSize="sm"
                    value={selectedModel}
                    disabled={disabled || settingsBusy || lifecycleBusy !== null}
                    aria-label={copy.model}
                    onChange={(event) => void updateSettings(event.currentTarget.value, selectedPermission)}
                    data-testid="structured-agent-live-model"
                  >
                    {!model && <option value="">{copy.providerDefault}</option>}
                    {availableModels.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                  </Select>
                </Field>
                <Field label={copy.permission} labelHidden>
                  <Select
                    uiSize="sm"
                    value={selectedPermission}
                    disabled={disabled || settingsBusy || lifecycleBusy !== null}
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
              </>
            )}
          </div>
  );

  return (
    <section
      ref={panelRef}
      className="structured-agent structured-agent--live"
      data-variant={variant}
      data-session-id={sessionId}
      data-provider={providerId}
      data-state={state}
      data-skin={activeSkin}
      data-review-aside={reviewAside || undefined}
      data-history-only={historyOnly || undefined}
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
            <span className="ez-ui-visually-hidden">{copy.status}: </span>{statusLabel ?? (awaitingFirstMessage ? copy.notStarted : state)}
          </span>
          {owner === 'provider-native' && (
            <span className="structured-agent-session-header__owner">
              {copy.providerOwned} · {copy.readOnly}
            </span>
          )}
        </div>
        <div className="structured-agent-session-controls">
          {headerActions}
          {onOpenHistory && <Button type="button" variant="ghost" size="sm" onClick={onOpenHistory}>{i18n.language.startsWith('ko') ? '이전 대화' : 'Previous conversations'}</Button>}
          <Field label={copy.skin} labelHidden>
            <Select uiSize="sm" value={activeSkin} aria-label={copy.skin} data-testid="structured-agent-skin"
              onPointerDown={captureSkinView}
              onChange={(event) => { captureSkinView(); const next = event.currentTarget.value as ChatSkin; setPreferredSkin(next); writeChatSkin(next); onSkinChange?.(next); }}>
              <option value="bubble">{copy.bubbleSkin}</option><option value="cli">{copy.cliSkin}</option>
            </Select>
          </Field>
          {historyOnly && settingsControls}
          {hasLifecycleActions && (
            <div
              className="structured-agent-session-lifecycle"
              role="group"
              aria-label={copy.lifecycle}
              aria-busy={lifecycleBusy !== null || undefined}
              data-testid="structured-agent-lifecycle"
            >
              {canDetach && (
                <Button
                  variant="ghost"
                  size="sm"
                  leadingIcon={<Unlink2 />}
                  disabled={disabled || settingsBusy || lifecycleBusy !== null}
                  loading={lifecycleBusy === 'detach'}
                  loadingLabel={copy.detachingSession}
                  onClick={() => void runLifecycle('detach', onDetach)}
                  data-testid="structured-agent-detach"
                >
                  {copy.detachSession}
                </Button>
              )}
              {canArchive && (
                <Button
                  variant="ghost"
                  size="sm"
                  leadingIcon={<Archive />}
                  disabled={disabled || settingsBusy || lifecycleBusy !== null}
                  loading={lifecycleBusy === 'archive'}
                  loadingLabel={copy.archivingSession}
                  onClick={() => void runLifecycle('archive', onArchive)}
                  data-testid="structured-agent-archive"
                >
                  {copy.archiveSession}
                </Button>
              )}
              {canCancel && (
                <Button
                  variant="danger"
                  size="sm"
                  leadingIcon={<Square />}
                  disabled={disabled || settingsBusy || lifecycleBusy !== null}
                  loading={lifecycleBusy === 'cancel'}
                  loadingLabel={copy.stoppingAgent}
                  onClick={() => void runLifecycle('cancel', onCancel)}
                  data-testid="structured-agent-cancel"
                >
                  {copy.stopAgent}
                </Button>
              )}
            </div>
          )}
        </div>
        {settingsError && <p className="structured-agent__form-error" role="alert">{settingsError}</p>}
        {lifecycleError && <p className="structured-agent__form-error" role="alert">{lifecycleError}</p>}
      </header>

      <ConversationChangeReview key={`review:${sessionId}`} sessionId={sessionId} items={items} wide={wideReview && variant !== 'mobile'} mobile={variant === 'mobile'} ownerDocument={panelRef.current?.ownerDocument}
        onAsideChange={setReviewAside}
        onOpenProjectFiles={onOpenProjectFiles}
        onQuote={!historyOnly && !composerDisabled ? text => setDraftAction({ id: ++actionSequence.current, sessionId, insert: text }) : undefined} />
      {workflowContext}
      {!historyOnly && !providerOwned && capabilityClient && (providerId === 'codex' || providerId === 'claude') && <AgentCapabilitiesPanel
        client={capabilityClient} providerId={providerId} workspaceId={workspace.id} sessionId={capabilitySessionId === null ? undefined : capabilitySessionId ?? sessionId} remote={variant === 'mobile'}
        onCatalog={setCapabilityCatalog} onDiscoveryState={setCapabilityDiscovery} disabled={composerDisabled}
        onInsert={(item) => { setSelectedCapabilities((current) => [...current.filter((entry) => entry.id !== item.id), item]); setDraftAction({ id: ++actionSequence.current, sessionId, insert: item.invocation, ...(item.kind === 'skill' && item.invocation ? { skill: { providerId, id: item.id, name: item.name, invocation: item.invocation } } : {}) }); }}
      />}

      <StructuredAgentTranscript
        beforeMessages={beforeMessages}
        key={`transcript:${viewStateKey ?? sessionId}`}
        stateKey={viewStateKey ? `${viewStateKey}:transcript` : variant === 'desktop' ? `desktop-agent-transcript:${sessionId}` : undefined}
        items={items}
        approvals={approvals}
        providerLabel={providerLabel}
        loading={transcriptLoading}
        error={transcriptError}
        onRetry={onRetryTranscript}
        onResolveApproval={historyOnly ? undefined : onResolveApproval}
        controlsDisabled={disabled}
        onReply={!historyOnly && !composerDisabled && supportsMessageContext ? (replyTo) => setDraftAction({ id: ++actionSequence.current, sessionId, replyTo }) : undefined}
        onReuse={!historyOnly && !composerDisabled ? (text) => setDraftAction({ id: ++actionSequence.current, sessionId, text }) : undefined}
        onOpenRelatedSession={onOpenRelatedSession}
      />
      {childTrack !== undefined && (
        <section className="structured-agent-child-track" aria-label={copy.childTrack} data-testid="structured-agent-child-track">
          {childTrack}
        </section>
      )}
      {heartbeatControl}
      {recoveryControl}
      {!historyOnly && (
        <StructuredAgentComposer
          toolbar={settingsControls}
          queueItems={queueItems}
          onQueueAction={onQueueAction}
          capabilityCatalog={capabilityCatalog?.providerId === providerId && capabilityCatalog.workspaceId === workspace.id ? capabilityCatalog : undefined}
          capabilityDiscovery={capabilityDiscovery}
          onOpenHistory={onOpenHistory}
          key={`composer:${viewStateKey ?? sessionId}`}
          stateKey={viewStateKey ? `${viewStateKey}:composer` : variant === 'desktop' ? `desktop-agent-composer:${sessionId}` : undefined}
          busy={busy}
          autoFocus={awaitingFirstMessage && variant === 'desktop'}
          queuedCount={queuedCount}
          disabled={composerDisabled || lifecycleBusy !== null}
          disabledReason={composerDisabledReason ?? lifecycleDisabledReason}
          sendDisabled={disabled || sendDisabled}
          sendDisabledReason={sendDisabledReason}
          supportsMessageContext={supportsMessageContext}
          draftState={draftState}
          onDraftChange={onDraftChange}
          deliveryUncertain={deliveryUncertain}
          onReconcileDelivery={onReconcileDelivery}
          draftAction={draftAction?.sessionId === sessionId ? draftAction : undefined}
          onSend={(prompt, context) => sendWithCapabilities(prompt, context, onSend)}
          onInterruptAndSend={onInterruptAndSend ? (prompt, context) => sendWithCapabilities(prompt, context, onInterruptAndSend) : undefined}
          variant={variant}
        />
      )}
    </section>
  );
}
