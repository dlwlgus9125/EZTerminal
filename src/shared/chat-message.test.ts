import { describe, expect, it } from 'vitest';
import { ChatMessageContextSchema, MAX_CHAT_ATTACHMENT_BYTES, promptWithChatContext } from './chat-message';

describe('chat message context', () => {
  it('keeps explicit skill references and rejects unknown provider or unbounded selections', () => {
    const reference = { providerId: 'codex', id: '/skills/review/SKILL.md', name: 'review', invocation: '$review' };
    expect(ChatMessageContextSchema.parse({ skills: [reference] }).skills).toEqual([reference]);
    expect(ChatMessageContextSchema.safeParse({ skills: [{ ...reference, providerId: 'unknown' }] }).success).toBe(false);
    expect(ChatMessageContextSchema.safeParse({ skills: Array(21).fill(reference) }).success).toBe(false);
  });
  it('keeps quoted reply and text files distinct from the user request', () => {
    expect(promptWithChatContext('Explain this', {
      replyTo: { messageId: 'message-1', text: 'Earlier answer' },
      attachments: [{ id: 'a', kind: 'text', mimeType: 'text/plain', name: 'notes.txt', data: 'line 1\nline 2' }],
    })).toContain('Attached text file "notes.txt":\n"line 1\\nline 2"');
  });

  it('rejects binary text, unsupported image formats and oversized inline attachments', () => {
    for (const attachment of [
      { kind: 'text', mimeType: 'text/plain', data: '\0binary' },
      { kind: 'image', mimeType: 'image/svg+xml', data: 'YWJj' },
      { kind: 'image', mimeType: 'image/png', data: 'not base64' },
      { kind: 'text', mimeType: 'text/plain', data: 'x'.repeat(MAX_CHAT_ATTACHMENT_BYTES + 1) },
    ]) expect(ChatMessageContextSchema.safeParse({ attachments: [{ id: 'a', name: 'file', ...attachment }] }).success).toBe(false);
  });

  it('bounds the combined wire payload including JSON escaping and multibyte text', () => {
    const attachment = { kind: 'text', mimeType: 'text/plain', name: 'notes.txt', data: '\n'.repeat(240 * 1024) };
    expect(ChatMessageContextSchema.safeParse({ attachments: [{ id: 'a', ...attachment }] }).success).toBe(true);
    expect(ChatMessageContextSchema.safeParse({ attachments: [{ id: 'a', ...attachment }, { id: 'b', ...attachment }] }).success).toBe(false);
  });
});
