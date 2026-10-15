import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePreviewAnnotationStore } from "../../state/previewAnnotationStore";
import { saveDraftDiffComment } from "@/features/conversation/composer/draft/draft-diff-comments";
import { buildComposerAnnotationBundle } from "@/features/conversation/composer/submission/composer-annotations";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { BrowserNotesTile } from "../BrowserNotesTile";
import { BILLING_PAGE, seedPage, draft, tickClockPerRead } from "./fixtures";

const { mockSchedule } = vi.hoisted(() => ({ mockSchedule: vi.fn() }));
vi.mock("../previewNoteSnapshots", () => ({ schedulePageSnapshot: mockSchedule }));

const SCOPE = "thread-tile";
const store = () => usePreviewAnnotationStore.getState();

function renderTile(onRemoveAll: () => void = vi.fn()) {
  render(<BrowserNotesTile scopeId={SCOPE} workspaceId="workspace-1" threadId={SCOPE} onRemoveAll={onRemoveAll} />);
}

async function openHoverCard() {
  await userEvent.hover(screen.getByRole("button", { name: /Notes available/ }));
  return screen.findByTestId("browser-notes-card");
}

describe("BrowserNotesTile", () => {
  beforeEach(() => {
    tickClockPerRead();
    mockSchedule.mockClear();
    usePreviewAnnotationStore.setState({ byThread: {}, pages: {}, drafts: {} });
    useComposerDraftStore.setState({ drafts: {} });
    seedPage(SCOPE);
    seedPage(SCOPE, BILLING_PAGE, "Billing");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders nothing without Browser notes", () => {
    renderTile();

    expect(screen.queryByTestId("browser-notes-tile")).not.toBeInTheDocument();
  });

  it("labels a single page by name and note count", () => {
    store().saveAnnotation(SCOPE, draft(SCOPE, { pageIdentity: BILLING_PAGE }));

    renderTile();

    expect(screen.getByText("Billing · 1 note")).toBeInTheDocument();
  });

  it("labels several pages by total notes and page count", () => {
    store().saveAnnotation(SCOPE, draft(SCOPE));
    store().saveAnnotation(SCOPE, draft(SCOPE));
    store().saveAnnotation(SCOPE, draft(SCOPE, { pageIdentity: BILLING_PAGE }));

    renderTile();

    expect(screen.getByText("3 notes · 2 pages")).toBeInTheDocument();
  });

  it("lists each page's notes under its own numbering on hover", async () => {
    store().saveAnnotation(SCOPE, draft(SCOPE, { note: "Product one" }));
    store().saveAnnotation(SCOPE, draft(SCOPE, { note: "Product two" }));
    store().saveAnnotation(SCOPE, draft(SCOPE, { pageIdentity: BILLING_PAGE, note: "Billing one" }));
    renderTile();

    const card = await openHoverCard();

    expect(within(card).getAllByTestId("browser-note-row").map((row) => row.textContent)).toEqual([
      "1button.buyBilling one",
      "1button.buyProduct one",
      "2button.buyProduct two",
    ]);
  });

  it("removing a row renumbers its page and queues that page's snapshot redraw", async () => {
    const first = store().saveAnnotation(SCOPE, draft(SCOPE, { note: "Product one" }));
    store().saveAnnotation(SCOPE, draft(SCOPE, { note: "Product two" }));
    renderTile();
    await openHoverCard();

    await userEvent.click(screen.getByRole("button", { name: "Remove note 1 on Product" }));

    expect(store().getThreadAnnotations(SCOPE).map((note) => [note.note, note.displayNumber])).toEqual([
      ["Product two", 1],
    ]);
    expect(store().getThreadAnnotations(SCOPE).some((note) => note.id === first.id)).toBe(false);
    expect(mockSchedule).toHaveBeenCalledWith(SCOPE, first.pageIdentity);
  });

  it("removing the notes tile keeps Review comments", async () => {
    saveDraftDiffComment(SCOPE, {
      filePath: "apps/web/src/App.tsx",
      side: "right",
      line: 42,
      lineContent: "return <App />;",
    }, { note: "Handle the loading state", mentions: [] });
    store().saveAnnotation(SCOPE, draft(SCOPE));
    renderTile(() => store().clearPreviewNotes(SCOPE));

    await userEvent.click(screen.getByRole("button", { name: "Remove Product · 1 note" }));

    expect(store().getThreadAnnotations(SCOPE)).toEqual([]);
    expect(buildComposerAnnotationBundle(SCOPE)?.annotations).toEqual([
      expect.objectContaining({ kind: "diff", note: "Handle the loading state" }),
    ]);
  });

  it("calls onRemoveAll from the tile remove button", async () => {
    store().saveAnnotation(SCOPE, draft(SCOPE));
    const onRemoveAll = vi.fn();
    renderTile(onRemoveAll);

    await userEvent.click(screen.getByRole("button", { name: "Remove Product · 1 note" }));

    expect(onRemoveAll).toHaveBeenCalledTimes(1);
  });
});
