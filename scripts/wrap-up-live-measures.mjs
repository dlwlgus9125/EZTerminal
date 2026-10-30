/**
 * What scripts/verify-ux-live.mjs reads about the real providers while the product runs them: Claude's OTLP
 * `api_request` events and the JSON-RPC stream of `codex app-server` (both from scripts/live-provider-tap.cjs).
 * Cache ratios are the probes' measure (approvals.md "턴 마무리"): what the first request of a call read from the
 * cache ÷ the size of the conversation just before it.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const KEPT_ATTRIBUTES = new Set(['event.name', 'event.timestamp', 'session.id', 'query_source', 'query_source_safe', 'model', 'input_tokens', 'cache_read_tokens',
  'cache_creation_tokens', 'output_tokens', 'duration_ms', 'cost_usd', 'status_code', 'error', 'agent_id']);

const number = (value) => (value === undefined || value === null || Number.isNaN(Number(value)) ? null : Number(value));
export const ratio = (part, whole) => (part === null || part === undefined || !whole ? null : Math.round((part / whole) * 1_000) / 1_000);

/** OTLP/HTTP JSON logs receiver: keeps api_request and api_error, tagged by endpoint path (the tap puts the session id there). */
export function startTelemetry(file) {
  const events = [];
  const value = (any) => any?.stringValue ?? (any?.intValue !== undefined ? Number(any.intValue) : undefined) ?? any?.doubleValue ?? any?.boolValue;
  const server = http.createServer((request, response) => {
    const tag = (request.url ?? '').split('/').filter(Boolean)[0];
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      try {
        let raw = Buffer.concat(chunks);
        if (/gzip/iu.test(String(request.headers['content-encoding'] ?? ''))) raw = gunzipSync(raw);
        const body = JSON.parse(raw.toString('utf8') || '{}');
        for (const resourceLogs of body.resourceLogs ?? []) {
          for (const scopeLogs of resourceLogs.scopeLogs ?? []) {
            for (const record of scopeLogs.logRecords ?? []) {
              const attributes = {};
              for (const attribute of record.attributes ?? []) if (KEPT_ATTRIBUTES.has(attribute.key)) attributes[attribute.key] = value(attribute.value);
              const name = String(attributes['event.name'] ?? value(record.body) ?? '');
              if (!/api_(request|error)$/u.test(name)) continue;
              const event = { receivedAt: Date.now(), tag, name, ...attributes };
              events.push(event);
              appendFileSync(file, `${JSON.stringify(event)}\n`);
            }
          }
        }
      } catch {
        // A malformed export shows up as missing telemetry.
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ events, port: server.address().port, close: () => server.close() }));
  });
}

/** One api_request as the scenarios read it. */
export function requestFacts(event) {
  return {
    at: Date.parse(event['event.timestamp'] ?? '') || event.receivedAt,
    source: event.query_source ?? event.query_source_safe ?? null,
    input: number(event.input_tokens), cacheRead: number(event.cache_read_tokens), cacheCreation: number(event.cache_creation_tokens),
    output: number(event.output_tokens), durationMs: number(event.duration_ms), model: event.model ?? null,
  };
}

export const requestTotal = (request) => (request ? (request.input ?? 0) + (request.cacheRead ?? 0) + (request.cacheCreation ?? 0) : null);

/** A Claude session's requests in order. The tag is the id the CLI was launched with; a resume keeps it. */
export function claudeRequests(telemetry, providerSessionId) {
  return telemetry.events.filter((event) => event.name.endsWith('api_request') && (event['session.id'] === providerSessionId || event.tag === providerSessionId))
    .map(requestFacts).sort((left, right) => left.at - right.at);
}

/** The first request of each call of `source`, with the conversation's size just before it. */
export function claudeCalls(requests, source) {
  const calls = [];
  for (const [index, request] of requests.entries()) {
    if (request.source !== source) continue;
    const previous = requests[index - 1];
    if (previous?.source === source && request.at - previous.at < 1_000) continue;
    const before = requests.slice(0, index).filter((entry) => entry.source === 'sdk').at(-1);
    calls.push({ ...request, context: requestTotal(before), ratio: ratio(request.cacheRead, requestTotal(before)) });
  }
  return calls;
}

/** The main turn's calls, cross-turn: each first `sdk` request after a gap, against the last `sdk` request before the gap. */
export function claudeTurnStarts(requests, turns) {
  const sdk = requests.filter((request) => request.source === 'sdk');
  return turns.flatMap((turn) => {
    const start = Date.parse(turn.startedAt ?? '') - 500;
    const end = Date.parse(turn.finishedAt ?? '') + 1_000;
    const first = sdk.find((request) => request.at >= start && request.at <= end);
    if (!first) return [];
    const before = sdk.filter((request) => request.at < first.at).at(-1);
    return [{ turnId: turn.id, ...first, context: requestTotal(before), ratio: ratio(first.cacheRead, requestTotal(before)) }];
  });
}

// ── Codex ────────────────────────────────────────────────────────────────────

export function tapRecords(directory) {
  const file = path.join(directory, 'provider-tap.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

const responseTo = (records, pid, id) => records.find((record) => record.pid === pid && record.direction === 'out' && record.data?.id === id && !record.data?.method);
const messageText = (params) => (params?.input ?? []).map((part) => part?.text ?? '').join('\n');

function forkPurpose(text, clientId) {
  if (String(clientId ?? '').startsWith('predict:') || text.includes('most likely next message')) return 'predict';
  if (text.includes('Recap for the person')) return 'recap';
  return 'other';
}

/** Every `thread/fork` with its turn: what was asked, at what effort, the first usage, the answer, and how long it took. */
export function codexForks(records) {
  const codex = records.filter((record) => record.provider === 'codex');
  const forks = [];
  for (const record of codex) {
    if (record.direction !== 'in' || record.data?.method !== 'thread/fork') continue;
    const threadId = responseTo(codex, record.pid, record.data.id)?.data?.result?.thread?.id;
    if (!threadId) continue;
    const start = codex.find((entry) => entry.direction === 'in' && entry.data?.method === 'turn/start' && entry.data.params?.threadId === threadId);
    const text = messageText(start?.data?.params);
    const usage = codex.filter((entry) => entry.data?.method === 'thread/tokenUsage/updated' && entry.data.params?.threadId === threadId);
    const finished = codex.find((entry) => entry.data?.method === 'turn/completed' && entry.data.params?.threadId === threadId);
    const answer = codex.filter((entry) => entry.data?.method === 'item/completed' && entry.data.params?.threadId === threadId && entry.data.params?.item?.type === 'agentMessage')
      .map((entry) => entry.data.params.item.text).join('\n');
    const interrupted = codex.some((entry) => entry.direction === 'in' && entry.data?.method === 'turn/interrupt' && entry.data.params?.threadId === threadId);
    const parentUsage = codex.filter((entry) => entry.at < record.at && entry.data?.method === 'thread/tokenUsage/updated' && entry.data.params?.threadId === record.data.params?.threadId).at(-1);
    const first = usage[0]?.data.params.tokenUsage?.last;
    const parentContext = number(parentUsage?.data.params.tokenUsage?.last?.inputTokens);
    forks.push({
      at: record.at, threadId, sourceThreadId: record.data.params?.threadId, purpose: forkPurpose(text, start?.data?.params?.clientUserMessageId),
      ephemeral: record.data.params?.ephemeral, sandbox: record.data.params?.sandbox, approvalPolicy: record.data.params?.approvalPolicy,
      effort: start?.data?.params?.effort ?? null, question: text.slice(0, 900), answer, interrupted, status: finished?.data.params?.turn?.status ?? null,
      tookMs: finished ? finished.at - record.at : null,
      first: first ? { input: number(first.inputTokens), cached: number(first.cachedInputTokens), output: number(first.outputTokens) } : null,
      parentContext, ratio: ratio(number(first?.cachedInputTokens), parentContext), calls: usage.length,
    });
  }
  return forks;
}

/** A thread's own turns, in order: fields sent with `turn/start`, and the first usage update of each. */
export function codexTurns(records, threadId) {
  const codex = records.filter((record) => record.provider === 'codex');
  const starts = codex.filter((entry) => entry.direction === 'in' && entry.data?.method === 'turn/start' && entry.data.params?.threadId === threadId);
  const usage = codex.filter((entry) => entry.data?.method === 'thread/tokenUsage/updated' && entry.data.params?.threadId === threadId);
  return starts.map((start, index) => {
    const nextAt = starts[index + 1]?.at ?? Number.POSITIVE_INFINITY;
    const mine = usage.filter((entry) => entry.at > start.at && entry.at < nextAt);
    const before = usage.filter((entry) => entry.at < start.at).at(-1)?.data.params.tokenUsage?.last;
    const first = mine[0]?.data.params.tokenUsage?.last;
    return {
      at: start.at, effort: start.data.params.effort ?? null, additionalContext: start.data.params.additionalContext ?? null,
      first: first ? { input: number(first.inputTokens), cached: number(first.cachedInputTokens) } : null,
      context: number(before?.inputTokens), ratio: ratio(number(first?.cachedInputTokens), number(before?.inputTokens)),
    };
  });
}

/** A Claude session's stream: the processes whose `system init` named it. */
export function claudeStream(records, providerSessionId) {
  const pids = new Set(records.filter((record) => record.provider === 'claude' && record.data?.type === 'system' && record.data?.subtype === 'init' && record.data?.session_id === providerSessionId).map((record) => record.pid));
  return records.filter((record) => record.provider === 'claude' && pids.has(record.pid) && record.direction);
}
