import { FileDiff, parseDiffFromFile, type FileDiffMetadata } from "@pierre/diffs";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DiffSelection, useDiffSelection } from "../useDiffSelection";
import {
  type BrowserSelection,
  LINES,
  OLD_LINES,
  type SelectionEngine,
  TEXT,
  highlightedText,
  installBrowserSelection,
  mountDiffHost,
  mountSplitHost,
  pointIn,
  range,
  restoreBrowserSelection,
  select,
  showRows,
} from "./pierre-dom";

function addedFile(): FileDiffMetadata {
  return parseDiffFromFile(
    { name: "a.txt", contents: "" },
    { name: "a.txt", contents: `${TEXT}\n` },
  );
}

function instanceOf(fileDiff: FileDiffMetadata) {
  const instance = new FileDiff();
  instance.fileDiff = fileDiff;
  return instance;
}

function mountHook() {
  const hook: { current?: DiffSelection } = {};
  function Wrapper() {
    const scrollerRef = useRef<HTMLDivElement>(null);
    hook.current = useDiffSelection(scrollerRef);
    return (
      <div {...hook.current.wrapperProps}>
        <div ref={scrollerRef} data-testid="scroller" />
      </div>
    );
  }
  const view = render(<Wrapper />);
  return { hook, scroller: view.getByTestId("scroller") };
}

function setup() {
  const { hook, scroller } = mountHook();
  const { host, content } = mountDiffHost();
  scroller.append(host);
  const instance = instanceOf(addedFile());
  // Pierre rewrites the rows, then reports the render.
  const rewrite = (indices: readonly number[]) => {
    showRows(content, indices);
    hook.current?.onPostRender(host, instance, "update");
  };
  return { host, content, rewrite };
}

/** Every line changed, so the two columns hold different text at the same split indices. */
function setupSplit() {
  const { hook, scroller } = mountHook();
  const { host, deletions, additions } = mountSplitHost();
  scroller.append(host);
  const instance = instanceOf(
    parseDiffFromFile(
      { name: "a.txt", contents: `${OLD_LINES.join("\n")}\n` },
      { name: "a.txt", contents: `${TEXT}\n` },
    ),
  );
  const rewrite = (indices: readonly number[]) => {
    showRows(deletions, indices, OLD_LINES);
    showRows(additions, indices);
    hook.current?.onPostRender(host, instance, "update");
  };
  return { host, deletions, additions, rewrite };
}

const ENGINES: readonly SelectionEngine[] = ["composed-ranges", "shadow-root-selection"];

describe.each(ENGINES)("useDiffSelection with %s", (engine) => {
  let browser: BrowserSelection;

  beforeEach(() => {
    browser = installBrowserSelection(engine);
  });

  afterEach(() => {
    cleanup();
    restoreBrowserSelection();
    document.body.replaceChildren();
  });

  it("keeps a selection made in a file when the file's rows are rewritten", () => {
    const { content, rewrite } = setup();
    const held = range(0, 9);
    rewrite(held);
    select(browser, content, [2, 4], [7, 3]);
    document.dispatchEvent(new Event("selectionchange"));

    rewrite(range(10, 19));
    rewrite(held);

    expect(browser.toString()).toBe(highlightedText(held, [2, 4], [7, 3]));
  });

  it("copies the whole selection when the rows that hold it have scrolled out", () => {
    const { host, content, rewrite } = setup();
    rewrite(range(0, 9));
    select(browser, content, [2, 4], [7, 3]);
    document.dispatchEvent(new Event("selectionchange"));
    rewrite(range(4, 13));
    const copied = new Map<string, string>();
    const clipboardData = { setData: (type: string, value: string) => copied.set(type, value) };

    fireEvent.copy(host, { clipboardData });

    const start = LINES.slice(0, 2).join("\n").length + 1 + 4;
    const end = LINES.slice(0, 7).join("\n").length + 1 + 3;
    expect(copied.get("text/plain")).toBe(TEXT.slice(start, end));
  });

  it("copies the rebuilt text while every row that holds the selection is mounted", () => {
    const { host, content, rewrite } = setup();
    rewrite(range(0, 9));
    select(browser, content, [2, 4], [7, 3]);
    document.dispatchEvent(new Event("selectionchange"));
    const copied = new Map<string, string>();
    const clipboardData = { setData: (type: string, value: string) => copied.set(type, value) };

    fireEvent.copy(host, { clipboardData });

    const start = LINES.slice(0, 2).join("\n").length + 1 + 4;
    const end = LINES.slice(0, 7).join("\n").length + 1 + 3;
    expect(copied.get("text/plain")).toBe(TEXT.slice(start, end));
  });

  describe("in the split layout", () => {
    it.each([
      ["additions", LINES],
      ["deletions", OLD_LINES],
    ] as const)("keeps a selection made in the %s column when its rows are rewritten", (side, lines) => {
      const split = setupSplit();
      const held = range(0, 9);
      split.rewrite(held);
      select(browser, split[side], [2, 4], [7, 3]);
      document.dispatchEvent(new Event("selectionchange"));

      split.rewrite(range(10, 19));
      split.rewrite(held);

      expect(browser.toString()).toBe(highlightedText(held, [2, 4], [7, 3], lines));
    });

    it("leaves a selection that spans both columns to the browser", () => {
      const { host, deletions, additions, rewrite } = setupSplit();
      const held = range(0, 9);
      rewrite(held);
      const [anchorNode, anchorOffset] = pointIn(additions, 2, 4);
      const [focusNode, focusOffset] = pointIn(deletions, 7, 3);
      browser.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
      document.dispatchEvent(new Event("selectionchange"));
      const copied = new Map<string, string>();
      const clipboardData = { setData: (type: string, value: string) => copied.set(type, value) };

      rewrite(range(10, 19));
      rewrite(held);
      fireEvent.copy(host, { clipboardData });

      // The browser's range, collapsed onto the columns by the rewrite, was not drawn back onto rows.
      const kept = browser.snapshot();
      expect(kept?.startContainer).toBe(deletions);
      expect(kept?.endContainer).toBe(additions);
      expect(copied.size).toBe(0);
    });
  });
});
