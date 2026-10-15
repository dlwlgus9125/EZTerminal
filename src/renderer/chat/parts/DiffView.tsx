import { FileMinus2, FilePen, FilePlus2 } from 'lucide-react';
import { useMemo } from 'react';

import { reviewLines, type RecordedFileChange } from '../../../shared/conversation-changes';

/** Max lines rendered per file before "show all"; the viewport scrolls within 288px. */
const MAX_LINES = 400;

function displayPath(path: string): string {
  return path.replace(/<WORKSPACE>[\\/]+/gu, '').replace(/\\\\/gu, '\\');
}

export function diffCounts(change: RecordedFileChange): { readonly added: number; readonly removed: number } {
  const lines = change.patch.split('\n');
  return {
    added: lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
    removed: lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
  };
}

/**
 * Unified diff of one recorded change. Line numbers appear only for real
 * provider patches; Claude edit fragments carry no file positions.
 */
export function DiffView({ change, variant = 'card' }: {
  readonly change: RecordedFileChange;
  readonly variant?: 'card' | 'cli';
}): JSX.Element {
  const lines = useMemo(() => reviewLines(change).slice(0, MAX_LINES), [change]);
  const { added, removed } = diffCounts(change);
  const Icon = removed === 0 && added > 0 ? FilePlus2 : added === 0 && removed > 0 ? FileMinus2 : FilePen;
  const numbered = change.coverage === 'patch';
  return (
    <figure className="chat-diff" data-variant={variant}>
      <figcaption className="chat-diff__header">
        <Icon aria-hidden="true" />
        <span className="chat-diff__path" title={displayPath(change.path)}>{displayPath(change.path)}</span>
        <span className="chat-diff__counts">
          {added > 0 && <span className="chat-diff__added">+{added}</span>}
          {removed > 0 && <span className="chat-diff__removed">−{removed}</span>}
        </span>
      </figcaption>
      <div className="chat-diff__body" role="region" aria-label={displayPath(change.path)} tabIndex={0}>
        <table className="chat-diff__table">
          <tbody>
            {lines.map((line, index) => (
              <tr key={index} className="chat-diff__line" data-kind={line.kind}>
                {numbered && <td className="chat-diff__number" aria-hidden="true">{line.before ?? ''}</td>}
                {numbered && <td className="chat-diff__number" aria-hidden="true">{line.after ?? ''}</td>}
                <td className="chat-diff__code"><code>{line.text || ' '}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
