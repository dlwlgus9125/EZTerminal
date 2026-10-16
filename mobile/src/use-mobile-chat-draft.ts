import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChatComposerDraft } from '../../src/renderer/chat-view-state';
import type { DaemonCommand, DaemonCommandReceipt } from '../../src/shared/daemon-protocol';
import { mobileAgentCreateAuthorityFingerprint } from './mobile-agent-create-recovery-store';
import { MobileChatStateStore, type MobileChatRecord, type MobileChatStateStoreLike } from './mobile-chat-state-store';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';

export type MobileChatSaveStatus = 'loading' | 'saved' | 'saving' | 'unavailable';

/** Every save is scoped; no effect sends a command, including after reconnect. */
export function useMobileChatDraft({transport,projectId,sessionId,store}: {
  readonly transport?: WsEzTerminalTransport;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly store?: MobileChatStateStoreLike;
}) {
  const storeRef=useRef(store ?? new MobileChatStateStore());
  const generationRef=useRef(0);
  const recordRef=useRef<MobileChatRecord | null>(null);
  const queueRef=useRef<Promise<void>>(Promise.resolve());
  const sendingRef=useRef(false);
  const [record,setRecord]=useState<MobileChatRecord | null>(null);
  const [status,setStatus]=useState<MobileChatSaveStatus>('loading');
  const [sending,setSending]=useState(false);
  const [reload,setReload]=useState(0);

  useEffect(() => {
    const generation=++generationRef.current;
    recordRef.current=null;queueRef.current=Promise.resolve();sendingRef.current=false;
    setRecord(null);setStatus('loading');setSending(false);
    if (!transport || !projectId || !sessionId) return;
    void (async () => {
      const authorityFingerprint=await mobileAgentCreateAuthorityFingerprint(await transport.getRemoteToken());
      const scope={authorityFingerprint,projectId,sessionId};
      const loaded=await storeRef.current.load(scope) ?? {schemaVersion:1 as const,scope,draft:{text:''}};
      if (generation !== generationRef.current) return;
      recordRef.current=loaded;setRecord(loaded);setStatus('saved');
    })().catch(() => { if (generation === generationRef.current) setStatus('unavailable'); });
    return () => { generationRef.current = generation + 1; };
  },[transport,projectId,sessionId,reload]);

  const persist=useCallback((next:MobileChatRecord):Promise<void> => {
    const generation=generationRef.current;
    setStatus('saving');
    const write=queueRef.current.catch(() => undefined).then(() => storeRef.current.save(next));
    queueRef.current=write;
    void write.then(() => {
      if (generation === generationRef.current && queueRef.current === write) setStatus('saved');
    },() => {
      if (generation === generationRef.current && queueRef.current === write) setStatus('unavailable');
    });
    return write;
  },[]);

  const onDraftChange=useCallback((draft:ChatComposerDraft):void => {
    const current=recordRef.current;
    if (!current) return;
    const next={...current,draft};
    recordRef.current=next;setRecord(next);
    void persist(next).catch(() => undefined);
  },[persist]);

  const send=useCallback(async (command:DaemonCommand):Promise<DaemonCommandReceipt | null> => {
    const current=recordRef.current;
    if (!transport?.isAuthed || !current || sendingRef.current) return null;
    const generation=generationRef.current;
    // A later edited draft must not replace an uncertain exact envelope.
    if (current.pending && (current.pending.type !== command.type
      || JSON.stringify(current.pending.payload) !== JSON.stringify(command.payload))) return null;
    const envelope=current.pending ?? command;
    const prepared={...current,pending:envelope};
    sendingRef.current=true;setSending(true);
    try {
      recordRef.current=prepared;setRecord(prepared);
      await persist(prepared);
      if (generation !== generationRef.current || !transport.isAuthed) return null;
      const receipt=await transport.sendDaemonCommand(envelope).catch(() => null);
      if (generation !== generationRef.current) return receipt;
      if (!receipt || (!receipt.ok && receipt.status === 'delivery-uncertain')) return receipt;
      const latest=recordRef.current ?? prepared;
      const sameDraft=JSON.stringify(latest.draft) === JSON.stringify(prepared.draft);
      const payload=envelope.payload;
      const matchesSentDraft='prompt' in payload && payload.prompt === latest.draft.text.trim()
        && JSON.stringify('context' in payload ? payload.context?.attachments ?? [] : []) === JSON.stringify(latest.draft.attachments ?? [])
        && JSON.stringify('context' in payload ? payload.context?.skills ?? [] : []) === JSON.stringify((latest.draft.skills ?? []).filter((skill) => latest.draft.text.includes(skill.invocation)))
        && JSON.stringify('context' in payload ? payload.context?.replyTo ?? null : null) === JSON.stringify(latest.draft.replyTo ?? null);
      const next:MobileChatRecord={schemaVersion:1,scope:latest.scope,draft:receipt.ok && sameDraft && matchesSentDraft ? {text:''} : latest.draft};
      // Do not declare success before the escrow is durably settled.
      recordRef.current=next;setRecord(next);
      try { await persist(next); }
      catch {
        const afterFailure=recordRef.current ?? next;
        const recovery={...afterFailure,pending:envelope,
          draft:JSON.stringify(afterFailure.draft) === JSON.stringify(next.draft) ? latest.draft : afterFailure.draft};
        recordRef.current=recovery;setRecord(recovery);
        throw new Error('The delivery receipt could not be saved securely.');
      }
      return receipt;
    } catch { return null; }
    finally {
      if (generation === generationRef.current) { sendingRef.current=false;setSending(false); }
    }
  },[persist,transport]);

  const retryStorage=useCallback(():void => {
    if (recordRef.current) void persist(recordRef.current).catch(() => undefined);
    else setReload(value => value+1);
  },[persist]);
  return {draftState:record?.draft,onDraftChange,status,pending:record?.pending,sending,send,retryStorage};
}
