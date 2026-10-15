import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePreviewAnnotationStore } from "../../state/previewAnnotationStore";
import { usePreviewTabsStore } from "../../state/previewTabsStore";
import { saveDraftDiffComment } from "@/features/conversation/composer/draft/draft-diff-comments";
import { buildComposerAnnotationBundle } from "@/features/conversation/composer/submission/composer-annotations";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { BrowserNotesTile } from "../BrowserNotesTile";
import { clearVisibleBrowserNotes } from "@/features/conversation/composer/draft/draft-browser-notes";
import { BILLING_PAGE, PRODUCT_PAGE, seedPage } from "./fixtures";

const { mockSchedule, mockRead } = vi.hoisted(() => ({ mockSchedule: vi.fn(), mockRead: vi.fn() }));
vi.mock("../previewNoteSnapshots", () => ({ schedulePageSnapshot: mockSchedule }));
vi.mock("../stagedDraftImages", () => ({ readStagedDraftImage: mockRead, stageDraftImage: vi.fn() }));

const SCOPE = "thread-tile";
const store = () => usePreviewAnnotationStore.getState();
const firstNote = () => store().getThreadAnnotations(SCOPE)[0]!;

function renderTile(onRemoveAll: () => void = vi.fn(), threadId: string | undefined = SCOPE) {
  render(<BrowserNotesTile scopeId={SCOPE} workspaceId="workspace-1" threadId={threadId} onRemoveAll={onRemoveAll} />);
}

async function openHoverCard() {
  await userEvent.hover(screen.getByRole("button", { name: /Notes available/ }));
  return screen.findByTestId("browser-notes-card");
}

describe("BrowserNotesTile", () => {
  beforeEach(() => {
    mockSchedule.mockClear();
    mockRead.mockReset().mockResolvedValue(new Uint8Array([1]));
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:page"), revokeObjectURL: vi.fn() });
    usePreviewAnnotationStore.setState({ byThread: {}, pages: {}, drafts: {} });
    useComposerDraftStore.setState({ drafts: {} });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the page's drawn image as the tile thumbnail", async () => {
    seedPage(SCOPE, PRODUCT_PAGE, "Product");

    renderTile();

    await waitFor(() => expect(document.querySelector("img")?.getAttribute("src")).toBe("blob:page"));
    expect(mockRead).toHaveBeenCalledWith(SCOPE, store().pages[SCOPE]![PRODUCT_PAGE]!.snapshot);
  });

  it("shows the thumbnail before a thread exists, reading the images staged under the scope", async () => {
    seedPage(SCOPE, PRODUCT_PAGE, "Product");

    renderTile(vi.fn(), undefined);

    await waitFor(() => expect(document.querySelector("img")?.getAttribute("src")).toBe("blob:page"));
    expect(mockRead).toHaveBeenCalledWith(SCOPE, store().pages[SCOPE]![PRODUCT_PAGE]!.snapshot);
  });

  it("falls back to the clean screenshot while the page waits for a redraw", async () => {
    seedPage(SCOPE, PRODUCT_PAGE, "Product", { snapshot: false });

    renderTile();

    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());
    expect(mockRead).toHaveBeenCalledWith(SCOPE, store().pages[SCOPE]![PRODUCT_PAGE]!.clean!.image);
  });

  it("offers Retake when the staged image is gone", async () => {
    mockRead.mockResolvedValue(null);
    seedPage(SCOPE, PRODUCT_PAGE, "Product");

    renderTile();

    expect(await screen.findByText("Retake")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("renders nothing without Browser notes", () => {
    renderTile();

    expect(screen.queryByTestId("browser-notes-tile")).not.toBeInTheDocument();
  });

  it("labels a single page by name and note count", () => {
    seedPage(SCOPE, BILLING_PAGE, "Billing");

    renderTile();

    expect(screen.getByText("Billing · 1 note")).toBeInTheDocument();
  });

  it("labels several pages by total notes and page count", () => {
    seedPage(SCOPE, PRODUCT_PAGE, "Product");
    seedPage(SCOPE, PRODUCT_PAGE, "Product");
    seedPage(SCOPE, BILLING_PAGE, "Billing");

    renderTile();

    expect(screen.getByText("3 notes · 2 pages")).toBeInTheDocument();
  });

  it("lists each page's notes under its own numbering on hover", async () => {
    seedPage(SCOPE, PRODUCT_PAGE, "Product", { note: "Product one" });
    seedPage(SCOPE, PRODUCT_PAGE, "Product", { note: "Product two" });
    seedPage(SCOPE, BILLING_PAGE, "Billing", { note: "Billing one" });
    renderTile();

    const card = await openHoverCard();

    expect(within(card).getAllByTestId("browser-note-row").map((row) => row.textContent)).toEqual([
      "1button.buyBilling one",
      "1button.buyProduct one",
      "2button.buyProduct two",
    ]);
  });

  it("removing a row renumbers its page and queues that page's snapshot redraw", async () => {
    seedPage(SCOPE, PRODUCT_PAGE, "Product", { note: "Product one" });
    seedPage(SCOPE, PRODUCT_PAGE, "Product", { note: "Product two" });
    const first = firstNote();
    renderTile();
    await openHoverCard();

    await userEvent.click(screen.getByRole("button", { name: "Remove note 1 on Product" }));

    expect(store().getThreadAnnotations(SCOPE).map((note) => [note.note, note.displayNumber])).toEqual([
      ["Product two", 1],
    ]);
    expect(store().getThreadAnnotations(SCOPE).some((note) => note.id === first.id)).toBe(false);
    expect(mockSchedule).toHaveBeenCalledWith(SCOPE, first.pageIdentity);
  });

  it("removing the last row clears the queued-bundle fallback like the tile remove does", async () => {
    seedPage(SCOPE, PRODUCT_PAGE, "Product", { note: "Only note" });
    const onRemoveAll = vi.fn();
    renderTile(onRemoveAll);
    await openHoverCard();

    await userEvent.click(screen.getByRole("button", { name: "Remove note 1 on Product" }));

    expect(onRemoveAll).toHaveBeenCalledTimes(1);
  });

  it("keeps the tile's remove callback for rows that leave notes behind", async () => {
    seedPage(SCOPE, PRODUCT_PAGE, "Product", { note: "One" });
    seedPage(SCOPE, PRODUCT_PAGE, "Product", { note: "Two" });
    const onRemoveAll = vi.fn();
    renderTile(onRemoveAll);
    await openHoverCard();

    await userEvent.click(screen.getByRole("button", { name: "Remove note 1 on Product" }));

    expect(onRemoveAll).not.toHaveBeenCalled();
  });

  it("opens the notes card when the tile takes keyboard focus", async () => {
    seedPage(SCOPE, PRODUCT_PAGE, "Product", { note: "Keyboard note" });
    renderTile();

    await userEvent.tab();

    expect(await screen.findByTestId("browser-notes-card")).toBeInTheDocument();
    expect(screen.getByText("Keyboard note")).toBeInTheDocument();
  });

  it("clicking a note shows its page in the Browser, then scrolls to the note", async () => {
    seedPage(SCOPE, PRODUCT_PAGE, "Product", { note: "Scroll here" });
    const note = firstNote();
    const order: string[] = [];
    const revealNote = vi.fn(async () => { order.push("reveal"); return { ok: true as const }; });
    Object.assign(window, { desktopBridge: { preview: { design: { revealNote } } } });
    usePreviewTabsStore.setState({
      openPage: vi.fn(async () => { order.push("open"); return "tab-1"; }),
    });
    renderTile();
    await openHoverCard();

    await userEvent.click(screen.getByTestId("browser-note-row"));

    await waitFor(() => expect(revealNote).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["open", "reveal"]);
    expect(revealNote).toHaveBeenCalledWith({
      selector: note.targetContext.selectorHint?.trim() || null,
      bounds: note.targetContext.bounds,
    });
    Object.assign(window, { desktopBridge: undefined });
  });

  it("does not scroll when the page could not be opened", async () => {
    seedPage(SCOPE, PRODUCT_PAGE, "Product", { note: "Scroll here" });
    const revealNote = vi.fn();
    Object.assign(window, { desktopBridge: { preview: { design: { revealNote } } } });
    const openPage = vi.fn(async () => null);
    usePreviewTabsStore.setState({ openPage });
    renderTile();
    await openHoverCard();

    await userEvent.click(screen.getByTestId("browser-note-row"));

    await waitFor(() => expect(openPage).toHaveBeenCalledTimes(1));
    expect(revealNote).not.toHaveBeenCalled();
    Object.assign(window, { desktopBridge: undefined });
  });

  it("removing the notes tile keeps Review comments", async () => {
    saveDraftDiffComment(SCOPE, {
      filePath: "apps/web/src/App.tsx",
      side: "right",
      line: 42,
      lineContent: "return <App />;",
    }, { note: "Handle the loading state", mentions: [] });
    seedPage(SCOPE, PRODUCT_PAGE, "Product");
    renderTile(() => clearVisibleBrowserNotes(SCOPE));

    await userEvent.click(screen.getByRole("button", { name: "Remove Product · 1 note" }));

    expect(store().getThreadAnnotations(SCOPE)).toEqual([]);
    expect(buildComposerAnnotationBundle(SCOPE)?.annotations).toEqual([
      expect.objectContaining({ kind: "diff", note: "Handle the loading state" }),
    ]);
  });

  it("calls onRemoveAll from the tile remove button", async () => {
    seedPage(SCOPE, PRODUCT_PAGE, "Product");
    const onRemoveAll = vi.fn();
    renderTile(onRemoveAll);

    await userEvent.click(screen.getByRole("button", { name: "Remove Product · 1 note" }));

    expect(onRemoveAll).toHaveBeenCalledTimes(1);
  });
});
