import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

type Theme = "matrix" | "dark" | "light" | "high-contrast";
type Density = "adaptive" | "compact" | "comfortable";
type Locale = "en" | "ko";
type Motion = "default" | "reduced";

interface StoryOptions {
  readonly density: Density;
  /** Leave product motion CSS untouched for assertions about reduced motion. */
  readonly freezeAnimations?: boolean;
  readonly locale: Locale;
  readonly motion: Motion;
  readonly scale?: 100 | 150;
  readonly theme: Theme;
}

async function openStory(
  page: Page,
  storyId: string,
  options: StoryOptions,
): Promise<void> {
  const scale = options.scale ?? 100;
  const globals = `theme:${options.theme};locale:${options.locale};density:${options.density};uiScale:${scale}`;
  const readyKey = `${storyId}|${options.theme}|${options.locale}|${options.density}|${scale}`;
  await page.emulateMedia({
    reducedMotion: options.motion === "reduced" ? "reduce" : "no-preference",
  });
  await page.goto(
    `/iframe.html?id=${storyId}&viewMode=story&globals=${encodeURIComponent(globals)}`,
    {
      // StoryReadyBoundary below is the product-specific readiness authority.
      // Waiting for Vite/Storybook's dev-server network to go fully idle makes
      // the first visual case depend on dependency warm-up and HMR traffic.
      waitUntil: "domcontentloaded",
    },
  );
  await expect(page.locator("html")).toHaveAttribute("data-story-ready", readyKey, {
    timeout: 60_000,
  });
  await expect(page.locator("#storybook-root")).toBeVisible();
  if (options.freezeAnimations !== false) {
    await page.addStyleTag({
      content: `
        *, *::before, *::after {
          animation-delay: 0s !important;
          animation-duration: 0s !important;
          caret-color: transparent !important;
          transition-delay: 0s !important;
          transition-duration: 0s !important;
        }
        html[data-effect-crt-rollbar="on"] body::after {
          animation: none !important;
          background-position: 0 35vh !important;
        }
      `,
    });
  }

  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-theme", options.theme);
  await expect(root).toHaveAttribute("data-density", options.density);
  await expect(root).toHaveAttribute("lang", options.locale);
  await expect(root).toHaveAttribute(
    "data-ui-scale",
    String(scale),
  );
  expect(
    await page.evaluate(
      () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
  ).toBe(options.motion === "reduced");
  if (options.scale === 150) {
    expect(
      await root.evaluate((element) => getComputedStyle(element).fontSize),
    ).toBe("24px");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
}

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  let results: Awaited<ReturnType<AxeBuilder["analyze"]>> | null = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("Axe is already running") || attempt === 39) throw error;
      // Storybook's accessibility addon can start its own audit on story load.
      // Wait for that authoritative run rather than racing a second axe.run().
      await page.waitForTimeout(250);
    }
  }
  if (!results) throw new Error("Accessibility audit did not return a result");

  expect(results.violations, "Story must satisfy WCAG 2.1 A/AA checks").toEqual(
    [],
  );
}

// Left-to-right order across the four header zones. The FX intensity control sits
// beside Agent Attention in zone four, not next to New Terminal, so the search
// field can occupy the whole elastic middle column.
const headerControlTestIds = [
  "workbench-brand-mark",
  "btn-new-tab",
  "btn-command-center",
  "btn-workspace-menu",
  "btn-effect-profile",
  "btn-toggle-agents",
] as const;

async function expectHeaderControlsNotToOverlap(page: Page): Promise<void> {
  const bounds = await Promise.all(
    headerControlTestIds.map(async (testId) => {
      const box = await page.getByTestId(testId).boundingBox();
      expect(box, `${testId} must have measurable geometry`).not.toBeNull();
      return { box: box!, testId };
    }),
  );

  for (let index = 0; index < bounds.length - 1; index += 1) {
    const current = bounds[index];
    const next = bounds[index + 1];
    expect(
      current.box.x + current.box.width,
      `${current.testId} must not overlap ${next.testId}`,
    ).toBeLessThanOrEqual(next.box.x + 0.5);
  }
}

const desktopCases = [
  {
    name: "800x600 high contrast error overlay at 150 percent",
    viewport: { width: 800, height: 600 },
    storyId: "compositions-workbench-shell--sidebar-error",
    screenshot: "desktop-800x600-error-high-contrast-150.png",
    expectedState: "error",
    sidebarMode: "overlay",
    options: {
      theme: "high-contrast",
      locale: "en",
      density: "compact",
      motion: "reduced",
      scale: 150,
    },
  },
  {
    name: "1024x720 light Korean loading overlay",
    viewport: { width: 1024, height: 720 },
    storyId: "compositions-workbench-shell--sidebar-loading-korean",
    screenshot: "desktop-1024x720-loading-light-ko.png",
    expectedState: "loading",
    sidebarMode: "overlay",
    options: {
      theme: "light",
      locale: "ko",
      density: "comfortable",
      motion: "default",
    },
  },
  {
    name: "1200x800 dark Korean sidebar closed",
    viewport: { width: 1200, height: 800 },
    storyId: "compositions-workbench-shell--sidebar-closed-korean",
    screenshot: "desktop-1200x800-closed-dark-ko.png",
    sidebarMode: "closed",
    options: {
      theme: "dark",
      locale: "ko",
      density: "adaptive",
      motion: "reduced",
    },
  },
  {
    name: "1440x900 Matrix English sidebar reflow",
    viewport: { width: 1440, height: 900 },
    storyId: "compositions-workbench-shell--sidebar-open",
    screenshot: "desktop-matrix-workbench.png",
    sidebarMode: "reflow",
    options: {
      theme: "matrix",
      locale: "en",
      density: "adaptive",
      motion: "default",
    },
  },
] as const;

test.describe("desktop Storybook visual contracts", () => {
  for (const visualCase of desktopCases) {
    test(visualCase.name, async ({ page }) => {
      await page.setViewportSize(visualCase.viewport);
      await openStory(page, visualCase.storyId, visualCase.options);

      const sidebar = page.getByTestId("workbench-sidebar");
      if (visualCase.sidebarMode === "closed") {
        await expect(sidebar).toHaveCount(0);
      } else {
        await expect(sidebar).toBeVisible();
        const expectedPosition =
          visualCase.sidebarMode === "overlay" ? "absolute" : "relative";
        expect(
          await sidebar.evaluate(
            (element) => getComputedStyle(element).position,
          ),
        ).toBe(expectedPosition);
        const scrim = page.locator(".workbench-sidebar-scrim");
        expect(
          await scrim.evaluate((element) => getComputedStyle(element).display),
        ).toBe(visualCase.sidebarMode === "overlay" ? "block" : "none");
        if (visualCase.sidebarMode === "overlay") {
          const bodyBox = await page.locator(".workbench-body").boundingBox();
          const sidebarBox = await sidebar.boundingBox();
          const scrimBox = await scrim.boundingBox();
          expect(bodyBox).not.toBeNull();
          expect(sidebarBox).not.toBeNull();
          expect(scrimBox).not.toBeNull();
          expect(sidebarBox!.y).toBeCloseTo(bodyBox!.y, 1);
          expect(scrimBox!.y).toBeCloseTo(bodyBox!.y, 1);
        }
      }
      if ("expectedState" in visualCase) {
        await expect(
          page.locator(`[data-variant="${visualCase.expectedState}"]`),
        ).toBeVisible();
      }
      await expect(page.getByTestId("btn-new-tab")).toBeVisible();
      await expect(page.getByTestId("btn-command-center")).toBeVisible();
      // Overlay sidebars intentionally isolate the header from the
      // accessibility tree. Its pixels remain visible behind the scrim.
      await expect(page.getByTestId("workbench-brand-mark")).toBeVisible();
      await expect(page.getByTestId("btn-effect-profile")).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      if (visualCase.options.theme === "matrix") {
        await expect(page.locator("html")).toHaveAttribute("data-effect-scanlines", "on");
        await expect(page.locator("html")).toHaveAttribute("data-effect-phosphor-glow", "on");
        if (visualCase.options.motion === "reduced") {
          await expect(page.locator("html")).not.toHaveAttribute("data-effect-crt-rollbar", "on");
        } else {
          await expect(page.locator("html")).toHaveAttribute("data-effect-crt-rollbar", "on");
        }
      }

      await expectNoAccessibilityViolations(page);
      await expect(page).toHaveScreenshot(visualCase.screenshot, {
        animations: "disabled",
      });
    });
  }

  test("empty sidebar state has deterministic semantics", async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await openStory(page, "compositions-workbench-shell--sidebar-empty", {
      theme: "matrix",
      locale: "en",
      density: "comfortable",
      motion: "reduced",
    });
    await expect(page.locator('[data-variant="empty"]')).toBeVisible();
    await expectNoAccessibilityViolations(page);
    await expect(page).toHaveScreenshot(
      "desktop-1200x800-empty-matrix-en.png",
      { animations: "disabled" },
    );
  });
});

test.describe("CRT signature header visual contracts", () => {
  test("keeps scaled header controls disjoint at supported widths", async ({ page }) => {
    const viewportHeights = new Map([
      [800, 600],
      [1024, 720],
      [1200, 800],
      [1440, 900],
    ]);

    for (const scale of [100, 150] as const) {
      for (const width of [800, 1024, 1200, 1440] as const) {
        await page.setViewportSize({ width, height: viewportHeights.get(width)! });
        await openStory(page, "compositions-app-header--crt-signature", {
          theme: "matrix",
          locale: "en",
          density: "compact",
          motion: "reduced",
          scale,
        });
        await expect(page.getByRole("heading", { name: "EZTerminal" })).toHaveText(
          "EZTerminal",
        );
        await expectHeaderControlsNotToOverlap(page);
      }
    }
  });

  test("keeps the full signal wordmark at 800px and 150 percent scale", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await openStory(page, "compositions-app-header--crt-signature", {
      theme: "matrix",
      locale: "en",
      density: "compact",
      motion: "default",
      scale: 150,
    });
    await expect(page.getByRole("heading", { name: "EZTerminal" })).toBeVisible();
    await expect(
      page.getByTestId("workbench-brand-mark").locator("[aria-hidden='true']").first(),
    ).toBeVisible();
    await expect(page.getByTestId("btn-effect-profile")).toHaveAttribute(
      "data-effect-intensity",
      "7",
    );
    await expect(page.getByTestId("btn-new-tab")).toHaveAttribute("title", /.+/);
    await expect(page.getByTestId("btn-command-center")).toHaveAttribute(
      "title",
      /.+/,
    );
    await expect(page.getByTestId("btn-workspace-menu")).toHaveAttribute(
      "title",
      /.+/,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expectNoAccessibilityViolations(page);
    await expect(page).toHaveScreenshot(
      "desktop-800x600-header-matrix-150.png",
      { animations: "disabled" },
    );
  });

  test("shows one accessible numeric CRT intensity utility", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openStory(page, "compositions-app-header--profile-menu-open", {
      theme: "matrix",
      locale: "en",
      density: "adaptive",
      motion: "default",
    });
    await expect(page.getByTestId("btn-effect-profile")).toHaveAttribute(
      "aria-label",
      /7/,
    );
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("data-effect-crt-rollbar", "on");
    await expectNoAccessibilityViolations(page);
    await expect(page).toHaveScreenshot(
      "desktop-matrix-effect-intensity.png",
      { animations: "disabled" },
    );
  });
});

const desktopHandoffCases = [
  {
    name: "01 boot intro",
    storyId: "compositions-desktop-handoff--boot",
    screenshot: "desktop-handoff-01-boot.png",
    readySelector: "[data-testid='boot-intro']",
    locale: "ko",
    motion: "default",
  },
  {
    name: "02 workbench and Agent Hub",
    storyId: "compositions-desktop-handoff--workbench-agent-hub",
    screenshot: "desktop-handoff-02-workbench-agent-hub.png",
    readySelector: "[data-testid='agent-hub']",
    locale: "ko",
  },
  {
    name: "03 command center",
    storyId: "compositions-desktop-handoff--command-center",
    screenshot: "desktop-handoff-03-command-center.png",
    readySelector: "[data-testid='quick-open-modal']",
    locale: "ko",
  },
  {
    name: "04 monitor",
    storyId: "compositions-desktop-handoff--monitor",
    screenshot: "desktop-handoff-04-monitor.png",
    readySelector: "[data-testid='status-panel']",
    locale: "ko",
  },
  {
    name: "05 remote",
    storyId: "compositions-desktop-handoff--remote",
    screenshot: "desktop-handoff-05-remote.png",
    readySelector: "[data-testid='remote-topology']",
    locale: "ko",
  },
  {
    name: "06 pairing QR",
    storyId: "compositions-desktop-handoff--pairing-qr",
    screenshot: "desktop-handoff-06-pairing-qr.png",
    readySelector: "[data-testid='pairing-qr-symbol']",
    locale: "ko",
  },
  {
    name: "07 pairing detected",
    storyId: "compositions-desktop-handoff--pairing-detected",
    screenshot: "desktop-handoff-07-pairing-detected.png",
    readySelector: "[data-testid='pairing-redeemed']",
    locale: "ko",
  },
  {
    name: "08 OpenClaw console",
    storyId: "compositions-desktop-handoff--openclaw-console",
    screenshot: "desktop-handoff-08-openclaw-console.png",
    readySelector: "[data-testid='openclaw-panel']",
    locale: "ko",
  },
  {
    name: "09 OpenClaw chat",
    storyId: "compositions-desktop-handoff--openclaw-chat",
    screenshot: "desktop-handoff-09-openclaw-chat.png",
    readySelector: "[data-testid='openclaw-chat-panel']",
    locale: "ko",
  },
  {
    name: "10 terminal paste warning",
    storyId: "compositions-desktop-handoff--paste-warning",
    screenshot: "desktop-handoff-10-paste-warning.png",
    readySelector: "[data-testid='terminal-paste-warning-cancel']",
    locale: "ko",
  },
  {
    name: "11 risky close",
    storyId: "compositions-desktop-handoff--risky-close",
    screenshot: "desktop-handoff-11-risky-close.png",
    readySelector: "[data-testid='risky-close-cancel']",
    locale: "ko",
  },
  {
    name: "12 settings",
    storyId: "compositions-desktop-handoff--settings",
    screenshot: "desktop-handoff-12-settings.png",
    readySelector: "[data-testid='settings-panel']",
    locale: "ko",
  },
  {
    name: "13 English workbench",
    storyId: "compositions-desktop-handoff--english-workbench",
    screenshot: "desktop-handoff-13-english-workbench.png",
    readySelector: ".desktop-handoff-workbench",
    locale: "en",
  },
  {
    name: "14 explorer breadcrumb",
    storyId: "compositions-desktop-handoff--explorer-breadcrumb",
    screenshot: "desktop-handoff-14-explorer-breadcrumb.png",
    readySelector: "[data-testid='file-breadcrumb']",
    locale: "en",
  },
] as const;

const desktopHandoffAxisCases = [
  {
    name: "800x600 high contrast KO at 150% uses sidebar overlay",
    storyId: "compositions-desktop-handoff--workbench-agent-hub",
    screenshot: "desktop-handoff-axis-800x600-high-contrast-ko-150.png",
    readySelector: "[data-testid='agent-hub']",
    viewport: { width: 800, height: 600 },
    theme: "high-contrast",
    locale: "ko",
    scale: 150,
    sidebarMode: "overlay",
  },
  {
    name: "1024x720 light KO at 150% isolates and dismisses the pairing dialog",
    storyId: "compositions-desktop-handoff--pairing-qr",
    screenshot: "desktop-handoff-axis-1024x720-light-ko-150.png",
    readySelector: "[data-testid='pairing-qr-symbol']",
    viewport: { width: 1024, height: 720 },
    theme: "light",
    locale: "ko",
    scale: 150,
    sidebarMode: "overlay",
    dialogContract: true,
  },
  {
    name: "1200x800 dark KO keeps the sidebar in workbench reflow",
    storyId: "compositions-desktop-handoff--settings",
    screenshot: "desktop-handoff-axis-1200x800-dark-ko.png",
    readySelector: "[data-testid='settings-panel']",
    viewport: { width: 1200, height: 800 },
    theme: "dark",
    locale: "ko",
    scale: 100,
    sidebarMode: "reflow",
  },
  {
    name: "1440x900 Matrix KO keeps Agent Hub in workbench reflow",
    storyId: "compositions-desktop-handoff--workbench-agent-hub",
    screenshot: "desktop-handoff-axis-1440x900-matrix-ko.png",
    readySelector: "[data-testid='agent-hub']",
    viewport: { width: 1440, height: 900 },
    theme: "matrix",
    locale: "ko",
    scale: 100,
    sidebarMode: "reflow",
  },
] as const;

test.describe("desktop handoff fixture integrity", () => {
  test("workbench fixture includes the production terminal composition seams", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openStory(page, "compositions-desktop-handoff--workbench-agent-hub", {
      theme: "matrix",
      locale: "ko",
      density: "adaptive",
      motion: "reduced",
    });

    await expect(page.getByTestId("quick-command-shelf").first()).toBeVisible();
    await expect(page.locator(".agent-aware-tab")).toHaveCount(3);
    await expect(page.getByTestId("pane-header-cwd").first()).toBeVisible();
  });

  test("Command Center fixture contains every production result kind", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openStory(page, "compositions-desktop-handoff--command-center", {
      theme: "matrix",
      locale: "en",
      density: "adaptive",
      motion: "reduced",
    });

    for (const kind of [
      "pane",
      "background-session",
      "file",
      "history",
      "quick-command",
      "action",
      "preset",
      "agent",
    ]) {
      await expect(page.locator(`[data-kind="${kind}"]`).first(), kind).toBeVisible();
    }
  });

  test("Settings fixture follows the selected global theme", async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await openStory(page, "compositions-desktop-handoff--settings", {
      theme: "dark",
      locale: "en",
      density: "adaptive",
      motion: "reduced",
    });

    await expect(page.getByTestId("settings-theme-select")).toHaveValue("dark");
    await expect(page.getByTestId("settings-effect-scanlines")).toBeDisabled();
    await expect(page.getByTestId("settings-effect-crt-rollbar")).toBeDisabled();
  });

  test("reduced motion skips the product boot and collapses sidebar entry motion", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 720 });
    await openStory(page, "compositions-desktop-handoff--boot-reduced-motion-behavior", {
      theme: "matrix",
      locale: "ko",
      density: "adaptive",
      motion: "reduced",
      freezeAnimations: false,
    });

    await expect(page.getByTestId("boot-intro")).toHaveCount(0);
    await expect(page.locator(".desktop-handoff-workbench")).toBeVisible();
    await expect(page.getByTestId("workbench-sidebar")).toHaveCSS("animation-duration", "0s");
  });
});

test.describe("desktop handoff source visual contracts", () => {
  for (const handoffCase of desktopHandoffCases) {
    test(handoffCase.name, async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await openStory(page, handoffCase.storyId, {
        theme: "matrix",
        locale: handoffCase.locale,
        density: "adaptive",
        motion: "motion" in handoffCase ? handoffCase.motion : "reduced",
      });
      await expect(page.locator(handoffCase.readySelector)).toBeVisible();
      await expect(page.getByTestId("btn-new-tab")).toHaveAttribute(
        "title",
        handoffCase.locale === "ko" ? "새 터미널" : "New Terminal",
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      await expectNoAccessibilityViolations(page);
      await expect(page).toHaveScreenshot(handoffCase.screenshot, {
        animations: "disabled",
        mask: "maskSelectors" in handoffCase
          ? handoffCase.maskSelectors.map((selector) => page.locator(selector))
          : [],
      });

      const alternateLocale: Locale = handoffCase.locale === "ko" ? "en" : "ko";
      await openStory(page, handoffCase.storyId, {
        theme: "matrix",
        locale: alternateLocale,
        density: "adaptive",
        motion: "motion" in handoffCase ? handoffCase.motion : "reduced",
      });
      await expect(page.locator(handoffCase.readySelector)).toBeVisible();
      await expect(page.getByTestId("btn-new-tab")).toHaveAttribute(
        "title",
        alternateLocale === "ko" ? "새 터미널" : "New Terminal",
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await expectNoAccessibilityViolations(page);
    });
  }
});

test.describe("desktop handoff responsive and interaction axes", () => {
  for (const handoffCase of desktopHandoffAxisCases) {
    test(handoffCase.name, async ({ page }) => {
      await page.setViewportSize(handoffCase.viewport);
      await openStory(page, handoffCase.storyId, {
        theme: handoffCase.theme,
        locale: handoffCase.locale,
        density: "adaptive",
        motion: "reduced",
        scale: handoffCase.scale,
      });
      await expect(page.locator(handoffCase.readySelector)).toBeVisible();
      // Storybook's root readiness signal can precede TerminalPane's async
      // session binding. Wait for all three dock panes so screenshots never
      // alternate between an empty prompt and the settled working directory.
      await expect(page.getByTestId("prompt-cwd")).toHaveCount(3);

      const sidebar = page.getByTestId("workbench-sidebar");
      const scrim = page.locator(".workbench-sidebar-scrim");
      if (handoffCase.sidebarMode === "overlay") {
        await expect(sidebar).toHaveCSS("position", "absolute");
        await expect(scrim).toBeVisible();
      } else {
        await expect(sidebar).toHaveCSS("position", "relative");
        await expect(scrim).toBeHidden();
      }

      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth
            && document.documentElement.scrollHeight <= window.innerHeight,
        ),
      ).toBe(true);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);

      if ("dialogContract" in handoffCase) {
        // The narrow sidebar is itself a modal dialog, so identify the nested
        // product dialog by its stable component seam.
        const dialog = page.getByTestId("pairing-qr-dialog");
        const invoker = page.getByTestId("desktop-handoff-dialog-invoker");
        await expect(dialog).toHaveAttribute("aria-modal", "true");
        await expect.poll(
          () => dialog.evaluate((element) => element.contains(document.activeElement)),
        ).toBe(true);
        expect(
          await page.evaluate(
            () => document.elementFromPoint(8, 8)?.classList.contains("ez-ui-dialog-backdrop"),
          ),
        ).toBe(true);

        await page.keyboard.press("Shift+Tab");
        expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(invoker).toBeFocused();

        await invoker.evaluate((element) => element.click());
        await expect(dialog).toBeVisible();
        await expect.poll(
          () => dialog.evaluate((element) => element.contains(document.activeElement)),
        ).toBe(true);
      }

      await expectNoAccessibilityViolations(page);
      await expect(page).toHaveScreenshot(handoffCase.screenshot, {
        animations: "disabled",
        mask: "maskSelectors" in handoffCase
          ? handoffCase.maskSelectors.map((selector) => page.locator(selector))
          : [],
      });
    });
  }
});

test("all built-in themes use the semantic token gallery", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStory(page, "foundations-tokens--theme-gallery", {
    theme: "matrix",
    locale: "en",
    density: "adaptive",
    motion: "reduced",
  });
  await expect(page.locator(".ez-story-theme-card")).toHaveCount(4);
  await expectNoAccessibilityViolations(page);
  await expect(page).toHaveScreenshot("desktop-1440x900-theme-gallery.png", {
    animations: "disabled",
  });
});

test.describe("terminal paste warning visual contracts", () => {
  for (const locale of ["en", "ko"] as const) {
    test(`shows combined paste risk in ${locale}`, async ({ page }) => {
      await page.setViewportSize({ width: 800, height: 600 });
      await openStory(
        page,
        "compositions-terminal-paste-warning--multiline-and-large",
        {
          theme: "matrix",
          locale,
          density: "adaptive",
          motion: "reduced",
        },
      );
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.locator(".ez-ui-dialog__header button")).toBeVisible();
      const dialogPaint = await dialog.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          backgroundColor: style.backgroundColor,
          borderColor: style.borderColor,
          borderWidth: style.borderWidth,
        };
      });
      expect(dialogPaint.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
      expect(dialogPaint.borderColor).not.toBe("rgba(0, 0, 0, 0)");
      expect(dialogPaint.borderWidth).toBe("1px");
      await expect(page.getByTestId("terminal-paste-warning-cancel")).toBeFocused();
      await expectNoAccessibilityViolations(page);
      await expect(page).toHaveScreenshot(
        `desktop-800x600-terminal-paste-warning-${locale}.png`,
        { animations: "disabled" },
      );
    });
  }
});

const mobileCases = [
  {
    name: "360x800 portrait English terminal shell",
    viewport: { width: 360, height: 800 },
    storyId: "compositions-mobile-workbench-shell--terminal-english",
    screenshot: "mobile-360x800-shell-en.png",
    options: {
      theme: "matrix",
      locale: "en",
      density: "adaptive",
      motion: "default",
    },
    surface: "terminal",
  },
  {
    name: "412x915 portrait Korean Matrix remote hub",
    viewport: { width: 412, height: 915 },
    storyId: "compositions-mobile-workbench-shell--hub-korean",
    screenshot: "mobile-412x915-shell-matrix-ko.png",
    options: {
      theme: "matrix",
      locale: "ko",
      density: "comfortable",
      motion: "reduced",
    },
    surface: "hub",
  },
  {
    name: "600x960 compact Korean auxiliary settings page",
    viewport: { width: 600, height: 960 },
    storyId: "compositions-mobile-workbench-shell--settings-page-korean",
    screenshot: "mobile-600x960-settings-dark-ko.png",
    options: {
      theme: "dark",
      locale: "ko",
      density: "compact",
      motion: "reduced",
    },
    surface: "destination",
  },
  {
    name: "915x412 landscape English remote hub",
    viewport: { width: 915, height: 412 },
    storyId: "compositions-mobile-workbench-shell--hub-english",
    screenshot: "mobile-915x412-shell-matrix-en.png",
    options: {
      theme: "matrix",
      locale: "en",
      density: "adaptive",
      motion: "default",
    },
    surface: "hub",
  },
  {
    name: "360x800 first manual connection",
    viewport: { width: 360, height: 800 },
    storyId: "compositions-mobile-workbench-shell--connect-english",
    screenshot: "mobile-360x800-connect-matrix-en.png",
    options: {
      theme: "matrix",
      locale: "en",
      density: "adaptive",
      motion: "reduced",
    },
    surface: "connect",
  },
] as const;

test.describe("mobile-width Storybook visual contracts", () => {
  for (const visualCase of mobileCases) {
    test(visualCase.name, async ({ page }) => {
      await page.setViewportSize(visualCase.viewport);
      await openStory(page, visualCase.storyId, visualCase.options);
      if (visualCase.surface === "connect") {
        await expect(page.getByTestId("connect-screen")).toBeVisible();
        await expect(page.getByTestId("connect-submit")).toBeVisible();
        await expect(page.getByTestId("mobile-terminal-layer")).toHaveCount(0);
      } else {
        await expect(page.getByTestId("mobile-terminal-layer")).toBeVisible();
        const coordinatorBox = await page.locator(".mobile-workbench-coordinator").boundingBox();
        expect(coordinatorBox, "mobile workbench must have measurable geometry").not.toBeNull();
        expect(coordinatorBox!.height).toBeCloseTo(visualCase.viewport.height, 0);
        if (visualCase.surface === "terminal") {
          await expect(page.getByTestId("mobile-page-shell")).toHaveCount(0);
          await expect(page.getByTestId("workspace-hub-btn")).toBeVisible();
        } else {
          await expect(page.getByTestId("mobile-page-shell")).toBeVisible();
          await expect(page.getByTestId("mobile-terminal-layer")).toHaveAttribute(
            "aria-hidden",
            "true",
          );
          if (visualCase.surface === "hub") {
            await expect(page.getByTestId("mobile-home-view")).toBeVisible();
            await expect(page.getByTestId("home-pc-control")).toBeVisible();
          } else {
            await expect(page.getByTestId("mobile-settings-view")).toBeVisible();
          }
        }
      }

      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);

      await expectNoAccessibilityViolations(page);
      await expect(page).toHaveScreenshot(visualCase.screenshot, {
        animations: "disabled",
        // The mobile settings and connection surfaces print the build SHA and
        // the app version. The SHA is "dev" locally and the real commit in CI,
        // and the version moves on every release. Mask both so the contract
        // covers layout and type rather than which build produced the
        // screenshot — otherwise a version bump alone fails the suite.
        mask: [page.locator("[data-build-stamp]")],
      });
    });
  }
});
