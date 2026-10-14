import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useToastStore } from "@/stores/toastStore";
import { MarkdownFileView } from "../MarkdownFileView";
import { resolveMarkdownHref } from "../markdown-links";

// jsdom has no layout, so render every virtual row of the Source view.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => ({
    getTotalSize: () => count * estimateSize(),
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * estimateSize(), size: estimateSize() })),
  }),
}));

const KNOWN = new Set(["CONTEXT.md", "docs/guide.md", "docs/other.md"]);

function renderView(content: string, options: { path?: string; mode?: "rendered" | "source" } = {}) {
  const onOpenFile = vi.fn();
  render(
    <MarkdownFileView
      path={options.path ?? "docs/guide.md"}
      content={content}
      mode={options.mode ?? "rendered"}
      knownPaths={KNOWN}
      pathsTruncated={false}
      onOpenFile={onOpenFile}
      threadId={null}
      scopeId="test-scope"
    />,
  );
  return { onOpenFile };
}

function toastTitles(): string[] {
  return useToastStore.getState().toasts.map((toast) => toast.title);
}

beforeEach(() => {
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MarkdownFileView links", () => {
  it("opens a relative link as a tab at the resolved path", async () => {
    const { onOpenFile } = renderView("See [context](../CONTEXT.md).");
    fireEvent.click(await screen.findByRole("link", { name: "context" }));
    expect(onOpenFile).toHaveBeenCalledWith("CONTEXT.md");
  });

  it("scrolls an anchor link to its heading", async () => {
    renderView("[jump](#setup-steps)\n\n## Setup steps\n\nBody.");
    const heading = await screen.findByRole("heading", { name: "Setup steps" });
    const scroll = vi.fn();
    heading.scrollIntoView = scroll;
    fireEvent.click(screen.getByRole("link", { name: "jump" }));
    expect(scroll).toHaveBeenCalled();
  });

  it("rejects a link that leaves the project root", async () => {
    const { onOpenFile } = renderView("[out](../../x.md)");
    fireEvent.click(await screen.findByRole("link", { name: "out" }));
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(toastTitles()).toEqual(["Link leaves the project"]);
  });

  it("toasts a missing target instead of opening it", async () => {
    const { onOpenFile } = renderView("[gone](x.md)");
    fireEvent.click(await screen.findByRole("link", { name: "gone" }));
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(toastTitles()).toEqual(["No file at docs/x.md"]);
  });

  it("opens an external link in the system browser", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { onOpenFile } = renderView("[site](https://example.com/a)");
    fireEvent.click(await screen.findByRole("link", { name: "site" }));
    expect(open).toHaveBeenCalledWith("https://example.com/a", "_blank", "noopener,noreferrer");
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("ignores a javascript: link", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { onOpenFile } = renderView("<a href=\"javascript:alert(1)\">x</a>\n\n[bad](javascript:alert(1))");
    const links = await screen.findAllByText(/bad|x/);
    for (const link of links) fireEvent.click(link);
    expect(open).not.toHaveBeenCalled();
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(toastTitles()).toEqual([]);
  });

  it("shows the raw markdown in Source mode", () => {
    renderView("# Title\n\n[link](a.md)", { mode: "source" });
    expect(screen.getByTestId("code-file-view").textContent).toContain("[link](a.md)");
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("resolveMarkdownHref", () => {
  it.each([
    ["docs/guide.md", "my%20notes.md", { kind: "file", path: "docs/my notes.md" }],
    ["docs/guide.md", "a..b.md", { kind: "file", path: "docs/a..b.md" }],
    ["docs/guide.md", "/src/app.ts", { kind: "file", path: "src/app.ts" }],
    ["docs/guide.md", "other.md#intro", { kind: "file", path: "docs/other.md" }],
    ["docs/guide.md", "./sub/../other.md?x=1", { kind: "file", path: "docs/other.md" }],
    ["README.md", "../x.md", { kind: "outside-root" }],
    ["docs/guide.md", "/../x.md", { kind: "outside-root" }],
    ["docs/guide.md", "%2e%2e/%2e%2e/x.md", { kind: "outside-root" }],
    ["docs/guide.md", "..\\x.md", { kind: "outside-root" }],
    ["docs/guide.md", "C:/x.md", { kind: "ignored" }],
    ["docs/guide.md", "javascript:alert(1)", { kind: "ignored" }],
    ["docs/guide.md", "data:text/html,hi", { kind: "ignored" }],
    ["docs/guide.md", "file:///etc/passwd", { kind: "ignored" }],
    ["docs/guide.md", "", { kind: "ignored" }],
    ["docs/guide.md", "mailto:a@b.c", { kind: "external", url: "mailto:a@b.c" }],
    ["docs/guide.md", "#my-heading", { kind: "anchor", id: "my-heading" }],
  ])("from %s resolves %s", (from, href, expected) => {
    expect(resolveMarkdownHref(from, href)).toEqual(expected);
  });
});
