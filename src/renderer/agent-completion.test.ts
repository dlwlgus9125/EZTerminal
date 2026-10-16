import { describe, expect, it } from 'vitest';
import { completionToken, insertCompletion } from './agent-completion';

describe('caret completion boundaries', () => {
  it('replaces the whole token at the caret without losing suffix, reply or attachments', () => {
    const value = { text: 'Please $revxxx then explain', selectionStart: 11, selectionEnd: 11,
      replyTo: { messageId: 'm1', text: 'Earlier question', role: 'user' as const }, attachments: [] };
    const token = completionToken(value.text, value.selectionStart, value.selectionEnd);
    expect(token).toEqual({ start: 7, end: 14, trigger: '$', query: 'rev' });
    const next = insertCompletion(value, '$review', token);
    expect(next.text).toBe('Please $review then explain');
    expect(next.replyTo).toBe(value.replyTo);
    expect(next.attachments).toBe(value.attachments);
    expect(next.selectionStart).toBe(14);
  });
  it.each(['https://example.com/rev', 'open /tmp/folder', '`/resume', 'echo foo$rev', 'C:\\Work\\$rev'])('does not hijack path/code %s', text => {
    expect(completionToken(text)).toBeUndefined();
  });
  it('mentions a workspace path with @, including separators, but not inside an email or code', () => {
    const text = 'see @src/au please';
    expect(completionToken(text, 11)).toEqual({ start: 4, end: 11, trigger: '@', query: 'src/au' });
    const next = insertCompletion({ text, selectionStart: 11, selectionEnd: 11 }, '@src/auth/useLogin.ts', completionToken(text, 11));
    expect(next.text).toBe('see @src/auth/useLogin.ts please');
    expect(completionToken('mail me@example.com')).toBeUndefined();
    expect(completionToken('`@src')).toBeUndefined();
  });
  it('does not complete a selected passage or path with a suffix beyond the caret', () => {
    expect(completionToken('$review', 1, 5)).toBeUndefined();
    expect(completionToken('/resume/notes', 7)).toBeUndefined();
  });
});
