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
          visualCase.sidebarMode === "overlay" ? "fixed" : "relative";
        expect(
          await sidebar.evaluate(
            (element) => getComputedStyle(element).position,
          ),
        ).toBe(expectedPosition);
        const scrim = page.locator(".workbench-sidebar-scrim");
        expect(
          await scrim.evaluate((element) => getComputedStyle(element).display),
        ).toBe(visualCase.sidebarMode === "overlay" ? "block" : "none");
      }
      if ("expectedState" in visualCase) {
        await expect(
          page.locator(`[data-variant="${visualCase.expectedState}"]`),
        ).toBeVisible();
      }
      await expect(page.getByTestId("btn-new-tab")).toBeVisible();
      await expect(page.getByTestId("btn-command-center")).toBeVisible();

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
