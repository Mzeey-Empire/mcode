// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { BrowserSurfaceIdentity, BrowserSurfacePageState } from "../../browser-surfaces";
import { previewStatus } from "../PreviewWebview";

const identity: BrowserSurfaceIdentity = {
  workspaceId: "workspace-1",
  scope: { kind: "thread", id: "thread-1" },
  tabId: "tab-1",
};

function failedLoad(overrides: Partial<BrowserSurfacePageState>): BrowserSurfacePageState {
  return {
    identity,
    generation: 1,
    pendingAddress: "http://localhost:5173/",
    committedAddress: "https://example.test/billing",
    recoveryAddress: "https://example.test/billing",
    title: "",
    favicon: null,
    phase: "error",
    mainFrameError: "ERR_CONNECTION_REFUSED",
    mainFrameErrorCode: -102,
    navigation: null,
    documentAccess: "unknown",
    ...overrides,
  };
}

describe("previewStatus", () => {
  it("reports the address that failed, not the page that stayed committed", () => {
    const status = previewStatus(failedLoad({}));

    expect(status.url).toBe("http://localhost:5173/");
    expect(status.error?.kind).toBe("connection-refused");
    expect(status.error?.message).toBe("Can't reach localhost:5173");
  });

  it("still names the failed address when Chromium's error document is the committed page", () => {
    const status = previewStatus(failedLoad({ committedAddress: "chrome-error://chromewebdata/" }));

    expect(status.url).toBe("http://localhost:5173/");
    expect(status.error?.message).toBe("Can't reach localhost:5173");
  });

  it("reports the committed address for a page that loaded", () => {
    const status = previewStatus(failedLoad({ phase: "loaded", mainFrameError: null, mainFrameErrorCode: null }));

    expect(status.url).toBe("https://example.test/billing");
    expect(status.error).toBeUndefined();
  });
});
