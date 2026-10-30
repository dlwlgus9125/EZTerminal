import { describe, expect, it } from 'vitest';

import { cartStory, formatStory, waitingStory } from '../wrap-up/wrap-up-fixtures';
import { buildChatModel } from './build-chat-model';
import type { ChatRow } from './types';

function kinds(rows: readonly ChatRow[]): string[] {
  return rows.map((row) => row.kind);
}

function toolNames(rows: readonly ChatRow[]): string[] {
  return rows.flatMap((row) => (row.kind === 'activity' ? row.entries.flatMap((entry) => (entry.kind === 'tool' ? [entry.tool.name] : [])) : []));
}

describe('turn wrap-up rows (시안)', () => {
  it('puts the suggested tasks, then the recap, after the turn’s last message and its change card', () => {
    const fixture = cartStory('ko', 'claude');
    const model = buildChatModel({
      items: fixture.items, turns: fixture.turns,
      wrapUp: { tasks: fixture.tasks!, recaps: [{ turnId: 'turn-cart', providerId: 'claude', trigger: 'unattended', state: 'complete', text: 'Fixed the cart loop.', createdAt: fixture.turns[0]!.finishedAt! }] },
    });
    expect(kinds(model.rows).slice(-4)).toEqual(['assistant', 'changes', 'task-suggestions', 'recap']);
    const card = model.rows.find((row) => row.kind === 'task-suggestions');
    expect(card?.kind === 'task-suggestions' && card.suggestions.tasks.map((task) => task.title)).toEqual([
      'Fix the always-true role check in src/auth.ts', 'Fix cents-to-dollars conversion in src/format.ts', 'Fix percentage math in applyDiscount (src/discount.ts)',
    ]);
  });

  it('folds the AI’s suggest_task calls into the card, for both AIs’ tool names', () => {
    for (const provider of ['claude', 'codex'] as const) {
      const fixture = cartStory('en', provider);
      const withCard = buildChatModel({ items: fixture.items, turns: fixture.turns, wrapUp: { tasks: fixture.tasks! } });
      expect(toolNames(withCard.rows)).toEqual(['Read', 'Read', 'Read', 'Read', 'Edit']);
      // Without a card (an older host) the calls stay ordinary tool rows: nothing the AI did is hidden.
      const withoutCard = buildChatModel({ items: fixture.items, turns: fixture.turns });
      expect(toolNames(withoutCard.rows).filter((name) => name.endsWith('suggest_task'))).toHaveLength(3);
    }
  });

  it('shows nothing for a card whose turn is not among the loaded rows', () => {
    const fixture = formatStory('ko', 'claude');
    const model = buildChatModel({ items: fixture.items, turns: fixture.turns, wrapUp: { recaps: [{ ...fixture.recaps![0]!, turnId: 'turn-elsewhere' }] } });
    expect(kinds(model.rows)).not.toContain('recap');
  });

  it('says the AI waits only while the decision it stopped for is pending, and keeps the card before the live turn status', () => {
    const fixture = waitingStory('en');
    const waiting = buildChatModel({ items: fixture.items, turns: fixture.turns, approvals: fixture.approvals!, wrapUp: { recaps: fixture.recaps! } });
    const recap = waiting.rows.find((row) => row.kind === 'recap');
    expect(recap?.kind === 'recap' && recap.waitingNow).toBe(true);
    expect(kinds(waiting.rows).slice(-2)).toEqual(['recap', 'turn-status']);
    const answered = buildChatModel({
      items: fixture.items, turns: fixture.turns, approvals: fixture.approvals!.map((approval) => ({ ...approval, state: 'allowed' as const })), wrapUp: { recaps: fixture.recaps! },
    });
    const after = answered.rows.find((row) => row.kind === 'recap');
    expect(after?.kind === 'recap' && after.waitingNow).toBeFalsy();
  });
});
