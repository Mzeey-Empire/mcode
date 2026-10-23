import type { HtmlVisual } from "@mcode/contracts";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockMessage } from "@/__tests__/mocks/transport";
import { MessageBubble } from "@/features/conversation/messages/MessageBubble";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { HtmlVisualFrame } from "../HtmlVisualFrame";
import { buildHtmlVisualDocument } from "../html-visual-document";

const visual: HtmlVisual = { title: "Latency by provider", html: "<!doctype html><p>chart</p>", maxHeight: 480 };
const root = document.documentElement;

function renderFrame() {
  render(<HtmlVisualFrame visual={visual} />);
  const frame = screen.getByTitle<HTMLIFrameElement>("Latency by provider");
  const contentWindow = frame.contentWindow;
  if (!contentWindow) throw new Error("frame has no window");
  return { frame, contentWindow };
}

function postFrom(source: Window, data: unknown) {
  act(() => window.dispatchEvent(new MessageEvent("message", { data, source })));
}

beforeEach(() => root.style.setProperty("--ink", "rgb(20, 20, 20)"));
afterEach(() => {
  root.classList.remove("dark");
  root.style.removeProperty("--ink");
});

describe("HtmlVisualFrame", () => {
  it("gives the page scripts but no same-origin access, top navigation, popups, or forms", () => {
    const { frame } = renderFrame();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("sends the new token values to the page when the app switches to dark mode", async () => {
    const { frame, contentWindow } = renderFrame();
    // The frame also posts the theme on load, so let that pass before switching modes.
    await new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
    const postMessage = vi.spyOn(contentWindow, "postMessage");

    act(() => {
      root.style.setProperty("--ink", "rgb(240, 240, 240)");
      root.classList.add("dark");
    });

    return vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(
      { type: "mcode:visual-theme", theme: expect.objectContaining({ colorScheme: "dark", tokens: expect.objectContaining({ "--ink": "rgb(240, 240, 240)" }) }) },
      "*",
    ));
  });

  it("grows with the page up to the requested height", () => {
    const { frame, contentWindow } = renderFrame();
    expect(frame.style.height).toBe("80px");

    postFrom(contentWindow, { type: "mcode:visual-height", height: 312.4 });
    expect(frame.style.height).toBe("313px");

    postFrom(contentWindow, { type: "mcode:visual-height", height: 5000 });
    expect(frame.style.height).toBe("480px");

    postFrom(contentWindow, { type: "mcode:visual-height", height: 4 });
    expect(frame.style.height).toBe("80px");
  });

  it("ignores height messages from anything but its own page", () => {
    const { frame, contentWindow } = renderFrame();
    postFrom(window, { type: "mcode:visual-height", height: 400 });
    postFrom(contentWindow, { type: "mcode:visual-height", height: "400" });
    postFrom(contentWindow, { type: "mcode:visual-height", height: Number.NaN });
    expect(frame.style.height).toBe("80px");
  });
});

describe("visual message", () => {
  beforeEach(() => resetThreadStoreForTests({ records: new Map([["thread-1", createEmptyThreadRecord()]]) }));
  afterEach(() => resetThreadStoreForTests());

  it("shows the page in the timeline instead of its fallback text", () => {
    const message = createMockMessage({ thread_id: "thread-1", role: "system", content: "Visual: Latency by provider", visual });
    render(<MessageBubble message={message} />);
    expect(screen.getByTitle("Latency by provider").tagName).toBe("IFRAME");
    expect(screen.queryByText("Visual: Latency by provider")).toBeNull();
  });
});

describe("buildHtmlVisualDocument", () => {
  const theme = { colorScheme: "light" as const, tokens: { "--ink": "</script><script>alert(1)</script>" } };

  it("keeps a page's doctype first so it renders in standards mode", () => {
    const document = new DOMParser().parseFromString(buildHtmlVisualDocument(visual.html, theme), "text/html");
    expect(document.compatMode).toBe("CSS1Compat");
    expect(document.body.textContent).toBe("chart");
  });

  it("puts the no-network policy in the head, where browsers honour it", () => {
    const page = "<!doctype html><html><head><title>t</title></head><body><p>chart</p></body></html>";
    const document = new DOMParser().parseFromString(buildHtmlVisualDocument(page, theme), "text/html");
    const policy = document.head.querySelector('meta[http-equiv="Content-Security-Policy"]');
    expect(policy?.getAttribute("content")).toMatch(/^default-src 'none';/);
  });

  it("cannot be broken out of by a token value", () => {
    const document = new DOMParser().parseFromString(buildHtmlVisualDocument("<p>chart</p>", theme), "text/html");
    expect(document.scripts).toHaveLength(1);
  });
});
