// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openUrlInPreview = vi.hoisted(() => vi.fn());
vi.mock("@/features/preview", () => ({ openUrlInPreview }));

import { openTerminalUrl } from "../openTerminalUrl";

describe("openTerminalUrl", () => {
  const openExternalUrl = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    window.desktopBridge = { openExternalUrl } as unknown as typeof window.desktopBridge;
  });

  afterEach(() => {
    window.desktopBridge = undefined;
  });

  it("opens a loopback URL in the thread's Browser tab", async () => {
    await openTerminalUrl({ url: "http://localhost:5173/", loopback: true }, "thread-1");

    expect(openUrlInPreview).toHaveBeenCalledWith({ url: "http://localhost:5173/", threadId: "thread-1" });
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("opens a public URL in the system browser", async () => {
    await openTerminalUrl({ url: "https://example.test/", loopback: false }, "thread-1");

    expect(openExternalUrl).toHaveBeenCalledWith("https://example.test/");
    expect(openUrlInPreview).not.toHaveBeenCalled();
  });

  it("falls back to the system browser for a loopback URL when no thread owns the terminal", async () => {
    await openTerminalUrl({ url: "http://localhost:5173/", loopback: true }, undefined);

    expect(openUrlInPreview).not.toHaveBeenCalled();
    expect(openExternalUrl).toHaveBeenCalledWith("http://localhost:5173/");
  });
});
