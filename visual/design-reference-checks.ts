import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page } from "./test";

/* Storybook helpers shared with the visual spec. They live here so the pinned hash covers how
   every approved case is rendered and audited, not just which checks run. */
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

export type Theme = "matrix" | "dark" | "light" | "high-contrast";
export type Density = "adaptive" | "compact" | "comfortable";
export type Locale = "en" | "ko";
export type Motion = "default" | "reduced";

export interface StoryOptions {
  readonly density: Density;
  /** Leave product motion CSS untouched for assertions about reduced motion. */
  readonly freezeAnimations?: boolean;
  readonly locale: Locale;
  readonly motion: Motion;
  readonly scale?: 100 | 150;
  readonly theme: Theme;
}

export async function openStory(
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

export async function expectNoAccessibilityViolations(page: Page): Promise<void> {
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

/**
 * The one checker every approved 2.0 design reference runs
 * (docs/ux/reference/2.0/manifest.json pins this file by SHA-256). The visual
 * spec only hands each `designReferenceCases` entry to it; changing what is
 * checked here changes the pin and so shows up in review.
 */
export interface DesignReferenceCase {
  readonly storyId: string;
  readonly screenshot: string;
  readonly readySelector: string;
  readonly locale: Locale;
  readonly theme: Theme;
  readonly viewports: readonly { readonly width: number; readonly height: number }[];
}

/** A stable identity for the focused control of the rendered story, or null when focus is anywhere else. */
async function focusedElement(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const active = document.activeElement;
    const surface = document.querySelector("#storybook-root");
    if (!active || !surface || active === surface || !surface.contains(active)) return null;
    return `${Array.from(document.querySelectorAll("*")).indexOf(active)}:${active.tagName}`;
  });
}

export async function checkReferenceSurface(page: Page, item: DesignReferenceCase): Promise<void> {
  const alternateLocale: Locale = item.locale === "ko" ? "en" : "ko";

  // The approved state: case locale at the reference size, accessible, pixel-pinned.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStory(page, item.storyId, { theme: item.theme, locale: item.locale, density: "adaptive", motion: "reduced" });
  await expectNoAccessibilityViolations(page);
  await expect(page.locator(item.readySelector).first()).toBeVisible();
  await expect(page).toHaveScreenshot(item.screenshot, { animations: "disabled" });

  // Keyboard focus moves into the surface and comes back the same way.
  await page.keyboard.press("Tab");
  const first = await focusedElement(page);
  expect(first, "Tab must move focus onto a control of the surface").not.toBeNull();
  await page.keyboard.press("Tab");
  const second = await focusedElement(page);
  expect(second, "a second Tab must land on another control of the surface").not.toBeNull();
  expect(second, "a second Tab must move focus on").not.toBe(first);
  await page.keyboard.press("Shift+Tab");
  expect(await focusedElement(page), "Shift+Tab must return focus to the previous control").toBe(first);

  // Every checked size lays out without horizontal overflow, in the case locale…
  for (const size of item.viewports) {
    await page.setViewportSize(size);
    await expect(page.locator(item.readySelector).first()).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `no horizontal overflow at ${size.width}x${size.height} (${item.locale})`,
    ).toBe(true);
  }

  // …and in the other locale, which must be accessible too.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStory(page, item.storyId, { theme: item.theme, locale: alternateLocale, density: "adaptive", motion: "reduced" });
  await expectNoAccessibilityViolations(page);
  await expect(page.locator(item.readySelector).first()).toBeVisible();
  for (const size of item.viewports) {
    await page.setViewportSize(size);
    await expect(page.locator(item.readySelector).first()).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `no horizontal overflow at ${size.width}x${size.height} (${alternateLocale})`,
    ).toBe(true);
  }
}
