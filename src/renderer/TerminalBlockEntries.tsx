import { memo, type ReactNode } from 'react';

import { Block } from './Block';
import type { BlockController } from './block-controller';
import type { TerminalRuntimeOptions } from './xterm-runtime';
import type { RuntimeLifecycleTier } from '../shared/runtime-lifecycle';

export interface TerminalBlockEntry {
  readonly id: string;
  readonly controller: BlockController | null;
}

export const TerminalBlockEntries = memo(function TerminalBlockEntries({
  entries,
  activeTakeoverController,
  terminalRuntimeOptions,
  runtimeLifecycleTier = 'active',
  pendingLabel,
  onDismiss,
  variant = 'default',
  menuFor,
}: {
  readonly entries: readonly TerminalBlockEntry[];
  readonly activeTakeoverController: BlockController | null;
  readonly terminalRuntimeOptions?: TerminalRuntimeOptions;
  readonly runtimeLifecycleTier?: RuntimeLifecycleTier;
  readonly pendingLabel: string;
  readonly onDismiss: (id: string) => void;
  /** The desktop terminal's instrument blocks; Android keeps `default`. */
  readonly variant?: 'default' | 'instrument';
  /** Header actions of an instrument block (its menu). */
  readonly menuFor?: (entry: TerminalBlockEntry & { readonly controller: BlockController }) => ReactNode;
}): JSX.Element {
  const instrument = variant === 'instrument';
  return (
    <>
      {entries.map((entry) => entry.controller ? (
        <Block
          key={entry.id}
          controller={entry.controller}
          onDismiss={() => onDismiss(entry.id)}
          isTakeover={activeTakeoverController === entry.controller}
          terminalRuntimeOptions={terminalRuntimeOptions}
          runtimeLifecycleTier={runtimeLifecycleTier}
          {...(instrument ? {
            variant,
            blockId: entry.id,
            ...(menuFor ? { menu: menuFor({ ...entry, controller: entry.controller }) } : {}),
          } : {})}
        />
      ) : (
        <section
          key={entry.id}
          className={instrument ? 'block block--instrument' : 'block'}
          data-testid="block"
          data-status="running"
        >
          <div className="block-pending">{pendingLabel}</div>
        </section>
      ))}
    </>
  );
});
