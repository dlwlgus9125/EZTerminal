import type { ChatAttachment } from '../../shared/chat-message';
import type { ColumnInfo, JsonValue, ResultRow } from '../../shared/ipc';
import type { BlockController, BlockStatus } from '../block-controller';

/**
 * A terminal block as quoted text for an AI conversation: the command, where
 * it ran, how it ended, and its output trimmed to a size a person can check
 * before sending. Pure, so the chip preview and the sent message are the same
 * text.
 */

export const EXCERPT_HEAD_LINES = 40;
export const EXCERPT_TAIL_LINES = 160;
export const EXCERPT_MAX_CHARS = 16_000;
export const EXCERPT_MAX_LINE_CHARS = 2_000;
export const EXCERPT_TABLE_ROWS = 100;
const NAME_COMMAND_CHARS = 60;

export interface BlockExcerptSource {
  readonly command: string;
  readonly cwd: string | null;
  readonly status: BlockStatus;
  readonly exitCode: number | null;
  /** Output as plain text (controls already removed). */
  readonly output: string;
}

export interface BlockExcerpt {
  readonly text: string;
  /** Output lines left out of the middle. */
  readonly omittedLines: number;
  /** The character cap cut the front of the output. */
  readonly clipped: boolean;
}

/* eslint-disable no-control-regex -- terminal output is made of control sequences */
const OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
const CSI = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g;
const ESCAPE = /\x1b[@-Z\\-_]|\x1b[ -/][0-~]/g;
const OTHER_CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g;
/* eslint-enable no-control-regex */

/** Lay one terminal line out as it shows: `\r` returns to column 0 and later text overwrites. */
function overlayCarriageReturns(line: string): string {
  const parts = line.replace(/\r+$/u, '').split('\r');
  let result = parts[0] ?? '';
  for (let index = 1; index < parts.length; index += 1) {
    const part = parts[index];
    result = part + result.slice(part.length);
  }
  return result;
}

function applyBackspaces(line: string): string {
  if (!line.includes('\b')) return line;
  const out: string[] = [];
  for (const char of line) {
    if (char === '\b') out.pop();
    else out.push(char);
  }
  return out.join('');
}

/** Terminal bytes (decoded) to the text a person sees: no colours, cursor moves or titles. */
export function stripTerminalControls(raw: string): string {
  const withoutSequences = raw.replace(OSC, '').replace(CSI, '').replace(ESCAPE, '');
  return withoutSequences
    .split('\n')
    .map((line) => applyBackspaces(overlayCarriageReturns(line)).replace(OTHER_CONTROLS, ''))
    .join('\n');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** ansi_up's escaped HTML (colour spans + entities) back to text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<[^>]*>/gu, '')
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu, (whole, name: string) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    });
}

function rawValue(value: JsonValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** One table cell on one line. */
function cell(value: JsonValue | undefined): string {
  return rawValue(value).replace(/[\t\r\n]+/gu, ' ');
}

/** A table result as tab-separated text, first rows only. */
export function tableToText(
  columns: readonly ColumnInfo[],
  run: { readonly start: number; readonly rows: readonly ResultRow[] },
  rowCount: number,
): string {
  const rows = run.start === 0 ? run.rows.slice(0, EXCERPT_TABLE_ROWS) : [];
  const lines = [columns.map((column) => column.name).join('\t')];
  for (const row of rows) lines.push(columns.map((column) => cell(row[column.name])).join('\t'));
  if (rows.length < rowCount) lines.push(`(총 ${rowCount}행 중 ${rows.length}행)`);
  return lines.join('\n');
}

function statusLine(status: BlockStatus, exitCode: number | null): string {
  if (status === 'running') return 'running';
  return exitCode === null ? status : `exit ${exitCode} · ${status}`;
}

const HEADER_COMMAND_CHARS = 1_000;
const HEADER_CWD_CHARS = 500;
const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max)}…` : value);

/** The quoted block: header lines, then the output trimmed head + tail, the whole capped in size. */
export function buildBlockExcerpt(source: BlockExcerptSource): BlockExcerpt {
  const header = [`$ ${clip(source.command.replace(/[\r\n]+/gu, ' '), HEADER_COMMAND_CHARS)}`];
  if (source.cwd) header.push(`cwd: ${clip(source.cwd, HEADER_CWD_CHARS)}`);
  header.push(statusLine(source.status, source.exitCode));
  const lines = source.output.replace(/\n+$/u, '').split('\n')
    .map((line) => (line.length > EXCERPT_MAX_LINE_CHARS ? `${line.slice(0, EXCERPT_MAX_LINE_CHARS)}…` : line));
  if (lines.length === 1 && lines[0] === '') lines.length = 0;
  let omittedLines = 0;
  let body = lines;
  if (lines.length > EXCERPT_HEAD_LINES + EXCERPT_TAIL_LINES) {
    omittedLines = lines.length - EXCERPT_HEAD_LINES - EXCERPT_TAIL_LINES;
    body = [
      ...lines.slice(0, EXCERPT_HEAD_LINES),
      `… (${omittedLines}줄 생략) …`,
      ...lines.slice(lines.length - EXCERPT_TAIL_LINES),
    ];
  }
  const head = header.join('\n');
  let text = body.length > 0 ? `${head}\n${body.join('\n')}` : head;
  let clipped = false;
  if (text.length > EXCERPT_MAX_CHARS) {
    clipped = true;
    const marker = '\n… (앞부분 생략) …\n';
    const room = Math.max(0, EXCERPT_MAX_CHARS - head.length - marker.length);
    const joined = body.join('\n');
    text = `${head}${marker}${joined.slice(joined.length - room)}`;
  }
  return { text, omittedLines, clipped };
}

/** What a block printed, as plain text, from whatever the controller still holds. Never fetches. */
export function readBlockOutput(controller: BlockController): string {
  const snapshot = controller.getSnapshot();
  if (snapshot.status === 'error') return snapshot.errorMessage ?? '';
  if (snapshot.shape === 'table') return tableToText(snapshot.columns, controller.getCachedRows('start'), snapshot.rowCount);
  if (snapshot.shape === 'text') {
    const run = controller.getCachedRows('end');
    const isHtml = snapshot.columns[0]?.type === 'html';
    const text = isHtml
      ? htmlToText(run.rows.map((row) => rawValue(row.value)).join(''))
      : run.rows.map((row) => rawValue(row.value)).join('\n');
    return stripTerminalControls(text);
  }
  if (snapshot.shape === 'pty') {
    const viewed = snapshot.ptyRenderMode === 'xterm' ? controller.readTerminalText() : null;
    return viewed ?? stripTerminalControls(controller.readRetainedPtyText());
  }
  return '';
}

export function excerptFromController(controller: BlockController): BlockExcerpt {
  const snapshot = controller.getSnapshot();
  return buildBlockExcerpt({
    command: controller.command,
    cwd: snapshot.startCwd,
    status: snapshot.status,
    exitCode: snapshot.exitCode,
    output: readBlockOutput(controller),
  });
}

export const TERMINAL_ATTACHMENT_PREFIX = 'terminal-output-';

/** The excerpt as a text attachment of the conversation draft, named `<label> · <command>`. */
export function terminalOutputAttachment(runId: string, command: string, excerpt: BlockExcerpt, label = 'Terminal'): ChatAttachment {
  const short = command.length > NAME_COMMAND_CHARS ? `${command.slice(0, NAME_COMMAND_CHARS)}…` : command;
  return {
    id: `${TERMINAL_ATTACHMENT_PREFIX}${runId}`.slice(0, 200),
    name: `${label} · ${short}`.slice(0, 240),
    mimeType: 'text/plain',
    kind: 'text',
    data: excerpt.text.length > 0 ? excerpt.text : `$ ${command}`,
  };
}

export function isTerminalAttachment(attachment: Pick<ChatAttachment, 'id'>): boolean {
  return attachment.id.startsWith(TERMINAL_ATTACHMENT_PREFIX);
}

const SENSITIVE = [
  /\b(?:api[_-]?key|secret|token|password|passwd|pwd|bearer|authorization)\b\s*[:=]/iu,
  /\bsk-[A-Za-z0-9_-]{16,}/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/u,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/u,
];

/** A cheap hint that output may hold a credential; it never blocks sending. */
export function looksSensitive(text: string): boolean {
  return SENSITIVE.some((pattern) => pattern.test(text));
}
