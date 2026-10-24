import { Glyph, Led, type GlyphName } from '../ui';
import type { LiveConversation, LiveFlow, WaitingItem, otherProjects } from './shell-model';
import { StageChain } from './StageChain';
import { conversationStateText, flowPhaseText, providerName, useShellText, waitingKindText } from './shell-text';

export interface ShellTerminal {
  readonly panelId: string;
  readonly title: string;
  readonly detail?: string;
}

export interface ShellTool {
  readonly id: string;
  readonly label: string;
  readonly glyph: GlyphName;
}

export interface LiveListProps {
  readonly projectName: string | null;
  readonly projectDetail?: string;
  readonly conversations: readonly LiveConversation[];
  readonly waiting: readonly WaitingItem[];
  readonly flows: readonly LiveFlow[];
  readonly terminals: readonly ShellTerminal[];
  /** The session or panel shown in the dock's active tab. */
  readonly focus: string | null;
  readonly others: ReturnType<typeof otherProjects>;
  readonly tools: readonly ShellTool[];
  readonly activeTool: string | null;
  /** How many conversations to list before "all". */
  readonly limit?: number;
  readonly onBoard: () => void;
  readonly onOpenConversation: (sessionId: string) => void;
  readonly onNewConversation: () => void;
  readonly onOpenWaiting: (item: WaitingItem) => void;
  readonly onOpenFlow: (subprojectId: string) => void;
  readonly onOpenTerminal: (panelId: string) => void;
  readonly onNewTerminal: () => void;
  readonly onAllConversations: () => void;
  readonly onOtherProject: (projectId: string) => void;
  readonly onTool: (id: string) => void;
}

/** Work mode's left column: what waits, conversations, flows and terminals of the project, then the tools. */
export function LiveList(props: LiveListProps): JSX.Element {
  const { text } = useShellText();
  const limit = props.limit ?? 12;
  const shown = props.conversations.slice(0, limit);
  const other = props.others[0];
  return (
    <nav className="ez-shell-live" aria-label={text(`${props.projectName ?? '프로젝트'} 작업 목록`, `${props.projectName ?? 'Project'} work list`)} data-testid="shell-live-list">
      <div className="ez-shell-live__head">
        <button type="button" className="ez-shell-back" onClick={props.onBoard} data-testid="shell-back-to-board"><Glyph name="back" size={14} />{text('판', 'Board')}</button>
        <b title={props.projectName ?? undefined}>{props.projectName ?? text('프로젝트 없음', 'No project')}</b>
        {props.projectDetail && <span className="ez-shell-live__detail">{props.projectDetail}</span>}
      </div>
      <div className="ez-shell-live__body">
        {props.waiting.length > 0 && (
          <>
            <h2 className="ez-shell-live__sec"><Glyph name="req" size={14} />{text('나를 기다리는 것', 'Waiting for me')}<span className="ez-shell-n">{props.waiting.length}</span></h2>
            {props.waiting.map((item) => (
              <button key={item.approvalId} type="button" className="ez-shell-row" data-need="true" onClick={() => props.onOpenWaiting(item)} data-testid="shell-live-waiting">
                <Led tone="amber" />
                <span className="ez-shell-row__t">{waitingKindText(item.kind, text)} · {item.title}</span>
                <span className="ez-shell-row__m">{providerName(item.providerId)} · {item.kind === 'question' ? text('답 기다림', 'answer needed') : text('허용 또는 거부', 'allow or deny')}</span>
              </button>
            ))}
          </>
        )}
        <h2 className="ez-shell-live__sec">
          <Glyph name="new" size={14} />{text('대화', 'Conversations')}<span className="ez-shell-n">{props.conversations.length}</span>
          <button type="button" className="ez-shell-live__add" aria-label={text('새 대화', 'New conversation')} onClick={props.onNewConversation} data-testid="shell-live-new">+</button>
        </h2>
        {shown.map((item) => (
          <span key={item.sessionId} style={{ display: 'contents' }}>
            <button type="button" className="ez-shell-row" data-need={item.lamp === 'amber' || undefined} aria-current={props.focus === item.sessionId ? 'true' : undefined}
              onClick={() => props.onOpenConversation(item.sessionId)} data-testid="shell-live-row" data-session={item.sessionId}>
              <Led tone={item.lamp} />
              <span className="ez-shell-row__t">{item.title}</span>
              <span className="ez-shell-row__m">
                {providerName(item.providerId)} · {conversationStateText(item.state, text)}{item.children.length > 0 ? text(` · 하위 ${item.children.length}`, ` · ${item.children.length} sub`) : ''}
              </span>
            </button>
            {item.children.map((child) => (
              <button key={child.sessionId} type="button" className="ez-shell-row" data-child="true" aria-current={props.focus === child.sessionId ? 'true' : undefined}
                onClick={() => props.onOpenConversation(child.sessionId)}
                aria-label={text(`${child.title} (하위 에이전트, ${conversationStateText(child.state, text)})`, `${child.title} (subagent, ${conversationStateText(child.state, text)})`)}>
                <Led tone={child.lamp} />
                <span className="ez-shell-row__t">{child.title}</span>
              </button>
            ))}
          </span>
        ))}
        <button type="button" className="ez-shell-row" data-more="true" onClick={props.onAllConversations} data-testid="shell-live-all">
          <span /><span className="ez-shell-row__t">{text('모두 보기 · 지난 대화와 CLI 기록', 'All · past conversations and CLI history')}</span>
        </button>
        {props.flows.length > 0 && (
          <>
            <h2 className="ez-shell-live__sec"><Glyph name="flow" size={14} />{text('흐름', 'Flows')}<span className="ez-shell-n">{props.flows.length}</span></h2>
            {props.flows.map((flow) => (
              <button key={flow.subprojectId} type="button" className="ez-shell-row" data-need={flow.lamp === 'amber' || undefined}
                onClick={() => props.onOpenFlow(flow.subprojectId)} data-testid="shell-live-flow">
                <Led tone={flow.lamp} />
                <span className="ez-shell-row__t">{flow.title}{flow.runNumber > 0 ? text(` · 실행 #${flow.runNumber}`, ` · run #${flow.runNumber}`) : ''}</span>
                {flow.runNumber > 0
                  ? <span className="ez-shell-row__chain"><StageChain stages={flow.stages} compact /></span>
                  : <span className="ez-shell-row__m">{flowPhaseText(flow.phase, text)}</span>}
              </button>
            ))}
          </>
        )}
        <h2 className="ez-shell-live__sec">
          <Glyph name="term" size={14} />{text('터미널', 'Terminals')}<kbd>Ctrl `</kbd><span className="ez-shell-n">{props.terminals.length}</span>
          <button type="button" className="ez-shell-live__add" aria-label={text('새 터미널', 'New terminal')} onClick={props.onNewTerminal} data-testid="shell-live-new-terminal">+</button>
        </h2>
        {props.terminals.map((terminal) => (
          <button key={terminal.panelId} type="button" className="ez-shell-row" aria-current={props.focus === terminal.panelId ? 'true' : undefined}
            onClick={() => props.onOpenTerminal(terminal.panelId)} data-testid="shell-live-terminal">
            <Led tone="idle" />
            <span className="ez-shell-row__t">{terminal.title}</span>
            {terminal.detail && <span className="ez-shell-row__m ez-shell-mono">{terminal.detail}</span>}
          </button>
        ))}
      </div>
      <div className="ez-shell-live__foot">
        {other && (
          <button type="button" className="ez-shell-live__other" onClick={() => props.onOtherProject(other.projectId)} data-testid="shell-live-other">
            <Led tone={other.waiting > 0 ? 'amber' : other.failed > 0 ? 'red' : 'on'} />
            {text('다른 프로젝트', 'Other projects')}: {props.others.slice(0, 2).map((project) => `${project.name} ${project.waiting > 0 ? text(`기다림 ${project.waiting}`, `${project.waiting} waiting`) : project.failed > 0 ? text(`멈춤 ${project.failed}`, `${project.failed} stopped`) : text(`작업 ${project.working}`, `${project.working} working`)}`).join(' · ')}
          </button>
        )}
        <div className="ez-shell-live__tools">
          {props.tools.map((tool) => (
            <button key={tool.id} type="button" className="ez-shell-iconbtn" aria-label={tool.label} title={tool.label} aria-pressed={props.activeTool === tool.id}
              onClick={() => props.onTool(tool.id)} data-testid={`shell-tool-${tool.id}`}>
              <Glyph name={tool.glyph} />
            </button>
          ))}
        </div>
      </div>
    </nav>
  );
}
