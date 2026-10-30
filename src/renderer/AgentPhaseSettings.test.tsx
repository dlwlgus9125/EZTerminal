// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_CHAT_AGENT_PHASES } from '../shared/chat-agent-profiles';
import { AgentPhaseSettings } from './AgentPhaseSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('단계 연결 › 검토', () => {
  for (const ko of [true, false]) {
    it(`says the review agent is what "review with another AI" uses (${ko ? 'ko' : 'en'})`, () => {
      act(() => root.render(<AgentPhaseSettings ko={ko} profiles={[]} phases={EMPTY_CHAT_AGENT_PHASES} providers={[]} onChange={vi.fn()} />));
      const review = container.querySelector('[data-provider="any"]')!.textContent!;
      expect(review).toContain(ko ? '검토… › 다른 AI로 검토' : 'Review… › Another AI');
      expect(review).not.toContain(ko ? '검토 맡기기' : 'Hand off a review');
    });
  }
});
