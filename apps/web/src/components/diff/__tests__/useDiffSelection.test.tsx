import { FileDiff, parseDiffFromFile, type FileDiffMetadata } from "@pierre/diffs";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DiffSelection, useDiffSelection } from "../useDiffSelection";
import {
  type BrowserSelection,
  LINES,
  type SelectionEngine,
  TEXT,
  highlightedText,
  installBrowserSelection,
  mountDiffHost,
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

function setup(renderMode: "unified" | "side-by-side") {
  const hook: { current?: DiffSelection } = {};
  function Wrapper() {
    const scrollerRef = useRef<HTMLDivElement>(null);
    hook.current = useDiffSelection(scrollerRef, renderMode);
    return (
      <div {...hook.current.wrapperProps}>
        <div ref={scrollerRef} data-testid="scroller" />
      </div>
    );
  }
  const view = render(<Wrapper />);
  const { host, content } = mountDiffHost();
  view.getByTestId("scroller").append(host);
  const instance = instanceOf(addedFile());
  // Pierre rewrites the rows, then reports the render.
  const rewrite = (indices: readonly number[]) => {
    showRows(content, indices);
    hook.current?.onPostRender(host, instance, "update");
  };
  return { host, content, rewrite };
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
    const { content, rewrite } = setup("unified");
    const held = range(0, 9);
    rewrite(held);
    select(browser, content, [2, 4], [7, 3]);
    document.dispatchEvent(new Event("selectionchange"));

    rewrite(range(10, 19));
    rewrite(held);

    expect(browser.toString()).toBe(highlightedText(held, [2, 4], [7, 3]));
  });

  it("copies the whole selection when the rows that hold it have scrolled out", () => {
    const { host, content, rewrite } = setup("unified");
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
    const { host, content, rewrite } = setup("unified");
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

  it("leaves the browser's own selection alone in side-by-side mode", () => {
    const { content, rewrite } = setup("side-by-side");
    rewrite(range(0, 9));
    select(browser, content, [2, 4], [7, 3]);
    document.dispatchEvent(new Event("selectionchange"));

    rewrite(range(10, 19));
    rewrite(range(0, 9));

    expect(browser.toString()).toBe("");
  });
});
