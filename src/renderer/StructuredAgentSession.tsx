import type { ApprovalResponse } from '../shared/approval-request';
import { buildChatModel, coalesceTranscript } from './chat/model/build-chat-model';
import { ChatProvider } from './chat/ChatContext';
import { ChatTranscript } from './chat/ChatTranscript';
import { chatCopy, useChatLocale } from './chat/copy';
import { ApprovalDock, ProposedPlanDock, type PlanAccessChoice } from './chat/dock/ApprovalDock';
import { proposedPlan, withoutRow } from './chat/model/proposed-plan';
import { ACCESS_LEVELS, agentPermissionCopy, isAccessLevel, type AccessLevel } from './agent-permission-copy';
import { readLastAccess, readPlanAccess, writeLastAccess, writePlanAccess } from './agent-plan-access';
import { TaskDock } from './chat/dock/TaskDock';
import { ConversationChangeReview } from './ConversationChangeReview';
import { AgentResultsOwnerContext } from './agent-results/AgentResultsContext';
import { createResultsFileResolver } from './agent-results/results-file-links';
import { publishResultsModel, publishResultsSession } from './agent-results/results-source-store';
import { useResultsCopy } from './agent-results/copy';
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { insertCompletion, type AppCommand } from './agent-completion';
import { useAgentCompletion, type CapabilityDiscoveryState, type ComposerFileSearch } from './use-agent-completion';
import { discoverCapabilities } from './capability-discovery-cache';

import type {
  DaemonApproval,
  DaemonTranscriptItem,
  DaemonTurn,
  ManagedAgentState,
  PermissionPreset,
  WorkspaceKind,
} from '../shared/daemon-protocol';
import {
  CHAT_ATTACHMENT_ACCEPT, CHAT_IMAGE_MIME_TYPES, MAX_CHAT_ATTACHMENTS, MAX_CHAT_ATTACHMENT_BYTES,
  validateChatMessageContext,
  type ChatAttachment, type ChatMessageContext, type ChatReplyReference, type ChatSkillReference,
} from '../shared/chat-message';
import {
  captureTranscriptAnchor, restoreTranscriptAnchor, readChatSkin, writeChatSkin, subscribeChatSkin,
  type ChatComposerDraft, type ChatSkin, type TranscriptAnchor,
} from './chat-view-state';
import { useAppTranslation } from './i18n';
import { announceConversationHeader, usePaneActions } from './shell/pane-actions';
import { Glyph, glyphIcon, type GlyphIcon } from './ui/Glyph';
import { useAgentStateLabel } from './agent-state-label';
import { readSessionViewState, saveSessionViewState } from './session-view-state';
import { Button, Dialog, Field, Menu, MenuItem, MenuLabel, MenuRadioItem, MenuSeparator, Select } from './ui';
import { conversationFileChanges } from '../shared/conversation-changes';
import { SettingPill } from './chat/composer/SettingPill';
import { FolderPill } from './chat/composer/FolderPill';
import type { ConversationFolders } from '../shared/conversation-folders';
import { UsagePill, type UsagePillCopy } from './chat/composer/UsagePill';
import type { AgentUsage } from '../shared/agent-usage';
import type { AgentCapabilitiesClient, AgentCapabilityCatalog, AgentCapabilityItem } from '../shared/agent-capabilities';
import { AgentCapabilitiesPanel } from './AgentCapabilitiesPanel';
import type { ConversationQueueAction, ConversationQueueItem } from './conversation-queue';
import { structuredAgentEffortOptions, withCurrentModel } from './structured-agent-create';
import type { ConversationSettingsValues, QueuedSettingsProp } from './queued-settings';
import { SIDE_QUESTION_PROVIDER_IDS, type AgentSideQuestionClient } from '../shared/agent-side-question';
import { SideQuestionSurface } from './side-question/SideQuestionSurface';
import { useSideQuestionThread } from './side-question/use-side-question-thread';

export type StructuredAgentUiResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string; readonly deliveryUncertain?: boolean };

export type { ChatComposerDraft, ChatSkin } from './chat-view-state';

export interface StructuredAgentModelOption {
  readonly id: string;
  readonly label: string;
  readonly resolvedModel?: string;
  readonly isDefault?: boolean;
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
  /** Starting in plan mode: the access level the approved plan runs with. Kept on this device, never sent. */
  readonly planAccess?: AccessLevel;
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
  readonly modelOf: (provider: string) => string;
  readonly modelsLoading: string;
  readonly workspace: string;
  readonly workspaceHint: string;
  readonly noProviders: string;
  readonly noWorkspaces: string;
  readonly required: string;
  readonly permission: string;
  /** Model, access and plan mode change between turns; effort may change at any time. */
  readonly settingsAfterTurn: string;
  readonly planShortcutHint: string;
  readonly usage: UsagePillCopy;
  readonly settingsLockedDuringTurn: string;
  readonly settingsQueuedDuringTurn: string;
  readonly settingsFailed: string;
  readonly decisionHint: string;
  /** The message box shown away from the conversation (a terminal): the decision is not above it. */
  readonly decisionElsewhereHint: string;
  readonly planCommandOn: string;
  readonly planCommandOff: string;
  readonly modelCommand: string;
  readonly newCommand: string;
  readonly clearCommand: string;
  readonly clearAfterTurn: string;
  readonly clearUnavailable: string;
  readonly btwCommand: string;
  readonly btwButton: string;
  readonly btwUnavailable: string;
  readonly btwProviderOnly: string;
  readonly btwAfterSend: string;
  readonly implementPlanFailed: string;
  readonly planOn: string;
  readonly planOff: string;
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
  readonly childTrackMore: (count: number) => string;
  readonly childTrackLess: string;
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
  readonly parentConversation: string;
  readonly backToParent: string;
  readonly subagentManaged: string;
  readonly subagentApprovalWaiting: string;
  readonly reviewApproval: string;
  readonly archivedReadOnly: string;
  readonly endedReadOnly: string;
  readonly skin: string;
  readonly bubbleSkin: string;
  readonly cliSkin: string;
  readonly conversationMenu: string;
  readonly previousConversations: string;
  readonly tabSection: string;
  readonly keepTab: string;
  readonly splitRight: string;
  readonly splitBelow: string;
  readonly moveToNewWindow: string;
  readonly moveToMainWindow: string;
  readonly closeTab: string;
  readonly heartbeatMenu: string;
  readonly delegateHandoff: string;
  readonly delegateReview: string;
  readonly heartbeatOn: string;
  readonly changedFiles: (count: number) => string;
  readonly close: string;
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
    tabSection: 'Tab', keepTab: 'Keep open', splitRight: 'Split right', splitBelow: 'Split down',
    moveToNewWindow: 'Move to new window', moveToMainWindow: 'Move to main window', closeTab: 'Close tab',
    conversationMenu: 'Conversation menu', previousConversations: 'Previous conversations', heartbeatMenu: 'Heartbeat…', heartbeatOn: 'Heartbeat', delegateHandoff: 'Hand off…', delegateReview: 'Ask for review…',
    changedFiles: (count) => `${count} ${count === 1 ? 'file' : 'files'} changed`, close: 'Close',
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
    providerDefault: 'Default model',
    modelOf: (provider) => `${provider} model`,
    modelsLoading: 'Loading models…',
    workspace: 'Workspace',
    workspaceHint: 'The Agent reads and changes files only in this workspace.',
    noProviders: 'No ready Agent provider is available.',
    noWorkspaces: 'No active workspace is available for this project.',
    required: 'Choose an option to continue.',
    permission: 'Access',
    settingsAfterTurn: 'You can change this after the current turn.',
    planShortcutHint: 'Shift+Tab plan mode',
    usage: {
      title: (provider) => `${provider} usage`,
      names: { fiveHour: '5-hour', weekly: 'Weekly', context: 'Context' },
      short: { fiveHour: '5h', weekly: 'wk', context: 'ctx' },
      resetIn: (time) => `Resets in ${time}`,
      updated: 'Updated',
      summary: (provider, parts) => `${provider} usage: ${parts.join(', ')}`,
      windowPart: (window, percent, resetIn) => `${window === 'fiveHour' ? '5-hour' : 'weekly'} limit ${percent}% used${resetIn ? ` (resets in ${resetIn})` : ''}`,
      contextPart: (percent) => `context ${percent}% used`,
    },
    settingsLockedDuringTurn: 'Model, access and plan mode can change after this turn. Esc stops it.',
    settingsQueuedDuringTurn: 'Settings you change now apply from the next request. Esc stops this turn.',
    settingsFailed: 'The setting was not changed.',
    decisionHint: 'Shift+Tab goes to the waiting decision · Esc stops the turn',
    decisionElsewhereHint: 'This conversation waits for your decision · open it to answer · Esc stops the turn',
    planCommandOn: 'Turn plan mode on (Shift+Tab)',
    planCommandOff: 'Turn plan mode off (Shift+Tab)',
    modelCommand: 'Choose the model',
    newCommand: 'Start a new conversation in this project',
    clearCommand: 'Start over in this tab with the same settings',
    clearAfterTurn: 'You can start over after this turn. Esc stops it.',
    clearUnavailable: 'Starting over is not available here.',
    btwCommand: 'Ask a side question about this conversation (not saved)',
    btwButton: 'btw · side question',
    btwUnavailable: 'Side questions are not available here.',
    btwProviderOnly: 'This AI does not answer side questions yet.',
    btwAfterSend: 'Side questions open once you have sent this conversation a message in this app session.',
    implementPlanFailed: 'Plan mode is off, but the request to implement the plan was not sent. It is in the message box; send it again.',
    planOn: 'Plan mode on',
    planOff: 'Plan mode off',
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
    childTrackMore: (count: number) => `+${count} more`,
    childTrackLess: 'Show fewer',
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
    parentConversation: 'Parent conversation',
    backToParent: 'Back to parent',
    subagentManaged: 'The parent conversation runs this subagent. Send follow-ups there.',
    subagentApprovalWaiting: 'This subagent is waiting for your approval in the parent conversation.',
    reviewApproval: 'Review in parent',
    archivedReadOnly: 'This session is archived. Its transcript remains available, but new messages are disabled.',
    endedReadOnly: 'This session has ended. Its transcript remains available, but new messages are disabled.',
  },
  ko: {
    skin: '대화 스킨', bubbleSkin: '말풍선', cliSkin: 'CLI',
    tabSection: '탭', keepTab: '탭으로 고정', splitRight: '오른쪽으로 나누기', splitBelow: '아래로 나누기',
    moveToNewWindow: '새 창으로 옮기기', moveToMainWindow: '메인 창으로 옮기기', closeTab: '탭 닫기',
    conversationMenu: '대화 메뉴', previousConversations: '이전 대화', heartbeatMenu: '하트비트…', heartbeatOn: '하트비트', delegateHandoff: '맡기기…', delegateReview: '검토 맡기기…',
    changedFiles: (count) => `파일 ${count}개 변경`, close: '닫기',
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
    providerDefault: '기본 모델',
    modelOf: (provider) => `${provider} 모델`,
    modelsLoading: '모델 불러오는 중…',
    workspace: 'Workspace',
    workspaceHint: 'Agent는 선택한 Workspace 안에서만 파일을 읽고 변경합니다.',
    noProviders: '사용 가능한 Agent provider가 없습니다.',
    noWorkspaces: '이 프로젝트에 활성 Workspace가 없습니다.',
    required: '계속하려면 항목을 선택하세요.',
    permission: '권한',
    settingsAfterTurn: '현재 작업이 끝난 뒤 바꿀 수 있습니다.',
    planShortcutHint: 'Shift+Tab 계획',
    usage: {
      title: (provider) => `${provider} 사용량`,
      names: { fiveHour: '5시간', weekly: '주간', context: '컨텍스트' },
      short: { fiveHour: '5h', weekly: '주간', context: 'ctx' },
      resetIn: (time) => `${time} 후 초기화`,
      updated: '갱신',
      summary: (provider, parts) => `${provider} 사용량: ${parts.join(', ')}`,
      windowPart: (window, percent, resetIn) => `${window === 'fiveHour' ? '5시간' : '주간'} 한도 ${percent}% 사용${resetIn ? `(${resetIn} 후 초기화)` : ''}`,
      contextPart: (percent) => `컨텍스트 ${percent}% 사용`,
    },
    settingsLockedDuringTurn: '모델·권한·계획은 이 작업이 끝난 뒤 바꿀 수 있습니다. Esc로 멈춥니다.',
    settingsQueuedDuringTurn: '지금 바꾼 설정은 다음 요청부터 적용됩니다. Esc로 이 작업을 멈춥니다.',
    settingsFailed: '설정을 바꾸지 못했습니다.',
    decisionHint: 'Shift+Tab 기다리는 결정으로 이동 · Esc 멈춤',
    decisionElsewhereHint: '이 대화가 결정을 기다립니다 · 대화를 열어 답하세요 · Esc 멈춤',
    planCommandOn: '계획 모드 켜기 (Shift+Tab)',
    planCommandOff: '계획 모드 끄기 (Shift+Tab)',
    modelCommand: '모델 고르기',
    newCommand: '이 프로젝트에서 새 대화 시작',
    clearCommand: '이 탭에서 같은 설정으로 새로 시작',
    clearAfterTurn: '이 작업이 끝난 뒤 새로 시작할 수 있습니다. Esc로 멈춥니다.',
    clearUnavailable: '이 화면에서는 새로 시작할 수 없습니다.',
    btwCommand: '이 대화에 대해 곁가지 질문 (저장 안 됨)',
    btwButton: 'btw · 곁가지 질문',
    btwUnavailable: '이 화면에서는 곁가지 질문을 할 수 없습니다.',
    btwProviderOnly: '이 AI는 아직 곁가지 질문을 지원하지 않습니다.',
    btwAfterSend: '이번 실행에서 이 대화에 메시지를 한 번 보낸 뒤 곁가지 질문을 할 수 있습니다.',
    implementPlanFailed: '계획 모드는 꺼졌지만 구현 요청을 보내지 못했습니다. 입력창에 넣어 두었으니 다시 보내세요.',
    planOn: '계획 모드 켜짐',
    planOff: '계획 모드 꺼짐',
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
    childSummary: '서브에이전트 업데이트',
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
    childTrack: '서브에이전트',
    childTrackMore: (count: number) => `외 ${count}개`,
    childTrackLess: '접기',
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
    providerOwnedReadOnly: '이 서브에이전트는 provider가 소유합니다. 여기서 대화를 확인할 수 있지만 직접 메시지와 수명주기 변경은 상위 provider가 관리합니다.',
    parentConversation: '상위 대화',
    backToParent: '상위 대화로',
    subagentManaged: '상위 대화가 이 서브에이전트를 실행합니다. 후속 요청은 상위 대화에서 보내세요.',
    subagentApprovalWaiting: '이 서브에이전트가 상위 대화에서 승인을 기다리고 있습니다.',
    reviewApproval: '승인 확인',
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
  initialPermissionPreset = readLastAccess() ?? 'standard',
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
  const permissionText = agentPermissionCopy(useChatLocale());
  const [draftAccess, setDraftAccess] = useState<AccessLevel>(() => {
    const preset = restoredForm?.permissionPreset ?? initialPermissionPreset;
    return isAccessLevel(preset) ? preset : 'standard';
  });
  const draftPlan = permissionPreset === 'plan';
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
  // A draft has no conversation to start over: `/clear` is held back with a reason, never sent.
  const draftCommands = useMemo<readonly AppCommand[]>(() => [
    { name: 'clear', description: copy.clearCommand, takesText: true, disabledReason: copy.clearUnavailable, run: () => undefined },
    // Reserved so `/btw …` in a draft never becomes the first message.
    { name: 'btw', description: copy.btwCommand, takesText: true, disabledReason: copy.btwAfterSend, run: () => undefined },
  ], [copy.clearCommand, copy.clearUnavailable, copy.btwCommand, copy.btwAfterSend]);
  const completion = useAgentCompletion({ value: draftValue, onChange: updateDraftInput, inputRef: draftInputRef,
    catalog: catalog?.providerId === providerId && catalog.workspaceId === workspaceId ? catalog : undefined,
    discovery, onOpenHistory, disabled: loading || submitting || deliveryRecovery, mobile: variant === 'mobile', appCommands: draftCommands });
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
    if (isAccessLevel(initialPermissionPreset)) setDraftAccess(initialPermissionPreset);
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
      // A recovered send repeats the original command; its level was kept when it was first sent.
      ...(draftPlan && !deliveryRecovery ? { planAccess: draftAccess } : {}),
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
          <Glyph name="warn" />
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
        <label className="structured-agent-permission structured-agent-plan-start" data-selected={draftPlan || undefined}>
          <input
            type="checkbox"
            checked={draftPlan}
            disabled={loading || submitting || deliveryRecovery}
            onChange={(event) => {
              setPermissionPreset(event.currentTarget.checked ? 'plan' : draftAccess);
              setSubmitError(null);
            }}
            data-testid="structured-agent-start-in-plan"
          />
          <span>
            <strong>{permissionText.startInPlan}</strong>
            <small>{permissionText.planHint}</small>
          </span>
        </label>
        <fieldset className="structured-agent-permissions" disabled={loading || submitting || deliveryRecovery}>
          <legend>{copy.permission}</legend>
          <div className="structured-agent-permissions__grid">
            {ACCESS_LEVELS.map((level) => {
              const option = permissionText.levels[level];
              return (
                <label
                  key={level}
                  className="structured-agent-permission"
                  data-preset={level}
                  data-selected={draftAccess === level || undefined}
                >
                  <input
                    type="radio"
                    name={permissionName}
                    value={level}
                    checked={draftAccess === level}
                    onChange={() => {
                      setDraftAccess(level);
                      writeLastAccess(level);
                      if (!draftPlan) setPermissionPreset(level);
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
            value={draftText} readOnly={deliveryRecovery || submitting} maxLength={65_536} onKeyDown={event => { completion.keyDown(event); }}
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
            leadingIcon={<Glyph name="bot" />}
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

/** Coalesces adjacent streaming chunks without changing authoritative ordering. */
export function coalesceStructuredAgentTranscript(
  items: readonly DaemonTranscriptItem[],
): readonly (DaemonTranscriptItem & { readonly sourceIds: readonly string[] })[] {
  return coalesceTranscript(items);
}

export interface StructuredAgentTranscriptProps {
  readonly beforeMessages?: ReactNode;
  readonly stateKey?: string;
  readonly items: readonly DaemonTranscriptItem[];
  readonly approvals?: readonly DaemonApproval[];
  /** Turn records enable "Working for 12s" and settle tools of finished turns. */
  readonly turns?: readonly DaemonTurn[];
  readonly providerLabel: string;
  readonly skin?: ChatSkin;
  readonly workspaceRoot?: string;
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly onRetry?: () => void;
  readonly onResolveApproval?: (
    approvalId: string,
    decision: 'allow' | 'deny',
    response?: ApprovalResponse,
  ) => Promise<StructuredAgentUiResult>;
  /** Host accepts answers, plan mode and deny feedback (`approval-response-v1`). */
  readonly approvalResponses?: boolean;
  readonly onOpenRelatedSession?: (sessionId: string) => void;
  readonly onOpenLink?: (url: string) => void;
  readonly onReviewChanges?: () => void;
  /** Older messages exist above the loaded window. */
  readonly hasEarlier?: boolean;
  readonly loadingEarlier?: boolean;
  readonly onLoadEarlier?: () => void;
  readonly controlsDisabled?: boolean;
  readonly onReply?: (reply: ChatReplyReference) => void;
  readonly onReuse?: (text: string) => void;
  /** The access level an approved plan runs with, shared with the composer. */
  readonly planAccess?: PlanAccessChoice;
  /** The host can allow a command or edit for the rest of the conversation. */
  readonly approvalSession?: boolean;
  /** Asks about a plan Codex proposed in plan mode; Codex itself never asks. */
  readonly planReview?: {
    readonly providerId: string;
    readonly permissionPreset: PermissionPreset;
    readonly state: ManagedAgentState;
    readonly onApprove: () => Promise<StructuredAgentUiResult>;
    readonly onKeepPlanning: (message: string) => Promise<StructuredAgentUiResult>;
  };
}

/**
 * The conversation, its pending approval and the agent's task list. Rows come
 * from the shared chat view-model so both skins present the same content.
 */
export const StructuredAgentTranscript = memo(function StructuredAgentTranscript({
  beforeMessages,
  stateKey,
  items,
  approvals = [],
  turns,
  providerLabel,
  skin,
  workspaceRoot,
  loading = false,
  error = null,
  onRetry,
  onResolveApproval,
  approvalResponses = false,
  onOpenRelatedSession,
  onOpenLink,
  onReviewChanges,
  hasEarlier = false,
  loadingEarlier = false,
  onLoadEarlier,
  controlsDisabled = false,
  onReply,
  onReuse,
  planAccess,
  planReview,
  approvalSession = false,
}: StructuredAgentTranscriptProps): JSX.Element {
  const copy = useStructuredAgentCopy();
  const locale = useChatLocale();
  const built = useMemo(() => buildChatModel({ items, approvals, ...(turns ? { turns } : {}) }), [items, approvals, turns]);
  // Desktop: the Results tab reads the model built here, and chat links and cards lead to it.
  const results = useContext(AgentResultsOwnerContext);
  useEffect(() => {
    if (!results) return undefined;
    publishResultsModel(results.ownerPanelId, built);
    return undefined;
  }, [built, results]);
  useEffect(() => (results ? () => publishResultsModel(results.ownerPanelId, undefined) : undefined), [results]);
  const openResults = useCallback((section: 'changes' | 'files' | 'summary', target?: { readonly turnId?: string; readonly path?: string; readonly line?: number }) => {
    results?.open({ activate: true, target: { section, ...target } });
  }, [results]);
  const changedPathsKey = useMemo(() => [...new Set(built.rows.flatMap((row) => (row.kind === 'changes' ? row.files.map((file) => file.path) : [])))].join('\n'), [built]);
  const resolveFileLink = useMemo(
    () => createResultsFileResolver(workspaceRoot, changedPathsKey ? changedPathsKey.split('\n') : []),
    [changedPathsKey, workspaceRoot],
  );
  const proposal = planReview && planAccess
    ? proposedPlan(built, { providerId: planReview.providerId, permissionPreset: planReview.permissionPreset, state: planReview.state, ...(turns ? { turns } : {}) })
    : undefined;
  const model = useMemo(() => withoutRow(built, proposal), [built, proposal]);
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const pendingId = model.pending?.approval.id ?? proposal?.id;
  useEffect(() => setDockCollapsed(false), [pendingId]);
  const unfinishedTodo = model.todo && model.todo.some((item) => item.status !== 'completed') ? model.todo : undefined;
  return (
    <ChatProvider
      skin={skin ?? readChatSkin()}
      locale={locale}
      stateKey={stateKey}
      {...(workspaceRoot ? { workspaceRoot } : {})}
      {...(onReply ? { onReply } : {})}
      {...(onReuse ? { onReuse } : {})}
      {...(onOpenLink ? { onOpenLink } : {})}
      {...(onOpenRelatedSession ? { onOpenRelated: onOpenRelatedSession } : {})}
      {...(results ? { onOpenResults: openResults, resolveFileLink } : onReviewChanges ? { onReviewChanges } : {})}
    >
      <ChatTranscript
        model={model}
        providerLabel={providerLabel || copy.assistant}
        stateKey={stateKey}
        loading={loading}
        error={error}
        onRetry={onRetry}
        before={beforeMessages}
        emptyLabel={copy.transcriptEmpty}
        loadingLabel={copy.transcriptLoading}
        retryLabel={copy.retry}
        {...(hasEarlier && onLoadEarlier ? { earlier: { loading: loadingEarlier, onLoad: onLoadEarlier } } : {})}
      />
      {unfinishedTodo && <TaskDock items={unfinishedTodo} />}
      {model.pending && onResolveApproval && (
        <ApprovalDock
          pending={model.pending}
          pendingCount={model.pendingCount}
          canRespond={approvalResponses}
          disabled={controlsDisabled}
          collapsed={dockCollapsed}
          onCollapsedChange={setDockCollapsed}
          onResolve={(approvalId, decision, response) => (response
            ? onResolveApproval(approvalId, decision, response)
            : onResolveApproval(approvalId, decision))}
          {...(planAccess ? { planAccess } : {})}
          canAllowForSession={approvalSession}
        />
      )}
      {!model.pending && proposal && planReview && planAccess && (
        <ProposedPlanDock
          markdown={proposal.markdown}
          access={planAccess}
          disabled={controlsDisabled}
          collapsed={dockCollapsed}
          onCollapsedChange={setDockCollapsed}
          onApprove={planReview.onApprove}
          onKeepPlanning={planReview.onKeepPlanning}
        />
      )}
    </ChatProvider>
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

/** What needs the person first, then what is running, then what finished. */
const CHILD_TRACK_RANK: Partial<Record<ManagedAgentState, number>> = {
  blocked: 0, 'delivery-uncertain': 0, error: 1, starting: 2, working: 2, queued: 3,
};
/** Chips shown before the rest folds into "+N"; a 20-subagent turn stays one row. */
const CHILD_TRACK_VISIBLE = 4;

/** A compact projection of direct children; the authoritative tree remains in the daemon snapshot. */
export function StructuredAgentChildTrack({
  items,
  onSelectSession,
}: StructuredAgentChildTrackProps): JSX.Element | null {
  const copy = useStructuredAgentCopy();
  const stateLabel = useAgentStateLabel();
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const ordered = items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => (CHILD_TRACK_RANK[left.item.state] ?? 4) - (CHILD_TRACK_RANK[right.item.state] ?? 4) || left.index - right.index)
    .map(({ item }) => item);
  const hidden = expanded ? 0 : Math.max(0, ordered.length - CHILD_TRACK_VISIBLE);
  const visible = hidden > 0 ? ordered.slice(0, CHILD_TRACK_VISIBLE) : ordered;

  // One row of chips above the composer: state dot, name and state. Provider and ownership
  // stay in the accessible name and tooltip; attention states carry the visual weight.
  return (
    <nav className="structured-agent-children" aria-label={`${copy.childTrack} ${items.length}`} data-expanded={expanded || undefined}>
      <span className="structured-agent-children__heading" aria-hidden="true">{copy.childTrack}</span>
      <ul className="structured-agent-children__list" data-expanded={expanded || undefined}>
        {visible.map((item) => {
          const ownership = item.owner === 'provider-native' ? `${copy.providerOwned} · ${copy.readOnly}` : copy.managed;
          const details = `${item.title} · ${stateLabel(item.state)} · ${item.providerLabel} · ${ownership}`;
          return (
            <li key={item.sessionId}>
              <button
                type="button"
                className="structured-agent-child"
                data-owner={item.owner}
                data-state={item.state}
                title={details}
                aria-label={`${copy.openRelated}: ${details}`}
                onClick={() => onSelectSession(item.sessionId)}
                data-testid="structured-agent-child"
              >
                <span className="structured-agent-state" data-state={item.state}><span aria-hidden="true" /></span>
                <span className="structured-agent-child__title">{item.title}</span>
                <span className="structured-agent-child__status">{stateLabel(item.state)}</span>
                <span className="ez-ui-visually-hidden"> · {item.providerLabel} · {ownership}</span>
              </button>
            </li>
          );
        })}
        {(hidden > 0 || expanded) && ordered.length > CHILD_TRACK_VISIBLE && (
          <li>
            <button type="button" className="structured-agent-child structured-agent-child--more" aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)} data-testid="structured-agent-child-more">
              {expanded ? copy.childTrackLess : copy.childTrackMore(hidden)}
            </button>
          </li>
        )}
      </ul>
    </nav>
  );
}

export interface StructuredAgentComposerProps {
  readonly toolbar?: ReactNode;
  /** The conversation's AI; the message box carries its colour. */
  readonly providerId?: string;
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
  /** `append` adds after what is already typed (queued messages handed back on stop). */
  readonly draftAction?: { readonly id: number; readonly text?: string; readonly insert?: string; readonly append?: string; readonly skill?: ChatSkillReference; readonly replyTo?: ChatReplyReference };
  readonly variant?: 'desktop' | 'mobile';
  /** `@` file mentions; absent where the workspace cannot be searched (Android). */
  readonly fileSearch?: ComposerFileSearch;
  /** Earlier prompts of this conversation, oldest first, for ↑ recall. */
  readonly recentPrompts?: readonly string[];
  /** Present while the turn can be stopped: Esc, or the stop button when the draft is empty. */
  readonly onStop?: () => void;
  readonly stopping?: boolean;
  /** Resolves a dropped file to a workspace path so it can be mentioned instead of uploaded. */
  readonly pathForDrop?: (file: File) => string | null;
  /** Why the settings above cannot change right now; shown under the message box. */
  readonly statusHint?: string;
  /** Moves focus to a pending decision above the message box; false when there is none. */
  readonly onFocusDecision?: () => boolean;
  /** `/plan`, `/model`, `/new`: conversation commands typed in the message box. */
  readonly appCommands?: readonly AppCommand[];
  /** /btw: shown only while the conversation can take a side question. */
  readonly sideQuestion?: {
    readonly label: string;
    readonly open: boolean;
    readonly controlsId: string;
    readonly buttonRef: RefObject<HTMLButtonElement>;
    /** Ask the message box's text and open the window; false when it was not taken (the box keeps it). */
    readonly onAsk: (text: string) => boolean;
    readonly onOpen: () => void;
  };
  /** Shift+Tab in the message box switches plan mode, as the plan button does. */
  readonly plan?: {
    readonly on: boolean;
    readonly onToggle: () => void;
    readonly disabled?: boolean;
    /** Why it cannot switch now; announced instead of switching. */
    readonly blockedReason?: string;
  };
}

/** A message box holding `/btw …` is a side question being typed: its text never reaches draft storage. */
const SIDE_QUESTION_DRAFT = /^\s*\/btw(?:\s|$)/u;
export function storableDraft(draft: ChatComposerDraft): ChatComposerDraft {
  const parked = draft.parkedDraft;
  const kept = parked && SIDE_QUESTION_DRAFT.test(parked.text) ? { ...draft, parkedDraft: { ...parked, text: '', selectionStart: 0, selectionEnd: 0 } } : draft;
  return SIDE_QUESTION_DRAFT.test(kept.text) ? { ...kept, text: '', selectionStart: 0, selectionEnd: 0 } : kept;
}

/** Owns the draft below the transcript so streamed items never disturb typing. */
export const StructuredAgentComposer = memo(function StructuredAgentComposer({
  toolbar,
  providerId,
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
  fileSearch,
  recentPrompts = [],
  onStop,
  stopping = false,
  pathForDrop,
  statusHint,
  onFocusDecision,
  appCommands,
  sideQuestion,
  plan,
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
    onDraftChange?.(storableDraft(next));
  };
  const completion = useAgentCompletion({ value, onChange: updateDraft, inputRef, catalog: capabilityCatalog,
    discovery: capabilityDiscovery, onOpenHistory, disabled, mobile: variant === 'mobile', ...(fileSearch ? { fileSearch } : {}),
    ...(appCommands ? { appCommands } : {}) });
  const [dragging, setDragging] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const recall = useRef<number | undefined>(undefined);
  // Grow with the text up to eight lines, then scroll inside the box.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
  }, [value.text]);
  useEffect(() => {
    // Storage echoes what it was given; a side question it was not given is not overwritten by that echo.
    if (draftState && JSON.stringify(draftState) !== JSON.stringify(valueRef.current)
      && JSON.stringify(draftState) !== JSON.stringify(storableDraft(valueRef.current))) {
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
  const appliedDraftAction = useRef<number | undefined>(undefined);
  useEffect(() => {
    // Applied once, as soon as the box takes input again (a stop disables it while it runs).
    if (!draftAction || disabled || appliedDraftAction.current === draftAction.id) return;
    appliedDraftAction.current = draftAction.id;
    const appended = draftAction.append === undefined ? undefined
      : valueRef.current.text.trim() ? `${valueRef.current.text.replace(/\s+$/u, '')}\n\n${draftAction.append}` : draftAction.append;
    const next = { ...valueRef.current, ...(draftAction.text !== undefined ? { text: draftAction.text } : {}),
      ...(appended !== undefined ? { text: appended } : {}),
      ...(draftAction.insert ? insertCompletion(valueRef.current, draftAction.insert, undefined, draftAction.skill) : {}),
      ...(draftAction.skill ? { skills: [...(valueRef.current.skills ?? []).filter((skill) => skill.id !== draftAction.skill!.id), draftAction.skill] } : {}),
      ...(draftAction.replyTo ? { replyTo: draftAction.replyTo } : {}) };
    updateDraft(draftAction.insert ? next : { ...next, selectionStart: next.text.length, selectionEnd: next.text.length });
    inputRef.current?.focus();
    // The action ID is issued only by an explicit transcript action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftAction?.id, disabled]);
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
    const shiftTab = event.key === 'Tab' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
    // An open suggestion list takes the first Shift+Tab to close, like Tab.
    if (shiftTab && plan && completion.open) {
      completion.keyDown(event);
      event.preventDefault();
      return;
    }
    if (completion.keyDown(event)) return;
    if (completion.composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (shiftTab && plan) {
      event.preventDefault();
      // While plan mode cannot change, Shift+Tab goes back to the decision waiting above, as Tab order would.
      if (plan.disabled) { if (!onFocusDecision?.() && plan.blockedReason) setAnnouncement(plan.blockedReason); return; }
      setAnnouncement(plan.on ? copy.planOff : copy.planOn);
      plan.onToggle();
      return;
    }
    if (event.key === 'Escape' && onStop && !stopping) {
      event.preventDefault();
      onStop();
      return;
    }
    const input = event.currentTarget;
    const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
    if (event.key === 'ArrowUp' && recentPrompts.length > 0 && (valueRef.current.text === '' || (recall.current !== undefined && atStart))) {
      event.preventDefault();
      const index = recall.current === undefined ? recentPrompts.length - 1 : Math.max(0, recall.current - 1);
      recall.current = index;
      const text = recentPrompts[index] ?? '';
      updateDraft({ ...valueRef.current, text, selectionStart: 0, selectionEnd: 0 });
      return;
    }
    if (event.key === 'ArrowDown' && recall.current !== undefined && input.selectionStart === valueRef.current.text.length) {
      event.preventDefault();
      const index = recall.current + 1;
      recall.current = index < recentPrompts.length ? index : undefined;
      const text = recall.current === undefined ? '' : recentPrompts[recall.current] ?? '';
      updateDraft({ ...valueRef.current, text, selectionStart: text.length, selectionEnd: text.length });
      return;
    }
    if (variant === 'mobile' || event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    recall.current = undefined;
    void deliver('send');
  };

  const mentionPaths = (paths: readonly string[]): void => {
    if (!paths.length) return;
    const current = valueRef.current;
    const position = current.selectionEnd ?? current.text.length;
    const before = current.text.slice(0, position);
    const insertion = `${before && !/\s$/u.test(before) ? ' ' : ''}${paths.map((path) => `@${path.includes(' ') ? `"${path}"` : path}`).join(' ')} `;
    const text = `${before}${insertion}${current.text.slice(position)}`;
    updateDraft({ ...current, text, selectionStart: position + insertion.length, selectionEnd: position + insertion.length });
    inputRef.current?.focus();
  };

  /** Starts an `@` mention at the caret so the file picker opens. */
  const insertMention = (): void => {
    const current = valueRef.current;
    const position = current.selectionEnd ?? current.text.length;
    const before = current.text.slice(0, position);
    const lead = before && !/\s$/u.test(before) ? ' ' : '';
    const text = `${before}${lead}@${current.text.slice(position)}`;
    const caret = position + lead.length + 1;
    updateDraft({ ...current, text, selectionStart: caret, selectionEnd: caret });
    inputRef.current?.focus();
  };

  const takeFiles = (files: FileList | File[]): void => {
    const list = Array.from(files);
    const images = list.filter((file) => (CHAT_IMAGE_MIME_TYPES as readonly string[]).includes(file.type));
    const others = list.filter((file) => !images.includes(file));
    const mentioned: string[] = [];
    const uploads: File[] = [...images];
    for (const file of others) {
      const path = pathForDrop?.(file);
      if (path) mentioned.push(path); else uploads.push(file);
    }
    mentionPaths(mentioned);
    if (uploads.length) {
      const transfer = new DataTransfer();
      uploads.forEach((file) => transfer.items.add(file));
      void attachFiles(transfer.files);
    }
  };

  const hasDraft = draft.trim().length > 0 || attachments.length > 0;
  const sendBlocked = disabled || sendDisabled || queueBusy || uncertain || readingFiles || !hasDraft || submitting !== null;
  // onStop is offered only while the turn can be stopped, including while it waits for approval.
  const showStop = !hasDraft && onStop !== undefined;

  return (
    <form
      className="structured-agent-composer chat-composer"
      data-variant={variant}
      data-provider={providerId || undefined}
      data-busy={busy || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        void deliver('send');
      }}
      onDragOver={(event) => {
        if (disabled || !Array.from(event.dataTransfer.types).includes('Files')) return;
        event.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        setDragging(false);
        if (!disabled) takeFiles(event.dataTransfer.files);
      }}
    >
      {queuedCount > 0 && <section className="conversation-queue chat-queue" aria-label={ko ? '대기 중인 요청' : 'Queued requests'}>
        <p className="chat-queue__title"><Glyph name="clock" />{ko ? '다음에 보낼 요청' : 'Up next'} <span>{queuedCount}</span></p>
        {queueItems.length === 0 && <p className="chat-queue__loading">{ko ? '요청 내용을 불러오는 중…' : 'Loading accepted requests…'}</p>}
        <ol>{queueItems.map(item => <li key={item.turnId} className="chat-queue__item">
          <p>{item.text}</p>
          {!!item.context?.attachments?.length && <small>{ko ? '첨부' : 'Attachments'} {item.context.attachments.length}</small>}
          {onQueueAction && <div className="conversation-queue__actions">{(['run-next', 'take', 'remove'] as const).map(action => <Button key={action} type="button" variant="ghost" size="sm"
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
            }}>{action === 'take' ? (ko ? '편집' : 'Edit') : action === 'remove' ? (ko ? '삭제' : 'Remove') : (ko ? '중단하고 지금 보내기' : 'Interrupt and run now')}</Button>)}</div>}
        </li>)}</ol>
      </section>}
      {value.parkedDraft && <div className="structured-agent-composer__parked" role="status">
        <span>{ko ? '기존 초안을 보관했습니다. 이 요청을 보내면 복원합니다.' : 'Previous draft saved. It will return after you send this request.'}</span>
        <Button type="button" variant="ghost" size="sm" disabled={queueBusy || submitting !== null || uncertain} onClick={() => {
          const { parkedDraft, ...current } = valueRef.current;
          if (parkedDraft) updateDraft({ ...parkedDraft, parkedDraft: current });
        }}>{ko ? '초안 전환' : 'Switch draft'}</Button>
      </div>}
      {completion.menu}
      <div className="chat-composer__box" data-dragging={dragging || undefined} data-disabled={disabled || undefined}>
        {value.replyTo && <div className="structured-agent-composer__reply">
          <Glyph name="undo" /><blockquote>{value.replyTo.text}</blockquote>
          <Button variant="ghost" size="sm" disabled={disabled} aria-label={copy.removeReply}
            onClick={() => updateDraft({ ...valueRef.current, replyTo: undefined })}><Glyph name="x" /></Button>
        </div>}
        {attachments.length > 0 && <ul className="structured-agent-composer__attachments">
          {attachments.map((attachment) => <li key={attachment.id} data-kind={attachment.kind} data-attachment-id={attachment.id}>
            {attachment.kind === 'image'
              ? <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt={attachment.name} />
              : <Glyph name="clip" />}
            <span>{attachment.name}</span>
            <Button variant="ghost" size="sm" disabled={disabled} aria-label={`${copy.removeAttachment}: ${attachment.name}`}
              onClick={() => updateDraft({ ...valueRef.current, attachments: (valueRef.current.attachments ?? []).filter((entry) => entry.id !== attachment.id) })}><Glyph name="x" /></Button>
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
            className="structured-agent-textarea structured-agent-textarea--composer chat-composer__input"
            rows={1}
            maxLength={65_536}
            value={draft}
            placeholder={busy
              ? (ko ? '다음에 보낼 메시지를 입력하세요 (Esc로 중단)' : 'Queue a follow-up (Esc to stop)')
              : fileSearch
                ? (ko ? '무엇이든 요청하세요 · @ 파일 참조 · / 명령' : 'Ask anything · @ to mention files · / for commands')
                : copy.messagePlaceholder}
            disabled={disabled}
            aria-describedby={disabledReason ? disabledReasonId : undefined}
            onKeyDown={keyDown}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (!files.length || disabled) return;
              event.preventDefault();
              takeFiles(files);
            }}
            onChange={(event) => {
              recall.current = undefined;
              updateDraft({ ...valueRef.current, text: event.currentTarget.value, selectionStart: event.currentTarget.selectionStart, selectionEnd: event.currentTarget.selectionEnd });
              setError(null);
            }}
            onSelect={(event) => {
              const input = event.currentTarget;
              // A selection read while the box still shows text the draft already replaced (a command such as
              // /btw just cleared it) belongs to the old text: saving it would put the caret outside the draft.
              if (input.value !== valueRef.current.text) return;
              if (valueRef.current.selectionStart !== input.selectionStart || valueRef.current.selectionEnd !== input.selectionEnd) {
                updateDraft({ ...valueRef.current, selectionStart: input.selectionStart, selectionEnd: input.selectionEnd });
              }
            }}
            data-testid="structured-agent-composer-input"
          />
        </Field>
        </div>
        <div className="chat-composer__bar">
          <input ref={fileInputRef} type="file" multiple accept={CHAT_ATTACHMENT_ACCEPT}
            hidden onChange={(event) => void attachFiles(event.currentTarget.files)} />
          <Menu
            label={ko ? '추가' : 'Add'}
            placement="top-start"
            trigger={<button type="button" className="chat-composer__plus" disabled={disabled} aria-label={ko ? '추가' : 'Add'} title={ko ? '추가' : 'Add'}><Glyph name="plus" /></button>}
          >
            <MenuItem icon={glyphIcon('clip')} disabled={!supportsMessageContext || readingFiles} onSelect={() => fileInputRef.current?.click()}>
              {supportsMessageContext ? copy.attach : copy.attachmentUnsupported}
            </MenuItem>
            {fileSearch && <MenuItem icon={glyphIcon('file')} onSelect={insertMention}>
              {ko ? '파일 참조' : 'Mention a file'}
            </MenuItem>}
            <MenuItem icon={glyphIcon('spark')} onSelect={() => completion.openManual('skills')}>{ko ? '스킬' : 'Skills'}</MenuItem>
            <MenuItem icon={glyphIcon('term')} onSelect={() => completion.openManual('commands')}>{ko ? '명령' : 'Commands'}</MenuItem>
          </Menu>
          {toolbar && <div className="conversation-composer-toolbar chat-composer__settings">{toolbar}</div>}
          <span className="chat-composer__spacer" />
          {sideQuestion && (
            <button
              ref={sideQuestion.buttonRef}
              type="button"
              className="chat-icon-action chat-composer__btw"
              aria-label={sideQuestion.label}
              title={sideQuestion.label}
              aria-expanded={sideQuestion.open}
              aria-controls={sideQuestion.open ? sideQuestion.controlsId : undefined}
              onClick={() => {
                // Plain text becomes the side question; a message with attachments or a reply stays put.
                const text = valueRef.current.text.trim();
                const plain = !(valueRef.current.attachments?.length) && !valueRef.current.replyTo && !text.startsWith('/');
                if (text && plain) {
                  if (sideQuestion.onAsk(text)) updateDraft(valueRef.current.parkedDraft ?? { text: '', selectionStart: 0, selectionEnd: 0 });
                } else sideQuestion.onOpen();
              }}
              data-testid="structured-agent-btw"
            >
              <Glyph name="chat" />
            </button>
          )}
          {busy && onInterruptAndSend && hasDraft && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={sendBlocked}
              loading={submitting === 'interrupt'}
              loadingLabel={copy.sending}
              onClick={() => void deliver('interrupt')}
              data-testid="structured-agent-interrupt-send"
            >
              {copy.interruptSend}
            </Button>
          )}
          {/* With a draft the round button sends; stopping stays one click away. */}
          {!showStop && onStop !== undefined && (
            <button
              type="button"
              className="chat-icon-action chat-composer__stop"
              disabled={disabled || stopping}
              aria-label={ko ? '중단' : 'Stop'}
              title={ko ? '중단 (Esc)' : 'Stop (Esc)'}
              onClick={() => onStop()}
              data-testid="structured-agent-stop"
            >
              {stopping ? <Glyph name="spin" className="chat-spin" /> : <Glyph name="stop" />}
            </button>
          )}
          {showStop ? (
            <button
              type="button"
              className="chat-composer__send"
              data-kind="stop"
              disabled={disabled || stopping}
              aria-label={ko ? '중단' : 'Stop'}
              title={ko ? '중단 (Esc)' : 'Stop (Esc)'}
              onClick={() => onStop?.()}
              data-testid="structured-agent-stop"
            >
              {stopping ? <Glyph name="spin" className="chat-spin" /> : <Glyph name="stop" />}
            </button>
          ) : (
            <button
              type="submit"
              className="chat-composer__send"
              data-kind={busy ? 'queue' : 'send'}
              disabled={sendBlocked}
              aria-label={busy ? copy.queue : copy.send}
              title={busy ? copy.queue : copy.send}
              data-testid="structured-agent-send"
            >
              {submitting === 'send' ? <Glyph name="spin" className="chat-spin" /> : <Glyph name="send" />}
              <span className="ez-ui-visually-hidden">{busy ? copy.queue : copy.send}</span>
            </button>
          )}
        </div>
        {dragging && <div className="chat-composer__drop" aria-hidden="true">{ko ? '놓아서 첨부하기 — 파일은 경로로, 이미지는 첨부로 추가됩니다' : 'Drop to attach — files are added as paths, images as attachments'}</div>}
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
      {!disabledReason && !sendDisabledReason && (statusHint ?? (variant !== 'mobile' && !busy && !draft ? `${copy.desktopSendHint}${plan ? ` · ${copy.planShortcutHint}` : ''}` : undefined)) && (
        <p className="structured-agent-composer__hint" data-testid="structured-agent-composer-hint">
          {statusHint ?? `${copy.desktopSendHint}${plan ? ` · ${copy.planShortcutHint}` : ''}`}
        </p>
      )}
      {queuedCount > 0 && <span className="ez-ui-visually-hidden" aria-live="polite">{formatTemplate(copy.queued, { count: queuedCount })}</span>}
      {plan && <span className="ez-ui-visually-hidden" aria-live="polite" data-testid="structured-agent-plan-announcement">{announcement}</span>}
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
  /** More actions for the conversation menu, after "Previous conversations". */
  readonly menuItems?: readonly { readonly label: string; readonly icon?: GlyphIcon; readonly disabled?: boolean; readonly onSelect: () => void }[];
  readonly statusLabel?: string;
  readonly onOpenHistory?: () => void;
  readonly capabilityClient?: AgentCapabilitiesClient;
  readonly workflowContext?: ReactNode;
  readonly viewStateKey?: string;
  readonly sessionId: string;
  readonly title: string;
  readonly providerId: string;
  readonly providerLabel: string;
  /** The AI's last reported plan limits and this conversation's context. */
  readonly usage?: AgentUsage;
  readonly workspace: StructuredAgentWorkspaceOption;
  /**
   * The working folder and the project's other folders this conversation also works in. Given,
   * they show as a composer setting on desktop instead of the folder line in the header.
   */
  readonly folders?: ConversationFolders;
  /** Before the conversation starts: the working folder is chosen from the folder setting. */
  readonly workspaceChoices?: {
    readonly options: readonly StructuredAgentWorkspaceOption[];
    readonly onSelect: (workspaceId: string) => void;
    readonly onNewWorktree?: () => void;
    readonly disabled?: boolean;
  };
  /** Opens the project editor, where its folders are added, removed or made the main one. */
  readonly onEditProject?: () => void;
  /** Before the conversation starts: the AI is chosen at the top of the model setting. */
  readonly providerChoices?: {
    readonly options: readonly { readonly id: string; readonly label: string; readonly disabled?: boolean; readonly description?: string }[];
    readonly onSelect: (providerId: string) => void;
  };
  readonly model?: string;
  readonly modelOptions?: readonly StructuredAgentModelOption[];
  readonly permissionPreset: PermissionPreset;
  readonly state: ManagedAgentState;
  readonly awaitingFirstMessage?: boolean;
  readonly queuedCount?: number;
  readonly items: readonly DaemonTranscriptItem[];
  readonly approvals?: readonly DaemonApproval[];
  /** Turn records for live "Working for…" status and settling tools of finished turns. */
  readonly turns?: readonly DaemonTurn[];
  /** Host accepts answers, plan mode and deny feedback (`approval-response-v1`). */
  readonly approvalResponses?: boolean;
  /** Host can allow a command or edit for the rest of the conversation (`approval-session-v1`). */
  readonly approvalSession?: boolean;
  /** Host asks about a plan Codex proposed itself (`plan-proposal-v1`); no dock of our own then. */
  readonly planProposals?: boolean;
  /** Opens an http(s) link from chat in the system browser. */
  readonly onOpenLink?: (url: string) => void;
  readonly hasEarlier?: boolean;
  readonly loadingEarlier?: boolean;
  readonly onLoadEarlier?: () => void;
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
  /** EZTerminal settings this conversation's AI changed (with undo) and proposed (a person applies them), above the input. */
  readonly settingsTrack?: ReactNode;
  /** A subagent's parent conversation: the header leads back to it. */
  readonly parent?: { readonly sessionId: string; readonly title: string };
  /** Provider's agent kind for a provider-native subagent, e.g. Claude `Explore`. */
  readonly subagentType?: string;
  /** The parent holds an approval this subagent raised. */
  readonly parentApprovalPending?: boolean;
  /** Opens a new conversation (`/new`). */
  readonly onNewConversation?: () => void;
  /**
   * Replaces this conversation in place with a new one with the same settings (`/clear`). Text typed
   * after `/clear` starts the new conversation's message box; it is not sent.
   */
  readonly onClearConversation?: (draftText?: string) => void;
  /**
   * /btw for a live conversation: the host's client, and whether its provider session is attached
   * now (snapshot `sideQuestionSessionIds`). Absent in drafts, history and views without a host.
   */
  readonly sideQuestion?: { readonly client: AgentSideQuestionClient; readonly available: boolean };
  /** Hand this conversation's work, or a review of it, to a new child agent. */
  readonly onDelegate?: (mode: 'handoff' | 'review') => void;
  readonly heartbeatControl?: ReactNode;
  /** A heartbeat is scheduled; the header shows it while its settings stay in a dialog. */
  readonly heartbeatActive?: boolean;
  readonly recoveryControl?: ReactNode;
  readonly onRetryTranscript?: () => void;
  readonly onSend: (prompt: string, context?: ChatMessageContext) => Promise<StructuredAgentUiResult>;
  readonly onInterruptAndSend?: (prompt: string, context?: ChatMessageContext) => Promise<StructuredAgentUiResult>;
  /** Receives only the settings that changed. */
  readonly onChangeSettings?: (settings: {
    readonly model?: string;
    readonly permissionPreset?: PermissionPreset;
    readonly reasoningEffort?: string;
  }) => Promise<StructuredAgentUiResult>;
  /** Current reasoning effort; the effort pill appears only when the host accepts it. */
  readonly reasoningEffort?: string;
  readonly effortSupported?: boolean;
  /** Settings chosen while a turn runs: what the turn uses now and what the next request will use (one line above the pills). */
  readonly pendingSettings?: { readonly current: string; readonly next: string; readonly onCancel?: () => void };
  /** The effort menu's 이번 요청만 / 이후 계속 choice. */
  readonly effortScope?: { readonly value: 'once' | 'keep'; readonly onChange: (scope: 'once' | 'keep') => void };
  /** Which agent an approved plan runs with (단계 연결), shown in the plan approval dock. */
  readonly planPhaseNote?: string;
  /** The host queues model, permission and plan changes made during a turn for the next request (pills stay open). */
  readonly queueSettings?: boolean;
  /**
   * From the host: what the running request uses while the pills show the next request's settings. Builds
   * the pending line (and its scope choice) unless `pendingSettings` gives it ready-made.
   */
  readonly queuedSettings?: QueuedSettingsProp;
  readonly fileSearch?: ComposerFileSearch;
  readonly pathForDrop?: (file: File) => string | null;
  readonly onResolveApproval?: (
    approvalId: string,
    decision: 'allow' | 'deny',
    response?: ApprovalResponse,
  ) => Promise<StructuredAgentUiResult>;
  readonly onOpenRelatedSession?: (sessionId: string) => void;
  readonly onCancel?: () => Promise<StructuredAgentUiResult>;
  readonly onArchive?: () => Promise<StructuredAgentUiResult>;
  readonly onDetach?: () => Promise<StructuredAgentUiResult>;
  readonly variant?: 'desktop' | 'mobile';
  /**
   * `composer`: only the message box with its settings and banners, for typing into this
   * conversation from elsewhere (a terminal's AI input). The conversation tab stays `full`.
   */
  readonly presentation?: 'full' | 'composer';
  /**
   * Android chat (I4): one header row — leading control · title · state · results · extensions · ⋯ —
   * like the desktop row, instead of the inline control block. Ignored on desktop.
   */
  readonly compactHeader?: boolean;
  /** Leading header control, e.g. the Android page's back button in the compact row. */
  readonly headerLeading?: ReactNode;
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

/** Conversations with a send in progress from any box in this renderer. */
const sendingSessions = new Set<string>();

export function StructuredAgentSessionPanel({
  onOpenProjectFiles,
  queueItems,
  onQueueAction,
  capabilitySessionId,
  beforeMessages,
  headerActions,
  menuItems = [],
  statusLabel,
  capabilityClient,
  onOpenHistory,
  workflowContext,
  sessionId,
  viewStateKey,
  title,
  providerId,
  providerLabel,
  usage,
  workspace,
  folders,
  workspaceChoices,
  onEditProject,
  providerChoices,
  model,
  modelOptions = [],
  permissionPreset,
  state,
  queuedCount = 0,
  awaitingFirstMessage = false,
  items,
  approvals = [],
  turns,
  approvalResponses = false,
  approvalSession = false,
  planProposals = false,
  onOpenLink,
  hasEarlier = false,
  loadingEarlier = false,
  onLoadEarlier,
  reasoningEffort,
  effortSupported = false,
  pendingSettings: givenPendingSettings,
  queuedSettings,
  planPhaseNote,
  effortScope: givenEffortScope,
  queueSettings = false,
  fileSearch,
  pathForDrop,
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
  settingsTrack,
  parent,
  subagentType,
  parentApprovalPending = false,
  onDelegate,
  onNewConversation,
  onClearConversation,
  sideQuestion,
  heartbeatControl,
  heartbeatActive = false,
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
  presentation = 'full',
  compactHeader = false,
  headerLeading,
}: StructuredAgentSessionPanelProps): JSX.Element {
  const copy = useStructuredAgentCopy();
  const full = presentation === 'full';
  const compactRow = variant === 'mobile' && compactHeader;
  // The header's changed-files button opens the review; its sheet gives focus back to it.
  const reviewButtonRef = useRef<HTMLButtonElement>(null);
  const paneActions = usePaneActions();
  // This header carries the tab's actions, so a group of one may hide its tab strip while it is shown.
  // A message box shown elsewhere (in a terminal tab) has no header and never hides that tab's strip.
  const paneHeaderId = full ? paneActions?.panelId : undefined;
  useEffect(() => {
    if (!paneHeaderId) return undefined;
    announceConversationHeader(paneHeaderId, true);
    return () => announceConversationHeader(paneHeaderId, false);
  }, [paneHeaderId]);
  const { i18n } = useAppTranslation();
  const chatLocale = useChatLocale();
  const permissionText = agentPermissionCopy(chatLocale);
  const stateLabel = useAgentStateLabel();
  const [capabilityCatalog, setCapabilityCatalog] = useState<AgentCapabilityCatalog>();
  const [capabilityDiscovery, setCapabilityDiscovery] = useState<CapabilityDiscoveryState>({ loading: !!capabilityClient });
  const [selectedCapabilities, setSelectedCapabilities] = useState<readonly AgentCapabilityItem[]>([]);
  useEffect(() => { setCapabilityCatalog(undefined); setSelectedCapabilities([]); }, [sessionId, providerId, workspace.id]);
  // Without the header's extensions panel, the message box still reads the catalog for its models and `/` skills.
  const discoverHere = !full && !historyOnly && owner !== 'provider-native' && capabilityClient !== undefined
    && (providerId === 'codex' || providerId === 'claude');
  const discoverySessionId = capabilitySessionId === null ? undefined : capabilitySessionId ?? sessionId;
  useEffect(() => {
    if (!discoverHere || !capabilityClient) return undefined;
    let alive = true;
    setCapabilityDiscovery({ loading: true });
    void discoverCapabilities(capabilityClient, { providerId, workspaceId: workspace.id, ...(discoverySessionId ? { sessionId: discoverySessionId } : {}) })
      .then((result) => {
        if (!alive) return;
        if (result.ok) { setCapabilityCatalog(result.value); setCapabilityDiscovery({ loading: false }); }
        else setCapabilityDiscovery({ loading: false, error: result.message });
      })
      .catch(() => { if (alive) setCapabilityDiscovery({ loading: false, error: 'Extensions could not be read.' }); });
    return () => { alive = false; };
  }, [capabilityClient, discoverHere, discoverySessionId, providerId, workspace.id]);
  const listedModels = capabilityCatalog?.providerId === providerId && capabilityCatalog.workspaceId === workspace.id && capabilityCatalog.models.length
    ? capabilityCatalog.models.map((entry) => ({ id: entry.id, label: entry.displayName, resolvedModel: entry.resolvedModel, isDefault: entry.isDefault })) : modelOptions;
  const availableModels = withCurrentModel(listedModels, model);
  // The models arrive with the provider's catalog; until then only the current model is known.
  const modelsLoading = capabilityDiscovery.loading && listedModels.length === 0;
  const providerName = providerId === 'codex' ? 'Codex' : providerId === 'claude' ? 'Claude' : providerLabel;
  const sendWithCapabilities = async (prompt: string, context: ChatMessageContext | undefined, send: typeof onSend): Promise<StructuredAgentUiResult> => {
    // One send per conversation at a time across every box showing it (its tab, a terminal):
    // taken before the skill check awaits, so a second box cannot send the same draft meanwhile.
    if (sendingSessions.has(sessionId)) return { ok: false, message: 'This message is already being sent. Wait for it before sending again.' };
    sendingSessions.add(sessionId);
    try {
      return await checkedSend(prompt, context, send);
    } finally {
      sendingSessions.delete(sessionId);
    }
  };
  const checkedSend = async (prompt: string, context: ChatMessageContext | undefined, send: typeof onSend): Promise<StructuredAgentUiResult> => {
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
  // Android keeps the folder line in its header: the phone does not list a conversation's folders yet.
  const folderPill = variant !== 'mobile' && folders ? (
    <FolderPill workspace={workspace} folders={folders}
      {...(workspaceChoices ? { choices: workspaceChoices } : {})} {...(onEditProject ? { onEditProject } : {})} />
  ) : null;
  const panelRef = useRef<HTMLElement>(null);
  const [wideReview, setWideReview] = useState(false);
  const [reviewAside, setReviewAside] = useState(false);
  const [reviewRequest, setReviewRequest] = useState(0);
  const [heartbeatOpen, setHeartbeatOpen] = useState(false);
  // Files, not change records: two edits of one file count once, as in the turn's change card.
  const changeCount = useMemo(() => new Set(conversationFileChanges(items, sessionId).map((change) => change.path.toLowerCase())).size, [items, sessionId]);
  // Desktop with a Results tab: changes are reviewed there, not beside or over this panel.
  const resultsOwner = useContext(AgentResultsOwnerContext);
  const results = variant === 'mobile' ? null : resultsOwner;
  const resultsCopy = useResultsCopy();
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
    const viewport = panelRef.current?.querySelector<HTMLElement>('.chat-viewport__scroll');
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
    const viewport = panelRef.current?.querySelector<HTMLElement>('.chat-viewport__scroll');
    const input = panelRef.current?.querySelector<HTMLTextAreaElement>('[data-testid="structured-agent-composer-input"]');
    if (viewport && saved.anchor) restoreTranscriptAnchor(viewport, saved.anchor);
    if (input && saved.selection) { input.setSelectionRange(...saved.selection); if (saved.focused) input.focus({ preventScroll: true }); }
    skinTransition.current = null;
  }, [activeSkin]);
  const [selectedModel, setSelectedModel] = useState(model ?? '');
  const [selectedPermission, setSelectedPermission] = useState(permissionPreset);
  const [selectedEffort, setSelectedEffort] = useState(reasoningEffort ?? '');
  useEffect(() => setSelectedEffort(reasoningEffort ?? ''), [reasoningEffort]);
  const recentPrompts = useMemo(() => {
    const prompts: string[] = [];
    for (const item of items) {
      if (item.kind !== 'user-message' || item.isDelta) continue;
      const text = item.text.trim();
      if (text && prompts.at(-1) !== text) prompts.push(text);
    }
    return prompts.slice(-50);
  }, [items]);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<{ readonly title: string; readonly detail: string } | null>(null);
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
  // While plan mode is on the stored preset is `plan`; the level the plan runs with is remembered here.
  const [planAccess, setPlanAccess] = useState<AccessLevel>(() => (isAccessLevel(permissionPreset) ? permissionPreset : readPlanAccess(sessionId)));
  useEffect(() => setPlanAccess(isAccessLevel(permissionPreset) ? permissionPreset : readPlanAccess(sessionId)), [permissionPreset, sessionId]);
  const planOn = selectedPermission === 'plan';
  const accessLevel: AccessLevel = isAccessLevel(selectedPermission) ? selectedPermission : planAccess;
  const turnCurrent = CANCELLABLE_AGENT_STATES.has(state);
  const settingsLocked = disabled || settingsBusy || lifecycleBusy !== null;
  // A host that queues changes for the next request keeps the pills open during a turn.
  const lockedByTurn = turnCurrent && !queueSettings;
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

  /** Sends only what changed: the host takes an effort-only change during a turn, but nothing else. */
  const updateSettings = async (next: { readonly model?: string; readonly permissionPreset?: PermissionPreset; readonly reasoningEffort?: string }): Promise<StructuredAgentUiResult> => {
    const changes = {
      ...(next.model && next.model !== selectedModel ? { model: next.model } : {}),
      ...(next.permissionPreset && next.permissionPreset !== selectedPermission ? { permissionPreset: next.permissionPreset } : {}),
      ...(next.reasoningEffort && next.reasoningEffort !== selectedEffort ? { reasoningEffort: next.reasoningEffort } : {}),
    };
    if (Object.keys(changes).length === 0) return { ok: true };
    const previousModel = selectedModel;
    const previousPermission = selectedPermission;
    const previousEffort = selectedEffort;
    if (changes.model !== undefined) setSelectedModel(changes.model);
    if (changes.permissionPreset !== undefined) setSelectedPermission(changes.permissionPreset);
    if (changes.reasoningEffort !== undefined) setSelectedEffort(changes.reasoningEffort);
    setSettingsError(null);
    if (!onChangeSettings) return { ok: true };
    setSettingsBusy(true);
    const result = await onChangeSettings(changes).catch((): StructuredAgentUiResult => ({
      ok: false,
      message: '',
    }));
    setSettingsBusy(false);
    if (!result.ok) {
      setSelectedModel(previousModel);
      setSelectedPermission(previousPermission);
      setSelectedEffort(previousEffort);
      setSettingsError({ title: copy.settingsFailed, detail: result.message });
    }
    return result;
  };
  const togglePlan = (): void => {
    if (planOn) { void updateSettings({ permissionPreset: planAccess }); return; }
    writePlanAccess(sessionId, accessLevel);
    setPlanAccess(accessLevel);
    void updateSettings({ permissionPreset: 'plan' });
  };
  /** In plan mode the level only matters once the plan is approved, so it changes here without a host round trip. */
  const changeAccess = (level: AccessLevel): void => {
    // The person's own choice: new conversations start with it.
    writeLastAccess(level);
    if (!planOn) { void updateSettings({ permissionPreset: level }); return; }
    writePlanAccess(sessionId, level);
    setPlanAccess(level);
  };
  const planAccessChoice: PlanAccessChoice = { level: planAccess, onChange: changeAccess, ...(planPhaseNote ? { phaseNote: planPhaseNote } : {}) };
  const approveProposedPlan = async (): Promise<StructuredAgentUiResult> => {
    const changed = await updateSettings({ permissionPreset: planAccess });
    if (!changed.ok) return changed;
    const prompt = chatCopy(chatLocale).approval.implementPlanPrompt;
    const sent = await onSend(prompt).catch((): StructuredAgentUiResult => ({ ok: false, message: 'The message could not be sent.' }));
    if (!sent.ok) {
      // Plan mode is already off; keep the request where the person can send it again.
      setDraftAction({ id: ++actionSequence.current, sessionId, text: prompt });
      setSettingsError({ title: copy.implementPlanFailed, detail: sent.message });
    }
    return sent;
  };
  const planBlockedReason = lockedByTurn && !settingsLocked ? copy.settingsAfterTurn : undefined;
  // /btw: a side question about this conversation, answered without tools and kept in memory only.
  const sideThread = useSideQuestionThread(sessionId, sideQuestion?.client);
  const [sideOpen, setSideOpen] = useState(false);
  const sideButtonRef = useRef<HTMLButtonElement>(null);
  const sideWindowId = useId();
  const btwReason = !sideQuestion || historyOnly || providerOwned ? copy.btwUnavailable
    : !SIDE_QUESTION_PROVIDER_IDS.includes(providerId) ? copy.btwProviderOnly
      : !sideQuestion.available ? copy.btwAfterSend : undefined;
  const openSide = (): void => setSideOpen(true);
  /** False when the thread refuses it (one already pending, or too long): the caller keeps the text. */
  const askSide = (text: string): boolean => { const accepted = sideThread.ask(text); setSideOpen(true); return accepted; };
  const appCommands: readonly AppCommand[] = [
    ...(!settingsReadOnly ? [{
      name: 'plan', description: planOn ? copy.planCommandOff : copy.planCommandOn,
      ...(settingsLocked || turnCurrent ? { disabledReason: copy.settingsAfterTurn } : {}), run: togglePlan,
    }, {
      name: 'model', description: copy.modelCommand,
      ...(settingsLocked || turnCurrent ? { disabledReason: copy.settingsAfterTurn } : {}),
      // After the suggestion list closes, so the menu keeps focus.
      run: () => requestAnimationFrame(() => panelRef.current?.querySelector<HTMLButtonElement>('[data-testid="structured-agent-live-model"]')?.click()),
    }] : []),
    ...(onNewConversation ? [{ name: 'new', description: copy.newCommand, run: onNewConversation }] : []),
    // Always reserved, with or without text after it: sent on, Claude would move to a session this
    // conversation does not follow.
    { name: 'clear', description: copy.clearCommand, takesText: true, run: (text?: string) => onClearConversation?.(text),
      ...(!onClearConversation ? { disabledReason: copy.clearUnavailable }
        : settingsLocked || turnCurrent ? { disabledReason: copy.clearAfterTurn } : {}) },
    // Always reserved: `/btw …` is never a prompt. Chosen from the list (no text) it opens the window.
    { name: 'btw', description: copy.btwCommand, takesText: true, run: (text?: string) => (text?.trim() ? askSide(text) : (openSide(), true)),
      ...(btwReason ? { disabledReason: btwReason } : {}) },
  ];
  // The Results tab puts review comments into this draft (never sends) and can point at the decision above.
  const canInsertDraft = !historyOnly && !composerDisabled;
  const resultsActions = useRef<{ insert: (text: string) => void; focus: () => boolean }>({ insert: () => undefined, focus: () => false });
  resultsActions.current = {
    insert: (text: string) => setDraftAction({ id: ++actionSequence.current, sessionId, insert: text }),
    focus: () => focusDecision(),
  };
  useEffect(() => {
    if (!results) return undefined;
    publishResultsSession(results.ownerPanelId, {
      ...(canInsertDraft ? { insertIntoDraft: (text: string) => resultsActions.current.insert(text) } : { draftUnavailable: historyOnly ? 'history' : 'disabled' }),
      focusDecision: () => { resultsActions.current.focus(); },
    });
    return undefined;
  }, [canInsertDraft, historyOnly, results]);
  useEffect(() => (results ? () => publishResultsSession(results.ownerPanelId, undefined) : undefined), [results]);
  /** Shift+Tab from the message box: the decision waiting above takes focus (its main action, or the folded strip). */
  const focusDecision = (): boolean => {
    const target = panelRef.current?.querySelector<HTMLElement>(
      '.chat-dock:not(.chat-dock--collapsed) [data-dock-primary]:not(:disabled), .chat-dock:not(.chat-dock--collapsed) .chat-dock__option, .chat-dock--collapsed button',
    );
    target?.focus();
    return Boolean(target);
  };
  /**
   * Stop the turn the way Claude Code and Codex do: queued messages are handed
   * back to the message box (taken off the queue first) instead of being dropped.
   */
  const stopTurn = async (): Promise<void> => {
    if (!onCancel || lifecycleBusy !== null) return;
    const taken: string[] = [];
    if (onQueueAction) {
      for (const item of queueItems ?? []) {
        const result = await onQueueAction(item, 'take').catch((): StructuredAgentUiResult => ({ ok: false, message: '' }));
        if (result.ok && item.text.trim()) taken.push(item.text.trim());
      }
    }
    await runLifecycle('cancel', onCancel);
    if (taken.length) setDraftAction({ id: ++actionSequence.current, sessionId, append: taken.join('\n\n') });
  };
  /** Esc anywhere in the conversation stops the turn, unless a field, menu or dialog takes it first. */
  const stopOnEscape = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape' || event.defaultPrevented || !canCancel || lifecycleBusy !== null || disabled) return;
    if ((event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"], .chat-dock')) return;
    event.preventDefault();
    void stopTurn();
  };
  /**
   * Codex takes only allow or deny, so "deny with feedback" denies, then interrupts
   * and sends the feedback as the next message, the way Codex's own prompt does.
   */
  const resolveApprovalFor = onResolveApproval && providerId === 'codex'
    ? async (approvalId: string, decision: 'allow' | 'deny', response?: ApprovalResponse): Promise<StructuredAgentUiResult> => {
      if (decision !== 'deny' || response?.kind !== 'feedback') return response ? onResolveApproval(approvalId, decision, response) : onResolveApproval(approvalId, decision);
      const denied = await onResolveApproval(approvalId, 'deny');
      if (!denied.ok) return denied;
      return (onInterruptAndSend ?? onSend)(response.message);
    }
    : onResolveApproval;
  const effortOptions = structuredAgentEffortOptions(providerId);
  const effortLabel = (value: string): string => ({
    minimal: i18n.language.startsWith('ko') ? '최소' : 'Minimal',
    low: i18n.language.startsWith('ko') ? '낮음' : 'Low',
    medium: i18n.language.startsWith('ko') ? '보통' : 'Medium',
    high: i18n.language.startsWith('ko') ? '높음' : 'High',
    xhigh: i18n.language.startsWith('ko') ? '매우 높음' : 'Extra high',
    max: i18n.language.startsWith('ko') ? '최대' : 'Max',
  } as Record<string, string>)[value] ?? value;
  // "지금 차례 → 다음 요청": model and effort always, the permission when it changes.
  const settingsText = (values: ConversationSettingsValues, withAccess: boolean): string => [
    values.model ? availableModels.find((option) => option.id === values.model)?.label ?? values.model : copy.providerDefault,
    ...(values.reasoningEffort ? [effortLabel(values.reasoningEffort)] : []),
    ...(withAccess ? [values.permissionPreset === 'plan' ? permissionText.plan : permissionText.levels[values.permissionPreset].label] : []),
  ].join(' · ');
  const nextValues: ConversationSettingsValues = {
    ...(selectedModel ? { model: selectedModel } : {}),
    permissionPreset: selectedPermission,
    ...(selectedEffort ? { reasoningEffort: selectedEffort } : {}),
  };
  const queuedAccessChanged = queuedSettings !== undefined && queuedSettings.current.permissionPreset !== nextValues.permissionPreset;
  const queuedDiffers = queuedSettings !== undefined && (
    queuedAccessChanged
    || (queuedSettings.current.model ?? '') !== (nextValues.model ?? '')
    || (queuedSettings.current.reasoningEffort ?? '') !== (nextValues.reasoningEffort ?? ''));
  const pendingSettings = givenPendingSettings ?? (queuedSettings && queuedDiffers ? {
    current: settingsText(queuedSettings.current, queuedAccessChanged),
    next: settingsText(nextValues, queuedAccessChanged),
    ...(queuedSettings.onCancel ? { onCancel: queuedSettings.onCancel } : {}),
  } : undefined);
  const effortScope = givenEffortScope ?? (queuedSettings?.scope && queuedSettings.onScope && pendingSettings
    ? { value: queuedSettings.scope, onChange: queuedSettings.onScope }
    : undefined);

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

  // The model and effort pills join into one chip. On a phone's narrow composer they wrap as one piece:
  // as two flex items the row could break between them and split the chip.
  const pairModelAndEffort = (model: JSX.Element, effort: JSX.Element | false): JSX.Element => (
    variant === 'mobile' && effort ? <span className="chat-pill-pair">{model}{effort}</span> : <>{model}{effort}</>
  );

  const settingsControls = (
<div className="structured-agent-session-settings" role="group" aria-label={copy.settings}>
            {pendingSettings && !settingsReadOnly && <p className="chat-pending-settings" role="status" data-testid="structured-agent-pending-settings">
              <Glyph name="clock" />
              <span className="chat-pending-settings__now">{turnCurrent ? (i18n.language.startsWith('ko') ? '지금 차례' : 'This turn') : (i18n.language.startsWith('ko') ? '지금' : 'Now')} <strong>{pendingSettings.current}</strong></span>
              <span className="chat-pending-settings__arrow" aria-hidden="true"><Glyph name="next" /></span>
              <span className="chat-pending-settings__next">{i18n.language.startsWith('ko') ? '다음 요청' : 'Next request'} <strong>{pendingSettings.next}</strong></span>
              {effortScope && <span className="chat-pending-settings__scope" role="radiogroup" aria-label={i18n.language.startsWith('ko') ? '적용 범위' : 'Applies to'}>
                {(['once', 'keep'] as const).map((value) => <label key={value} data-checked={effortScope.value === value || undefined}>
                  <input type="radio" name={`${sessionId}-effort-scope`} value={value} checked={effortScope.value === value} onChange={() => effortScope.onChange(value)} />
                  {value === 'once' ? (i18n.language.startsWith('ko') ? '다음 요청 1회만' : 'Next request only') : (i18n.language.startsWith('ko') ? '이후 계속' : 'From now on')}
                </label>)}
              </span>}
              {pendingSettings.onCancel && <button type="button" className="chat-pending-settings__cancel" onClick={pendingSettings.onCancel}>{i18n.language.startsWith('ko') ? '예약 취소' : 'Cancel change'}</button>}
            </p>}
            {settingsReadOnly ? (
              <>
                <span className="structured-agent-session-setting" data-testid="structured-agent-live-model-value">
                  <small>{copy.modelOf(providerName)}</small>
                  <strong>{availableModels.find((option) => option.id === selectedModel)?.label ?? (selectedModel || copy.providerDefault)}</strong>
                </span>
                <span className="structured-agent-session-setting" data-testid="structured-agent-live-permission-value">
                  <small>{copy.permission}</small>
                  <strong>{planOn ? `${permissionText.plan} · ` : ''}{permissionText.levels[accessLevel].label}</strong>
                </span>
                {folderPill}
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="chat-pill chat-pill--plan"
                  aria-pressed={planOn}
                  aria-keyshortcuts="Shift+Tab"
                  aria-label={permissionText.plan}
                  title={lockedByTurn && !settingsLocked ? copy.settingsAfterTurn : `${permissionText.planHint} (${permissionText.planShortcut})`}
                  disabled={settingsLocked || lockedByTurn}
                  onClick={togglePlan}
                  data-testid="structured-agent-live-plan"
                >
                  <Glyph name="edit" />
                  <span className="chat-pill__value">{permissionText.plan}</span>
                </button>
                {pairModelAndEffort(<SettingPill
                  label={copy.modelOf(providerName)}
                  icon={glyphIcon('mon')}
                  prefix={providerName}
                  value={selectedModel}
                  placeholder={copy.providerDefault}
                  options={availableModels.map((option) => ({ value: option.id, label: option.label }))}
                  {...(modelsLoading ? { status: copy.modelsLoading } : {})}
                  {...(providerChoices ? { leading: {
                    label: 'AI',
                    value: providerId,
                    options: providerChoices.options.map((option) => ({ value: option.id, label: option.label,
                      ...(option.disabled ? { disabled: true } : {}), ...(option.description ? { description: option.description } : {}) })),
                    onChange: providerChoices.onSelect,
                  } } : {})}
                  disabled={settingsLocked || lockedByTurn}
                  {...(lockedByTurn && !settingsLocked ? { hint: copy.settingsAfterTurn } : {})}
                  onChange={(next) => void updateSettings({ model: next })}
                  testId="structured-agent-live-model"
                />, effortSupported && (
                  <SettingPill
                    label={i18n.language.startsWith('ko') ? '추론 강도' : 'Reasoning effort'}
                    icon={glyphIcon('mon')}
                    value={selectedEffort}
                    placeholder={i18n.language.startsWith('ko') ? '기본 강도' : 'Default effort'}
                    options={effortOptions.map((value) => ({ value, label: effortLabel(value) }))}
                    disabled={disabled || settingsBusy}
                    onChange={(next) => void updateSettings({ reasoningEffort: next })}
                    testId="structured-agent-live-effort"
                  />
                ))}
                <SettingPill
                  label={copy.permission}
                  icon={accessLevel === 'full-access' ? glyphIcon('warn') : glyphIcon('ok')}
                  value={accessLevel}
                  options={ACCESS_LEVELS.map((level) => ({ value: level, label: permissionText.levels[level].label, description: permissionText.levels[level].hint }))}
                  disabled={settingsLocked || (lockedByTurn && !planOn)}
                  {...(lockedByTurn && !planOn && !settingsLocked ? { hint: copy.settingsAfterTurn } : {})}
                  onChange={changeAccess}
                  testId="structured-agent-live-permission"
                />
                {folderPill}
                {usage && <UsagePill usage={usage} providerName={providerName} copy={copy.usage} locale={i18n.language} />}
              </>
            )}
          </div>
  );

  const capabilitiesPanel = !historyOnly && !providerOwned && capabilityClient && (providerId === 'codex' || providerId === 'claude') ? <AgentCapabilitiesPanel compact={variant !== 'mobile' || compactRow}
        client={capabilityClient} providerId={providerId} workspaceId={workspace.id} sessionId={capabilitySessionId === null ? undefined : capabilitySessionId ?? sessionId} remote={variant === 'mobile'}
        onCatalog={setCapabilityCatalog} onDiscoveryState={setCapabilityDiscovery} disabled={composerDisabled}
        onInsert={(item) => { setSelectedCapabilities((current) => [...current.filter((entry) => entry.id !== item.id), item]); setDraftAction({ id: ++actionSequence.current, sessionId, insert: item.invocation, ...(item.kind === 'skill' && item.invocation ? { skill: { providerId, id: item.id, name: item.name, invocation: item.invocation } } : {}) }); }}
      /> : null;

  return (
    <section
      ref={panelRef}
      onKeyDown={stopOnEscape}
      className={full ? 'structured-agent structured-agent--live' : 'structured-agent structured-agent--live structured-agent--composer-only'}
      data-variant={variant}
      data-session-id={sessionId}
      data-provider={providerId}
      data-state={state}
      data-skin={activeSkin}
      data-review-aside={reviewAside || undefined}
      data-history-only={historyOnly || undefined}
      data-presentation={full ? undefined : presentation}
      data-header-layout={compactRow ? 'row' : undefined}
      data-testid="structured-agent-session"
      {...(full ? { 'aria-labelledby': titleId } : { 'aria-label': `${title} · ${providerLabel}` })}
    >
      {full && <header className="structured-agent-session-header">
        {headerLeading}
        <div className="structured-agent-session-header__identity">
          {parent && onOpenRelatedSession ? (
            <button type="button" className="structured-agent-session-header__parent" onClick={() => onOpenRelatedSession(parent.sessionId)}
              title={`${copy.parentConversation}: ${parent.title}`} aria-label={`${copy.backToParent}: ${parent.title}`} data-testid="structured-agent-parent">
              <Glyph name="up" /><span>{parent.title}</span>
            </button>
          ) : <span className="structured-agent__eyebrow">{providerLabel}</span>}
          <h1 id={titleId} title={`${title} · ${providerLabel} · ${workspace.label}`}>{title}</h1>
          {subagentType && <span className="chat-chip">{subagentType}</span>}
          {/* With the folder setting below, the header names the conversation and its state only. */}
          {!folderPill && <p title={workspace.path}>{workspace.label} · {workspace.kind === 'worktree' ? 'Worktree' : 'Local'}</p>}
        </div>
        <div className="structured-agent-session-header__status">
          <span className="structured-agent-state" data-state={state}>
            <span aria-hidden="true" />
            <span className="ez-ui-visually-hidden">{copy.status}: </span>{statusLabel ?? (awaitingFirstMessage ? copy.notStarted : stateLabel(state))}
          </span>
          {/* A subagent with a parent says who runs it below the transcript instead. */}
          {owner === 'provider-native' && !parent && (
            <span className="structured-agent-session-header__owner">
              {copy.providerOwned} · {copy.readOnly}
            </span>
          )}
        </div>
        {/* Desktop and the compact Android row: one row with an overflow menu. Otherwise Android keeps its inline controls. */}
        {variant === 'mobile' && !compactRow ? (
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
                    leadingIcon={<Glyph name="unlink" />}
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
                    leadingIcon={<Glyph name="archive" />}
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
                    leadingIcon={<Glyph name="stop" />}
                    disabled={disabled || settingsBusy || lifecycleBusy !== null}
                    loading={lifecycleBusy === 'cancel'}
                    loadingLabel={copy.stoppingAgent}
                    onClick={() => void stopTurn()}
                    data-testid="structured-agent-cancel"
                  >
                    {copy.stopAgent}
                  </Button>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="structured-agent-session-controls">
            {headerActions}
            {/* Android keeps the heartbeat control inline below the header, so the chip and menu entry are desktop only. */}
            {heartbeatActive && variant !== 'mobile' && (
              <button type="button" className="chat-header-chip" onClick={() => setHeartbeatOpen(true)} data-testid="structured-agent-heartbeat-chip">
                <Glyph name="mon" />{copy.heartbeatOn}
              </button>
            )}
            {results ? (
              <Button type="button" variant="ghost" size="sm" leadingIcon={<Glyph name="diff" />}
                onClick={() => results.open({ activate: true, target: { section: 'changes' } })} data-testid="structured-agent-results">
                {resultsCopy.results}{changeCount > 0 ? ` ${String(changeCount)}` : ''}
              </Button>
            ) : changeCount > 0 && (
              <Button ref={reviewButtonRef} type="button" variant="ghost" size="sm" leadingIcon={<Glyph name="diff" />} onClick={() => setReviewRequest((request) => request + 1)} data-testid="structured-agent-review-changes">
                {copy.changedFiles(changeCount)}
              </Button>
            )}
            {capabilitiesPanel}
            {historyOnly && settingsControls}
            {paneActions?.preview && (
              <button type="button" className="chat-icon-action chat-header-pin" aria-label={copy.keepTab} title={copy.keepTab}
                onClick={paneActions.keep} data-testid="structured-agent-keep-tab">
                <Glyph name="pin" size={16} />
              </button>
            )}
            <Menu
              label={copy.conversationMenu}
              placement="bottom-end"
              trigger={(
                <button type="button" className="chat-icon-action chat-header-more" aria-label={copy.conversationMenu} title={copy.conversationMenu}
                  aria-busy={lifecycleBusy !== null || undefined} data-testid="structured-agent-menu">
                  <Glyph name="more" />
                </button>
              )}
            >
              {/* The phone's one-row header has no folder line: the menu names where the conversation works. */}
              {compactRow && (
                <MenuLabel className="structured-agent-menu-folder" title={workspace.path} data-testid="structured-agent-menu-folder">
                  {i18n.language.startsWith('ko') ? '작업 폴더' : 'Working folder'}: {workspace.label} · {workspace.kind === 'worktree' ? 'Worktree' : 'Local'}
                </MenuLabel>
              )}
              {compactRow && <MenuSeparator />}
              {onOpenHistory && <MenuItem icon={glyphIcon('clock')} onSelect={onOpenHistory}>{copy.previousConversations}</MenuItem>}
              {menuItems.map((entry) => (
                <MenuItem key={entry.label} {...(entry.icon ? { icon: entry.icon } : {})} disabled={entry.disabled} onSelect={entry.onSelect}>{entry.label}</MenuItem>
              ))}
              <MenuLabel>{copy.skin}</MenuLabel>
              {(['bubble', 'cli'] as const).map((skin) => (
                <MenuRadioItem key={skin} checked={activeSkin === skin} data-testid={`structured-agent-skin-${skin}`}
                  onSelect={() => { captureSkinView(); setPreferredSkin(skin); writeChatSkin(skin); onSkinChange?.(skin); }}>
                  {skin === 'bubble' ? copy.bubbleSkin : copy.cliSkin}
                </MenuRadioItem>
              ))}
              {onDelegate && !providerOwned && !historyOnly && <MenuSeparator />}
              {onDelegate && !providerOwned && !historyOnly && (
                <MenuItem icon={glyphIcon('next')} onSelect={() => onDelegate('handoff')} data-testid="structured-agent-delegate">{copy.delegateHandoff}</MenuItem>
              )}
              {onDelegate && !providerOwned && !historyOnly && (
                <MenuItem icon={glyphIcon('search')} onSelect={() => onDelegate('review')} data-testid="structured-agent-delegate-review">{copy.delegateReview}</MenuItem>
              )}
              {heartbeatControl !== undefined && variant !== 'mobile' && <MenuSeparator />}
              {heartbeatControl !== undefined && variant !== 'mobile' && <MenuItem icon={glyphIcon('mon')} onSelect={() => setHeartbeatOpen(true)} data-testid="structured-agent-heartbeat-open">{copy.heartbeatMenu}</MenuItem>}
              {paneActions && <MenuSeparator />}
              {paneActions && <MenuLabel>{copy.tabSection}</MenuLabel>}
              {paneActions?.preview && <MenuItem onSelect={paneActions.keep} data-testid="structured-agent-tab-keep">{copy.keepTab}</MenuItem>}
              {paneActions && <MenuItem onSelect={() => paneActions.split('right')} data-testid="structured-agent-tab-split-right">{copy.splitRight}</MenuItem>}
              {paneActions && <MenuItem onSelect={() => paneActions.split('below')} data-testid="structured-agent-tab-split-below">{copy.splitBelow}</MenuItem>}
              {paneActions?.moveToNewWindow && <MenuItem onSelect={paneActions.moveToNewWindow} data-testid="structured-agent-tab-new-window">{copy.moveToNewWindow}</MenuItem>}
              {paneActions?.moveToMainWindow && <MenuItem onSelect={paneActions.moveToMainWindow} data-testid="structured-agent-tab-main-window">{copy.moveToMainWindow}</MenuItem>}
              {paneActions && <MenuItem icon={glyphIcon('x')} onSelect={paneActions.close} data-testid="structured-agent-tab-close">{copy.closeTab}</MenuItem>}
              {hasLifecycleActions && (canDetach || canArchive) && <MenuSeparator />}
              {!historyOnly && canDetach && (
                <MenuItem icon={glyphIcon('unlink')} disabled={disabled || settingsBusy || lifecycleBusy !== null}
                  onSelect={() => void runLifecycle('detach', onDetach)} data-testid="structured-agent-detach">
                  {copy.detachSession}
                </MenuItem>
              )}
              {!historyOnly && canArchive && (
                <MenuItem icon={glyphIcon('archive')} disabled={disabled || settingsBusy || lifecycleBusy !== null}
                  onSelect={() => void runLifecycle('archive', onArchive)} data-testid="structured-agent-archive">
                  {copy.archiveSession}
                </MenuItem>
              )}
            </Menu>
          </div>
        )}
      </header>}
      {/* Below the header, full width: a failure is read, not squeezed beside the controls. */}
      {settingsError && (
        <div className="structured-agent__banner structured-agent__banner--error structured-agent-session-error" role="alert" data-testid="structured-agent-session-error">
          <Glyph name="warn" />
          <span><strong>{settingsError.title}</strong> {settingsError.detail}</span>
          <Button variant="ghost" size="sm" onClick={() => setSettingsError(null)}>{copy.close}</Button>
        </div>
      )}
      {lifecycleError && (
        <div className="structured-agent__banner structured-agent__banner--error structured-agent-session-error" role="alert">
          <Glyph name="warn" />
          <span><strong>{copy.lifecycleFailed}</strong> {lifecycleError === copy.lifecycleFailed ? '' : lifecycleError}</span>
          <Button variant="ghost" size="sm" onClick={() => setLifecycleError(null)}>{copy.close}</Button>
        </div>
      )}

      {full && variant === 'mobile' && !compactRow && capabilitiesPanel}
      {full && !results && <ConversationChangeReview key={`review:${sessionId}`} sessionId={sessionId} items={items} wide={wideReview && variant !== 'mobile'} mobile={variant === 'mobile'} ownerDocument={panelRef.current?.ownerDocument}
        onAsideChange={setReviewAside}
        openRequest={reviewRequest}
        hideTrigger={variant !== 'mobile' || compactRow}
        returnFocusRef={reviewButtonRef}
        onOpenProjectFiles={onOpenProjectFiles}
        onQuote={!historyOnly && !composerDisabled ? text => setDraftAction({ id: ++actionSequence.current, sessionId, insert: text }) : undefined} />}
      {full && workflowContext}
      {full && <StructuredAgentTranscript
        beforeMessages={beforeMessages}
        key={`transcript:${viewStateKey ?? sessionId}`}
        stateKey={viewStateKey ? `${viewStateKey}:transcript` : variant === 'desktop' ? `desktop-agent-transcript:${sessionId}` : undefined}
        items={items}
        approvals={approvals}
        {...(turns ? { turns } : {})}
        skin={activeSkin}
        workspaceRoot={workspace.path}
        approvalResponses={approvalResponses}
        approvalSession={approvalSession}
        {...(onOpenLink ? { onOpenLink } : {})}
        onReviewChanges={() => setReviewRequest((request) => request + 1)}
        hasEarlier={hasEarlier}
        loadingEarlier={loadingEarlier}
        {...(onLoadEarlier ? { onLoadEarlier } : {})}
        providerLabel={providerLabel}
        loading={transcriptLoading}
        error={transcriptError}
        onRetry={onRetryTranscript}
        onResolveApproval={historyOnly ? undefined : resolveApprovalFor}
        controlsDisabled={disabled}
        onReply={!historyOnly && !composerDisabled && supportsMessageContext ? (replyTo) => setDraftAction({ id: ++actionSequence.current, sessionId, replyTo }) : undefined}
        onReuse={!historyOnly && !composerDisabled ? (text) => setDraftAction({ id: ++actionSequence.current, sessionId, text }) : undefined}
        onOpenRelatedSession={onOpenRelatedSession}
        {...(!settingsReadOnly ? { planAccess: planAccessChoice } : {})}
        {...(!settingsReadOnly && !composerDisabled && !planProposals ? {
          planReview: { providerId, permissionPreset: selectedPermission, state, onApprove: approveProposedPlan, onKeepPlanning: (message: string) => onSend(message) },
        } : {})}
      />}
      {full && childTrack !== undefined && (
        <section className="structured-agent-child-track" data-testid="structured-agent-child-track">
          {childTrack}
        </section>
      )}
      {full && settingsTrack}
      {full && variant === 'mobile' && heartbeatControl}
      {full && variant !== 'mobile' && heartbeatControl !== undefined && (
        <Dialog open={heartbeatOpen} onOpenChange={setHeartbeatOpen} title={copy.heartbeatOn} ownerDocument={panelRef.current?.ownerDocument} closeLabel={copy.close}>
          {heartbeatControl}
        </Dialog>
      )}
      {recoveryControl}
      {full && !historyOnly && providerOwned && parent && (
        // A provider-owned subagent takes no messages: say who runs it and lead back.
        <footer className="structured-agent-subagent-footer" data-attention={parentApprovalPending || undefined} data-testid="structured-agent-subagent-footer">
          <p role={parentApprovalPending ? 'status' : undefined}>{parentApprovalPending ? copy.subagentApprovalWaiting : copy.subagentManaged}</p>
          {onOpenRelatedSession && (
            <Button type="button" size="sm" variant={parentApprovalPending ? 'primary' : 'secondary'} onClick={() => onOpenRelatedSession(parent.sessionId)}>
              {parentApprovalPending ? copy.reviewApproval : copy.backToParent}
            </Button>
          )}
        </footer>
      )}
      {full && sideOpen && !historyOnly && !(providerOwned && parent) && (
        <div className="side-question-anchor">
          <SideQuestionSurface
            variant={variant}
            ko={chatLocale === 'ko'}
            id={sideWindowId}
            thread={sideThread}
            onClose={() => setSideOpen(false)}
            {...(btwReason ? { disabledReason: btwReason } : {})}
            returnFocusRef={sideButtonRef}
          />
        </div>
      )}
      {!historyOnly && !(providerOwned && parent) && (
        <StructuredAgentComposer
          toolbar={settingsControls}
          providerId={providerId}
          queueItems={queueItems}
          onQueueAction={onQueueAction}
          capabilityCatalog={capabilityCatalog?.providerId === providerId && capabilityCatalog.workspaceId === workspace.id ? capabilityCatalog : undefined}
          capabilityDiscovery={capabilityDiscovery}
          onOpenHistory={onOpenHistory}
          key={`composer:${viewStateKey ?? sessionId}`}
          stateKey={viewStateKey ? `${viewStateKey}:composer` : variant === 'desktop' ? `desktop-agent-composer:${sessionId}` : undefined}
          busy={busy}
          autoFocus={full && awaitingFirstMessage && variant === 'desktop'}
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
          recentPrompts={recentPrompts}
          {...(canCancel ? { onStop: () => void stopTurn() } : {})}
          stopping={lifecycleBusy === 'cancel'}
          {...(fileSearch ? { fileSearch } : {})}
          {...(pathForDrop ? { pathForDrop } : {})}
          {...(!settingsReadOnly ? { plan: { on: planOn, onToggle: togglePlan, disabled: settingsLocked || lockedByTurn, ...(planBlockedReason ? { blockedReason: planBlockedReason } : {}) } } : {})}
          {...(!settingsReadOnly && turnCurrent ? { statusHint: state === 'blocked' ? (full ? copy.decisionHint : copy.decisionElsewhereHint) : queueSettings ? copy.settingsQueuedDuringTurn : copy.settingsLockedDuringTurn } : {})}
          {...(full ? { onFocusDecision: focusDecision } : {})}
          appCommands={appCommands}
          {...(!btwReason ? { sideQuestion: { label: copy.btwButton, open: sideOpen, controlsId: sideWindowId, buttonRef: sideButtonRef, onAsk: askSide, onOpen: openSide } } : {})}
        />
      )}
    </section>
  );
}
