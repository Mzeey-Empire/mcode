import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false },
}));

describe("isDesktopDev", () => {
  const originalRendererUrl = process.env.ELECTRON_RENDERER_URL;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.ELECTRON_RENDERER_URL;
  });

  afterEach(() => {
    if (originalRendererUrl === undefined) {
      delete process.env.ELECTRON_RENDERER_URL;
    } else {
      process.env.ELECTRON_RENDERER_URL = originalRendererUrl;
    }
  });

  it("is true when unpackaged and ELECTRON_RENDERER_URL is set", async () => {
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5173";
    const { isDesktopDev } = await import("../is-desktop-dev.js");
    expect(isDesktopDev()).toBe(true);
  });

  it("is false when ELECTRON_RENDERER_URL is unset", async () => {
    const { isDesktopDev } = await import("../is-desktop-dev.js");
    expect(isDesktopDev()).toBe(false);
  });

  it("is false when the app is packaged even if ELECTRON_RENDERER_URL is set", async () => {
    vi.doMock("electron", () => ({
      app: { isPackaged: true },
    }));
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5173";
    const { isDesktopDev } = await import("../is-desktop-dev.js");
    expect(isDesktopDev()).toBe(false);
  });
});
