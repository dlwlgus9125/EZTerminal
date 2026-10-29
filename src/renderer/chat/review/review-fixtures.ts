import { encodeFileChanges, type RecordedFileChange } from '../../../shared/conversation-changes';
import type { DaemonTranscriptItem, DaemonTurn } from '../../../shared/daemon-protocol';
import {
  composeFixPrompt, findingId, reviewSummaryText, type ReviewFinding, type ReviewTarget, type ReviewerRef,
} from '../../../shared/review-findings';
import type { ReviewPayload } from '../../../shared/transcript-payload';

/**
 * Review-loop fixtures for the 시안 stories and the renderer tests: a cart kit where a conversation
 * changed price formatting, a discount helper and the cart loop. The `src/format.ts:2` and
 * `src/discount.ts:4` findings are the real answers Claude and Codex gave in the 2026-10-29 probes
 * (artifacts/review-findings-probe); `src/cart.ts:5`, `src/auth.ts:6` and `src/cart.ts:1` are
 * written to match the seeded bugs of the probe repository (scripts/review-probe-repo.mjs).
 */

export const REVIEW_ROOT = 'C:\\Working\\cart-kit';
export const REVIEW_SESSION = 'review-chat';
export const REVIEWER_SESSION = 'review-chat-codex-review';
/** Fixed clock for everything that is not live, so screenshots stay the same. */
export const REVIEW_T0 = Date.parse('2026-10-29T00:40:00.000Z');

const iso = (offsetSeconds: number): string => new Date(REVIEW_T0 + offsetSeconds * 1_000).toISOString();

type FindingDraft = Omit<ReviewFinding, 'id'>;

export function withId(reviewId: string, draft: FindingDraft): ReviewFinding {
  return { ...draft, id: findingId(reviewId, draft.file, draft.line, draft.title) };
}

// ── Findings ─────────────────────────────────────────────────────────────────

export const CLAUDE_FORMAT: FindingDraft = {
  file: 'src/format.ts', line: 2, endLine: 2, severity: 'critical', category: 'correctness',
  title: 'formatPrice divides cents by 10 instead of 100, so every price shows 10x too high',
  body: 'There are 100 cents in a dollar, but the change divides by 10. Every formatted price now comes out ten times its real value.',
  scenario: 'formatPrice(1999) now returns "$199.90". It should return "$19.99".',
  excerpt: { startLine: 2, lines: ['  const dollars = cents / 10;'] },
};

export const CLAUDE_DISCOUNT: FindingDraft = {
  file: 'src/discount.ts', line: 4, endLine: 4, severity: 'high', category: 'correctness',
  title: 'applyDiscount treats percent as a fraction, so a 15% discount subtracts 15x the total',
  body: 'The doc comment says percent is a whole number (15 means 15%), but the code multiplies total by percent without dividing by 100. Any percent above 1 gives a negative result, and percent = 1 gives 0.',
  scenario: 'applyDiscount(200, 15) returns 200 - 3000 = -2800. It should return 170.',
  excerpt: { startLine: 4, lines: ['  return total - total * percent;'] },
};

export const CLAUDE_CART: FindingDraft = {
  file: 'src/cart.ts', line: 5, endLine: 5, severity: 'high', category: 'correctness',
  title: 'The loop runs to index <= items.length, so it reads one item past the end of the cart',
  body: 'With <= the last pass reads items[items.length], which is undefined, and reading .price from it throws.',
  scenario: 'cartTotal([{ price: 500, quantity: 2 }]) throws "Cannot read properties of undefined (reading \'price\')" instead of returning 1000.',
  excerpt: { startLine: 5, lines: ['  for (let index = 0; index <= items.length; index += 1) {'] },
};

export const CODEX_AUTH: FindingDraft = {
  file: 'src/auth.ts', line: 6, endLine: 6, severity: 'critical', category: 'security',
  title: 'The access check is always true',
  body: 'indexOf never returns less than -1, so have >= -1 holds for every role, and || accepts before the ranks are compared. Unknown roles pass as well.',
  scenario: 'canAccess("guest", "admin") returns true; it should return false. canAccess("nobody", "admin") also returns true.',
  excerpt: { startLine: 6, lines: ['  return have >= -1 || have >= need;'] },
};

export const CODEX_CART: FindingDraft = {
  file: 'src/cart.ts', line: 5, endLine: 5, severity: 'high', category: 'correctness',
  title: 'Cart totals read past the last item',
  body: 'The loop condition uses <= items.length, so the final iteration dereferences an undefined item and throws for any non-empty cart.',
  scenario: 'cartTotal([{ price: 1000, quantity: 1 }]) throws a TypeError instead of returning 1000.',
  excerpt: { startLine: 5, lines: ['  for (let index = 0; index <= items.length; index += 1) {'] },
};

export const CODEX_DISCOUNT: FindingDraft = {
  file: 'src/discount.ts', line: 4, endLine: 4, severity: 'high', category: 'correctness',
  title: 'Percentage discounts are applied without dividing by 100',
  body: 'The documented input uses whole percentages, but the calculation treats them as multipliers. Ordinary discounts therefore produce negative totals; divide percent by 100 before multiplying.',
  scenario: 'applyDiscount(10000, 15) returns -140000 cents instead of 8500 cents.',
  excerpt: { startLine: 4, lines: ['  return total - total * percent;'] },
};

export const CODEX_FORMAT: FindingDraft = {
  file: 'src/format.ts', line: 2, endLine: 2, severity: 'medium', category: 'correctness',
  title: 'Formatted prices are ten times too large',
  body: 'Prices are stored in cents, so converting to dollars requires dividing by 100. Dividing by 10 inflates every nonzero displayed price tenfold.',
  scenario: 'formatPrice(1000) returns "$100.00" instead of "$10.00".',
  excerpt: { startLine: 2, lines: ['  const dollars = cents / 10;'] },
};

/** On a line the branch did not change: the walkthrough shows it as outside the change. */
export const CODEX_ITEM: FindingDraft = {
  file: 'src/cart.ts', line: 1, endLine: 1, severity: 'low', category: 'validation',
  title: 'Item accepts negative and fractional quantities',
  body: 'Nothing rejects quantity -1 or 0.5, so cartTotal can return a negative or fractional total.',
  scenario: 'cartTotal([{ price: 500, quantity: -2 }]) returns -1000.',
  excerpt: { startLine: 1, lines: ['export interface Item { price: number; quantity: number }'] },
};

// ── Diffs ────────────────────────────────────────────────────────────────────

const PATCH_FORMAT = [
  '@@ -1,4 +1,4 @@',
  ' export function formatPrice(cents: number): string {',
  '-  const dollars = cents / 100;',
  '+  const dollars = cents / 10;',
  '   return `$${dollars.toFixed(2)}`;',
  ' }',
].join('\n');

const PATCH_DISCOUNT = [
  '@@ -0,0 +1,5 @@',
  '+/** Applies a percentage discount, e.g. 15 for 15%. */',
  '+export function applyDiscount(total: number, percent: number): number {',
  '+  // percent is a whole number: 15 means 15%',
  '+  return total - total * percent;',
  '+}',
].join('\n');

const PATCH_CART = [
  '@@ -2,8 +2,8 @@',
  ' ',
  ' export function cartTotal(items: Item[]): number {',
  '   let total = 0;',
  '-  for (let index = 0; index < items.length; index += 1) {',
  '+  for (let index = 0; index <= items.length; index += 1) {',
  '     total += items[index].price * items[index].quantity;',
  '   }',
  '   return total;',
  ' }',
].join('\n');

/** The fix turn's edits in the outcomes fixture. */
const PATCH_AUTH_FIX = [
  '@@ -5,2 +5,2 @@',
  '   const need = ORDER.indexOf(required);',
  '-  return have >= -1 || have >= need;',
  '+  return have >= 0 && need >= 0 && have >= need;',
].join('\n');

const PATCH_CART_FIX = [
  '@@ -5,1 +5,1 @@',
  '-  for (let index = 0; index <= items.length; index += 1) {',
  '+  for (let index = 0; index < items.length; index += 1) {',
].join('\n');

const PATCH_CART_RENAME = [
  '@@ -4,4 +4,4 @@',
  '   let total = 0;',
  '-  for (let index = 0; index <= items.length; index += 1) {',
  '-    total += items[index].price * items[index].quantity;',
  '+  for (let i = 0; i <= items.length; i += 1) {',
  '+    total += items[i].price * items[i].quantity;',
  '   }',
].join('\n');

const PATCH_AUTH = [
  '@@ -3,5 +3,5 @@',
  ' export function canAccess(role: string, required: string): boolean {',
  '   const have = ORDER.indexOf(role);',
  '   const need = ORDER.indexOf(required);',
  '-  return have >= 0 && have >= need;',
  '+  return have >= -1 || have >= need;',
  ' }',
].join('\n');

function gitFile(path: string, patch: string, added = false): string {
  return [
    `diff --git a/${path} b/${path}`,
    ...(added ? ['new file mode 100644', '--- /dev/null'] : ['index 1f64b68..fe174bb 100644', `--- a/${path}`]),
    `+++ b/${path}`,
    patch,
  ].join('\n');
}

/** `git diff HEAD` plus the untracked file: what an uncommitted-changes review read. */
export const UNCOMMITTED_DIFF = `${[
  gitFile('src/cart.ts', PATCH_CART),
  gitFile('src/format.ts', PATCH_FORMAT),
  gitFile('src/discount.ts', PATCH_DISCOUNT, true),
].join('\n')}\n`;

/** The branch since it left main, uncommitted and untracked changes included. */
export const BRANCH_DIFF = `${[
  gitFile('src/auth.ts', PATCH_AUTH),
  gitFile('src/cart.ts', PATCH_CART),
  gitFile('src/format.ts', PATCH_FORMAT),
  gitFile('src/discount.ts', PATCH_DISCOUNT, true),
].join('\n')}\n`;

/** The files as they are now (the Files view and "파일에서 보기"). */
export const REVIEW_FILES: Readonly<Record<string, string>> = {
  'src/cart.ts': 'export interface Item { price: number; quantity: number }\n\nexport function cartTotal(items: Item[]): number {\n  let total = 0;\n  for (let index = 0; index <= items.length; index += 1) {\n    total += items[index].price * items[index].quantity;\n  }\n  return total;\n}\n',
  'src/format.ts': 'export function formatPrice(cents: number): string {\n  const dollars = cents / 10;\n  return `$${dollars.toFixed(2)}`;\n}\n',
  'src/discount.ts': '/** Applies a percentage discount, e.g. 15 for 15%. */\nexport function applyDiscount(total: number, percent: number): number {\n  // percent is a whole number: 15 means 15%\n  return total - total * percent;\n}\n',
  'src/auth.ts': "const ORDER = ['guest', 'member', 'admin'];\n\nexport function canAccess(role: string, required: string): boolean {\n  const have = ORDER.indexOf(role);\n  const need = ORDER.indexOf(required);\n  return have >= -1 || have >= need;\n}\n",
};

// ── Transcript items ─────────────────────────────────────────────────────────

function item(sequence: number, kind: DaemonTranscriptItem['kind'], text: string, overrides: Partial<DaemonTranscriptItem> = {}): DaemonTranscriptItem {
  const sessionId = overrides.sessionId ?? REVIEW_SESSION;
  return {
    id: `${sessionId}:${String(sequence)}`, sessionId, sequence, kind, text,
    isDelta: false, isSensitive: false, createdAt: iso(sequence * 4), ...overrides,
  };
}

function edit(sequence: number, turnId: string, path: string, patch: string, name: 'Edit' | 'Write' = 'Edit'): DaemonTranscriptItem[] {
  const absolute = `${REVIEW_ROOT}\\${path.replace(/\//gu, '\\')}`;
  const callId = `call-${String(sequence)}`;
  const change: RecordedFileChange = { path: absolute, patch, coverage: 'patch' };
  const added = patch.split('\n').filter((line) => line.startsWith('+')).length;
  const removed = patch.split('\n').filter((line) => line.startsWith('-')).length;
  return [
    item(sequence, 'tool-call', `${name}\n${JSON.stringify({ file_path: absolute })}`, {
      turnId, payload: { v: 1, type: 'tool', callId, name, category: name === 'Write' ? 'write' : 'edit', phase: 'call', status: 'running', target: absolute },
    }),
    item(sequence + 1, 'tool-result', encodeFileChanges([change])!, {
      turnId,
      payload: { v: 1, type: 'tool', callId, name, category: name === 'Write' ? 'write' : 'edit', phase: 'result', status: 'completed', files: [{ path: absolute, kind: name === 'Write' ? 'add' : 'update', added, removed }] },
    }),
  ];
}

export type FixtureLanguage = 'ko' | 'en';

const PERSON = {
  ko: {
    ask: '가격은 센트로 받아서 달러로 표시해 줘. 할인 함수도 추가해 줘 — 할인율은 15처럼 정수 퍼센트로 받아. 장바구니 합계 루프도 정리해 줘.',
    answer: 'formatPrice가 센트를 받아 달러로 표시하게 바꾸고, `src/discount.ts`에 `applyDiscount(total, percent)`를 추가했습니다. 장바구니 합계 루프도 인덱스 하나로 정리했습니다.',
    rename: 'cart.ts 루프 변수 이름은 i로 바꿔 줘.',
    renamed: '`src/cart.ts`의 루프 변수 이름을 `i`로 바꿨습니다.',
    tests: '할인 함수에 테스트도 추가해 줘.',
    testing: '`src/discount.test.ts`에 15%, 0%, 100% 할인 경우를 넣고 있습니다…',
  },
  en: {
    ask: 'Take prices in cents and show them in dollars. Add a discount helper too — the rate comes as a whole percent like 15. And tidy up the cart total loop.',
    answer: 'formatPrice now takes cents and shows dollars, and `src/discount.ts` has `applyDiscount(total, percent)`. The cart total loop now walks one index.',
    rename: 'Rename the loop variable in cart.ts to i.',
    renamed: 'Renamed the loop variable in `src/cart.ts` to `i`.',
    tests: 'Add tests for the discount helper too.',
    testing: 'Adding 15%, 0% and 100% cases to `src/discount.test.ts`…',
  },
} as const;

/** The conversation's first turn: the changes every review below looks at. */
function firstTurn(lang: FixtureLanguage = 'ko'): DaemonTranscriptItem[] {
  return [
    item(1, 'user-message', PERSON[lang].ask, { turnId: 'turn-1' }),
    ...edit(2, 'turn-1', 'src/format.ts', PATCH_FORMAT),
    ...edit(4, 'turn-1', 'src/discount.ts', PATCH_DISCOUNT, 'Write'),
    ...edit(6, 'turn-1', 'src/cart.ts', PATCH_CART),
    item(8, 'assistant-message', PERSON[lang].answer, { turnId: 'turn-1' }),
  ];
}

function turn(id: string, state: DaemonTurn['state'], startedAt: string, finishedAt?: string): DaemonTurn {
  return {
    id, sessionId: REVIEW_SESSION, commandId: `command-${id}`, state, revision: 1, startedAt,
    ...(finishedAt ? { finishedAt } : {}), createdAt: startedAt, updatedAt: finishedAt ?? startedAt,
  };
}

const SELF_CLAUDE: ReviewerRef = { mode: 'self', providerId: 'claude', model: 'claude-opus-5-5' };
const OTHER_CODEX: ReviewerRef = { mode: 'other', providerId: 'codex', sessionId: REVIEWER_SESSION, model: 'gpt-6.1-sol' };
const UNCOMMITTED: ReviewTarget = { kind: 'uncommitted' };
const BRANCH: ReviewTarget = { kind: 'base-branch', baseRef: 'main' };

/** A review row's payload from shared findings (the payload's schema type has mutable arrays). */
export function reviewPayload(payload: Omit<ReviewPayload, 'v' | 'type' | 'findings'> & { readonly findings?: readonly ReviewFinding[] }): ReviewPayload {
  const { findings, ...rest } = payload;
  return {
    v: 1, type: 'review', ...rest,
    ...(findings ? { findings: findings.map(({ excerpt, ...finding }) => ({ ...finding, ...(excerpt ? { excerpt: { startLine: excerpt.startLine, lines: [...excerpt.lines] } } : {}) })) } : {}),
  };
}

function reviewRow(sequence: number, payload: Omit<ReviewPayload, 'v' | 'type' | 'findings'> & { readonly findings?: readonly ReviewFinding[] }, createdAt?: string): DaemonTranscriptItem {
  const full = reviewPayload(payload);
  const label = `${payload.reviewer.providerId === 'codex' ? 'Codex' : 'Claude'}${payload.reviewer.mode === 'other' ? ' (other AI)' : ''}`;
  const text = reviewSummaryText({
    reviewerLabel: label, state: payload.state, ...(payload.findings ? { findings: payload.findings } : {}), ...(payload.reason ? { reason: payload.reason } : {}),
    ...(payload.waitingFor ? { waitingFor: payload.waitingFor } : {}),
  });
  return item(sequence, 'notice', text, { payload: full, ...(createdAt ? { createdAt } : {}) });
}

export interface ReviewFixture {
  readonly items: readonly DaemonTranscriptItem[];
  readonly turns: readonly DaemonTurn[];
  /** The conversation's state for the panel. */
  readonly state: 'idle' | 'working';
  readonly reviewId: string;
}

const finishedFirstTurn = (): DaemonTurn => turn('turn-1', 'completed', iso(4), iso(34));

/** Claude reviews its own conversation (read-only fork) and is still reading; `now` sets the elapsed clock. */
export function runningSelfReview(now: number): ReviewFixture {
  const reviewId = 'review-claude-running';
  return {
    reviewId, state: 'idle', turns: [finishedFirstTurn()],
    items: [...firstTurn(), reviewRow(40, { reviewId, reviewer: SELF_CLAUDE, target: UNCOMMITTED, state: 'running' }, new Date(now - 12_000).toISOString())],
  };
}

/** Codex is asked while Claude is still answering: the review waits for the turn to end. */
export function queuedOtherReview(now: number): ReviewFixture {
  const reviewId = 'review-codex-queued';
  return {
    reviewId, state: 'working',
    turns: [finishedFirstTurn(), turn('turn-2', 'working', new Date(now - 21_000).toISOString())],
    items: [
      ...firstTurn(),
      item(10, 'user-message', PERSON.ko.tests, { turnId: 'turn-2', createdAt: new Date(now - 21_000).toISOString() }),
      reviewRow(12, { reviewId, reviewer: { mode: 'other', providerId: 'codex' }, target: BRANCH, state: 'queued', waitingFor: 'turn', focus: '금액 계산과 권한 검사' }, new Date(now - 6_000).toISOString()),
      item(13, 'assistant-message', PERSON.ko.testing, { turnId: 'turn-2', isDelta: true, createdAt: new Date(now - 4_000).toISOString() }),
    ],
  };
}

/** The conversation is idle, but as many conversations as may run at once already do: the Codex review waits its turn. */
export function slotQueuedReview(now: number): ReviewFixture {
  const reviewId = 'review-codex-slot';
  return {
    reviewId, state: 'idle',
    turns: [finishedFirstTurn()],
    items: [
      ...firstTurn(),
      reviewRow(12, { reviewId, reviewer: { mode: 'other', providerId: 'codex' }, target: BRANCH, state: 'queued', waitingFor: 'slot', focus: '금액 계산과 권한 검사' }, new Date(now - 6_000).toISOString()),
    ],
  };
}

export const MIXED_REVIEW_ID = 'review-claude-mixed';

/**
 * Claude's review of the uncommitted changes, three problems later: the format one is being
 * fixed, the discount one was dismissed, and the cart file changed after the review (stale).
 */
export function mixedSelfReview(now: number, lang: FixtureLanguage = 'ko'): ReviewFixture {
  const reviewId = MIXED_REVIEW_ID;
  const findings = [CLAUDE_FORMAT, CLAUDE_DISCOUNT, CLAUDE_CART].map((draft) => withId(reviewId, draft));
  const [format, discount] = findings;
  const fix = composeFixPrompt({ reviewerLabel: 'Claude', findings: [format!] });
  return {
    reviewId, state: 'working',
    turns: [
      finishedFirstTurn(),
      turn('turn-2', 'completed', iso(130), iso(150)),
      turn('turn-3', 'working', new Date(now - 18_000).toISOString()),
    ],
    items: [
      ...firstTurn(lang),
      reviewRow(20, { reviewId, reviewer: SELF_CLAUDE, target: UNCOMMITTED, state: 'running' }, iso(80)),
      reviewRow(21, {
        reviewId, reviewer: SELF_CLAUDE, target: UNCOMMITTED, state: 'complete', findings, durationMs: 38_000,
        overall: 'formatPrice shows prices ten times too high, applyDiscount turns normal discounts into negative totals, and the cart loop reads past its last item.',
      }, iso(118)),
      item(30, 'user-message', PERSON[lang].rename, { turnId: 'turn-2', createdAt: iso(130) }),
      ...edit(31, 'turn-2', 'src/cart.ts', PATCH_CART_RENAME),
      item(33, 'assistant-message', PERSON[lang].renamed, { turnId: 'turn-2', createdAt: iso(148) }),
      item(34, 'notice', 'Review finding dismissed.', { payload: { v: 1, type: 'review-status', reviewId, findingIds: [discount!.id], state: 'dismissed' }, createdAt: iso(160) }),
      item(40, 'user-message', fix.ok ? fix.text : '', {
        turnId: 'turn-3', createdAt: new Date(now - 18_000).toISOString(), payload: { v: 1, type: 'review-fix', reviewId, findingIds: [format!.id] },
      }),
      item(41, 'tool-call', `Edit\n${JSON.stringify({ file_path: `${REVIEW_ROOT}\\src\\format.ts` })}`, {
        turnId: 'turn-3', createdAt: new Date(now - 9_000).toISOString(),
        payload: { v: 1, type: 'tool', callId: 'call-fix-format', name: 'Edit', category: 'edit', phase: 'call', status: 'running', target: `${REVIEW_ROOT}\\src\\format.ts` },
      }),
    ],
  };
}

export const OTHER_REVIEW_ID = 'review-codex-branch';

/** Codex reviews the branch since main in a read-only conversation of its own. */
export function otherAiReview(): ReviewFixture {
  const reviewId = OTHER_REVIEW_ID;
  const findings = [CODEX_AUTH, CODEX_CART, CODEX_DISCOUNT, CODEX_FORMAT, CODEX_ITEM].map((draft) => withId(reviewId, draft));
  return {
    reviewId, state: 'idle', turns: [finishedFirstTurn()],
    items: [
      ...firstTurn(),
      reviewRow(20, { reviewId, reviewer: { mode: 'other', providerId: 'codex' }, target: BRANCH, state: 'queued', focus: '금액 계산과 권한 검사' }, iso(70)),
      reviewRow(21, { reviewId, reviewer: OTHER_CODEX, target: BRANCH, state: 'running', focus: '금액 계산과 권한 검사' }, iso(72)),
      reviewRow(22, {
        reviewId, reviewer: OTHER_CODEX, target: BRANCH, state: 'complete', focus: '금액 계산과 권한 검사', findings, durationMs: 39_000,
        overall: 'The branch has an always-true access check and three money bugs: cart totals throw, discounts go negative and prices show ten times too high.',
      }, iso(111)),
    ],
  };
}

/** A second review after the fixes: nothing left to report. */
export function emptyReview(): ReviewFixture {
  const reviewId = 'review-claude-empty';
  return {
    reviewId, state: 'idle', turns: [finishedFirstTurn()],
    items: [
      ...firstTurn(),
      reviewRow(20, { reviewId, reviewer: SELF_CLAUDE, target: UNCOMMITTED, state: 'running' }, iso(60)),
      reviewRow(21, { reviewId, reviewer: SELF_CLAUDE, target: UNCOMMITTED, state: 'complete', findings: [], durationMs: 21_000,
        overall: 'Both functions now convert and discount correctly.' }, iso(81)),
    ],
  };
}

/** The reviewer answered in prose instead of the findings format. */
export function failedReview(): ReviewFixture {
  const reviewId = 'review-claude-failed';
  return {
    reviewId, state: 'idle', turns: [finishedFirstTurn()],
    items: [
      ...firstTurn(),
      reviewRow(20, { reviewId, reviewer: SELF_CLAUDE, target: UNCOMMITTED, state: 'running' }, iso(60)),
      reviewRow(21, {
        reviewId, reviewer: SELF_CLAUDE, target: UNCOMMITTED, state: 'failed',
        reason: 'invalid-output',
        rawText: 'I reviewed the diff. The main problem is in src/format.ts: dividing cents by 10 makes every price ten times too high. applyDiscount in src/discount.ts also multiplies by the whole percent, so 15 subtracts fifteen times the total.',
      }, iso(92)),
    ],
  };
}

/** The conversation's AI cannot review here; the other one can. */
export function unsupportedReview(): ReviewFixture {
  const reviewId = 'review-codex-unsupported';
  return {
    reviewId, state: 'idle', turns: [finishedFirstTurn()],
    items: [
      ...firstTurn(),
      reviewRow(20, {
        reviewId, reviewer: { mode: 'self', providerId: 'codex' }, target: UNCOMMITTED, state: 'unsupported',
        reason: 'provider-too-old',
      }, iso(60)),
    ],
  };
}

/** EZTerminal closed while the review ran. */
export function interruptedReview(): ReviewFixture {
  const reviewId = 'review-claude-interrupted';
  return {
    reviewId, state: 'idle', turns: [finishedFirstTurn()],
    items: [
      ...firstTurn(),
      reviewRow(20, { reviewId, reviewer: SELF_CLAUDE, target: UNCOMMITTED, state: 'running' }, iso(60)),
      reviewRow(21, { reviewId, reviewer: SELF_CLAUDE, target: UNCOMMITTED, state: 'interrupted', reason: 'app-closed' }, iso(64)),
    ],
  };
}

/** The person stopped the review. */
export function cancelledReview(): ReviewFixture {
  const reviewId = 'review-claude-cancelled';
  return {
    reviewId, state: 'idle', turns: [finishedFirstTurn()],
    items: [
      ...firstTurn(),
      reviewRow(20, { reviewId, reviewer: SELF_CLAUDE, target: UNCOMMITTED, state: 'running' }, iso(60)),
      reviewRow(21, { reviewId, reviewer: SELF_CLAUDE, target: UNCOMMITTED, state: 'cancelled' }, iso(70)),
    ],
  };
}

export const OUTCOMES_REVIEW_ID = 'review-codex-outcomes';

/**
 * What a fix turn leaves behind, one problem each: Codex's branch review after a fix turn whose reply says the access
 * check was fixed and the discount was left on purpose (with why), and does not mention the cart loop it edited
 * (응답 끝 · 확인 필요). The format problem is being fixed now and the item check was dismissed.
 */
export function fixOutcomesReview(now: number): ReviewFixture {
  const reviewId = OUTCOMES_REVIEW_ID;
  const findings = [CODEX_AUTH, CODEX_CART, CODEX_DISCOUNT, CODEX_FORMAT, CODEX_ITEM].map((draft) => withId(reviewId, draft));
  const [auth, cart, discount, format, itemCheck] = findings;
  const first = composeFixPrompt({ reviewerLabel: 'Codex', findings: [auth!, cart!, discount!] });
  const second = composeFixPrompt({ reviewerLabel: 'Codex', findings: [format!] });
  return {
    reviewId, state: 'working',
    turns: [finishedFirstTurn(), turn('turn-2', 'completed', iso(130), iso(170)), turn('turn-3', 'working', new Date(now - 12_000).toISOString())],
    items: [
      ...firstTurn(),
      reviewRow(22, {
        reviewId, reviewer: OTHER_CODEX, target: BRANCH, state: 'complete', focus: '금액 계산과 권한 검사', findings, durationMs: 39_000,
        overall: 'The branch has an always-true access check and three money bugs: cart totals throw, discounts go negative and prices show ten times too high.',
      }, iso(111)),
      item(30, 'user-message', first.ok ? first.text : '', {
        turnId: 'turn-2', createdAt: iso(130), payload: { v: 1, type: 'review-fix', reviewId, findingIds: [auth!.id, cart!.id, discount!.id] },
      }),
      ...edit(31, 'turn-2', 'src/auth.ts', PATCH_AUTH_FIX),
      ...edit(33, 'turn-2', 'src/cart.ts', PATCH_CART_FIX),
      item(35, 'assistant-message', [
        '권한 검사는 역할을 모를 때 거부하도록 고쳤고, 장바구니 루프는 마지막 항목에서 멈추게 했습니다.',
        '',
        `- \`${auth!.id}\`: fixed`,
        `- \`${discount!.id}\`: not changed (호출하는 쪽이 이미 0.15 같은 비율을 넘깁니다. 여기서 100으로 나누면 그쪽이 깨집니다.)`,
      ].join('\n'), { turnId: 'turn-2', createdAt: iso(168) }),
      item(36, 'notice', 'Review finding dismissed.', { payload: { v: 1, type: 'review-status', reviewId, findingIds: [itemCheck!.id], state: 'dismissed' }, createdAt: iso(172) }),
      item(40, 'user-message', second.ok ? second.text : '', {
        turnId: 'turn-3', createdAt: new Date(now - 12_000).toISOString(), payload: { v: 1, type: 'review-fix', reviewId, findingIds: [format!.id] },
      }),
    ],
  };
}

const MODULES = ['orders', 'payments', 'refunds', 'invoices', 'coupons', 'shipping', 'tax', 'returns'] as const;

/** A large change: the reviewer sent more than a card keeps, and some paths were outside the folder. */
export function truncatedReview(): ReviewFixture {
  const reviewId = 'review-codex-truncated';
  const findings = Array.from({ length: 32 }, (_, index): ReviewFinding => {
    const module = MODULES[index % MODULES.length]!;
    const line = 12 + (index * 7) % 60;
    return withId(reviewId, {
      file: `src/${module}/${module}-${String(Math.floor(index / MODULES.length) + 1)}.ts`, line, endLine: line,
      severity: index < 3 ? 'high' : index < 12 ? 'medium' : 'low', category: 'correctness',
      title: `${module} amounts are rounded before the total is summed`,
      body: 'Each line is rounded to cents before it is added, so totals drift by up to a cent per line.',
    });
  });
  return {
    reviewId, state: 'idle', turns: [finishedFirstTurn()],
    items: [
      ...firstTurn(),
      reviewRow(20, { reviewId, reviewer: OTHER_CODEX, target: BRANCH, state: 'complete', findings, truncated: true, dropped: 3, durationMs: 94_000,
        overall: 'Rounding happens per line in every money module.' }, iso(140)),
    ],
  };
}

/** The other AI's own read-only conversation: the request it received, then its answer. */
export function reviewerConversation(): readonly DaemonTranscriptItem[] {
  return [
    item(1, 'user-message', 'Review the changes on this branch since it left `main`, including uncommitted and untracked files, for correctness bugs only, most severe first. …', {
      sessionId: REVIEWER_SESSION, turnId: 'review-turn',
      payload: { v: 1, type: 'review-request', reviewId: OTHER_REVIEW_ID, target: BRANCH, focus: '금액 계산과 권한 검사' },
    }),
    item(2, 'assistant-message', '{"findings":[{"file":"src/auth.ts","line":6,"title":"The access check is always true", …}],"overall":"The branch has an always-true access check and three money bugs."}', {
      sessionId: REVIEWER_SESSION, turnId: 'review-turn',
    }),
  ];
}

export const REVIEW_TARGETS = { uncommitted: UNCOMMITTED, branch: BRANCH } as const;

/** The same conversation under another session id (stories keep their view state apart). */
export function inSession(fixture: ReviewFixture, sessionId: string): ReviewFixture {
  return {
    ...fixture,
    items: fixture.items.map((entry) => (entry.sessionId === REVIEW_SESSION ? { ...entry, sessionId, id: entry.id.replace(REVIEW_SESSION, sessionId) } : entry)),
    turns: fixture.turns.map((entry) => ({ ...entry, sessionId })),
  };
}

const ACTIVE_TURN: ReadonlySet<DaemonTurn['state']> = new Set(['queued', 'submitting', 'working', 'blocked', 'delivery-uncertain']);

/**
 * What a host does with a card action, for stories: a dismissal or reopening is a status row, a fix
 * is a new turn with the fix message (queued behind a running turn), stopping ends the review.
 * Other actions (walkthrough, retry, …) change nothing in the transcript.
 */
export function applyReviewAction(
  state: { readonly items: readonly DaemonTranscriptItem[]; readonly turns: readonly DaemonTurn[] },
  action: { readonly kind: string; readonly reviewId: string; readonly findingIds?: readonly string[] },
  now: number,
): { readonly items: readonly DaemonTranscriptItem[]; readonly turns: readonly DaemonTurn[] } {
  const sessionId = state.items[0]?.sessionId ?? REVIEW_SESSION;
  const sequence = Math.max(0, ...state.items.map((entry) => entry.sequence)) + 1;
  const at = new Date(now).toISOString();
  const latest = [...state.items].reverse().find((entry) => entry.payload?.type === 'review' && entry.payload.reviewId === action.reviewId);
  const review = latest?.payload?.type === 'review' ? latest.payload : undefined;
  const base = { id: `${sessionId}:${String(sequence)}`, sessionId, sequence, isDelta: false, isSensitive: false, createdAt: at };
  if ((action.kind === 'dismiss' || action.kind === 'reopen') && action.findingIds?.length) {
    return {
      ...state,
      items: [...state.items, { ...base, kind: 'notice', text: action.kind === 'dismiss' ? 'Review finding dismissed.' : 'Review finding reopened.',
        payload: { v: 1, type: 'review-status', reviewId: action.reviewId, findingIds: [...action.findingIds], state: action.kind === 'dismiss' ? 'dismissed' : 'open' } }],
    };
  }
  if ((action.kind === 'fix' || action.kind === 'fix-all') && review && action.findingIds?.length) {
    const findings = (review.findings ?? []).filter((finding) => action.findingIds!.includes(finding.id));
    const prompt = composeFixPrompt({ reviewerLabel: review.reviewer.providerId === 'codex' ? 'Codex' : 'Claude', findings });
    // A message that does not fit is never sent; the card only offers batches that fit.
    if (!prompt.ok) return state;
    const turnId = `fix-${String(sequence)}`;
    const busy = state.turns.some((entry) => ACTIVE_TURN.has(entry.state));
    return {
      items: [...state.items, { ...base, kind: 'user-message', turnId, text: prompt.text,
        payload: { v: 1, type: 'review-fix', reviewId: action.reviewId, findingIds: [...action.findingIds] } }],
      turns: [...state.turns, turn(turnId, busy ? 'queued' : 'working', at)].map((entry) => ({ ...entry, sessionId })),
    };
  }
  if (action.kind === 'cancel' && review) {
    return { ...state, items: [...state.items, { ...base, kind: 'notice', text: 'Review stopped.', payload: { ...review, state: 'cancelled' } }] };
  }
  return state;
}

/** The id of the fixture review's problem at `index` in the card's reading order. */
export function walkFindingId(fixture: ReviewFixture, index: number): string | undefined {
  const latest = [...fixture.items].reverse().find((entry) => entry.payload?.type === 'review' && entry.payload.reviewId === fixture.reviewId);
  const findings = latest?.payload?.type === 'review' ? latest.payload.findings ?? [] : [];
  const files = [...new Set(findings.map((finding) => finding.file))];
  const ordered = files.flatMap((file) => findings.filter((finding) => finding.file === file)
    .sort((left, right) => (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER)));
  return ordered[index]?.id;
}
