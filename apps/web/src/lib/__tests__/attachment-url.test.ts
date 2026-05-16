import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildStoredAttachmentImageSrc,
  clearAttachmentTransportWsUrlCache,
  setAttachmentTransportWsUrl,
} from "../attachment-url";
import { AUTH_TOKEN_STORAGE_KEY } from "@/transport/scan-port-range";

describe("buildStoredAttachmentImageSrc", () => {
  const threadId = "550e8400-e29b-41d4-a716-446655440000";
  const id = "a1b2c3d4-e5f6-4789-a012-3456789abcde";

  beforeEach(() => {
    clearAttachmentTransportWsUrlCache();
    localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    vi.stubGlobal("desktopBridge", undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearAttachmentTransportWsUrlCache();
    localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  });

  it("uses mcode-attachment when desktopBridge is present", () => {
    vi.stubGlobal("desktopBridge", {});
    expect(buildStoredAttachmentImageSrc(threadId, id, "image/png")).toBe(
      `mcode-attachment://${threadId}/${id}.png`,
    );
  });

  it("uses HTTP /attachments when transport URL is set (browser)", () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, "test-token-xyz");
    setAttachmentTransportWsUrl("ws://127.0.0.1:19400?token=ignored");
    const url = buildStoredAttachmentImageSrc(threadId, id, "image/jpeg");
    expect(url).toBe(
      `http://127.0.0.1:19400/attachments/${threadId}/${id}.jpg?token=${encodeURIComponent("test-token-xyz")}`,
    );
  });

  it("falls back to mcode-attachment when no transport URL and no desktop", () => {
    expect(buildStoredAttachmentImageSrc(threadId, id, "image/gif")).toBe(
      `mcode-attachment://${threadId}/${id}.gif`,
    );
  });
});
