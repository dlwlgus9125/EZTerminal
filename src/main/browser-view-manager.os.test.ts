import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';

/**
 * The guards on a real `WebContentsView`, in an Electron of their own: its profile is a scratch folder, its only server is
 * on loopback, and every `*.example` name maps there. See `browser-view-manager.harness.ts`.
 */

type Case = { readonly reached: readonly string[]; readonly all: readonly string[]; readonly url: string; readonly blocked: string | null; readonly frames: readonly string[] };
type Report = Record<string, unknown> & { readonly fatal?: string };

const root = path.resolve(__dirname, '..', '..');
let scratch: string;
let report: Report;

beforeAll(async () => {
  scratch = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'ez-browser-guards-')));
  const outDir = path.join(scratch, 'bundle');
  await build({
    root, configFile: false, logLevel: 'silent',
    // It runs from a scratch folder, with no node_modules beside it.
    ssr: { noExternal: true },
    build: {
      ssr: path.join(root, 'src', 'main', 'browser-view-manager.harness.ts'), outDir, emptyOutDir: true, minify: false,
      rollupOptions: { external: ['electron'], output: { format: 'es', entryFileNames: 'harness.mjs' } },
    },
  });
  const electron = createRequire(__filename)('electron') as unknown as string;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const failure = await new Promise<string>((resolve) => {
    execFile(electron, [path.join(outDir, 'harness.mjs'), '--scratch', scratch], { env, timeout: 150_000 }, (error, _stdout, stderr) => resolve(`${error?.message ?? ''}\n${stderr}`.slice(-2_000)));
  });
  const file = path.join(scratch, 'report.json');
  report = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Report : { fatal: `the harness wrote no report: ${failure}` };
}, 180_000);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
});

const of = (name: string): Case => report[name] as Case;

describe('the harness', () => {
  it('ran to the end', () => {
    expect(report.fatal).toBeUndefined();
    expect(report.done).toBe(true);
  });
});

describe('a pane the AI has driven: nothing reaches the site, and the page stays', () => {
  it.each(['guard-link', 'guard-script', 'guard-redirect-link', 'guard-redirect-tool', 'guard-form', 'guard-window-open', 'guard-target-blank', 'guard-file-link'])('%s', (name) => {
    expect(of(name).reached).toEqual([]);
    expect(of(name).url).toContain('/pad');
  });

  it('guard-meta-refresh: the refresh is stopped on the page that tried it', () => {
    expect(of('guard-meta-refresh').reached).toEqual([]);
    expect(of('guard-meta-refresh').url).toContain('/meta');
  });

  it.each(['guard-iframe', 'guard-iframe-redirect'])('%s: the frame does not load, the page stays', (name) => {
    expect(of(name).reached).toEqual([]);
    expect(of(name).url).toContain('/pad');
  });

  // Without this, a click that never landed would pass every `reached: []` above.
  it('tells the pane what it stopped: each attempt really happened', () => {
    for (const name of ['guard-link', 'guard-script', 'guard-redirect-link', 'guard-redirect-tool', 'guard-form', 'guard-window-open', 'guard-target-blank', 'guard-meta-refresh', 'guard-iframe', 'guard-iframe-redirect']) {
      expect(of(name).blocked, name).toBe('site-not-allowed');
    }
  });
});

describe('a pane no one has ever seen', () => {
  it('a tool\'s click lands, quickly', () => {
    expect(report['unseen-click']).toMatchObject({ clicked: 1 });
    expect((report['unseen-click'] as { ms: number }).ms).toBeLessThan(1_500);
  });

  it('with the app minimized too', () => {
    expect(report['unseen-click-minimized']).toMatchObject({ clicked: 1 });
    expect((report['unseen-click-minimized'] as { ms: number }).ms).toBeLessThan(1_500);
  });

  it('gives a screenshot', () => {
    expect(report['unseen-click-shot']).toMatchObject({ empty: false });
    expect(report['unseen-click-minimized-shot']).toMatchObject({ empty: false });
  });
});

describe('what stops the tools lifts no guard', () => {
  it('a late script after 중지 is refused like any other', () => {
    expect(of('after-stop').reached).toEqual([]);
    expect(of('after-stop').url).toContain('/pad');
  });

  it('중지 refuses the tools for the rest of the turn', () => {
    expect(report['after-stop-refusal']).toBe('stopped');
  });

  it('a late script after the turn ends is refused like any other', () => {
    expect(of('after-turn-end').reached).toEqual([]);
    expect(of('after-turn-end').url).toContain('/pad');
  });

  it('a pane closed and opened again in the conversation stays guarded', () => {
    expect(of('survives-close').reached).toEqual([]);
    expect(report['survives-close-url']).toContain('/pad');
  });
});

describe('only a navigation the person made is excepted', () => {
  it('the address bar reaches the site, and the page stays unread by the AI', () => {
    expect(of('person-address-bar').reached).toEqual(['/landed?via=address-bar']);
    expect(report['person-address-bar-site']).toBe('external');
    expect(report['person-address-bar-state']).toBe('external');
  });

  it('the address bar\'s pass covers its own redirect', () => {
    expect(of('person-address-bar-redirect').reached).toEqual(['/landed?via=person-redirect']);
  });

  it('a real click on a link while no tool runs', () => {
    expect(of('person-click').reached).toEqual(['/landed?via=link']);
  });

  it('not a script a click sets off', () => {
    expect(of('person-click-script').reached).toEqual([]);
    expect(of('person-click-script').url).toContain('/pad');
  });

  it('not a click that lands while a tool runs', () => {
    expect(of('person-click-while-tool-runs').reached).toEqual([]);
  });

  it('not a script that waits out the click', () => {
    expect(of('person-click-then-late-script').reached).toEqual([]);
  });

  it('not a script clicking a link for itself', () => {
    expect(of('script-anchor-without-input').reached).toEqual([]);
  });

  it('the pass ends with the person\'s navigation, even one that commits nothing', () => {
    expect(report['person-pass-ends-could-go-back'], 'the back really went').toBe(true);
    expect(of('person-pass-ends').reached).toEqual([]);
    expect(of('person-pass-ends').blocked).toBe('site-not-allowed');
  });

  it('a name that does not resolve reads as a server that is not there', () => {
    expect(report['name-that-does-not-resolve-fault']).toBe('server-down');
  });

  it('a pane no AI has driven is the person\'s', () => {
    expect(of('never-driven').reached).toEqual(['/landed?via=person-only']);
  });

  it('a popup to a local page opens here, and no window appears', () => {
    expect(of('popup-local-opens-here').url).toContain('/landed?via=popup');
  });
});

describe('DNS rebinding', () => {
  it('a name resolving to this PC is cancelled before the request', () => {
    expect(of('rebind-before-request').reached).toEqual([]);
    expect(of('rebind-before-request').blocked).toBe('rebind-suspected');
  });

  it('for what a page pulls in too', () => {
    expect(of('rebind-subresources').reached).toEqual([]);
  });

  it('a name some page merely points at this PC is held against nobody: a page could fill the list that way', () => {
    expect(report['rebind-subresources-suspect']).toBe(false);
  });

  it('the second layer stops a site that answers from here before its page commits', () => {
    // The honest residual: this request did reach the server, because the address is known only from the response.
    expect(of('rebind-second-layer').reached).toEqual(['/landed']);
    expect(of('rebind-second-layer').blocked).toBe('rebind-suspected');
    expect(report['rebind-second-layer-page']).toBe('local');
    expect(of('rebind-second-layer').url).toContain('/pad');
  });

  it('and tools refuse a site whose page was already up', () => {
    expect(of('rebind-later-response').blocked).toBe('rebind-suspected');
    expect(report['rebind-later-page']).toBe('rebind-suspected');
  });

  it('its page does not stay up: the view goes, its address stays for the person to open again', () => {
    expect(report['rebind-later-ended']).toBe(true);
    expect(report['rebind-later-state']).toMatchObject({ needsReopen: true, site: 'external' });
    expect((report['rebind-later-state'] as { url: string }).url).toContain('later.example');
  });

  it('a page whose own name turns to this PC is caught the same, by the resolver', () => {
    expect(of('rebind-name-flips').reached).toEqual([]);
    expect(report['rebind-name-flips-ended']).toBe(true);
    expect(report['rebind-name-flips-suspect']).toBe(true);
  });

  describe('a suspect site is out of reach by every road', () => {
    it.each(['suspect-script', 'suspect-redirect', 'suspect-click', 'suspect-iframe', 'suspect-window-open'])('%s', (name) => {
      expect(of(name).reached).toEqual([]);
      expect(of(name).blocked).toBe('rebind-suspected');
      expect(of(name).url).toContain('/pad');
    });

    it('every kind of request, while the same ones reach a site in good standing', () => {
      expect(of('suspect-every-road').reached).toEqual([]);
      expect([...of('clean-every-road').reached].sort()).toEqual(['/beacon', '/c.css', '/fetch', '/img', '/s.js', '/ws']);
    });

    it('except the person going to it, for that visit', () => {
      expect(of('suspect-person').reached).toEqual(['/landed?via=suspect-person']);
      expect(report['suspect-person-cleared']).toBe(true);
    });

    it('every suspect stays one: a second cannot overwrite the first', () => {
      expect(report['suspects-page']).toBe('rebind-suspected');
      expect(report['suspects-both']).toEqual([true, true]);
    });

    it('going elsewhere, or closing the pane, ends nothing', () => {
      expect(report['suspect-outlives']).toBe(true);
    });

    it('on a pane that never heard of it: suspicion belongs to the partition', () => {
      expect(of('suspect-other-pane').reached).toEqual([]);
      expect(of('suspect-other-pane').blocked).toBe('rebind-suspected');
      expect(of('suspect-other-pane').url).toContain('/pad');
      expect(report['suspect-other-pane-answers']).toEqual({ suspected: true, site: 'external' });
    });

    it('when no pane owns the response that gave it away', () => {
      expect(report['suspect-no-pane']).toBe(true);
    });

    it('after a restart', () => {
      expect(report['suspect-restart']).toBe(true);
    });

    it('and its page ends on a pane that heard nothing, and only there', () => {
      expect(report['suspect-document-elsewhere-ended']).toBe(true);
      expect(report['suspect-document-elsewhere-reopen']).toBe(true);
      expect(of('suspect-document-elsewhere').url).toContain('/pad');
    });

    it('a frame of it stops being read, and its page goes on', () => {
      const before = report['suspect-frame-before'] as { text: string; unreadFrames: readonly string[] };
      const after = report['suspect-frame-after'] as { text: string; unreadFrames: readonly string[] };
      expect(before.text, 'the frame really was readable').toContain('COUSIN-FRAME-TEXT');
      expect(before.unreadFrames).toEqual([]);
      expect(after.text).toContain('TOP-TEXT');
      expect(after.text).not.toContain('COUSIN-FRAME-TEXT');
      expect(after.unreadFrames.some((url) => url.includes('split.example'))).toBe(true);
      expect(report['suspect-frame-top-up']).toBe(true);
    });

    describe('a person\'s own visit', () => {
      it('the site works for them, its own frames and requests too', () => {
        expect(of('suspect-visit').reached).toEqual(expect.arrayContaining(['/with-frames', '/landed?via=own-frame', '/landed?via=visit-fetch']));
        expect(report['suspect-visit-own-fetch']).toBe(200);
      });

      it('the AI still reads nothing there, though the list names the site', () => {
        expect(report['suspect-visit-page']).toBe('external');
        expect(report['suspect-visit-state']).toBe('external');
      });

      it('holds for that pane alone', () => {
        expect(report['suspect-visit-here']).toBe(false);
        expect(report['suspect-visit-other-pane']).toBe(true);
      });

      it('ends with the visit', () => {
        expect(report['suspect-visit-after']).toBe(true);
      });

      it('Back is a visit of theirs too', () => {
        expect(report['suspect-visit-back']).toBe('external');
        expect(report['suspect-visit-still']).toBe(true);
      });

      it('only allowing the site again lifts it', () => {
        expect(report['suspect-visit-allowed']).toEqual({ suspected: false, site: 'allowed' });
      });
    });
  });

  it('an allowed site with a public answer loads, its own frames too', () => {
    expect(report['allowed-loads-site']).toBe('allowed');
    expect(of('allowed-loads').reached).toEqual(['/with-frames', '/landed?via=own-frame']);
  });

  it('a revoke applies at once', () => {
    expect(report['revoked-at-once-site']).toBe('external');
  });
});

describe('what the tools do to a real page, unseen', () => {
  const snapshot = (): { text: string; truncated: boolean; unreadFrames: readonly string[] } => report['tools-snapshot'] as never;

  it('reads the page, a frame it may read, and refs what can be acted on', () => {
    expect(snapshot().text).toMatch(/heading "Order summary"/u);
    expect(snapshot().text).toMatch(/textbox "Name" value="old" \[ref=e\d+\]/u);
    expect(snapshot().text).toMatch(/button "Save" \[ref=e\d+\]/u);
    expect(snapshot().text).toContain('SAME-ORIGIN-FRAME-TEXT');
  });

  it('never returns a password', () => {
    expect(snapshot().text).toMatch(/textbox "Password"/u);
    expect(snapshot().text).not.toContain('hunter2-secret');
  });

  it('names a frame it did not read, and reads nothing of it', () => {
    expect(snapshot().unreadFrames.some((url) => url.includes('evil.example'))).toBe(true);
    expect(snapshot().text).not.toContain('landed');
  });

  it('leaves out what a page hides from the person, and keeps what is only hard to see', () => {
    const text = report['hidden-text'] as string;
    for (const words of ['VISIBLE-WORDS', 'WHITE-WORDS', 'RESTORED-WORDS']) expect(text, words).toContain(words);
    for (const words of ['OPACITY-WORDS', 'NESTED-OPACITY-WORDS', 'NESTED-BUTTON', 'FONT-ZERO-WORDS', 'OFF-LEFT-WORDS', 'OFF-TOP-WORDS']) expect(text, words).not.toContain(words);
  });

  it('keeps hidden words out of a name that comes from content, and the words a person sees in it', () => {
    const text = report['hidden-text'] as string;
    for (const words of ['BUTTON-HIDDEN-WORDS', 'LINK-HIDDEN-WORDS', 'HEADING-HIDDEN-WORDS']) expect(text, words).not.toContain(words);
    expect(text).toContain('button "Buy now"');
    expect(text).toMatch(/link \[ref=e\d+\]/u);
    expect(text).toMatch(/heading "Heading\s+shown"/u);
  });

  it('keeps what it must: a button in a font-size:0 wrapper, and a closed select\'s options', () => {
    const text = report['hidden-text'] as string;
    expect(text).toContain('button "Keep this button"');
    expect(text).toContain('SIZE-OPTION');
  });

  it('does not read a frame whose element is hidden, off the page or of no size, or a frame inside one, and names each', () => {
    const text = report['hidden-text'] as string;
    expect(text).toContain('SHOWN-FRAME-WORDS');
    for (const words of ['TRANSPARENT-FRAME-WORDS', 'OFF-PAGE-FRAME-WORDS', 'TINY-FRAME-WORDS', 'NESTED-FRAME-WORDS']) expect(text, words).not.toContain(words);
    expect(report['hidden-text-unread'] as readonly string[]).toEqual(['about:srcdoc', 'about:srcdoc', 'about:srcdoc', 'about:srcdoc', 'about:srcdoc']);
  });

  it('clicks, types over what a field holds, and presses', () => {
    expect(report['tools-clicked']).toBe(1);
    expect(report['tools-typed']).toBe('Ada');
    expect(report['tools-retyped']).toBe('Grace');
    expect(report['tools-pressed']).toBe(1);
  });

  it('tells a password field by its own reading', () => {
    expect(report['tools-password']).toMatchObject({ password: true });
    expect(report['tools-name-target']).toMatchObject({ password: false, name: 'Name', role: 'textbox' });
  });

  it('will not click what something else covers, whatever the page\'s own contains says', () => {
    expect(report['tools-covered']).toBe('stale-ref');
  });

  it('asks the page\'s own code nothing: its poisoned contains and focus never ran', () => {
    expect(report['tools-poisoned']).toBe(0);
  });

  it('opens no file dialog and says so', () => {
    expect(report['tools-chooser']).toMatchObject({ opened: true });
  });

  it('hears the console', () => {
    const lines = report['tools-console'] as readonly string[];
    expect(lines.some((line) => line.includes('page says hello'))).toBe(true);
    expect(lines.some((line) => line.includes('thrown here'))).toBe(true);
  });

  it('shoots CSS pixels as JPEG, the whole page or one element', () => {
    expect(report['tools-shot']).toMatchObject({ width: 1280, height: 800, jpeg: '/9j/' });
    expect(report['tools-crop']).toMatchObject({ smaller: true });
  });

  it('makes a thumbnail a row can carry, or none, whatever the page', () => {
    const thumb = report['tools-thumb'] as { bytes: number; jpeg: string };
    expect(thumb.jpeg).toBe('/9j/');
    expect(thumb.bytes).toBeGreaterThan(0);
    expect(thumb.bytes).toBeLessThanOrEqual(24_000);
    const noisy = report['tools-thumb-noisy'];
    expect(noisy === 'dropped' || (typeof noisy === 'number' && noisy <= 24_000), String(noisy)).toBe(true);
  });

  it('ends a ref at a navigation', () => {
    expect(report['tools-after-navigation']).toBe('stale-ref');
  });
});

describe('the app\'s own ports', () => {
  it('no resource type reaches them, from a local page or from the person', () => {
    expect(report.controlHits).toBe(0);
    expect(of('control-script-top').url).toContain('/pad');
  });
});

describe('an external top page', () => {
  it('reaches nothing on this PC, from the first request of the page', () => {
    expect(of('external-to-local').reached).toEqual(['/reaches-local']);
    expect(of('external-to-local').all.filter((entry) => entry.includes('pwn'))).toEqual([]);
  });

  it.each(['external-parting-shot', 'external-parting-shot-hidden'])('%s: reaches nothing on this PC on its way out, as the pane moves to a local page', (name) => {
    expect(of(name).all.filter((entry) => entry.startsWith('/parting'))).toEqual([]);
  });

  it('keeps its own frames, for the person who went there', () => {
    expect(of('person-site-own-frames').reached).toEqual(['/with-frames', '/landed?via=own-frame']);
  });
});

describe('what runs with no frame', () => {
  it('an external site gets no service worker', () => {
    expect(report['worker-external-secure'], 'the site could have had one').toBe(true);
    expect(report['worker-external-service-answer']).toBe('refused');
    expect(of('worker-external-service').all).toEqual([]);
  });

  it('an external page\'s worker reaches nothing on this PC', () => {
    expect(report['worker-external-shared-answer']).toBe('refused');
    expect(of('worker-external-shared').all).toEqual([]);
  });

  it('a local app keeps its service worker, and it reaches this PC', () => {
    expect(report['worker-local-service']).toBe('controlled');
    expect(report['worker-local-reach']).toBe('reached');
    expect(of('worker-local').all).toContain('/sw-reaches-local');
  });

  it('and a page\'s own request through that worker', () => {
    expect(report['worker-local-through']).toBe(200);
    expect(of('worker-local').all).toContain('/workers/through-worker');
  });

  it('and its shared worker', () => {
    expect(report['worker-local-shared']).toBe('reached');
    expect(of('worker-local').all).toContain('/shared-local');
  });

  it('a local worker that hides where it came from fails closed', () => {
    expect(report['worker-local-no-referrer']).toBe('refused');
    expect(of('worker-local').all).not.toContain('/sw-no-referrer');
  });

  it('a local worker still reaches nothing outside, and not the app\'s own ports', () => {
    expect(report['worker-local-outside']).toBe('refused');
    expect(of('worker-local').all).not.toContain('/sw-outside');
    expect(report['worker-local-control']).toBe('refused');
    expect(report.controlHitsAfterWorkers).toBe(report.controlHits);
  });
});

describe('file pages', () => {
  it('read their own folder and nothing outside it, for every resource', () => {
    expect(report['file-fetch-own']).toBe('body{color:red}');
    expect(report['file-fetch-outside']).toBe('refused');
    expect(report['file-fetch-junction'], 'a junction out of the folder').toBe('refused');
    expect(String(report['file-frame'] ?? '')).not.toContain('OUTSIDE-SECRET');
  });

  it('a person cannot open a file outside the folders either', () => {
    expect(report['file-outside-person-url']).not.toContain('secret');
  });
});

describe('the page\'s world', () => {
  it('has no preload, no sandbox hole and its own partition', () => {
    expect(report.preferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, disableDialogs: true, preload: null, webviewTag: false, ownPartition: true });
    expect((report.world as { globals: unknown }).globals).toEqual({ require: 'undefined', process: 'undefined', ezterminal: 'undefined', electron: 'undefined', module: 'undefined' });
  });

  it('gets no permission, and no prompt stalls it', () => {
    const { geolocation, notification, media, display, clipboardRead, clipboardWrite } = report.world as Record<string, string>;
    expect(geolocation).toBe('denied');
    expect(notification).toBe('denied');
    for (const answer of [media, display, clipboardRead, clipboardWrite]) {
      expect(answer).not.toBe('granted');
      expect(answer).not.toBe('stalled');
    }
  });

  it('cannot stall on a dialog', () => {
    expect(report.dialogMs).toBeLessThan(1_000);
  });

  it('has no way out through WebRTC', () => {
    expect(report.webRtcPolicy).toBe('disable_non_proxied_udp');
  });

  it('shares no cookies with the app', () => {
    expect(report.cookies).toEqual({ partition: 1, defaultSession: 0 });
  });

  it('downloads nothing', () => {
    expect(report.download).toEqual({ blocked: 'download-blocked', onDisk: [] });
  });
});

describe('what a guard reports for the conversation\'s rows', () => {
  const rows = (): readonly { conversationId: string; reason: string; turnId: string }[] => report['block-rows'] as never;

  it('a stop on a page the AI is at, with its turn', () => {
    expect(rows()).toContainEqual({ conversationId: 'pane-guard-script', reason: 'site-not-allowed', turnId: 'turn-1' });
  });

  it('nothing of a person\'s own browsing', () => {
    expect(rows().filter((row) => row.conversationId === 'pane-world')).toEqual([]);
  });
});

describe('addresses to offer', () => {
  it('come with the pane\'s state, and only when there are some', () => {
    expect(report.candidates).toEqual([{ url: 'http://127.0.0.1:PORT/', source: 'terminal' }]);
    expect(report['no-candidates']).toBeNull();
  });
});

describe('picking an element', () => {

  it('takes the person\'s click, and the page never hears it', () => {
    expect(report['pick-allowed']).toBe(true);
    expect(report['pick-state']).toBe(true);
    expect(report['pick-page-heard']).toBe(0);
    expect(report['pick-after']).toBe(false);
  });

  it('hands over the element, in the host\'s own reading', () => {
    expect(report.picked).toEqual([{ conversationId: 'pane-pick', url: 'http://127.0.0.1:PORT/counter', selector: '#go', role: 'button', name: 'go', imageBase64: '/9j/' }]);
  });

  it('gives the next click back to the page', () => {
    expect(report['pick-then-page-heard']).toBe(1);
  });

  it('ends at Esc, with the keyboard in the page, and picks nothing', () => {
    expect(report['pick-escape']).toEqual({ picking: false, picked: 0 });
  });

  it('ends when the person cancels, and the page goes on', () => {
    expect(report['pick-cancel']).toEqual({ picking: false, clicked: 2 });
  });

  it('ends with the page', () => {
    expect(report['pick-navigated']).toBe(false);
  });

  it('is refused on a site not allowed, and with no page', () => {
    expect(report['pick-outside']).toEqual({ can: false, picking: false });
    expect(report['pick-no-page']).toBe(false);
  });
});

describe('lifecycle', () => {
  it('keeps three views live: the oldest hidden one goes, keeping its address', () => {
    const cap = report.cap as Record<string, { live: boolean; needsReopen: boolean; url: string }>;
    expect(Object.values(cap).filter((pane) => pane.live)).toHaveLength(3);
    expect(cap['cap-1']).toMatchObject({ live: false, needsReopen: true });
    expect(cap['cap-1']!.url).toContain('cap=cap-1');
    expect(cap['cap-2']!.live, 'used last, so kept').toBe(true);
  });

  it('never reloads an evicted page by itself', () => {
    expect(report.capReloads).toEqual(['/landed?cap=cap-5']);
  });

  it('a crashed page is gone, not hanging', () => {
    expect(report.crash).toEqual({ page: 'page-gone', fault: 'gone' });
  });
});
