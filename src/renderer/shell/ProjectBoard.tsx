import { useState, type ReactNode } from 'react';

import { Glyph, Led, type GlyphName } from '../ui';
import type { LiveConversation, LiveFlow, WaitingItem, otherProjects } from './shell-model';
import { StageChain } from './StageChain';
import type { ShellTerminal } from './LiveList';
import { workflowRepeatLabel } from '../workflow/workflow-copy';
import { conversationStateText, flowPhaseText, providerName, useShellText, waitingKindText } from './shell-text';

export interface BoardProject {
  readonly name: string;
  readonly path?: string;
}

/** The project folder's working-tree changes (git status) and its worktrees. */
export interface BoardChanges {
  readonly branch?: string;
  readonly files: number;
  readonly added: number;
  readonly removed: number;
  readonly worktrees: number;
  readonly availability: 'ready' | 'not-a-repository' | 'unavailable';
  /** The change list hit its cap: the counts are a lower bound. */
  readonly truncated: boolean;
}

export interface ProjectBoardProps {
  readonly project: BoardProject | null;
  readonly flows: readonly LiveFlow[];
  readonly conversations: readonly LiveConversation[];
  readonly terminals: readonly ShellTerminal[];
  readonly waiting: readonly WaitingItem[];
  readonly others: ReturnType<typeof otherProjects>;
  /** The new-conversation composer (the production start panel), one line. */
  readonly startBar?: ReactNode;
  readonly changes?: BoardChanges | null;
  readonly onOpenConversation: (sessionId: string) => void;
  /** Opens a waiting item where it is answered (a flow approval, a terminal agent); its conversation when absent. */
  readonly onOpenWaiting?: (item: WaitingItem) => void;
  readonly onOpenFlow: (subprojectId: string) => void;
  /** 다시 실행 from the board (absent where the host cannot take it in one request). */
  readonly onRunAgain?: (subprojectId: string) => void;
  readonly onNewFlow: () => void;
  readonly onOpenTerminal: (panelId: string) => void;
  readonly onNewTerminal: () => void;
  readonly onDecide: (item: WaitingItem, decision: 'allow' | 'deny') => Promise<{ readonly ok: boolean; readonly message?: string }>;
  readonly onOtherProject: (projectId: string) => void;
  readonly onFiles: () => void;
  readonly onWorktree?: () => void;
  readonly onProjectSettings: () => void;
  readonly onAddProject: () => void;
  readonly conversationLimit?: number;
}

function Lane({ glyph, title, note, children }: { readonly glyph: GlyphName; readonly title: string; readonly note: ReactNode; readonly children: ReactNode }): JSX.Element {
  return (
    <section className="ez-shell-lane" aria-label={title}>
      <div className="ez-shell-lane__head">
        <h2><Glyph name={glyph} size={16} />{title}</h2>
        <span>{note}</span>
      </div>
      <div className="ez-shell-lane__body">{children}</div>
    </section>
  );
}

function WaitingCard({ item, onDecide, onOpen }: {
  readonly item: WaitingItem;
  readonly onDecide: ProjectBoardProps['onDecide'];
  readonly onOpen: () => void;
}): JSX.Element {
  const { text } = useShellText();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const decide = (decision: 'allow' | 'deny'): void => {
    setBusy(true); setError(undefined);
    void onDecide(item, decision).then((result) => {
      setBusy(false);
      if (!result.ok) setError(result.message ?? text('결정을 보내지 못했습니다.', 'The decision was not sent.'));
    });
  };
  const decidable = item.kind === 'command' || item.kind === 'file-change' || item.kind === 'tool';
  return (
    <article className="ez-shell-need" aria-label={`${waitingKindText(item.kind, text, item.asks)}: ${item.title}`} data-testid="shell-need" data-kind={item.kind}>
      <div className="ez-shell-need__k"><Glyph name={item.kind === 'question' || item.asks === 'answer' ? 'q' : 'ok'} size={14} />{waitingKindText(item.kind, text, item.asks)}{item.providerId ? ` · ${providerName(item.providerId)}` : ''}</div>
      <p className="ez-shell-need__t">{item.title}</p>
      {item.kind === 'command' ? <pre className="ez-shell-need__c">{item.detail}</pre> : item.detail && <p className="ez-shell-need__q">{item.detail}</p>}
      <div className="ez-shell-btns">
        {decidable ? (
          <>
            <button type="button" className="ez-shell-btn" data-tone="amber" disabled={busy} onClick={() => decide('allow')} data-testid="shell-need-allow">{text('허용', 'Allow')}</button>
            <button type="button" className="ez-shell-btn" disabled={busy} onClick={() => decide('deny')} data-testid="shell-need-deny">{text('거부', 'Deny')}</button>
            <button type="button" className="ez-shell-btn" data-tone="flat" onClick={onOpen}>{text('대화 열기', 'Open conversation')}</button>
          </>
        ) : (
          <button type="button" className="ez-shell-btn" onClick={onOpen} data-testid="shell-need-answer">{item.kind === 'question' ? text('답하기', 'Answer')
            : item.kind === 'flow-approval' ? (item.asks === 'answer' ? text('답하기', 'Answer') : text('승인 보기', 'Review approval'))
              : item.kind === 'terminal-agent' ? text('받은 요청 보기', 'Open requests') : text('대화 열기', 'Open conversation')}</button>
        )}
      </div>
      {error && <p className="ez-shell-need__error" role="alert">{error}</p>}
    </article>
  );
}

/** A project's home: flows, conversations, terminals; what waits for the person on the right; a start bar below. */
export function ProjectBoard(props: ProjectBoardProps): JSX.Element {
  const { text } = useShellText();
  const working = props.conversations.filter((item) => item.state === 'working').length;
  const waitingCount = props.conversations.filter((item) => item.lamp === 'amber').length;
  const shown = props.conversations.slice(0, props.conversationLimit ?? 8);
  if (!props.project) {
    return (
      <div className="ez-shell-boardwrap" data-testid="shell-board">
        <main className="ez-shell-board" aria-label={text('판', 'Board')}>
          <div className="ez-shell-phead"><h1>{text('프로젝트를 고르세요', 'Choose a project')}</h1></div>
          <p className="ez-shell-empty">{text('작업할 폴더를 프로젝트로 추가하면 대화·워크플로·터미널이 여기에 모입니다.', 'Add a folder as a project: its conversations, workflows and terminals gather here.')}</p>
          <div className="ez-shell-btns"><button type="button" className="ez-shell-btn" data-tone="go" onClick={props.onAddProject} data-testid="shell-board-add-project">{text('프로젝트 추가', 'Add project')}</button></div>
        </main>
        <aside className="ez-shell-side" aria-label={text('나를 기다리는 것', 'Waiting for me')} />
      </div>
    );
  }
  return (
    <>
      <div className="ez-shell-boardwrap" data-testid="shell-board">
        <main className="ez-shell-board" aria-label={text(`${props.project.name} 판`, `${props.project.name} board`)}>
          <div className="ez-shell-phead">
            <h1>{props.project.name}</h1>
            {props.project.path && <span className="ez-shell-phead__path" title={props.project.path}>{props.project.path}{props.changes?.branch ? ` · ${props.changes.branch}` : ''}</span>}
            <span className="ez-shell-phead__right">
              <button type="button" className="ez-shell-btn" data-tone="flat" onClick={props.onFiles} data-testid="shell-board-files"><Glyph name="file" size={16} />{text('파일', 'Files')}</button>
              {props.onWorktree && <button type="button" className="ez-shell-btn" data-tone="flat" onClick={props.onWorktree}><Glyph name="wt" size={16} />{text('워크트리', 'Worktree')}</button>}
              <button type="button" className="ez-shell-btn" data-tone="flat" onClick={props.onProjectSettings}><Glyph name="set" size={16} />{text('프로젝트 설정', 'Project settings')}</button>
            </span>
          </div>
          <Lane glyph="flow" title={text('워크플로', 'Workflows')} note={text(`워크플로 ${props.flows.length}`, `${props.flows.length} workflows`)}>
            {props.flows.length === 0 && <p className="ez-shell-empty">{text('워크플로가 없습니다.', 'No workflows yet.')}</p>}
            {props.flows.map((flow) => (
              <div key={flow.subprojectId} className="ez-shell-card ez-shell-flowcard" data-need={flow.lamp === 'amber' || undefined} data-testid="shell-flow-card">
                <button type="button" className="ez-shell-flowcard__name" onClick={() => props.onOpenFlow(flow.subprojectId)}>
                  <span className="ez-shell-card__k"><Led tone={flow.lamp} />{flow.runNumber > 0 ? text(`실행 #${flow.runNumber} · `, `Run #${flow.runNumber} · `) : ''}{flowPhaseText(flow.phase, text)}</span>
                  <span className="ez-shell-card__t">{flow.title}</span>
                  <span className="ez-shell-card__m">{flow.autoApprove ? text('자동 승인', 'Auto-approve') : text('승인은 내가', 'I approve')}{flow.repeat ? ` · ${workflowRepeatLabel(flow.repeat, text)}` : ''}</span>
                </button>
                <StageChain stages={flow.stages} onOpenConversation={props.onOpenConversation} />
                <span className="ez-shell-flowcard__actions">
                  {flow.phase === 'awaiting-approval'
                    ? <button type="button" className="ez-shell-btn" data-tone="amber" onClick={() => props.onOpenFlow(flow.subprojectId)} data-testid="shell-flow-open">{text('승인 보기', 'Review approval')}</button>
                    : <button type="button" className="ez-shell-btn" onClick={() => props.onOpenFlow(flow.subprojectId)} data-testid="shell-flow-open">{text('워크플로 보기', 'Open workflow')}</button>}
                  {props.onRunAgain && flow.canRunAgain && <button type="button" className="ez-shell-btn" onClick={() => props.onRunAgain!(flow.subprojectId)} data-testid="shell-flow-run-again">{flow.runNumber > 0 ? text('다시 실행', 'Run again') : text('실행', 'Run')}</button>}
                </span>
              </div>
            ))}
          </Lane>
          <Lane glyph="new" title={text('대화', 'Conversations')} note={text(`진행 ${working} · 기다림 ${waitingCount}`, `${working} working · ${waitingCount} waiting`)}>
            {shown.length === 0 && <p className="ez-shell-empty">{text('아래 막대에 할 일을 적으면 새 대화가 시작됩니다.', 'Type a task in the bar below to start a conversation.')}</p>}
            {shown.map((item) => (
              <button key={item.sessionId} type="button" className="ez-shell-card" data-need={item.lamp === 'amber' || undefined}
                onClick={() => props.onOpenConversation(item.sessionId)} data-testid="shell-conversation-card" data-session={item.sessionId}>
                <span className="ez-shell-card__k"><Led tone={item.lamp} />{providerName(item.providerId)} · {conversationStateText(item.state, text)}</span>
                <span className="ez-shell-card__t">{item.title}</span>
                <span className="ez-shell-card__m">{item.children.length > 0 ? text(`하위 에이전트 ${item.children.length}`, `${item.children.length} subagents`) : ' '}</span>
              </button>
            ))}
          </Lane>
          <Lane glyph="term" title={text('터미널', 'Terminals')} note={<>{props.terminals.length} · <kbd>Ctrl `</kbd></>}>
            {props.terminals.map((terminal) => (
              <button key={terminal.panelId} type="button" className="ez-shell-card" onClick={() => props.onOpenTerminal(terminal.panelId)} data-testid="shell-terminal-card">
                <span className="ez-shell-card__k"><Led tone="idle" />{terminal.title}</span>
                {terminal.detail && <span className="ez-shell-term-thumb">{terminal.detail}</span>}
              </button>
            ))}
            <button type="button" className="ez-shell-btn" data-tone="flat" onClick={props.onNewTerminal} data-testid="shell-board-new-terminal">{text('+ 새 터미널', '+ New terminal')}</button>
          </Lane>
          {props.changes && (
            <Lane glyph="diff" title={text('변경', 'Changes')} note={text('작업 폴더', 'Working folder')}>
              <button type="button" className="ez-shell-card" data-wide="true" onClick={props.onFiles} data-testid="shell-changes-card">
                <span className="ez-shell-card__k"><Led tone={props.changes.files > 0 ? 'ok' : 'idle'} />{props.changes.branch ?? text('작업 폴더', 'Working folder')}</span>
                <span className="ez-shell-card__t ez-shell-card__t--plain">
                  {props.changes.availability === 'ready'
                    ? <>{props.changes.truncated
                      ? text(`파일 ${props.changes.files}개 이상 바뀜`, `${props.changes.files}+ files changed`)
                      : text(`파일 ${props.changes.files}개 바뀜`, `${props.changes.files} files changed`)} <b className="ez-shell-plus">+{props.changes.added}</b> <b className="ez-shell-minus">−{props.changes.removed}</b></>
                    : props.changes.availability === 'not-a-repository'
                      ? text('Git 저장소가 아닙니다', 'Not a Git repository')
                      : text('변경을 읽지 못했습니다', 'Changes could not be read')}
                  {` · ${text(`워크트리 ${props.changes.worktrees}`, `${props.changes.worktrees} worktrees`)}`}
                </span>
              </button>
            </Lane>
          )}
        </main>
        <aside className="ez-shell-side" aria-label={text('나를 기다리는 것', 'Waiting for me')} data-testid="shell-waiting">
          <h2><Glyph name="req" size={16} />{text('나를 기다리는 것', 'Waiting for me')}<span className="ez-shell-n">{props.waiting.length}</span></h2>
          {props.waiting.length === 0 && <p className="ez-shell-empty">{text('지금 기다리는 것이 없습니다.', 'Nothing is waiting for you.')}</p>}
          {props.waiting.map((item) => (
            <WaitingCard key={item.approvalId} item={item} onDecide={props.onDecide} onOpen={() => (props.onOpenWaiting ? props.onOpenWaiting(item) : props.onOpenConversation(item.sessionId))} />
          ))}
          {props.others.length > 0 && <h2><Glyph name="proj" size={16} />{text('다른 프로젝트', 'Other projects')}</h2>}
          {props.others.slice(0, 3).map((project) => (
            <button key={project.projectId} type="button" className="ez-shell-card" onClick={() => props.onOtherProject(project.projectId)} data-testid="shell-other-project">
              <span className="ez-shell-card__k"><Led tone={project.waiting > 0 ? 'amber' : project.failed > 0 ? 'red' : 'on'} />{project.name}</span>
              <span className="ez-shell-card__m">
                {[project.waiting > 0 ? text(`기다림 ${project.waiting}`, `${project.waiting} waiting`) : '',
                  project.failed > 0 ? text(`멈춤 ${project.failed}`, `${project.failed} stopped`) : '',
                  project.working > 0 ? text(`작업 중 ${project.working}`, `${project.working} working`) : ''].filter(Boolean).join(' · ')}
              </span>
            </button>
          ))}
        </aside>
      </div>
      <div className="ez-shell-launch" data-testid="shell-start-bar">
        <div className="ez-shell-launch__composer">{props.startBar}</div>
        <span className="ez-shell-launch__actions">
          <button type="button" className="ez-shell-btn" onClick={props.onNewTerminal}>{text('새 터미널', 'New terminal')}</button>
          <button type="button" className="ez-shell-btn" onClick={props.onNewFlow} data-testid="shell-board-new-flow">{text('새 워크플로', 'New workflow')}</button>
        </span>
      </div>
    </>
  );
}
