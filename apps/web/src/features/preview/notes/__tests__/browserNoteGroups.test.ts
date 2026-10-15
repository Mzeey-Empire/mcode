import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePreviewAnnotationStore } from "../../state/previewAnnotationStore";
import {
  browserNotesTileLabel,
  browserPageLabel,
  groupBrowserNotes,
} from "../browserNoteGroups";
import { BILLING_PAGE, seedPage, draft, PRODUCT_PAGE, tickClockPerRead } from "./fixtures";

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
    tickClockPerRead();
    usePreviewAnnotationStore.setState({ byThread: {}, pages: {}, drafts: {} });
    seedPage(THREAD);
    seedPage(THREAD, BILLING_PAGE, "Billing");
  });

  it("fronts the page that was annotated last", () => {
    store().saveAnnotation(THREAD, draft(THREAD, { note: "Product note" }));
    store().saveAnnotation(THREAD, draft(THREAD, { pageIdentity: BILLING_PAGE, note: "Billing note" }));

    expect(groups().map((group) => group.page.pageIdentity)).toEqual([BILLING_PAGE, PRODUCT_PAGE]);
  });

  it("keeps each page's notes in that page's numbering order", () => {
    store().saveAnnotation(THREAD, draft(THREAD, { note: "First" }));
    store().saveAnnotation(THREAD, draft(THREAD, { note: "Second" }));

    expect(groups()[0]?.notes.map((note) => [note.note, note.displayNumber])).toEqual([
      ["First", 1],
      ["Second", 2],
    ]);
  });

  it("drops notes whose page has no record", () => {
    store().saveAnnotation(THREAD, draft(THREAD));

    expect(groupBrowserNotes(store().getThreadAnnotations(THREAD), {})).toEqual([]);
  });
});

describe("browserNotesTileLabel", () => {
  beforeEach(() => {
    tickClockPerRead();
    usePreviewAnnotationStore.setState({ byThread: {}, pages: {}, drafts: {} });
    seedPage(THREAD);
    seedPage(THREAD, BILLING_PAGE, "Billing");
  });

  it("names the page for a single page", () => {
    store().saveAnnotation(THREAD, draft(THREAD, { pageIdentity: BILLING_PAGE }));

    expect(browserNotesTileLabel(groups())).toBe("Billing · 1 note");
  });

  it("counts notes and pages for several pages", () => {
    store().saveAnnotation(THREAD, draft(THREAD));
    store().saveAnnotation(THREAD, draft(THREAD));
    store().saveAnnotation(THREAD, draft(THREAD, { pageIdentity: BILLING_PAGE }));
    store().saveAnnotation(THREAD, draft(THREAD, { pageIdentity: BILLING_PAGE }));

    expect(browserNotesTileLabel(groups())).toBe("4 notes · 2 pages");
  });
});

describe("browserPageLabel", () => {
  it("falls back to the host when the page has no title", () => {
    expect(browserPageLabel({ title: "  ", url: "http://localhost:5173/billing" })).toBe("localhost:5173");
    expect(browserPageLabel({ title: null, url: "not a url" })).toBe("not a url");
  });
});
