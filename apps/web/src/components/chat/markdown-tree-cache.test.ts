import type { Element, ElementData, Root } from "hast";
import type { Root as MdastRoot } from "mdast";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown, { type Components, type UrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { beforeEach, describe, expect, it } from "vitest";
import { copyMarkdownTree, estimateMarkdownTreeBytes, MarkdownTreeCache, type MarkdownRemarkPlugins } from "./markdown-tree-cache";

declare module "hast" {
  interface ElementData {
    review?: unknown;
    onClick?: unknown;
  }
}

let parses = 0;
const countParses = () => () => {
  parses += 1;
};
const gfm: MarkdownRemarkPlugins = [remarkGfm, countParses];
const gfmWithBreaks: MarkdownRemarkPlugins = [remarkGfm, remarkBreaks, countParses];

// Not idempotent, so a replay that rewrote stored URLs a second time would change the markup.
const proxyUrl: UrlTransform = (url) => `/proxy?to=${encodeURIComponent(url)}`;

const components: Components = {
  a: ({ href, children }) => createElement("a", { href, "data-kind": "custom-link" }, children),
  code: ({ className, children }) => createElement("code", { "data-lang": className ?? "inline" }, children),
};

const RICH = [
  "## Findings",
  "Read [the docs](https://example.com/docs), [mail](mailto:a@b.c), [bad](javascript:alert(1)) and `src/app.ts`.",
  "- one\n- two\n  - nested",
  "| a | b |\n|---|---|\n| <b>raw</b> | ~~gone~~ |",
  "```ts\nconst x = 1;\n```",
  "![logo](./logo.png)",
].join("\n\n");

function cacheWith(limits = { maxEntries: 8, maxBytes: 1024 * 1024 }) {
  return new MarkdownTreeCache(proxyUrl, limits);
}

function parse(content: string): Root {
  let tree: Root | undefined;
  Markdown({ children: content, remarkPlugins: [remarkGfm], rehypePlugins: [() => (parsed: Root) => { tree = parsed; }] });
  if (!tree) throw new Error("react-markdown produced no tree");
  return tree;
}

function html(cache: MarkdownTreeCache, content: string, remarkPlugins = gfm, admit = true): string {
  return renderToStaticMarkup(cache.render({ content, remarkPlugins, components, admit }));
}

beforeEach(() => {
  parses = 0;
});

describe("MarkdownTreeCache", () => {
  it("replays a stored parse with the same markup react-markdown renders directly", () => {
    const cache = cacheWith();
    const direct = renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm], urlTransform: proxyUrl, components }, RICH));

    const first = html(cache, RICH);
    const replayed = html(cache, RICH);

    expect(parses).toBe(1);
    expect(first).toBe(direct);
    expect(replayed).toBe(direct);
  });

  it("parses changed content instead of showing the earlier tree", () => {
    const cache = cacheWith();
    html(cache, "first draft");

    const edited = html(cache, "first draft, edited");

    expect(parses).toBe(2);
    expect(edited).toBe("<p>first draft, edited</p>");
  });

  it("parses the same content again under a different remark plugin list", () => {
    const cache = cacheWith();
    expect(html(cache, "line one\nline two", gfm)).toBe("<p>line one\nline two</p>");

    expect(html(cache, "line one\nline two", gfmWithBreaks)).toBe("<p>line one<br/>\nline two</p>");
    expect(parses).toBe(2);
  });

  it("does not store text rendered without admission, such as a streaming update", () => {
    const cache = cacheWith();
    html(cache, "still streaming", gfm, false);
    html(cache, "still streaming", gfm, false);

    expect(parses).toBe(2);
  });

  it("evicts the least recently used tree once the entry bound is reached", () => {
    const cache = cacheWith({ maxEntries: 2, maxBytes: 1024 * 1024 });
    html(cache, "a");
    html(cache, "b");
    html(cache, "a");
    html(cache, "c");
    expect(parses).toBe(3);

    html(cache, "a");
    expect(parses).toBe(3);
    html(cache, "b");
    expect(parses).toBe(4);
  });

  it("keeps stored trees within the byte bound and never stores one larger than it", () => {
    const tenChars = estimateMarkdownTreeBytes(parse("aaaaaaaaaa"), "aaaaaaaaaa");
    const cache = cacheWith({ maxEntries: 8, maxBytes: Math.floor(tenChars * 2.5) });
    html(cache, "aaaaaaaaaa");
    html(cache, "bbbbbbbbbb");
    html(cache, "cccccccccc");
    html(cache, "x".repeat(200));
    html(cache, "x".repeat(200));
    expect(parses).toBe(5);

    html(cache, "cccccccccc");
    html(cache, "bbbbbbbbbb");
    expect(parses).toBe(5);
    html(cache, "aaaaaaaaaa");
    expect(parses).toBe(6);
  });

  it("charges a dense table more of the byte bound than prose of the same length", () => {
    const table = ["| a | b | c |", "|---|---|---|", ...Array.from({ length: 30 }, (_, row) => `| ${row} | x | \`y\` |`)].join("\n");
    const prose = "word ".repeat(Math.ceil(table.length / 5)).slice(0, table.length);

    const tableBytes = estimateMarkdownTreeBytes(parse(table), table);
    const proseBytes = estimateMarkdownTreeBytes(parse(prose), prose);

    // Retained heap follows node count, so a char-only estimate would let tables overrun the bound.
    expect(tableBytes).toBeGreaterThan(proseBytes * 4);
  });

  it("copies a tree without sharing any object or array with the original", () => {
    const original = parse(RICH);
    const shared = new Set<object>();
    const collect = (value: unknown): void => {
      if (typeof value !== "object" || value === null) return;
      shared.add(value);
      for (const nested of Object.values(value)) collect(nested);
    };
    collect(original);
    const leaked: unknown[] = [];
    const check = (value: unknown): void => {
      if (typeof value !== "object" || value === null) return;
      if (shared.has(value)) leaked.push(value);
      for (const nested of Object.values(value)) check(nested);
    };

    const copy = copyMarkdownTree(original);
    check(copy);

    expect(copy).toEqual(original);
    expect(leaked).toEqual([]);
  });

  it("keeps a stored tree's plugin data intact when a later mount edits every nested value", () => {
    const remarkPlugins: MarkdownRemarkPlugins = [decorateFirstParagraph(pluginData), countParses];
    const cache = cacheWith();
    const draw = (edit: boolean) => renderToStaticMarkup(cache.render({
      content: "plugin data", remarkPlugins, admit: true,
      components: { span: ({ node, children }) => {
        expect(node?.data).toEqual(pluginData());
        if (edit) editEveryValue(node);
        return createElement("span", null, children);
      } },
    }));

    expect(draw(false)).toBe("<p><span>original</span></p>");
    expect(draw(true)).toBe("<p><span>original</span></p>");
    expect(draw(false)).toBe("<p><span>original</span></p>");
    expect(parses).toBe(1);
  });

  it("parses again instead of storing a tree whose plugin data cannot be copied", () => {
    const remarkPlugins: MarkdownRemarkPlugins = [decorateFirstParagraph(() => ({ onClick: () => undefined })), countParses];
    const cache = cacheWith();
    const draw = () => renderToStaticMarkup(cache.render({ content: "uncloneable", remarkPlugins, admit: true, components }));

    expect(draw()).toBe("<p><span>original</span></p>");
    expect(draw()).toBe("<p><span>original</span></p>");
    expect(parses).toBe(2);
  });
});

function pluginData(): ElementData {
  return { review: { tokens: [{ value: "original" }], map: new Map([["token", { value: "original" }]]),
    set: new Set(["original"]), date: new Date(12345) } };
}

/** A remark plugin that hands its own hast node, carrying `data`, to the first paragraph. */
function decorateFirstParagraph(data: () => ElementData) {
  return () => (tree: MdastRoot) => {
    const paragraph = tree.children[0];
    if (!paragraph) throw new Error("missing paragraph");
    const span: Element = { type: "element", tagName: "span", properties: {}, data: data(),
      children: [{ type: "text", value: "original" }] };
    paragraph.data = { hChildren: [span] };
  };
}

function editEveryValue(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) editEveryValue(child);
  if (value instanceof Map) {
    for (const child of value.values()) editEveryValue(child);
    value.set("edited", "edited");
  }
  if (value instanceof Set) value.add("edited");
  if (value instanceof Date) value.setTime(0);
  Object.defineProperty(value, "edited", { value: true, enumerable: true, configurable: true });
}
