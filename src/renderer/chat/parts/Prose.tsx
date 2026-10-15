import { useMemo } from 'react';

import { useChatContext } from '../ChatContext';
import { useChatCopy } from '../copy';
import { ChatMarkdown, type ChatMarkdownLabels } from '../markdown/ChatMarkdown';

/** Markdown body of a chat message, with links routed to the host. */
export function Prose({ markdown, streaming = false, variant }: {
  readonly markdown: string;
  readonly streaming?: boolean;
  readonly variant: 'prose' | 'cli';
}): JSX.Element {
  const context = useChatContext();
  const copy = useChatCopy();
  const labels = useMemo<Partial<ChatMarkdownLabels>>(() => ({
    copyCode: copy.copyCode, copied: copy.copied, copyFailed: copy.copyFailed,
    wrapLines: copy.wrapLines, task: copy.task, blockedImage: copy.blockedImage,
  }), [copy]);
  return (
    <ChatMarkdown
      markdown={markdown}
      streaming={streaming}
      variant={variant}
      labels={labels}
      {...(context.onOpenLink ? { onOpenLink: context.onOpenLink } : {})}
    />
  );
}
