import { SafeMarkdown } from '../../SafeMarkdown';
import { useChatContext } from '../ChatContext';

/**
 * Markdown body of a chat message. Interim: SafeMarkdown with links wired;
 * replaced by the streaming-aware ChatMarkdown module.
 */
export function Prose({ markdown, variant }: {
  readonly markdown: string;
  readonly streaming?: boolean;
  readonly variant: 'prose' | 'cli';
}): JSX.Element {
  const context = useChatContext();
  return (
    <SafeMarkdown
      className={`chat-prose chat-prose--${variant}`}
      markdown={markdown}
      {...(context.onOpenLink ? { openExternalHttpUrl: context.onOpenLink } : {})}
    />
  );
}
