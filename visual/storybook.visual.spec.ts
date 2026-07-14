import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

type Theme = "matrix" | "dark" | "light" | "high-contrast";
type Density = "adaptive" | "compact" | "comfortable";
type Locale = "en" | "ko";
type Motion = "default" | "reduced";

interface StoryOptions {
  readonly density: Density;
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
  const globals = `theme:${options.theme};locale:${options.locale};density:${options.density}`;
  await page.emulateMedia({
    reducedMotion: options.motion === "reduced" ? "reduce" : "no-preference",
  });
  await page.goto(
    `/iframe.html?id=${storyId}&viewMode=story&globals=${encodeURIComponent(globals)}`,
    {
      waitUntil: "networkidle",
    },
  );
  await expect(page.locator("#storybook-root")).toBeVisible();
  await page.evaluate(
    async ({ scale }) => {
      await document.fonts.ready;
      document.documentElement.dataset.uiScale = String(scale);
      document.documentElement.style.fontSize = scale === 150 ? "150%" : "";
    },
    { scale: options.scale ?? 100 },
  );
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

  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-theme", options.theme);
  await expect(root).toHaveAttribute("data-density", options.density);
  await expect(root).toHaveAttribute("lang", options.locale);
  await expect(root).toHaveAttribute(
    "data-ui-scale",
    String(options.scale ?? 100),
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
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();

  expect(results.violations, "Story must satisfy WCAG 2.1 A/AA checks").toEqual(
    [],
  );
}

const headerControlTestIds = [
  "workbench-brand-mark",
  "btn-new-tab",
  "btn-effect-profile",
  "btn-command-center",
  "btn-workspace-menu",
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
      await expect(page.getByRole("heading", { name: "EZTerminal" })).toBeVisible();
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
      "data-profile",
      "crt-signature",
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

  test("shows the effect profiles as one accessible CRT utility", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openStory(page, "compositions-app-header--profile-menu-open", {
      theme: "matrix",
      locale: "en",
      density: "adaptive",
      motion: "default",
    });
    await expect(page.getByRole("menu", { name: "CRT effect profile" })).toBeVisible();
    await expect(page.getByRole("menuitemradio")).toHaveCount(4);
    await expect(page.locator("html")).toHaveAttribute("data-effect-crt-rollbar", "on");
    await expectNoAccessibilityViolations(page);
    await expect(page).toHaveScreenshot(
      "desktop-matrix-effect-profile-menu.png",
      { animations: "disabled" },
    );
  });
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
  },
  {
    name: "412x915 portrait Korean Matrix workbench",
    viewport: { width: 412, height: 915 },
    storyId: "compositions-mobile-workbench-shell--terminal-korean",
    screenshot: "mobile-412x915-shell-matrix-ko.png",
    options: {
      theme: "matrix",
      locale: "ko",
      density: "comfortable",
      motion: "reduced",
    },
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
    page: true,
  },
  {
    name: "915x412 landscape English terminal shell",
    viewport: { width: 915, height: 412 },
    storyId: "compositions-mobile-workbench-shell--terminal-english",
    screenshot: "mobile-915x412-shell-matrix-en.png",
    options: {
      theme: "matrix",
      locale: "en",
      density: "adaptive",
      motion: "default",
    },
  },
] as const;

test.describe("mobile-width Storybook visual contracts", () => {
  for (const visualCase of mobileCases) {
    test(visualCase.name, async ({ page }) => {
      await page.setViewportSize(visualCase.viewport);
      await openStory(page, visualCase.storyId, visualCase.options);
      await expect(page.getByTestId("mobile-terminal-layer")).toBeVisible();
      if ("page" in visualCase) {
        await expect(page.getByTestId("mobile-page-shell")).toBeVisible();
        await expect(page.getByTestId("mobile-terminal-layer")).toHaveAttribute(
          "aria-hidden",
          "true",
        );
      } else {
        await expect(page.getByTestId("mobile-page-shell")).toHaveCount(0);
      }
      const wideActions = page.locator(".workspace-wide-action");
      if (visualCase.viewport.width >= 600) {
        await expect(wideActions.first()).toBeVisible();
      } else {
        await expect(wideActions.first()).toBeHidden();
      }

      await expectNoAccessibilityViolations(page);
      await expect(page).toHaveScreenshot(visualCase.screenshot, {
        animations: "disabled",
      });
    });
  }
});
