import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';

import type { DaemonSnapshot, DaemonTranscriptItem } from '../../src/shared/daemon-protocol';
import type { SecureStorageLike } from './mobile-agent-create-recovery-store';
import { isDaemonSnapshot, isDaemonTranscriptItem } from './transport/ws-transport-contract';

export interface MobileOfflineChatCache {
  readonly schemaVersion: 1;
  readonly authorityFingerprint: string;
  readonly savedAt: string;
  readonly snapshot: DaemonSnapshot;
  readonly transcripts: Readonly<Record<string,readonly DaemonTranscriptItem[]>>;
}
const MAX_BYTES=8*1024*1024;
const queues=new Map<string,Promise<void>>();
/** Usage and live /btw availability are shown only while connected: the phone keeps no copy. */
const USAGE_KEYS=new Set(['agentUsage','providerUsage','sideQuestionSessionIds']);
const withoutUsage=(snapshot:DaemonSnapshot):DaemonSnapshot => snapshot.agentUsage === undefined && snapshot.providerUsage === undefined && snapshot.sideQuestionSessionIds === undefined
  ? snapshot
  : Object.fromEntries(Object.entries(snapshot).filter(([key]) => !USAGE_KEYS.has(key))) as unknown as DaemonSnapshot;
const keyFor=(authority:string):string => {
  if (!/^sha256:[a-f0-9]{64}$/u.test(authority)) throw new Error('Invalid offline cache authority.');
  return `ezterminal-offline-chat-v1:${authority.slice(7)}`;
};

/** Encrypted, explicitly stale read cache. It never owns or starts a live session. */
export class MobileOfflineChatCacheStore {
  constructor(private readonly secure:SecureStorageLike=SecureStoragePlugin) {}

  async load(authority:string):Promise<MobileOfflineChatCache | null> {
    const key=keyFor(authority);
    if ((await this.secure.getPlatform()).value !== 'android') return null;
    if (!(await this.secure.keys()).value.includes(key)) return null;
    const raw=(await this.secure.get({key})).value;
    if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) throw new Error('Offline chat cache is too large.');
    const value=JSON.parse(raw) as MobileOfflineChatCache;
    if (value?.schemaVersion !== 1 || value.authorityFingerprint !== authority
      || typeof value.savedAt !== 'string' || !isDaemonSnapshot(value.snapshot)
      || !value.transcripts || typeof value.transcripts !== 'object' || Array.isArray(value.transcripts)) throw new Error('Invalid offline chat cache.');
    for (const [sessionId,items] of Object.entries(value.transcripts)) {
      if (!value.snapshot.sessions.some(session => session.id === sessionId)
        || !Array.isArray(items) || items.length > 2_000
        || !items.every(item => isDaemonTranscriptItem(item,sessionId))) throw new Error('Invalid cached transcript.');
    }
    return {...value,snapshot:withoutUsage(value.snapshot)};
  }

  private update(authority:string,mutate:(current:MobileOfflineChatCache | null)=>MobileOfflineChatCache | null):Promise<void> {
    const key=keyFor(authority);
    const write=(queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if ((await this.secure.getPlatform()).value !== 'android') return;
      const current=await this.load(authority);
      const next=mutate(current);
      if (!next) return;
      const raw=JSON.stringify(next);
      if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) throw new Error('Offline chat cache storage limit reached.');
      if (!(await this.secure.set({key,value:raw})).value
        || (await this.secure.get({key})).value !== raw) throw new Error('Offline chat cache write failed.');
    });
    queues.set(key,write);
    void write.finally(() => {if (queues.get(key) === write) queues.delete(key);}).catch(() => undefined);
    return write;
  }

  saveSnapshot(authority:string,snapshot:DaemonSnapshot):Promise<void> {
    if (!isDaemonSnapshot(snapshot)) return Promise.reject(new Error('Invalid daemon cache snapshot.'));
    return this.update(authority,current => ({schemaVersion:1,authorityFingerprint:authority,savedAt:new Date().toISOString(),snapshot:withoutUsage(snapshot),
      transcripts:Object.fromEntries(Object.entries(current?.transcripts ?? {}).filter(([id]) => snapshot.sessions.some(session => session.id === id))),
    }));
  }

  saveTranscript(authority:string,sessionId:string,items:readonly DaemonTranscriptItem[]):Promise<void> {
    const retained=items.filter(item => !item.isSensitive).slice(-2_000);
    if (!retained.every(item => isDaemonTranscriptItem(item,sessionId))) return Promise.reject(new Error('Invalid transcript cache input.'));
    return this.update(authority,current => {
      if (!current?.snapshot.sessions.some(session => session.id === sessionId)) return current;
      return {...current,savedAt:new Date().toISOString(),transcripts:{...current.transcripts,[sessionId]:retained}};
    });
  }
}
