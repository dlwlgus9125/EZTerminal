import { useState } from 'react';

import type { ChatTool } from '../model/types';
import { useChatContext } from '../ChatContext';
import { useChatCopy } from '../copy';
import { DiffView } from './DiffView';

/** Characters shown before "show all"; mirrors Orca's tool detail cap. */
export const TOOL_DETAIL_LIMIT = 4_000;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/gu;

export function cleanOutput(text: string): string {
  return text.replace(ANSI, '').replace(/\r\n?/gu, '\n').replace(/\n+$/u, '');
}

export function OutputBlock({ text, label, tone }: {
  readonly text: string;
  readonly label: string;
  readonly tone?: 'error';
}): JSX.Element {
  const copy = useChatCopy();
  const [full, setFull] = useState(false);
  const cleaned = cleanOutput(text);
  const truncated = !full && cleaned.length > TOOL_DETAIL_LIMIT;
  const shown = truncated ? cleaned.slice(0, TOOL_DETAIL_LIMIT) : cleaned;
  const lines = cleaned.split('\n').length;
  return (
    <div className="chat-output" data-tone={tone}>
      <pre className="chat-output__pre" aria-label={label} tabIndex={0}><code>{shown || copy.noOutput}</code></pre>
      {truncated && (
        <button type="button" className="chat-link-button" onClick={() => setFull(true)}>
          {copy.showAll(lines)}
        </button>
      )}
    </div>
  );
}

function prettyInput(tool: ChatTool): string | undefined {
  if (tool.inputValue) {
    // Bodies the diff view already shows are left out of the input listing.
    const rest = Object.fromEntries(Object.entries(tool.inputValue).filter(([key]) => !['content', 'old_string', 'new_string'].includes(key)));
    if (!Object.keys(rest).length) return undefined;
    return JSON.stringify(rest, null, 2);
  }
  return tool.input?.trim() || undefined;
}

/** Expanded body of one tool line: command + output, diffs, or input/output. */
export function ToolDetail({ tool, variant = 'card' }: {
  readonly tool: ChatTool;
  readonly variant?: 'card' | 'cli';
}): JSX.Element {
  const copy = useChatCopy();
  const { workspaceRoot } = useChatContext();
  const failed = tool.status === 'failed' || tool.status === 'denied';
  if (tool.changes?.length) {
    return (
      <div className="chat-tool-detail">
        {tool.changes.map((change, index) => <DiffView key={`${change.path}:${index}`} change={change} variant={variant} workspaceRoot={workspaceRoot} />)}
      </div>
    );
  }
  if (tool.category === 'command') {
    return (
      <div className="chat-tool-detail">
        {tool.command && <pre className="chat-output__command"><code>{`$ ${tool.command}`}</code></pre>}
        {tool.output !== undefined && <OutputBlock text={tool.output} label={copy.output} tone={failed ? 'error' : undefined} />}
      </div>
    );
  }
  const input = tool.category === 'read' || tool.category === 'edit' || tool.category === 'write' ? undefined : prettyInput(tool);
  return (
    <div className="chat-tool-detail">
      {input && <OutputBlock text={input} label={copy.input} />}
      {tool.output !== undefined && <OutputBlock text={tool.output} label={copy.output} tone={failed ? 'error' : undefined} />}
    </div>
  );
}

export function hasToolDetail(tool: ChatTool): boolean {
  return Boolean(tool.changes?.length || tool.output || tool.command || prettyInput(tool));
}
