import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState, type ComponentProps } from 'react';
import { expect, fn, spyOn, userEvent, waitFor, within } from 'storybook/test';

import { ChatMarkdown, type ChatMarkdownLabels } from './ChatMarkdown';
import { parseFileReference, type ResolveFileLink } from './file-links';
import { CodeHighlighterContext } from './highlight-context';
import { HighlighterProvider } from './HighlighterProvider';

const KNOWN_FILES = new Set([
  'src/main/remote-bridge.ts',
  'test/remote-bridge.test.ts',
  'mobile/src/MobileComposer.tsx',
  'README.md',
]);

const resolveFileLink: ResolveFileLink = (text) => {
  const target = parseFileReference(text);
  return target && KNOWN_FILES.has(target.path) ? target : undefined;
};

const KOREAN_LABELS: Partial<ChatMarkdownLabels> = {
  copyCode: '코드 복사',
  copied: '복사됨',
  copyFailed: '복사하지 못함',
  wrapLines: '줄 바꿈',
  blockedImage: (label) => `이미지를 불러오지 않음: ${label}`,
  task: '작업',
};

const ENGLISH_REPLY = `## Fix: reconnect drops the last streamed line

The bridge closed the socket **before** flushing the final delta, so the renderer never saw the tail of the reply. I moved the flush ahead of \`close()\` in \`src/main/remote-bridge.ts:214\` and added a regression test in test/remote-bridge.test.ts.

### What changed

1. Flush pending deltas before closing (\`flushPending()\` now awaits the write queue).
2. Treat \`ECONNRESET\` during the flush as a normal close, not an error.
3. Keep the close code at \`1000\` so the Android companion does not retry.

- [x] Reproduced with a throttled socket
- [x] Regression test fails before the fix
- [ ] Verify on the Android companion

| Case | Before | After |
| --- | --- | --- |
| Normal close | delivered | delivered |
| Slow consumer | last line lost | delivered |
| Reset during flush | error toast | silent close |

> **Note:** the Windows host still buffers up to 64 KiB, so very large replies arrive in two chunks. That is expected.

See the [WebSocket close handshake](https://datatracker.ietf.org/doc/html/rfc6455#section-7) for why the close frame must come last, or write to <dev@example.com>. Links with other schemes, like [this editor link](vscode://file/src/app.ts), stay plain text.

\`\`\`ts
export async function closeBridge(socket: BridgeSocket): Promise<void> {
  // Flush before close so the renderer receives the final delta.
  await socket.flushPending();
  socket.close(1000, 'done');
}
\`\`\`

Run the focused test:

\`\`\`bash
pnpm vitest run test/remote-bridge.test.ts --reporter=verbose
\`\`\`

~~Retrying on reset~~ is no longer needed; verifying the whole change took ~5 min.`;

const KOREAN_REPLY = `## 원격 연결 복구 흐름 정리

재연결 중에 입력한 초안이 사라지는 문제를 확인했습니다. 원인은 \`MobileComposer\`가 연결 상태가 바뀔 때마다 초기화되기 때문이었고, \`mobile/src/MobileComposer.tsx:88\`에서 초안을 세션별 저장소로 옮겼습니다.

### 변경 사항

- 초안은 PC별 암호화 저장소에 보관합니다.
- 연결이 복구되어도 **자동으로 다시 전송하지 않습니다**.
- 응답이 유실되면 같은 화면에서 명시적으로 다시 시도합니다.
  - 그동안 작성한 새 초안은 덮어쓰지 않습니다.

| 상태 | 표시 | 사용자 동작 |
| --- | --- | --- |
| 연결됨 | 정상 | 없음 |
| 재연결 중 | 경고 배너 | 초안 계속 작성 |
| 응답 유실 | 오류와 재시도 | 재시도 선택 |

> 참고: 과거 CLI 기록은 읽기만으로 제공자 실행을 시작하지 않습니다.

자세한 기준은 [정책 문서](https://example.com/policy)와 README.md를 확인하세요. 남은 확인 항목:

- [x] 에뮬레이터에서 재연결 재현
- [ ] 실제 기기에서 확인

\`\`\`powershell
# 서명 도구 위치를 확인합니다.
Get-Command signtool.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
$env:EZTERMINAL_CHANNEL = 'beta'
\`\`\`

\`\`\`diff
-  const [draft, setDraft] = useState('');
+  const [draft, setDraft] = useSessionDraft(sessionId);
\`\`\`

\`\`\`json
{
  "draftStorage": "encrypted",
  "autoResend": false,
  "retry": { "manual": true, "maxAttempts": 2 }
}
\`\`\``;

const LONG_LINE = `curl -sS -X POST "https://api.example.com/v1/projects/ezterminal/releases?channel=beta&include=assets,notes,checksums&format=json" -H "Accept: application/json" -H "X-Request-Id: 7f3c9a52-1d4e-4c0b-9e61-2b8f5d0a7c14" --data '{"version":"2.0.0","notes":"Chat markdown, highlighted code blocks and file links"}'`;

const CODE_SAMPLES = `\`\`\`tsx
import { ChatMarkdown } from './chat/markdown/ChatMarkdown';

export function Reply({ text }: { readonly text: string }): JSX.Element {
  const [open, setOpen] = useState(false); // tracks the disclosure
  return <ChatMarkdown markdown={text} streaming={!open} />;
}
\`\`\`

\`\`\`bash
# Install and run the Storybook tests for this module
pnpm install --frozen-lockfile
pnpm test:storybook src/renderer/chat/markdown && echo "ok: $?"
\`\`\`

\`\`\`powershell
$ErrorActionPreference = 'Stop'
Get-ChildItem -Path .\\release -Filter *.exe | ForEach-Object { Get-FileHash $_.FullName -Algorithm SHA256 }
\`\`\`

\`\`\`diff
@@ -12,7 +12,7 @@ export function render(): void {
-  const html = markdownToHtml(text);
+  const nodes = renderChatMarkdown(text);
   mount(nodes);
 }
\`\`\`

\`\`\`json
{ "name": "ezterminal", "version": "2.0.0", "private": true, "engines": { "node": ">=22.13" } }
\`\`\`

\`\`\`
plain output without a language
  exit code 0
\`\`\`

\`\`\`brainfuck
++++++++[>++++[>++>+++<<-]>+<<-]>>.
\`\`\`

\`\`\`bash
${LONG_LINE}
\`\`\``;

function longReply(): string {
  const sections: string[] = [];
  for (let index = 1; sections.join('\n\n').length < 6_200; index += 1) {
    sections.push(`### Step ${index}: review the session transcript

The restored session replays every turn from the daemon snapshot, so the renderer must keep the reading position stable while older turns load above it. Each turn keeps its own draft, attachments and approval state; switching skins never resets them.

- Restore the scroll anchor by message ID, not by pixel offset.
- Load earlier turns in pages of fifty and keep the anchor visible.
- Show \`Load earlier messages\` only when the host reports more history.

\`\`\`ts
const anchor = transcript.anchorFor(messageId);
await transcript.loadEarlier({ pageSize: 50 });
transcript.restore(anchor);
\`\`\``);
  }
  return `## Long reply\n\n${sections.join('\n\n')}\n\nThat is the end of the long reply.`;
}

const LONG_REPLY = longReply();

const meta = {
  title: 'Chat/Markdown',
  component: ChatMarkdown,
  parameters: { layout: 'padded', a11y: { test: 'error' } },
  args: {
    markdown: ENGLISH_REPLY,
    onOpenLink: fn(),
    onOpenFile: fn(),
    resolveFileLink,
  },
  decorators: [
    (Story) => (
      <HighlighterProvider>
        <div style={{ width: 'min(calc(100vw - 32px), 46rem)' }}>
          <Story />
        </div>
      </HighlighterProvider>
    ),
  ],
} satisfies Meta<typeof ChatMarkdown>;

export default meta;
type Story = StoryObj<typeof meta>;

async function waitForHighlight(root: HTMLElement, count: number): Promise<void> {
  await waitFor(
    () => expect(root.querySelectorAll('.chat-md-code[data-highlighted="true"]').length).toBe(count),
    { timeout: 10_000 },
  );
}

export const EnglishReply: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForHighlight(canvasElement, 2);
    await userEvent.click(canvas.getByRole('link', { name: 'WebSocket close handshake' }));
    await expect(args.onOpenLink).toHaveBeenCalledWith('https://datatracker.ietf.org/doc/html/rfc6455#section-7');
    await userEvent.click(canvas.getByRole('button', { name: 'src/main/remote-bridge.ts:214' }));
    await expect(args.onOpenFile).toHaveBeenCalledWith({ path: 'src/main/remote-bridge.ts', line: 214 });
    await expect(canvas.getByRole('button', { name: 'test/remote-bridge.test.ts' })).toBeVisible();
    await expect(canvas.queryByRole('link', { name: 'this editor link' })).toBeNull();
    await expect(canvas.getByText(/~5 min/)).toBeVisible();
  },
};
export const EnglishReplyDark: Story = { ...EnglishReply, globals: { theme: 'dark' } };
export const EnglishReplyLight: Story = { ...EnglishReply, globals: { theme: 'light' } };
export const EnglishReplyHighContrast: Story = { ...EnglishReply, globals: { theme: 'high-contrast' } };

export const KoreanReply: Story = {
  globals: { locale: 'ko' },
  args: { markdown: KOREAN_REPLY, labels: KOREAN_LABELS },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitForHighlight(canvasElement, 3);
    await expect(canvas.getByRole('button', { name: 'mobile/src/MobileComposer.tsx:88' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'README.md' })).toBeVisible();
    await expect(canvas.getAllByRole('button', { name: '코드 복사' })).toHaveLength(3);
  },
};
export const KoreanReplyDark: Story = { ...KoreanReply, globals: { locale: 'ko', theme: 'dark' } };
export const KoreanReplyLight: Story = { ...KoreanReply, globals: { locale: 'ko', theme: 'light' } };
export const KoreanReplyHighContrast: Story = { ...KoreanReply, globals: { locale: 'ko', theme: 'high-contrast' } };

export const CodeBlocks: Story = {
  args: { markdown: CODE_SAMPLES },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // tsx, bash, powershell, diff, json and the long bash line; plain and
    // unknown-language blocks stay unhighlighted.
    await waitForHighlight(canvasElement, 6);
    const blocks = [...canvasElement.querySelectorAll<HTMLElement>('.chat-md-code')];
    await expect(blocks[5]!.classList.contains('chat-md-code--bare')).toBe(true);
    await expect(blocks[6]!.querySelector('.chat-md-code__language')).toHaveTextContent('brainfuck');
    await expect(blocks[6]!.dataset.highlighted).toBeUndefined();

    const longBlock = blocks[7]!;
    const pre = longBlock.querySelector('pre')!;
    await expect(pre.scrollWidth).toBeGreaterThan(pre.clientWidth);
    const wrap = within(longBlock).getByRole('button', { name: 'Wrap lines' });
    await userEvent.click(wrap);
    await expect(wrap).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(pre.scrollWidth).toBeLessThanOrEqual(pre.clientWidth));
    await userEvent.click(wrap);
    await expect(wrap).toHaveAttribute('aria-pressed', 'false');

    const writeText = spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    try {
      await userEvent.click(within(blocks[0]!).getByRole('button', { name: 'Copy code' }));
      await expect(writeText).toHaveBeenCalledWith(expect.stringContaining('export function Reply'));
      await expect(await within(blocks[0]!).findByRole('status')).toHaveTextContent('Copied');
    } finally {
      writeText.mockRestore();
    }
    await expect(canvas.getAllByRole('button', { name: 'Copy code' })).toHaveLength(8);
  },
};
export const CodeBlocksDark: Story = { ...CodeBlocks, globals: { theme: 'dark' } };
export const CodeBlocksLight: Story = { ...CodeBlocks, globals: { theme: 'light' } };
export const CodeBlocksHighContrast: Story = { ...CodeBlocks, globals: { theme: 'high-contrast' } };

/** The highlighted column must match the plain column's block metrics exactly. */
export const HighlightKeepsLayout: Story = {
  args: { markdown: CODE_SAMPLES },
  render: (args) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gridGap: '1rem' }}>
      <section aria-label="Plain" data-testid="plain">
        <CodeHighlighterContext.Provider value={null}>
          <ChatMarkdown {...args} />
        </CodeHighlighterContext.Provider>
      </section>
      <section aria-label="Highlighted" data-testid="highlighted">
        <ChatMarkdown {...args} />
      </section>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const highlighted = canvas.getByTestId('highlighted');
    await waitForHighlight(highlighted, 6);
    const plainBlocks = canvas.getByTestId('plain').querySelectorAll('pre');
    const highlightedBlocks = highlighted.querySelectorAll('pre');
    await expect(highlightedBlocks.length).toBe(plainBlocks.length);
    highlightedBlocks.forEach((pre, index) => {
      const plain = plainBlocks[index]!;
      expect(pre.getBoundingClientRect().height).toBe(plain.getBoundingClientRect().height);
      expect(pre.scrollWidth).toBe(plain.scrollWidth);
    });
  },
};

export const LongReply: Story = {
  args: { markdown: LONG_REPLY },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(LONG_REPLY.length).toBeGreaterThan(6_000);
    await expect(canvas.getByText('That is the end of the long reply.')).toBeVisible();
    await expect(canvasElement.querySelector('[data-markdown-pending]')).toBeNull();
  },
};

export const CliVariant: Story = {
  args: { variant: 'cli' },
  play: EnglishReply.play,
};
export const CliVariantDark: Story = { ...CliVariant, globals: { theme: 'dark' } };
export const CliVariantKorean: Story = {
  globals: { locale: 'ko' },
  args: { variant: 'cli', markdown: KOREAN_REPLY, labels: KOREAN_LABELS },
  play: KoreanReply.play,
};

function StreamingReply(props: Omit<ComponentProps<typeof ChatMarkdown>, 'markdown' | 'streaming'>): JSX.Element {
  const [length, setLength] = useState(0);
  const done = length >= ENGLISH_REPLY.length;
  useEffect(() => {
    if (done) return undefined;
    // Uneven chunks, like real deltas: sometimes mid-word.
    const timer = window.setTimeout(() => setLength((current) => current + 9 + (current % 7)), 24);
    return () => window.clearTimeout(timer);
  }, [done, length]);
  return (
    <>
      <p className="ez-story-note" data-testid="stream-state">{done ? 'done' : 'streaming'}</p>
      <ChatMarkdown {...props} markdown={ENGLISH_REPLY.slice(0, length)} streaming={!done} />
    </>
  );
}

export const Streaming: Story = {
  render: (args) => <StreamingReply {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const heading = await canvas.findByRole('heading', { level: 2 });
    await waitFor(() => expect(canvasElement.querySelector('.chat-md__fade')).not.toBeNull());
    // The open TypeScript fence renders as a code block before it closes.
    await waitFor(() => expect(canvasElement.querySelector('.chat-md-code__language')).toHaveTextContent('ts'), { timeout: 15_000 });
    await expect(canvas.getByTestId('stream-state')).toHaveTextContent('streaming');
    await waitFor(() => expect(canvas.getByTestId('stream-state')).toHaveTextContent('done'), { timeout: 20_000 });
    // Settled blocks were never re-created while the tail streamed.
    await expect(canvas.getByRole('heading', { level: 2 })).toBe(heading);
    await waitForHighlight(canvasElement, 2);
    // Faded runs stay as separate spans, so check the joined text.
    await expect(canvasElement.textContent).toContain('verifying the whole change took ~5 min.');
  },
};
