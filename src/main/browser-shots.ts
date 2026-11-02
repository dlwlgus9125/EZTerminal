import { promises as fs } from 'node:fs';
import path from 'node:path';

const SHOTS_DIR = 'browser-shots';
const KEPT_PER_CONVERSATION = 100;

/**
 * The screenshots an AI took, on this PC only, by conversation. A row carries at most a thumbnail: a whole shot is about a
 * megabyte, and rows go to phones. The oldest go first, and all of them go with the conversation.
 */
export class BrowserShots {
  constructor(private readonly dir: string, private readonly kept = KEPT_PER_CONVERSATION) {}

  /** A name is one folder, whatever a conversation is called. */
  private folder(conversationId: string): string {
    return path.join(this.dir, SHOTS_DIR, encodeURIComponent(conversationId).replace(/\./gu, '%2E'));
  }

  async save(conversationId: string, shotId: string, jpegBase64: string): Promise<void> {
    const folder = this.folder(conversationId);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, `${encodeURIComponent(shotId)}.jpg`), Buffer.from(jpegBase64, 'base64'));
    const names = await fs.readdir(folder);
    if (names.length <= this.kept) return;
    const aged = await Promise.all(names.map(async (name) => ({ name, at: (await fs.stat(path.join(folder, name))).mtimeMs })));
    aged.sort((left, right) => left.at - right.at || left.name.localeCompare(right.name));
    await Promise.all(aged.slice(0, aged.length - this.kept).map(({ name }) => fs.rm(path.join(folder, name), { force: true })));
  }

  async forget(conversationId: string): Promise<void> {
    await fs.rm(this.folder(conversationId), { recursive: true, force: true });
  }
}
