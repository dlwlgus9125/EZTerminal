import { useCallback, useMemo } from 'react';

import { useChatContext } from '../ChatContext';
import { useChatCopy } from '../copy';
import { ChatMarkdown, type ChatMarkdownLabels } from '../markdown/ChatMarkdown';
import type { FileLinkTarget } from '../markdown/file-links';

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
  const { onOpenResults, resolveFileLink } = context;
  const openFile = useCallback((file: FileLinkTarget) => {
    onOpenResults?.('files', { path: file.path, ...(file.line ? { line: file.line } : {}) });
  }, [onOpenResults]);
  return (
    <ChatMarkdown
      markdown={markdown}
      streaming={streaming}
      variant={variant}
      labels={labels}
      {...(context.onOpenLink ? { onOpenLink: context.onOpenLink } : {})}
      {...(onOpenResults && resolveFileLink ? { resolveFileLink, onOpenFile: openFile } : {})}
    />
  );
}
