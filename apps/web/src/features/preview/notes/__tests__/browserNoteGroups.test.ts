import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { usePreviewAnnotationStore } from "../../state/previewAnnotationStore";
import {
  browserNotesTileLabel,
  browserPageLabel,
  groupBrowserNotes,
} from "../browserNoteGroups";
import { BILLING_PAGE, PRODUCT_PAGE, seedPage } from "./fixtures";

const THREAD = "thread-groups";
const store = () => usePreviewAnnotationStore.getState();

function groups() {
  return groupBrowserNotes(store().getThreadAnnotations(THREAD), store().pages[THREAD] ?? {});
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("groupBrowserNotes", () => {
  beforeEach(() => {
    usePreviewAnnotationStore.setState({ byThread: {}, pages: {}, drafts: {} });
    useComposerDraftStore.setState({ drafts: {} });
  });

  it("fronts the page that was annotated last", () => {
    seedPage(THREAD, PRODUCT_PAGE, "Product", { note: "Product note" });
    seedPage(THREAD, BILLING_PAGE, "Billing", { note: "Billing note" });

    expect(groups().map((group) => group.page.pageIdentity)).toEqual([BILLING_PAGE, PRODUCT_PAGE]);
  });

  it("keeps each page's notes in that page's numbering order", () => {
    seedPage(THREAD, PRODUCT_PAGE, "Product", { note: "First" });
    seedPage(THREAD, PRODUCT_PAGE, "Product", { note: "Second" });

    expect(groups()[0]?.notes.map((note) => [note.note, note.displayNumber])).toEqual([
      ["First", 1],
      ["Second", 2],
    ]);
  });

  it("drops notes whose page has no record", () => {
    seedPage(THREAD, PRODUCT_PAGE, "Product");

    expect(groupBrowserNotes(store().getThreadAnnotations(THREAD), {})).toEqual([]);
  });
});

describe("browserNotesTileLabel", () => {
  beforeEach(() => {
    usePreviewAnnotationStore.setState({ byThread: {}, pages: {}, drafts: {} });
    useComposerDraftStore.setState({ drafts: {} });
  });

  it("names the page for a single page", () => {
    seedPage(THREAD, BILLING_PAGE, "Billing");

    expect(browserNotesTileLabel(groups())).toBe("Billing · 1 note");
  });

  it("counts notes and pages for several pages", () => {
    seedPage(THREAD, PRODUCT_PAGE, "Product");
    seedPage(THREAD, PRODUCT_PAGE, "Product");
    seedPage(THREAD, BILLING_PAGE, "Billing");
    seedPage(THREAD, BILLING_PAGE, "Billing");

    expect(browserNotesTileLabel(groups())).toBe("4 notes · 2 pages");
  });
});

describe("browserPageLabel", () => {
  it("falls back to the host when the page has no title", () => {
    expect(browserPageLabel({ title: "  ", url: "http://localhost:5173/billing" })).toBe("localhost:5173");
    expect(browserPageLabel({ title: null, url: "not a url" })).toBe("not a url");
  });
});
