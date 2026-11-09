import type { Root } from "hast";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown, { type Components, type UrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { beforeEach, describe, expect, it } from "vitest";
import { estimateMarkdownTreeBytes, MarkdownTreeCache, type MarkdownRemarkPlugins } from "./markdown-tree-cache";

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
});
