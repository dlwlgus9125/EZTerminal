import type { Meta, StoryObj } from '@storybook/react-vite';
import { useLayoutEffect, useMemo } from 'react';
import { fn } from 'storybook/test';

import type { DaemonApproval, DaemonTranscriptItem } from '../../shared/daemon-protocol';
import type { UiThemeColors } from '../../shared/theme-schema';
import { AppI18nProvider } from '../i18n';
import { ProjectConversationTree } from '../ProjectConversationTree';
import { projectConversationTree } from '../project-conversation-tree-model';
import { StructuredAgentSessionPanel } from '../StructuredAgentSession';
import { applyEffects, type EffectId } from '../effects';
import { deriveUiTokens, uiThemeColorsToCssVars } from '../theme-contrast';
import { ActivityRail } from '../workbench/ActivityRail';
import { AppHeader } from '../workbench/AppHeader';
import { SidebarShell } from '../workbench/SidebarShell';
import { WorkspaceBar } from '../workbench/WorkspaceBar';
import '../index.css';
import '../structured-agent.css';
import '../workbench/workbench.css';

/**
 * Theme direction candidates for the 2.0 overhaul (Phase 1c gate).
 *
 * Each candidate is previewed by overriding a BUILT-IN theme's tokens, so every
 * theme-specific rule in the product CSS still applies exactly as it will once
 * the chosen palette replaces the built-in values. Nothing here is registered
 * or persisted; the override style is removed when the story unmounts.
 */

interface Candidate {
  readonly target: 'dark' | 'light' | 'matrix';
  readonly glow: boolean;
  readonly ui: UiThemeColors;
  /** Decorative roles and terminal chrome aligned with the palette. */
  readonly extras: Readonly<Record<string, string>>;
}

/** A — monochrome: neutral near-black, primary actions in the foreground colour,
 * colour reserved for status and focus (Orca / shadcn-neutral family). */
const GRAPHITE_DARK: Candidate = {
  target: 'dark',
  glow: false,
  ui: {
    canvas: '#09090b', surface: '#111113', surfaceRaised: '#18181b', surfaceInset: '#060607',
    textPrimary: '#ededef', textSecondary: '#ababb3', textMuted: '#85858d', textInverse: '#09090b',
    borderSubtle: '#232327', borderStrong: '#67676f', accent: '#ededef', onAccent: '#09090b',
    focus: '#5b8cff', info: '#5b8cff', success: '#3fbf7f', warning: '#e5b34b', danger: '#f0595e',
  },
  extras: {
    '--ui-text-dim': '#85858d', '--ui-border-mid': '#1c1c20', '--ui-border-focus-soft': '#67676f',
    '--term-bg': '#09090b', '--term-bg-raised': '#111113', '--term-bg-inset': '#060607',
    '--term-border': '#232327', '--term-border-faint': '#18181b',
  },
};

const GRAPHITE_LIGHT: Candidate = {
  target: 'light',
  glow: false,
  ui: {
    canvas: '#fafafa', surface: '#ffffff', surfaceRaised: '#ffffff', surfaceInset: '#f4f4f5',
    textPrimary: '#18181b', textSecondary: '#52525b', textMuted: '#6b6b73', textInverse: '#ffffff',
    borderSubtle: '#e4e4e7', borderStrong: '#80808a', accent: '#18181b', onAccent: '#fafafa',
    focus: '#2563eb', info: '#2563eb', success: '#15803d', warning: '#8f5e00', danger: '#c42b3a',
  },
  extras: {
    '--ui-text-dim': '#6b6b73', '--ui-border-mid': '#ececee', '--ui-border-focus-soft': '#8a8a93',
    '--term-bg': '#fafafa', '--term-bg-raised': '#ffffff', '--term-bg-inset': '#f4f4f5',
    '--term-border': '#e4e4e7', '--term-border-faint': '#efeff1',
  },
};

/** B — warm charcoal with a blue accent; softer surfaces, colour on primary actions. */
const INK_DARK: Candidate = {
  target: 'dark',
  glow: false,
  ui: {
    canvas: '#1b1a18', surface: '#22211f', surfaceRaised: '#2b2a27', surfaceInset: '#161513',
    textPrimary: '#ecebe6', textSecondary: '#bdbab1', textMuted: '#9e9b92', textInverse: '#1b1a18',
    borderSubtle: '#363430', borderStrong: '#78756d', accent: '#7aa7ff', onAccent: '#0a1730',
    focus: '#9dbdff', info: '#7aa7ff', success: '#62c08f', warning: '#e2ae58', danger: '#ef6f6b',
  },
  extras: {
    '--ui-text-dim': '#9e9b92', '--ui-border-mid': '#2e2c29', '--ui-border-focus-soft': '#78756d',
    '--term-bg': '#1b1a18', '--term-bg-raised': '#22211f', '--term-bg-inset': '#161513',
    '--term-border': '#363430', '--term-border-faint': '#2b2a27',
  },
};

const INK_LIGHT: Candidate = {
  target: 'light',
  glow: false,
  ui: {
    canvas: '#faf9f6', surface: '#ffffff', surfaceRaised: '#ffffff', surfaceInset: '#f2f0eb',
    textPrimary: '#1c1b19', textSecondary: '#4a4843', textMuted: '#6b6861', textInverse: '#ffffff',
    borderSubtle: '#e4e1da', borderStrong: '#7d7a72', accent: '#2f5fd0', onAccent: '#ffffff',
    focus: '#2f5fd0', info: '#2f5fd0', success: '#1a7a4f', warning: '#8a5a00', danger: '#c0343f',
  },
  extras: {
    '--ui-text-dim': '#6b6861', '--ui-border-mid': '#ece9e3', '--ui-border-focus-soft': '#8c897f',
    '--term-bg': '#faf9f6', '--term-bg-raised': '#ffffff', '--term-bg-inset': '#f2f0eb',
    '--term-border': '#e4e1da', '--term-border-faint': '#eeebe5',
  },
};

/** Same identity, clearer surface steps and borders, brighter primary text. */
const MATRIX_REFINED: Candidate = {
  target: 'matrix',
  glow: true,
  ui: {
    canvas: '#020604', surface: '#07110b', surfaceRaised: '#0c1b12', surfaceInset: '#010402',
    textPrimary: '#c6fde0', textSecondary: '#8fe6b6', textMuted: '#66c592', textInverse: '#00150a',
    borderSubtle: '#1d3d29', borderStrong: '#4bbd7a', accent: '#35e58f', onAccent: '#001c0d',
    focus: '#8affba', info: '#62d8ff', success: '#35e58f', warning: '#ffd166', danger: '#ff6b7a',
  },
  extras: {
    '--ui-text-dim': '#52ad7c', '--ui-border-mid': '#163322', '--ui-border-focus-soft': '#2f7350',
    '--term-bg': '#020604', '--term-bg-raised': '#07110b', '--term-bg-inset': '#010402',
    '--term-border': '#2c6a47', '--term-border-faint': '#163322',
  },
};

const CANDIDATES = {
  'graphite-dark': GRAPHITE_DARK,
  'graphite-light': GRAPHITE_LIGHT,
  'ink-dark': INK_DARK,
  'ink-light': INK_LIGHT,
  'matrix-refined': MATRIX_REFINED,
} as const;

type DirectionId = keyof typeof CANDIDATES | 'current-dark' | 'current-light' | 'current-matrix';

/** The CRT effects the user keeps on in their own profile, so the Matrix pair
 * is judged as it is actually used (scanlines, glow, scroll, rollbar, flicker). */
const DAILY_MATRIX_EFFECTS: readonly EffectId[] = ['scanlines', 'phosphor-glow', 'scanline-scroll', 'crt-rollbar', 'flicker'];

function overrideCss(candidate: Candidate): string {
  const vars = {
    ...uiThemeColorsToCssVars(candidate.ui),
    ...deriveUiTokens(candidate.ui, { glow: candidate.glow, borderMid: candidate.extras['--ui-border-mid'] }),
    ...candidate.extras,
  };
  const declarations = Object.entries(vars).map(([name, value]) => `${name}: ${value};`).join(' ');
  return `html[data-theme='${candidate.target}'], html [data-theme='${candidate.target}'] { ${declarations} }`;
}

function useDirection(direction: DirectionId): void {
  useLayoutEffect(() => {
    const html = document.documentElement;
    const previous = html.dataset.theme;
    const candidate = direction in CANDIDATES ? CANDIDATES[direction as keyof typeof CANDIDATES] : undefined;
    html.dataset.theme = candidate?.target ?? direction.replace('current-', '');
    const style = document.createElement('style');
    style.id = 'theme-direction-preview';
    style.textContent = candidate ? overrideCss(candidate) : '';
    document.head.appendChild(style);
    applyEffects(new Set(html.dataset.theme === 'matrix' ? DAILY_MATRIX_EFFECTS : []));
    return () => {
      style.remove();
      applyEffects(new Set());
      if (previous) html.dataset.theme = previous;
    };
  }, [direction]);
}

const SESSION = 'theme-direction-session';
const T = '2026-10-15T09:30:00.000Z';

function item(id: string, sequence: number, kind: DaemonTranscriptItem['kind'], text: string): DaemonTranscriptItem {
  return { id, sessionId: SESSION, turnId: 'turn-1', sequence, kind, text, isDelta: false, isSensitive: false, createdAt: T };
}

const TRANSCRIPT: readonly DaemonTranscriptItem[] = [
  item('u1', 1, 'user-message', '로그인 실패 시 재시도 횟수가 화면에 안 나와요. 원인 찾아서 고쳐줘.'),
  item('r1', 2, 'reasoning', '먼저 로그인 폼과 재시도 상태를 관리하는 훅을 확인한다.'),
  item('t1', 3, 'tool-call', 'Grep\n{\n  "pattern": "retryCount",\n  "path": "src/auth"\n}'),
  item('t2', 4, 'tool-result', 'src/auth/useLogin.ts:42:  const [retryCount, setRetryCount] = useState(0);\nsrc/auth/LoginForm.tsx:18:  const { submit } = useLogin();'),
  item('a1', 5, 'assistant-message', [
    '원인을 찾았습니다. `useLogin`은 `retryCount`를 관리하지만 **반환하지 않아서** `LoginForm`이 값을 읽을 수 없습니다.',
    '',
    '| 파일 | 문제 | 수정 |',
    '| --- | --- | --- |',
    '| `src/auth/useLogin.ts` | `retryCount` 미반환 | 반환 객체에 추가 |',
    '| `src/auth/LoginForm.tsx` | 표시 영역 없음 | 오류 문구 아래에 표시 |',
    '',
    '```ts',
    'export function useLogin() {',
    '  const [retryCount, setRetryCount] = useState(0);',
    '  return { submit, retryCount };',
    '}',
    '```',
  ].join('\n')),
];

const APPROVAL: DaemonApproval = {
  id: 'approval-direction', sessionId: SESSION, turnId: 'turn-1', providerRequestId: 'request-direction',
  risk: 'write', title: 'src/auth/useLogin.ts 수정 허용?', detail: '선택한 작업 공간의 파일 1개를 수정합니다.',
  state: 'pending', revision: 1, createdAt: T, updatedAt: T,
};

function DirectionWorkbench({ direction, skin }: { readonly direction: DirectionId; readonly skin: 'bubble' | 'cli' }): JSX.Element {
  useDirection(direction);
  const nodes = useMemo(() => projectConversationTree({
    projects: [{ id: 'ez', title: 'EZTerminal', pinned: true }, { id: 'shop', title: 'shop-web' }],
    workflows: {},
    conversations: [
      { id: 'c1', projectId: 'ez', title: '로그인 재시도 표시 수정', updatedAt: Date.parse(T), source: 'agent', providerLabel: 'Claude', sessionId: SESSION },
      { id: 'c2', projectId: 'ez', title: '대화창 테마 개선', updatedAt: Date.parse(T) - 3_600_000, source: 'agent', providerLabel: 'Codex', sessionId: 'other' },
      { id: 'c3', projectId: 'ez', title: '릴리스 노트 정리', updatedAt: Date.parse(T) - 86_400_000, source: 'native', providerLabel: 'Codex' },
    ],
  }), []);
  return (
    <AppI18nProvider locale="ko" languages={['ko']}>
      <main className="app desktop-handoff-workbench" lang="ko" style={{ height: '100vh' }}>
        <AppHeader
          appVersion="2.0.0"
          attentionCount={1}
          commandCenterOpen={false}
          effectIntensity={7}
          onNewTerminal={() => undefined}
          onNewSession={() => undefined}
          onOpenAttention={() => undefined}
          onOpenCommandCenter={() => undefined}
          onOpenEffectSettings={() => undefined}
          onWorkspaceOpenChange={() => undefined}
          workspaceOpen={false}
        />
        <div className="workbench-body">
          <ActivityRail active="agents" attentionCount={1} openclawVisible={false} projectNavigation onSelect={() => undefined} />
          <SidebarShell destination="agents" title="프로젝트" width={300} onClose={() => undefined} onWidthChange={() => undefined}>
            <ProjectConversationTree nodes={nodes} persistenceScope={`theme-direction-${direction}`} onOpen={() => undefined} />
          </SidebarShell>
          <section className="desktop-handoff-workbench__canvas">
            <WorkspaceBar presetName="기본 작업 공간" paneCount={1} onApplyTwoByOne={() => undefined} onApplyOnePlusTwo={() => undefined} onApplySingle={() => undefined} />
            <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
              <StructuredAgentSessionPanel
                sessionId={SESSION}
                title="로그인 재시도 표시 수정"
                providerId="claude"
                providerLabel="Claude"
                workspace={{ id: 'main', label: 'EZTerminal', kind: 'local', path: 'C:\\Working\\EZTerminal' }}
                model="sonnet"
                modelOptions={[{ id: 'sonnet', label: 'Sonnet' }]}
                permissionPreset="standard"
                state="blocked"
                items={TRANSCRIPT}
                approvals={[APPROVAL]}
                skin={skin}
                onSend={fn(async () => ({ ok: true as const }))}
                onInterruptAndSend={fn(async () => ({ ok: true as const }))}
                onChangeSettings={fn(async () => ({ ok: true as const }))}
                onResolveApproval={fn(async () => ({ ok: true as const }))}
              />
            </div>
          </section>
        </div>
      </main>
    </AppI18nProvider>
  );
}

const meta = {
  title: 'Foundations/Theme directions',
  component: DirectionWorkbench,
  parameters: { layout: 'fullscreen' },
  args: { direction: 'graphite-dark', skin: 'bubble' },
} satisfies Meta<typeof DirectionWorkbench>;

export default meta;
type Story = StoryObj<typeof meta>;

export const GraphiteDark: Story = { args: { direction: 'graphite-dark' } };
export const GraphiteLight: Story = { args: { direction: 'graphite-light' } };
export const InkDark: Story = { args: { direction: 'ink-dark' } };
export const InkLight: Story = { args: { direction: 'ink-light' } };
export const MatrixRefined: Story = { args: { direction: 'matrix-refined', skin: 'cli' } };
export const CurrentDark: Story = { args: { direction: 'current-dark' } };
export const CurrentLight: Story = { args: { direction: 'current-light' } };
export const CurrentMatrix: Story = { args: { direction: 'current-matrix', skin: 'cli' } };
