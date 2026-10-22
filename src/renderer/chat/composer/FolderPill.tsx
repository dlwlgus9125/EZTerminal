import { ChevronDown, Folder, GitBranch, Settings, TriangleAlert } from 'lucide-react';
import { useState, type SyntheticEvent } from 'react';

import { conversationFolderName, type ConversationFolders } from '../../../shared/conversation-folders';
import { useAppTranslation } from '../../i18n';
import { Menu, MenuItem, MenuLabel, MenuRadioItem, MenuSeparator } from '../../ui';
import { placementFor } from './SettingPill';

export interface FolderPillWorkspace {
  readonly id: string;
  readonly label: string;
  readonly kind: 'local' | 'worktree';
  readonly path?: string;
}

interface FolderPillCopy {
  readonly workingFolder: string;
  readonly worktree: string;
  readonly fixed: string;
  readonly newWorktree: string;
  readonly alsoWorksIn: string;
  readonly missing: string;
  readonly instructions: string;
  readonly editProject: string;
  readonly summary: (name: string, count: number, missing: number) => string;
}

const COPY: Readonly<Record<'en' | 'ko', FolderPillCopy>> = {
  en: {
    workingFolder: 'Working folder',
    worktree: 'Worktree',
    fixed: 'Fixed once the conversation starts.',
    newWorktree: 'New worktree…',
    alsoWorksIn: 'Also works in',
    missing: 'Not found · left out',
    instructions: 'AGENTS.md and CLAUDE.md are read from the working folder only.',
    editProject: 'Edit project…',
    summary: (name, count, missing) => `Working folder: ${name}${count ? `, also works in ${count} ${count === 1 ? 'folder' : 'folders'}` : ''}${missing ? `, ${missing} not found` : ''}`,
  },
  ko: {
    workingFolder: '작업 위치',
    worktree: '워크트리',
    fixed: '대화를 시작한 뒤에는 바꿀 수 없습니다.',
    newWorktree: '새 워크트리…',
    alsoWorksIn: '함께 보는 폴더',
    missing: '찾을 수 없음 · 이 대화에서 빠짐',
    instructions: 'AGENTS.md·CLAUDE.md는 작업 위치의 파일만 읽습니다.',
    editProject: '프로젝트 편집…',
    summary: (name, count, missing) => `작업 위치: ${name}${count ? `, 함께 보는 폴더 ${count}개` : ''}${missing ? `, ${missing}개 찾을 수 없음` : ''}`,
  },
};

function FolderEntry({ folderPath, className }: { readonly folderPath: string; readonly className?: string }): JSX.Element {
  return (
    <MenuLabel className={`chat-folders__entry${className ? ` ${className}` : ''}`}>
      <span>{conversationFolderName(folderPath)}</span>
      <small className="chat-folders__path">{folderPath}</small>
    </MenuLabel>
  );
}

/**
 * The conversation's working folder and the project's other folders it also
 * works in, as a composer setting. Before the conversation starts it also
 * chooses the working folder; afterwards the folder is fixed and the menu only
 * lists them and leads to the project editor.
 */
export function FolderPill({ workspace, folders, choices, onEditProject }: {
  readonly workspace: FolderPillWorkspace;
  readonly folders: ConversationFolders;
  /** Only before the conversation starts. */
  readonly choices?: {
    readonly options: readonly FolderPillWorkspace[];
    readonly onSelect: (workspaceId: string) => void;
    readonly onNewWorktree?: () => void;
    readonly disabled?: boolean;
  };
  readonly onEditProject?: () => void;
}): JSX.Element {
  const { i18n } = useAppTranslation();
  const copy = COPY[i18n.language.startsWith('ko') ? 'ko' : 'en'];
  const [placement, setPlacement] = useState<'top-start' | 'top-end'>('top-start');
  const count = folders.additional.length;
  const missing = folders.missing.length;
  const Icon = workspace.kind === 'worktree' ? GitBranch : Folder;
  const summary = copy.summary(workspace.label, count, missing);
  const place = (event: SyntheticEvent<HTMLButtonElement>): void => setPlacement(placementFor(event.currentTarget));
  return (
    <Menu
      label={copy.workingFolder}
      placement={placement}
      className="chat-pill-menu chat-folders-menu"
      trigger={(
        <button type="button" className="chat-pill chat-pill--folders" aria-label={summary} title={summary}
          disabled={choices?.disabled} data-testid="structured-agent-folders" onClick={place} onKeyDown={place}>
          <Icon aria-hidden="true" />
          <span className="chat-pill__value">{workspace.label}</span>
          {count > 0 && <span className="chat-folders__count">+{count}</span>}
          {missing > 0 && <TriangleAlert className="chat-folders__alert" aria-hidden="true" />}
          <ChevronDown className="chat-pill__chevron" aria-hidden="true" />
        </button>
      )}
    >
      <MenuLabel>{copy.workingFolder}</MenuLabel>
      {choices ? (
        <>
          {choices.options.map((option) => (
            <MenuRadioItem key={option.id} checked={option.id === workspace.id} onSelect={() => choices.onSelect(option.id)}>
              <span className="chat-pill__option">
                <span>{option.label}</span>
                <small className="chat-folders__path">
                  {option.kind === 'worktree' ? `${copy.worktree} · ` : ''}{option.path}
                </small>
              </span>
            </MenuRadioItem>
          ))}
          {choices.onNewWorktree && <MenuItem icon={GitBranch} onSelect={choices.onNewWorktree}>{copy.newWorktree}</MenuItem>}
        </>
      ) : (
        <>
          <FolderEntry folderPath={folders.primary} />
          <MenuLabel className="chat-folders__note">{copy.fixed}</MenuLabel>
        </>
      )}
      {(count > 0 || missing > 0) && (
        <>
          <MenuSeparator />
          {count > 0 && <MenuLabel>{copy.alsoWorksIn}</MenuLabel>}
          {folders.additional.map((folderPath) => <FolderEntry key={folderPath} folderPath={folderPath} />)}
          {missing > 0 && (
            <MenuLabel className="chat-folders__missing"><TriangleAlert aria-hidden="true" />{copy.missing}</MenuLabel>
          )}
          {folders.missing.map((folderPath) => <FolderEntry key={folderPath} folderPath={folderPath} className="chat-folders__entry--missing" />)}
          <MenuLabel className="chat-folders__note">{copy.instructions}</MenuLabel>
        </>
      )}
      {onEditProject && (
        <>
          <MenuSeparator />
          <MenuItem icon={Settings} onSelect={onEditProject}>{copy.editProject}</MenuItem>
        </>
      )}
    </Menu>
  );
}
