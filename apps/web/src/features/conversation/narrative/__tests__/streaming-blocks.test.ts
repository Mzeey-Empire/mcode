import { describe, expect, it } from "vitest";
import { committedStreamingText, splitStreamingBlocks } from "../streaming-blocks";

describe("splitStreamingBlocks", () => {
  it("returns one text part for text without constructs", () => {
    expect(splitStreamingBlocks("hello\nworld")).toEqual([
      { kind: "text", text: "hello\nworld" },
    ]);
  });

  it("returns no parts for empty text", () => {
    expect(splitStreamingBlocks("")).toEqual([]);
  });

  it("extracts a closed mermaid fence between text runs", () => {
    const text = "before\n```mermaid\ngraph TD; A-->B;\n```\nafter";
    expect(splitStreamingBlocks(text)).toEqual([
      { kind: "text", text: "before\n" },
      { kind: "fence", lang: "mermaid", code: "graph TD; A-->B;", closed: true },
      { kind: "text", text: "after" },
    ]);
  });

  it("marks a fence still being streamed as open", () => {
    const text = "intro\n```mermaid\ngraph TD; A--";
    expect(splitStreamingBlocks(text)).toEqual([
      { kind: "text", text: "intro\n" },
      { kind: "fence", lang: "mermaid", code: "graph TD; A--", closed: false },
    ]);
  });

  it("emits an empty open fence part for a bare opener line", () => {
    expect(splitStreamingBlocks("```mermaid")).toEqual([
      { kind: "fence", lang: "mermaid", code: "", closed: false },
    ]);
  });

  it("extracts non-mermaid fences with their language", () => {
    const text = "```ts\nconst x = 1;\n```\ntail";
    expect(splitStreamingBlocks(text)).toEqual([
      { kind: "fence", lang: "ts", code: "const x = 1;", closed: true },
      { kind: "text", text: "tail" },
    ]);
  });

  it("keeps multiple fences in order", () => {
    const text =
      "```mermaid\ngraph TD; A-->B;\n```\nmiddle\n```mermaid\ngraph LR; X-->Y;\n```\n";
    expect(splitStreamingBlocks(text)).toEqual([
      { kind: "fence", lang: "mermaid", code: "graph TD; A-->B;", closed: true },
      { kind: "text", text: "middle\n" },
      { kind: "fence", lang: "mermaid", code: "graph LR; X-->Y;", closed: true },
    ]);
  });

  it("keeps a mermaid-looking line inside another fence as source", () => {
    const text = "```text\n```mermaid\ngraph TD;\n```\n";
    expect(splitStreamingBlocks(text)).toEqual([
      { kind: "fence", lang: "text", code: "```mermaid\ngraph TD;", closed: true },
    ]);
  });

  it("supports tilde fences and indented openers", () => {
    expect(splitStreamingBlocks("~~~mermaid\ngraph TD;\n~~~")).toEqual([
      { kind: "fence", lang: "mermaid", code: "graph TD;", closed: true },
    ]);
    expect(splitStreamingBlocks("  ```mermaid\ngraph TD;\n  ```")).toEqual([
      { kind: "fence", lang: "mermaid", code: "graph TD;", closed: true },
    ]);
  });

  it("lets a longer closer close a shorter opener", () => {
    expect(splitStreamingBlocks("```mermaid\ngraph TD;\n````")).toEqual([
      { kind: "fence", lang: "mermaid", code: "graph TD;", closed: true },
    ]);
  });

  it("takes the first info-string token as the language", () => {
    expect(splitStreamingBlocks("```ts title=x\nconst a = 1;\n```")).toEqual([
      { kind: "fence", lang: "ts", code: "const a = 1;", closed: true },
    ]);
  });

  it("does not treat a backtick in the info string as a fence", () => {
    const text = "```mermaid`x\ngraph TD;\n```";
    // "```mermaid`x" is not a valid opener, so "```" later opens a plain fence.
    expect(splitStreamingBlocks(text)).toEqual([
      { kind: "text", text: "```mermaid`x\ngraph TD;\n" },
      { kind: "fence", lang: "", code: "", closed: false },
    ]);
  });

  it("handles CRLF line endings", () => {
    const text = "before\r\n```mermaid\r\ngraph TD;\r\n```\r\nafter";
    expect(splitStreamingBlocks(text)).toEqual([
      { kind: "text", text: "before\r\n" },
      { kind: "fence", lang: "mermaid", code: "graph TD;", closed: true },
      { kind: "text", text: "after" },
    ]);
  });

  it("extracts a closed table once a non-table line follows", () => {
    const text = "| A | B |\n| - | - |\n| 1 | 2 |\n\ndone";
    expect(splitStreamingBlocks(text)).toEqual([
      { kind: "table", header: ["A", "B"], rows: [["1", "2"]], closed: true },
      { kind: "text", text: "\ndone" },
    ]);
  });

  it("marks a table still receiving rows as open", () => {
    const text = "lead\n| A | B |\n| - | - |\n| 1 |";
    expect(splitStreamingBlocks(text)).toEqual([
      { kind: "text", text: "lead\n" },
      { kind: "table", header: ["A", "B"], rows: [["1"]], closed: false },
    ]);
  });

  it("keeps a header row without a separator as text", () => {
    const text = "| maybe a table | not yet |";
    expect(splitStreamingBlocks(text)).toEqual([{ kind: "text", text }]);
  });

  it("does not treat a horizontal rule as a table separator", () => {
    const text = "| A |\n---\nmore";
    expect(splitStreamingBlocks(text)).toEqual([{ kind: "text", text }]);
  });

  it("keeps a table-looking line inside a fence as source", () => {
    const text = "```\n| A |\n| - |\n```\n";
    expect(splitStreamingBlocks(text)).toEqual([
      { kind: "fence", lang: "", code: "| A |\n| - |", closed: true },
    ]);
  });

  it("rejects a fence opener indented more than three spaces", () => {
    const text = "    ```mermaid\n    graph TD;\n    ```";
    expect(splitStreamingBlocks(text)).toEqual([{ kind: "text", text }]);
  });

  it("ends a table when a fence opener follows it", () => {
    const text = "| A |\n| - |\n| 1 |\n```ts\nconst x = 1;\n```\n";
    expect(splitStreamingBlocks(text)).toEqual([
      { kind: "table", header: ["A"], rows: [["1"]], closed: true },
      { kind: "fence", lang: "ts", code: "const x = 1;", closed: true },
    ]);
  });

  it("rejects a pipe row indented like a code block", () => {
    const text = "    | A |\n    | - |\n    | 1 |";
    expect(splitStreamingBlocks(text)).toEqual([{ kind: "text", text }]);
  });

  it("normalizes CRLF inside fenced code", () => {
    const text = "```ts\r\nconst a = 1;\r\nconst b = 2;\r\n```";
    expect(splitStreamingBlocks(text)).toEqual([
      { kind: "fence", lang: "ts", code: "const a = 1;\nconst b = 2;", closed: true },
    ]);
  });

  it("does not treat two pipe rows without dashes as a table", () => {
    const text = "| a |\n| b |";
    expect(splitStreamingBlocks(text)).toEqual([{ kind: "text", text }]);
  });
});

describe("committedStreamingText", () => {
  it("commits through the last blank line and holds the unfinished paragraph", () => {
    expect(committedStreamingText("One.\n\nTwo.\n\nThr")).toEqual({ committed: "One.\n\nTwo.\n\n", tail: "Thr" });
  });

  it("commits nothing before the first block boundary", () => {
    expect(committedStreamingText("Still typing\nthe first paragraph")).toEqual({
      committed: "",
      tail: "Still typing\nthe first paragraph",
    });
  });

  it("does not commit at a whitespace-only line that has no newline yet", () => {
    expect(committedStreamingText("One.\n  ")).toEqual({ committed: "", tail: "One.\n  " });
  });

  it("does not treat a blank line inside an open fence as a boundary", () => {
    const text = "Intro.\n\n```ts\nconst a = 1;\n\nconst b";
    expect(committedStreamingText(text)).toEqual({ committed: "Intro.\n\n", tail: "```ts\nconst a = 1;\n\nconst b" });
  });

  it("commits through a fence's closing line", () => {
    const text = "```ts\nconst a = 1;\n```\nAfter";
    expect(committedStreamingText(text)).toEqual({ committed: "```ts\nconst a = 1;\n```\n", tail: "After" });
  });

  it("finds blank-line boundaries in CRLF text", () => {
    expect(committedStreamingText("One.\r\n\r\nTwo")).toEqual({ committed: "One.\r\n\r\n", tail: "Two" });
  });

  it("splits every prefix of a stream without losing or adding characters", () => {
    const text = "Lead.\r\n\r\n```js\nx();\n\n```\n| A |\n| - |\n\n  \nEnd";
    for (let end = 0; end <= text.length; end++) {
      const { committed, tail } = committedStreamingText(text.slice(0, end));
      expect(committed + tail).toBe(text.slice(0, end));
    }
  });
});
