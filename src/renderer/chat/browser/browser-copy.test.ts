import { describe, expect, it } from 'vitest';

import { chatCopy } from '../copy';

/** Every string the browser copy says, with sample arguments for the ones that are functions. */
function strings(value: unknown, path = 'browser'): readonly (readonly [string, string])[] {
  if (typeof value === 'string') return [[path, value]];
  if (typeof value === 'function') return [[path, String((value as (...args: unknown[]) => unknown)('A', 'B', 'C'))]];
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, entry]) => strings(entry, `${path}.${key}`));
  return [];
}

const all = (locale: 'ko' | 'en'): readonly (readonly [string, string])[] => strings(chatCopy(locale).browser);

describe('in-app browser wording', () => {
  it('never says the AI read or saw a page: what the app knows is what it sent', () => {
    const claims = /AI가 (?:읽었|봤|확인했)|읽었습니다|확인했습니다|the AI (?:read|saw|checked|verified)\b/iu;
    for (const locale of ['ko', 'en'] as const) for (const [path, text] of all(locale)) expect(text, `${locale} ${path}`).not.toMatch(claims);
    expect(chatCopy('ko').browser.steps.screenshot).toContain('보냄');
    expect(chatCopy('en').browser.steps.screenshot).toContain('sent');
    expect(chatCopy('ko').browser.run.lastShot('14:41')).toContain('AI에게 보낸');
  });

  it('says plainly that allowing a site makes nothing safe, and that a page can steer the AI', () => {
    const ko = chatCopy('ko').browser.allow;
    expect(ko.warnTitle).toContain('안전해지는 것은 아닙니다');
    expect(ko.warn).toContain('AI를 움직이려 할 수 있고');
    expect(ko.warn).toContain('찾아내지 못합니다');
    const en = chatCopy('en').browser.allow;
    expect(en.warnTitle).toContain('does not make it safe');
    expect(en.warn).toContain('try to steer the AI');
  });

  it('says what full access leaves unguarded, and that the allow reaches full-access conversations in the project', () => {
    const ko = chatCopy('ko').browser.allow;
    expect(ko.warnFull).toContain('묻지 않고');
    expect(ko.warnFull).toContain('명령 실행이나 파일 변경');
    expect(ko.projectWide).toContain('전체 권한 대화');
    const en = chatCopy('en').browser.allow;
    expect(en.warnFull).toContain('without asking');
    expect(en.projectWide).toContain('full-access conversation');
  });

  it('gives a refusal no slot for page text: each reason is one fixed sentence', () => {
    for (const locale of ['ko', 'en'] as const) for (const reason of Object.values(chatCopy(locale).browser.refusal)) expect(typeof reason).toBe('string');
  });

  it('does not promise a retry after an allow: the tool was already refused', () => {
    expect(chatCopy('ko').browser.pane.strip.allowedDetail).toContain('저절로 다시 시도하지 않습니다');
    expect(chatCopy('en').browser.pane.strip.allowedDetail).toContain('does not try again');
  });

  it('keeps the phone from implying it can answer, and says what no answer does and by when', () => {
    const ko = chatCopy('ko').browser.waiting;
    expect(ko.title).toBe('데스크톱에서 승인 대기');
    expect(ko.note('14:45')).toContain('폰에서는 답할 수 없습니다');
    expect(ko.note('14:45')).toContain('14:45까지');
    expect(ko.note('14:45')).toContain('실행되지 않고 시간 초과');
    expect(chatCopy('en').browser.waiting.note('14:45')).toContain('does not run and it times out');
  });

  it('names what 중지 stops before it is pressed, and says the guard stays on after', () => {
    const ko = chatCopy('ko').browser.pane.strip;
    expect(ko.stop).toBe('브라우저만 중지');
    expect(ko.stoppedDetail).toContain('허용하지 않은 사이트로 가는 이동은 계속 막습니다');
    const en = chatCopy('en').browser.pane.strip;
    expect(en.stop).toBe('Stop browser only');
    expect(en.stoppedDetail).toContain('stays blocked');
  });

  it('says whose values an approval shows, and that a change voids it', () => {
    const ko = chatCopy('ko').browser.approval;
    expect(ko.held).toContain('앱이 보관한');
    expect(ko.voided).toContain('무효');
    expect(chatCopy('en').browser.approval.held).toContain('Held by the app');
    expect(chatCopy('en').browser.approval.voided).toContain('void');
  });

  it('says the automatic check runs once and that its turn is the AI asked, not the page confirmed', () => {
    const ko = chatCopy('ko').browser.check;
    expect(ko.once).toContain('한 번만');
    expect(ko.noCalls).toContain('본 기록이 없습니다');
    expect(ko.state.done).not.toMatch(/통과|성공|확인됨/u);
    const en = chatCopy('en').browser.check;
    expect(en.once).toContain('One turn only');
    expect(en.state.done).not.toMatch(/passed|verified|confirmed/iu);
  });

  it('never offers cookie import; the profile stays apart', () => {
    expect(chatCopy('ko').browser.settings.profileHint).toContain('가져오지 않습니다');
    expect(chatCopy('en').browser.settings.profileHint).toContain('never imported');
  });
});
