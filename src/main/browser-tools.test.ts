import { describe, expect, it, vi } from 'vitest';

import type { BrowserRefusal, BrowserSiteClass, BrowserToolName } from '../shared/browser';
import type { DaemonSnapshot, PermissionPreset } from '../shared/daemon-protocol';
import { BrowserRefused, type BrowserCdp, type BrowserTarget } from './browser-cdp';
import { BROWSER_TOOL_DEFINITIONS, BrowserTools, type BrowserApprovalRequest, type BrowserToolPages, type BrowserToolResult } from './browser-tools';
import type { BrowserPageResult } from './browser-view-manager';

const LOCAL = 'http://localhost:5173/cart';
const ALLOWED = 'https://staging.cart-kit.example/cart';
const OUTSIDE = 'https://elsewhere.example/';
const CLASS: Readonly<Record<string, BrowserSiteClass>> = { [LOCAL]: 'local', [ALLOWED]: 'allowed', [OUTSIDE]: 'external' };
const siteOf = (url: string): BrowserSiteClass => CLASS[url] ?? (url.startsWith('file:') ? 'file' : url.includes('localhost') ? 'local' : url.includes('staging.cart-kit') ? 'allowed' : 'external');

const BUTTON: BrowserTarget = { role: 'button', name: 'Pay', password: false };

function cdp(patch: Partial<Record<keyof BrowserCdp, unknown>> = {}) {
  const driver = {
    snapshot: vi.fn(async () => ({ text: 'button "Pay" [ref=e1]', truncated: false, unreadFrames: ['https://ads.example/'] })),
    screenshot: vi.fn(async () => ({ jpegBase64: 'SkVH', width: 1280, height: 800 })),
    consoleLines: vi.fn(() => ['log: hello', 'warning: careful', 'error: broken', 'exception: TypeError']),
    pageText: vi.fn(async () => 'Order summary'),
    target: vi.fn(async () => BUTTON),
    click: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    fileChooserOpened: vi.fn(() => false),
  };
  return { ...driver, ...patch } as typeof driver;
}

interface Options {
  readonly url?: string;
  readonly preset?: PermissionPreset;
  readonly snapshot?: Partial<DaemonSnapshot>;
  readonly agent?: Partial<DaemonSnapshot['agents'][number]> | null;
  readonly attended?: boolean;
  readonly answer?: 'allow' | 'approval-declined' | 'approval-timeout';
  readonly page?: BrowserPageResult;
  readonly trusted?: boolean;
  readonly cdp?: ReturnType<typeof cdp>;
}

function harness(options: Options = {}) {
  const url = options.url ?? LOCAL;
  const driver = options.cdp ?? cdp();
  const live: { current: BrowserPageResult } = {
    current: options.page ?? { ok: true, contents: {} as Electron.WebContents, cdp: driver as unknown as BrowserCdp, url, site: siteOf(url) },
  };
  const order: string[] = [];
  const pages: BrowserToolPages = {
    beginTool: vi.fn(() => { order.push('begin'); return undefined; }),
    endTool: vi.fn(() => { order.push('end'); }),
    page: vi.fn(() => live.current),
    classify: vi.fn((_id: string, target: string) => siteOf(target)),
    navigateForTool: vi.fn(async () => ({ isLoading: () => false }) as unknown as Electron.WebContents),
    refuseNavigation: vi.fn(),
    state: vi.fn(() => ({ conversationId: 'chat', url, loading: false, canBack: false, canForward: false, ai: 'driving' as const })),
  };
  const agent = options.agent === null ? [] : [{ sessionId: 'chat', state: 'working', currentTurnId: 'turn-1', ...options.agent }];
  const snapshot = { runtime: { browserEnabled: true }, agents: agent, ...options.snapshot } as unknown as DaemonSnapshot;
  const requests: BrowserApprovalRequest[] = [];
  const requestApproval = vi.fn(async (request: BrowserApprovalRequest) => {
    requests.push(request);
    return options.answer ?? 'allow' as const;
  });
  const tools = new BrowserTools({
    pages, getSnapshot: () => snapshot, turnAttended: () => options.attended ?? true, requestApproval,
    siteTrusted: () => options.trusted ?? false, delay: async () => undefined,
  });
  const call = (name: BrowserToolName, value: unknown = {}, preset: PermissionPreset = options.preset ?? 'standard'): Promise<BrowserToolResult> => tools.call(
    { sessionId: 'chat', projectId: 'project', permissionPreset: preset, turnId: 'turn-1' }, name, value,
  );
  return { tools, call, pages, driver, live, requests, requestApproval, order, snapshot };
}

const parsed = (result: BrowserToolResult): Record<string, unknown> => JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
const code = (result: BrowserToolResult): unknown => (result.isError ? parsed(result).code : 'ran');

const ARGS: Readonly<Record<BrowserToolName, unknown>> = {
  browser_snapshot: {}, browser_screenshot: {}, browser_console: {}, browser_wait: { ms: 0 },
  browser_navigate: { url: LOCAL }, browser_click: { ref: 'e1' }, browser_type: { ref: 'e1', text: 'SPRING' }, browser_press: { key: 'Enter' },
};
const ALL = Object.keys(ARGS) as BrowserToolName[];
const READS: BrowserToolName[] = ['browser_snapshot', 'browser_screenshot', 'browser_console', 'browser_wait'];
const PAGE_ACTIONS: BrowserToolName[] = ['browser_click', 'browser_type', 'browser_press'];

describe('every call answers to the host, before anything else', () => {
  it.each(ALL)('%s refuses while the setting is off', async (name) => {
    const { call, pages } = harness({ snapshot: { runtime: { browserEnabled: false } as DaemonSnapshot['runtime'] } });
    expect(code(await call(name, ARGS[name]))).toBe('browser-off');
    expect(pages.beginTool).not.toHaveBeenCalled();
  });

  it.each(ALL)('%s refuses with no turn running', async (name) => {
    expect(code(await harness({ agent: { currentTurnId: undefined } }).call(name, ARGS[name]))).toBe('unattended');
  });

  it.each(ALL)('%s refuses a turn no person sent', async (name) => {
    expect(code(await harness({ attended: false }).call(name, ARGS[name]))).toBe('unattended');
  });

  it.each(ALL)('%s refuses while the conversation is stopped on the person', async (name) => {
    expect(code(await harness({ agent: { state: 'blocked' } }).call(name, ARGS[name]))).toBe('unattended');
  });

  it('refuses a conversation with no agent', async () => {
    expect(code(await harness({ agent: null }).call('browser_snapshot'))).toBe('unattended');
  });

  it('refuses after the person pressed 중지 this turn', async () => {
    const { call, pages, driver } = harness();
    vi.mocked(pages.beginTool).mockReturnValue('stopped');
    expect(code(await call('browser_click', { ref: 'e1' }))).toBe('stopped');
    expect(driver.click).not.toHaveBeenCalled();
    expect(pages.endTool).not.toHaveBeenCalled();
  });

  it('arms the guard before it reads the page, and always disarms the tool', async () => {
    const { call, pages, order } = harness({ url: OUTSIDE });
    vi.mocked(pages.page).mockImplementation(() => { order.push('page'); return { ok: false, reason: 'no-page' }; });
    await call('browser_snapshot');
    expect(order).toEqual(['begin', 'page', 'end']);
  });

  it('refuses arguments it does not know', async () => {
    const { call, driver } = harness();
    expect((await call('browser_click', { ref: 'e1', x: 3 })).isError).toBe(true);
    expect((await call('browser_click', {})).isError).toBe(true);
    expect(driver.click).not.toHaveBeenCalled();
  });
});

describe('the preset table', () => {
  describe('a page that is not allowed', () => {
    it.each(ALL.filter((name) => name !== 'browser_navigate'))('%s is refused at every preset', async (name) => {
      for (const preset of ['plan', 'standard', 'full-access'] as const) {
        const { call, driver, requestApproval } = harness({ url: OUTSIDE, preset });
        const answer = code(await call(name, ARGS[name]));
        expect(answer, preset).toBe(preset === 'plan' && PAGE_ACTIONS.includes(name) ? 'plan-mode' : 'site-not-allowed');
        expect(driver.snapshot).not.toHaveBeenCalled();
        expect(driver.click).not.toHaveBeenCalled();
        expect(requestApproval).not.toHaveBeenCalled();
      }
    });

    it('browser_navigate is refused at every preset, at once, and the pane bar says so', async () => {
      for (const preset of ['plan', 'standard', 'full-access'] as const) {
        const { call, pages, requestApproval } = harness({ preset });
        expect(code(await call('browser_navigate', { url: OUTSIDE })), preset).toBe('site-not-allowed');
        expect(pages.navigateForTool).not.toHaveBeenCalled();
        expect(pages.refuseNavigation).toHaveBeenCalledWith('chat', OUTSIDE, 'site-not-allowed');
        expect(requestApproval).not.toHaveBeenCalled();
      }
    });
  });

  describe('plan', () => {
    it.each(PAGE_ACTIONS)('%s is refused by the host, on every site: Codex would run it', async (name) => {
      for (const url of [LOCAL, ALLOWED, 'file:///C:/repo/index.html']) {
        const { call, driver } = harness({ url, preset: 'plan' });
        expect(code(await call(name, ARGS[name])), url).toBe('plan-mode');
        expect(driver.click).not.toHaveBeenCalled();
        expect(driver.type).not.toHaveBeenCalled();
        expect(driver.press).not.toHaveBeenCalled();
      }
    });

    it.each(READS)('%s runs on local and allowed sites', async (name) => {
      for (const url of [LOCAL, ALLOWED]) expect(code(await harness({ url, preset: 'plan' }).call(name, ARGS[name])), url).toBe('ran');
    });

    it('browser_navigate runs, and asks nothing', async () => {
      const { call, requestApproval, pages } = harness({ url: LOCAL, preset: 'plan' });
      expect(code(await call('browser_navigate', { url: ALLOWED }))).toBe('ran');
      expect(pages.navigateForTool).toHaveBeenCalled();
      expect(requestApproval).not.toHaveBeenCalled();
    });
  });

  describe('standard', () => {
    it.each(ALL)('%s is free on a local page', async (name) => {
      const { call, requestApproval } = harness();
      expect(code(await call(name, ARGS[name]))).toBe('ran');
      expect(requestApproval).not.toHaveBeenCalled();
    });

    it.each(ALL)('%s is free on a file page', async (name) => {
      const { call, requestApproval } = harness({ url: 'file:///C:/repo/index.html' });
      expect(code(await call(name, ARGS[name]))).toBe('ran');
      expect(requestApproval).not.toHaveBeenCalled();
    });

    it.each(READS)('%s is free on an allowed site', async (name) => {
      const { call, requestApproval } = harness({ url: ALLOWED });
      expect(code(await call(name, ARGS[name]))).toBe('ran');
      expect(requestApproval).not.toHaveBeenCalled();
    });

    it.each(PAGE_ACTIONS)('%s asks on an allowed site', async (name) => {
      const { call, requestApproval } = harness({ url: ALLOWED });
      expect(code(await call(name, ARGS[name]))).toBe('ran');
      expect(requestApproval).toHaveBeenCalledTimes(1);
    });

    it('browser_navigate asks when it goes to an allowed site', async () => {
      const { call, requestApproval } = harness();
      expect(code(await call('browser_navigate', { url: ALLOWED }))).toBe('ran');
      expect(requestApproval).toHaveBeenCalledTimes(1);
    });
  });

  describe('full access', () => {
    it.each(ALL)('%s is free on an allowed site', async (name) => {
      const { call, requestApproval } = harness({ url: ALLOWED, preset: 'full-access' });
      const value = name === 'browser_navigate' ? { url: ALLOWED } : ARGS[name];
      expect(code(await call(name, value))).toBe('ran');
      expect(requestApproval).not.toHaveBeenCalled();
    });
  });
});

describe('approval', () => {
  it('holds the host\'s own arguments, the page\'s words apart', async () => {
    const { call, requests } = harness({ url: ALLOWED });
    await call('browser_type', { ref: 'e1', text: 'SPRING' });
    expect(requests[0]).toMatchObject({
      sessionId: 'chat', turnId: 'turn-1', origin: 'https://staging.cart-kit.example', tool: 'browser_type', action: 'type',
      run: { kind: 'type', value: 'SPRING' }, pageElement: 'button "Pay"',
    });
  });

  it('shows the full URL of a navigation', async () => {
    const { call, requests } = harness();
    await call('browser_navigate', { url: `${ALLOWED}?step=2` });
    expect(requests[0]).toMatchObject({ run: { kind: 'navigate', url: `${ALLOWED}?step=2` } });
  });

  it('shows the keys', async () => {
    const { call, requests } = harness({ url: ALLOWED });
    await call('browser_press', { key: 'Control+Enter' });
    expect(requests[0]).toMatchObject({ run: { kind: 'press', keys: 'Control+Enter' } });
  });

  it('runs nothing on a declined or timed-out answer', async () => {
    for (const answer of ['approval-declined', 'approval-timeout'] as const) {
      const { call, driver, pages } = harness({ url: ALLOWED, answer });
      expect(code(await call('browser_click', { ref: 'e1' }))).toBe(answer);
      expect(driver.click).not.toHaveBeenCalled();
      expect(code(await call('browser_navigate', { url: ALLOWED }))).toBe(answer);
      expect(pages.navigateForTool).not.toHaveBeenCalled();
    }
  });

  it('lets the person use the pane while they decide: no tool runs during the wait', async () => {
    const { call, order, requestApproval } = harness({ url: ALLOWED });
    requestApproval.mockImplementation(async () => { order.push('asked'); return 'allow'; });
    await call('browser_click', { ref: 'e1' });
    expect(order).toEqual(['begin', 'end', 'asked', 'begin', 'end']);
  });

  it('runs nothing if the person pressed 중지 during the wait, whatever the answer was', async () => {
    const { call, pages, driver, requestApproval } = harness({ url: ALLOWED });
    requestApproval.mockImplementation(async () => { vi.mocked(pages.beginTool).mockReturnValue('stopped'); return 'allow'; });
    expect(code(await call('browser_click', { ref: 'e1' }))).toBe('stopped');
    expect(driver.click).not.toHaveBeenCalled();
  });

  it('reports a stop that ended the wait', async () => {
    const { call, driver } = harness({ url: ALLOWED, answer: 'stopped' as never });
    expect(code(await call('browser_click', { ref: 'e1' }))).toBe('stopped');
    expect(driver.click).not.toHaveBeenCalled();
  });

  it('declines on a host with nobody to ask', async () => {
    const { pages, snapshot, driver } = harness({ url: ALLOWED });
    const tools = new BrowserTools({ pages, getSnapshot: () => snapshot, turnAttended: () => true, delay: async () => undefined });
    expect(code(await tools.call({ sessionId: 'chat', projectId: 'p', permissionPreset: 'standard' }, 'browser_click', { ref: 'e1' }))).toBe('approval-declined');
    expect(driver.click).not.toHaveBeenCalled();
  });

  it('skips the question once the person said so for this site', async () => {
    const { call, requestApproval, driver } = harness({ url: ALLOWED, trusted: true });
    expect(code(await call('browser_click', { ref: 'e1' }))).toBe('ran');
    expect(requestApproval).not.toHaveBeenCalled();
    expect(driver.click).toHaveBeenCalled();
  });

  describe('is void if anything changed while it waited', () => {
    const during = (change: (h: ReturnType<typeof harness>) => void) => {
      const h = harness({ url: ALLOWED });
      h.requestApproval.mockImplementation(async () => { change(h); return 'allow'; });
      return h;
    };

    it('the page went to another origin', async () => {
      const h = during(({ live, driver }) => { live.current = { ok: true, contents: {} as Electron.WebContents, cdp: driver as unknown as BrowserCdp, url: 'https://other.cart-kit.example/', site: 'allowed' }; });
      expect(code(await h.call('browser_click', { ref: 'e1' }))).toBe('site-not-allowed');
      expect(h.driver.click).not.toHaveBeenCalled();
    });

    it('the site was revoked', async () => {
      const h = during(({ live, driver }) => { live.current = { ok: true, contents: {} as Electron.WebContents, cdp: driver as unknown as BrowserCdp, url: ALLOWED, site: 'external' }; });
      expect(code(await h.call('browser_click', { ref: 'e1' }))).toBe('site-not-allowed');
      expect(h.driver.click).not.toHaveBeenCalled();
    });

    it('the site was revoked before a navigation', async () => {
      const h = during(({ pages }) => { vi.mocked(pages.classify).mockReturnValue('external'); });
      expect(code(await h.call('browser_navigate', { url: ALLOWED }))).toBe('site-not-allowed');
      expect(h.pages.navigateForTool).not.toHaveBeenCalled();
    });

    it('the element changed', async () => {
      const h = during(({ driver }) => { driver.target.mockResolvedValue({ role: 'button', name: 'Delete account', password: false }); });
      expect(code(await h.call('browser_click', { ref: 'e1' }))).toBe('stale-ref');
      expect(h.driver.click).not.toHaveBeenCalled();
    });

    it('the element became a password field', async () => {
      const h = during(({ driver }) => { driver.target.mockResolvedValue({ ...BUTTON, password: true }); });
      expect(code(await h.call('browser_click', { ref: 'e1' }))).toBe('stale-ref');
    });

    it('the element went', async () => {
      const h = during(({ driver }) => { driver.target.mockRejectedValue(new BrowserRefused('stale-ref')); });
      expect(code(await h.call('browser_click', { ref: 'e1' }))).toBe('stale-ref');
      expect(h.driver.click).not.toHaveBeenCalled();
    });

    it('the page crashed', async () => {
      const h = during(({ live }) => { live.current = { ok: false, reason: 'page-gone' }; });
      expect(code(await h.call('browser_click', { ref: 'e1' }))).toBe('page-gone');
    });
  });
});

describe('the other refusals', () => {
  it.each<[BrowserRefusal, BrowserPageResult]>([
    ['no-page', { ok: false, reason: 'no-page' }],
    ['page-gone', { ok: false, reason: 'page-gone' }],
    ['rebind-suspected', { ok: false, reason: 'rebind-suspected' }],
  ])('%s', async (reason, page) => {
    for (const name of ALL.filter((tool) => tool !== 'browser_navigate')) expect(code(await harness({ page }).call(name, ARGS[name])), name).toBe(reason);
  });

  it('no-page hands over what could be opened', async () => {
    const h = harness({ page: { ok: false, reason: 'no-page' } });
    const tools = new BrowserTools({ pages: h.pages, getSnapshot: () => h.snapshot, turnAttended: () => true, devUrls: () => ['http://localhost:5173/'] });
    expect(parsed(await tools.call({ sessionId: 'chat', projectId: 'p', permissionPreset: 'standard' }, 'browser_snapshot', {}))).toMatchObject({ code: 'no-page', devUrls: ['http://localhost:5173/'] });
  });

  it('stale-ref comes through from the page layer', async () => {
    expect(code(await harness({ cdp: cdp({ target: vi.fn(async () => { throw new BrowserRefused('stale-ref'); }) }) }).call('browser_click', { ref: 'e9' }))).toBe('stale-ref');
  });

  it('a password is not typed on a site outside this PC, at any preset that may act', async () => {
    const password = cdp({ target: vi.fn(async () => ({ role: 'textbox', name: 'Password', password: true })) });
    for (const preset of ['standard', 'full-access'] as const) {
      const { call, requestApproval } = harness({ url: ALLOWED, preset, cdp: password });
      expect(code(await call('browser_type', { ref: 'e1', text: 'hunter2' }))).toBe('password-field');
      expect(requestApproval).not.toHaveBeenCalled();
      expect(password.type).not.toHaveBeenCalled();
    }
  });

  it('a password on this PC\'s own page is the person\'s dev login', async () => {
    const password = cdp({ target: vi.fn(async () => ({ role: 'textbox', name: 'Password', password: true })) });
    expect(code(await harness({ cdp: password }).call('browser_type', { ref: 'e1', text: 'dev' }))).toBe('ran');
    expect(password.type).toHaveBeenCalledWith('e1', 'dev');
  });

  it('upload-unsupported: a click that opened a file chooser', async () => {
    expect(code(await harness({ cdp: cdp({ fileChooserOpened: vi.fn(() => true) }) }).call('browser_click', { ref: 'e1' }))).toBe('upload-unsupported');
  });

  it('limit: thirty screenshots a turn', async () => {
    const { call, tools, driver } = harness();
    for (let index = 0; index < 30; index += 1) expect(code(await call('browser_screenshot')), String(index)).toBe('ran');
    expect(code(await call('browser_screenshot'))).toBe('limit');
    expect(driver.screenshot).toHaveBeenCalledTimes(30);
    tools.turnEnded('turn-1');
    expect(code(await call('browser_screenshot'))).toBe('ran');
  });

  it.each(['javascript:alert(1)', 'data:text/html,hi', 'chrome://settings', 'not a url'])('browser_navigate refuses %s', async (url) => {
    const { call, pages } = harness();
    expect(code(await call('browser_navigate', { url }))).toBe('site-not-allowed');
    expect(pages.navigateForTool).not.toHaveBeenCalled();
  });

  it('a key it does not send is an error', async () => {
    const { call, driver } = harness();
    expect((await call('browser_press', { key: 'F12' })).isError).toBe(true);
    expect(driver.press).not.toHaveBeenCalled();
  });
});

describe('what the tools return', () => {
  it('a snapshot names what it did not read', async () => {
    const value = parsed(await harness().call('browser_snapshot'));
    expect(value).toMatchObject({ url: LOCAL, page: 'button "Pay" [ref=e1]', unreadFrames: ['https://ads.example/'] });
  });

  it('a screenshot is an image beside its words', async () => {
    const result = await harness().call('browser_screenshot', { ref: 'e1' });
    expect(result.content[1]).toEqual({ type: 'image', data: 'SkVH', mimeType: 'image/jpeg' });
    expect((result.content[0] as { text: string }).text).toContain('quoted data');
  });

  it('the console filters by level', async () => {
    expect(parsed(await harness().call('browser_console', { level: 'error' })).lines).toBe('error: broken\nexception: TypeError');
    expect(parsed(await harness().call('browser_console', { level: 'warning' })).lines).toBe('warning: careful\nerror: broken\nexception: TypeError');
  });

  it('a wait finds text, or says it did not', async () => {
    expect(parsed(await harness().call('browser_wait', { text: 'Order', ms: 0 }))).toEqual({ ok: true, found: true });
    expect(parsed(await harness().call('browser_wait', { text: 'Nothing', ms: 0 }))).toEqual({ ok: true, found: false });
  });

  it('a wait stops if the person goes somewhere the AI may not read', async () => {
    const h = harness({ cdp: cdp({ pageText: vi.fn(async () => 'nothing yet') }) });
    let calls = 0;
    vi.mocked(h.pages.page).mockImplementation(() => {
      calls += 1;
      return calls > 1 ? { ok: true, contents: {} as Electron.WebContents, cdp: h.driver as unknown as BrowserCdp, url: OUTSIDE, site: 'external' } : h.live.current;
    });
    expect(code(await h.call('browser_wait', { text: 'Nothing', ms: 10_000 }))).toBe('site-not-allowed');
  });

  it('says when a click led somewhere the host stopped', async () => {
    const { call, pages, driver } = harness();
    let blocked: { origin: string; reason: BrowserRefusal } | undefined;
    vi.mocked(pages.state).mockImplementation(() => ({ conversationId: 'chat', url: LOCAL, loading: false, canBack: false, canForward: false, ai: 'driving', ...(blocked ? { blocked } : {}) }));
    driver.click.mockImplementation(async () => { blocked = { origin: 'https://elsewhere.example', reason: 'site-not-allowed' }; });
    expect(parsed(await call('browser_click', { ref: 'e1' }))).toMatchObject({ ok: true, blocked: { origin: 'https://elsewhere.example', reason: 'site-not-allowed' } });
  });

  it('does not repeat what was stopped before the click', async () => {
    const { call, pages } = harness();
    const blocked = { origin: 'https://elsewhere.example', reason: 'site-not-allowed' as const };
    vi.mocked(pages.state).mockReturnValue({ conversationId: 'chat', url: LOCAL, loading: false, canBack: false, canForward: false, ai: 'driving', blocked });
    expect(parsed(await call('browser_click', { ref: 'e1' }))).not.toHaveProperty('blocked');
  });
});

describe('the definitions', () => {
  const byName = new Map(BROWSER_TOOL_DEFINITIONS.map((tool) => [tool.name as string, tool]));

  it('are the eight names', () => {
    expect([...byName.keys()].sort()).toEqual([...ALL].sort());
  });

  it('load two up front and defer the rest', () => {
    expect([...byName.values()].filter((tool) => tool._meta).map((tool) => tool.name)).toEqual(['browser_snapshot', 'browser_screenshot']);
  });

  it('are honest about what acts: the host decides, the hint does not', () => {
    for (const name of READS) expect(byName.get(name)!.annotations, name).toEqual({ readOnlyHint: true });
    for (const name of ['browser_navigate', ...PAGE_ACTIONS]) expect(byName.get(name)!.annotations, name).toEqual({ readOnlyHint: false, openWorldHint: true });
  });

  it('never promise what a model should do in place of a check', () => {
    for (const tool of byName.values()) expect(JSON.stringify(tool)).not.toMatch(/please|must not follow/iu);
  });
});
