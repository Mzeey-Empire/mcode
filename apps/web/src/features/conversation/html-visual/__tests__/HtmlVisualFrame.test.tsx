import { createMockMessage } from "@mcode/contracts/testing";
import type { HtmlVisual } from "@mcode/contracts/models/html-visual";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { MessageBubble } from "@/features/conversation/messages/MessageBubble";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { useThreadStore } from "@/stores/threadStore";
import { HtmlVisualFrame } from "../HtmlVisualFrame";
import { buildHtmlVisualDocument } from "@mcode/shared/html-visual-document";

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
  // Unmount first: frames follow the html class, so resetting it would update a mounted frame.
  cleanup();
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
    await act(() => new Promise((resolve) => frame.addEventListener("load", resolve, { once: true })));
    const postMessage = vi.spyOn(contentWindow, "postMessage");

    // Async act, so the theme observer's callback runs inside it.
    await act(async () => {
      root.style.setProperty("--ink", "rgb(240, 240, 240)");
      root.classList.add("dark");
    });

    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(
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

  it("starts a remounted frame at the height its visual last measured", () => {
    const measured: HtmlVisual = { ...visual };
    const first = render(<HtmlVisualFrame visual={measured} />);
    const firstFrame = screen.getByTitle<HTMLIFrameElement>("Latency by provider");
    if (!firstFrame.contentWindow) throw new Error("frame has no window");
    postFrom(firstFrame.contentWindow, { type: "mcode:visual-height", height: 312 });
    first.unmount();

    const remounted = render(<HtmlVisualFrame visual={measured} />);
    expect(screen.getByTitle<HTMLIFrameElement>("Latency by provider").style.height).toBe("312px");
    remounted.unmount();

    render(<HtmlVisualFrame visual={{ ...measured }} />);
    expect(screen.getByTitle<HTMLIFrameElement>("Latency by provider").style.height).toBe("80px");
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

describe("visual marker in a reply", () => {
  const published = createMockMessage({ id: "visual-1", thread_id: "thread-1", role: "system", content: "Visual: Latency by provider", visual });
  // Keep the lazy renderer's cold load outside the find* wait, which a loaded runner can outlast.
  beforeAll(() => import("@/components/chat/MarkdownContent"));
  beforeEach(() => resetThreadStoreForTests({ records: new Map([["thread-1", { ...createEmptyThreadRecord(), messages: [published] }]]) }));
  afterEach(() => {
    cleanup();
    resetThreadStoreForTests();
  });

  function renderReply(markerId: string) {
    const reply = createMockMessage({ id: "answer", thread_id: "thread-1", role: "assistant", content: `Before\n\n![Latency](visual:${markerId})\n\nAfter` });
    return render(<MessageBubble message={reply} />);
  }

  it("shows the thread's visual where the reply places its marker", async () => {
    const { container } = renderReply("visual-1");
    expect((await screen.findByTitle("Latency by provider")).tagName).toBe("IFRAME");
    expect(container.querySelector("img")).toBeNull();
  });

  it("shows the marker's title as text when the thread has no such visual", async () => {
    const { container } = renderReply("missing");
    expect(await screen.findByText("Latency")).toBeTruthy();
    expect(container.querySelector("img, iframe")).toBeNull();
  });

  it("requests one older page when the marker's visual is not loaded yet", async () => {
    const loadOlderMessages = vi.fn(async () => "skipped" as const);
    useThreadStore.setState({ loadOlderMessages });
    renderReply("missing");
    await screen.findByText("Latency");
    expect(loadOlderMessages).toHaveBeenCalledExactlyOnceWith("thread-1");
  });

  it("requests no older page when the marker's visual is loaded", async () => {
    const loadOlderMessages = vi.fn(async () => "skipped" as const);
    useThreadStore.setState({ loadOlderMessages });
    renderReply("visual-1");
    await screen.findByTitle("Latency by provider");
    expect(loadOlderMessages).not.toHaveBeenCalled();
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
