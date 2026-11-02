import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BrowserShots } from './browser-shots';

let directory: string;

beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'ez-browser-shots-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');

describe('BrowserShots', () => {
  it('keeps a shot as a file of its conversation', async () => {
    await new BrowserShots(directory).save('chat', 'shot-1', JPEG);
    expect(readFileSync(path.join(directory, 'browser-shots', 'chat', 'shot-1.jpg')).toString('base64')).toBe(JPEG);
  });

  it('keeps the latest ones of a conversation, and no other conversation pays for it', async () => {
    const shots = new BrowserShots(directory, 3);
    for (const index of [1, 2, 3, 4, 5]) await shots.save('chat', `shot-${String(index)}`, JPEG);
    await shots.save('other', 'shot-1', JPEG);
    expect(readdirSync(path.join(directory, 'browser-shots', 'chat')).sort()).toEqual(['shot-3.jpg', 'shot-4.jpg', 'shot-5.jpg']);
    expect(readdirSync(path.join(directory, 'browser-shots', 'other'))).toEqual(['shot-1.jpg']);
  });

  it('remembers the order across a restart', async () => {
    await new BrowserShots(directory, 2).save('chat', 'shot-1', JPEG);
    await new Promise((resolve) => { setTimeout(resolve, 15); });
    await new BrowserShots(directory, 2).save('chat', 'shot-2', JPEG);
    await new Promise((resolve) => { setTimeout(resolve, 15); });
    await new BrowserShots(directory, 2).save('chat', 'shot-3', JPEG);
    expect(readdirSync(path.join(directory, 'browser-shots', 'chat')).sort()).toEqual(['shot-2.jpg', 'shot-3.jpg']);
  });

  it('goes with its conversation', async () => {
    const shots = new BrowserShots(directory);
    await shots.save('chat', 'shot-1', JPEG);
    await shots.forget('chat');
    expect(existsSync(path.join(directory, 'browser-shots', 'chat'))).toBe(false);
  });

  it('stays in its own folder, whatever the conversation is called', async () => {
    await new BrowserShots(directory).save('../../escape', 'shot-1', JPEG);
    expect(existsSync(path.join(directory, '..', 'escape'))).toBe(false);
    expect(readdirSync(path.join(directory, 'browser-shots'))).toHaveLength(1);
  });
});
