export type ChatSkin = 'bubble' | 'cli';
export type { ChatComposerDraft } from '../shared/chat-message';
export interface TranscriptAnchor {
  readonly top: number;
  readonly follow: boolean;
  readonly messageId?: string;
  readonly offset?: number;
}

const SKIN_KEY = 'ezterminal.chat.skin';
const SKIN_EVENT = 'ezterminal-chat-skin-changed';

export function readChatSkin(): ChatSkin {
  try { return localStorage.getItem(SKIN_KEY) === 'cli' ? 'cli' : 'bubble'; } catch { return 'bubble'; }
}
export function writeChatSkin(skin: ChatSkin): void {
  try { localStorage.setItem(SKIN_KEY, skin); } catch { /* A storage failure must not block changing the current view. */ }
  window.dispatchEvent(new CustomEvent(SKIN_EVENT, { detail: skin }));
}
export function subscribeChatSkin(listener: (skin: ChatSkin) => void): () => void {
  const local = (event: Event) => listener((event as CustomEvent<ChatSkin>).detail);
  const external = (event: StorageEvent) => { if (event.key === SKIN_KEY) listener(readChatSkin()); };
  window.addEventListener(SKIN_EVENT, local);
  window.addEventListener('storage', external);
  return () => { window.removeEventListener(SKIN_EVENT, local); window.removeEventListener('storage', external); };
}
export function captureTranscriptAnchor(viewport: HTMLElement): TranscriptAnchor {
  const top = viewport.getBoundingClientRect().top;
  const visible = Array.from(viewport.querySelectorAll<HTMLElement>('[data-message-id]'))
    .find((element) => element.getBoundingClientRect().bottom > top);
  return {
    top: viewport.scrollTop,
    follow: viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80,
    ...(visible ? { messageId: visible.dataset.messageId, offset: visible.getBoundingClientRect().top - top } : {}),
  };
}
export function restoreTranscriptAnchor(viewport: HTMLElement, anchor: TranscriptAnchor): void {
  if (anchor.follow) { viewport.scrollTop = viewport.scrollHeight; return; }
  const target = Array.from(viewport.querySelectorAll<HTMLElement>('[data-message-id]'))
    .find((element) => element.dataset.messageId === anchor.messageId);
  if (target && anchor.offset !== undefined) {
    viewport.scrollTop += target.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor.offset;
  } else viewport.scrollTop = anchor.top;
}
