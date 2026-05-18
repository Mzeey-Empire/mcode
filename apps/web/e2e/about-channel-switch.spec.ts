import { test, expect, type Page } from "@playwright/test";
import { getDefaultSettings } from "@mcode/contracts";
import { mockWebSocketServer } from "./helpers/e2e-helpers";

/**
 * Build a settings payload with the given updates channel. Starts from
 * canonical defaults so the renderer hydrates with every nested field
 * present (multiple components dereference `settings.x.y.z` without
 * optional chaining and would crash on a partial mock).
 */
function settingsWithChannel(channel: "stable" | "nightly") {
  const defaults = getDefaultSettings();
  return {
    ...defaults,
    updates: {
      ...defaults.updates,
      channel,
    },
  };
}

/**
 * Install a fake `window.desktopBridge` and mock the GitHub releases endpoint
 * BEFORE the page loads. Records every `applyReleaseLine` invocation on
 * `window.__mockApplyReleaseLineCalls` so tests can assert on it.
 */
async function setupBridge(
  page: Page,
  opts: { version: string; latestStable: string },
): Promise<void> {
  await page.addInitScript((args: { version: string; latestStable: string }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__mockApplyReleaseLineCalls = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).desktopBridge = {
      app: {
        getVersion: () => Promise.resolve(args.version),
        getUpdateStatus: () => Promise.resolve({ state: "idle" }),
        checkForUpdates: () => Promise.resolve({ state: "idle" }),
        installUpdate: () => Promise.resolve(false),
        downloadUpdate: () => Promise.resolve(),
        onUpdateStatus: () => () => {},
        offUpdateStatus: () => {},
        applyReleaseLine: (payload: unknown) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).__mockApplyReleaseLineCalls.push(payload);
          return Promise.resolve({ state: "idle" });
        },
      },
    };
  }, opts);

  await page.route("**/api.github.com/**/releases/latest", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tag_name: opts.latestStable }),
    }),
  );
}

/**
 * Open Settings, scroll to and click the About nav entry. Uses the same flow
 * as `about-visual.spec.ts` so any nav refactor is fixed in one place by the
 * existing visual spec.
 */
async function openAbout(page: Page): Promise<void> {
  await page.goto("/");
  // Wait for the Settings entry point to render rather than a fixed timeout.
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  // Wait for the Settings panel's About nav entry instead of sleeping.
  const aboutBtn = page.getByRole("button", { name: "About", exact: true });
  await expect(aboutBtn).toBeVisible();
  await aboutBtn.scrollIntoViewIfNeeded();
  await aboutBtn.click();
  // Wait for the release-line SegControl to mount before returning.
  await expect(page.getByRole("radio", { name: "Stable" })).toBeVisible();
}

test.describe("About section — channel switch downgrade flow", () => {
  test.setTimeout(30_000);

  test("nightly → stable on a newer version shows confirmation; cancel keeps nightly", async ({
    page,
  }) => {
    await setupBridge(page, {
      version: "0.12.0-nightly.20260518.42",
      latestStable: "v0.11.1",
    });
    await mockWebSocketServer(page, {
      "settings.get": settingsWithChannel("nightly"),
      "settings.update": settingsWithChannel("nightly"),
    });

    await openAbout(page);

    // Click the Stable radio in the release-line SegControl.
    await page.getByRole("radio", { name: "Stable" }).click();

    // Confirmation dialog appears (DialogTitle renders the heading text).
    const dialog = page.locator('[data-slot="dialog-content"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Switch to stable?");

    // Cancel keeps nightly.
    await dialog.getByRole("button", { name: "Stay on nightly" }).click();
    await expect(dialog).not.toBeVisible();

    // applyReleaseLine was NOT called. updateSettings was also not called for
    // this user-cancelled change, so the SegControl stays on Nightly.
    const calls = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).__mockApplyReleaseLineCalls,
    );
    expect(calls).toEqual([]);
    await expect(page.getByRole("radio", { name: "Nightly" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  test("nightly → stable confirm calls applyReleaseLine with allowDowngrade=true", async ({
    page,
  }) => {
    await setupBridge(page, {
      version: "0.12.0-nightly.20260518.42",
      latestStable: "v0.11.1",
    });
    await mockWebSocketServer(page, {
      "settings.get": settingsWithChannel("nightly"),
      // Echo back the requested update so the SegControl moves to Stable.
      "settings.update": () => settingsWithChannel("stable"),
    });

    await openAbout(page);

    await page.getByRole("radio", { name: "Stable" }).click();

    const dialog = page.locator('[data-slot="dialog-content"]');
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Switch and downgrade" }).click();

    // Wait for the bridge call to land.
    await expect
      .poll(
        async () =>
          page.evaluate(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            () => (window as any).__mockApplyReleaseLineCalls.length,
          ),
        { timeout: 5_000 },
      )
      .toBeGreaterThan(0);

    const calls = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).__mockApplyReleaseLineCalls,
    );
    expect(calls).toEqual([
      { releaseLine: "stable", allowDowngrade: true },
    ]);
  });

  test("stable → nightly never shows confirmation", async ({ page }) => {
    await setupBridge(page, {
      version: "0.11.1",
      latestStable: "v0.11.1",
    });
    await mockWebSocketServer(page, {
      "settings.get": settingsWithChannel("stable"),
      "settings.update": () => settingsWithChannel("nightly"),
    });

    await openAbout(page);

    await page.getByRole("radio", { name: "Nightly" }).click();

    // Wait for the bridge call to land first. The synchronous "upgrade" path
    // does not branch into the dialog; once applyReleaseLine has been invoked
    // we know the dialog code path was skipped, so a follow-up `toHaveCount(0)`
    // is no longer racing a timer.
    await expect
      .poll(
        async () =>
          page.evaluate(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            () => (window as any).__mockApplyReleaseLineCalls.length,
          ),
        { timeout: 5_000 },
      )
      .toBeGreaterThan(0);

    // Dialog should NOT have rendered.
    await expect(page.locator('[data-slot="dialog-content"]')).toHaveCount(0);

    const calls = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).__mockApplyReleaseLineCalls,
    );
    expect(calls).toEqual([
      { releaseLine: "nightly", allowDowngrade: false },
    ]);
  });
});
