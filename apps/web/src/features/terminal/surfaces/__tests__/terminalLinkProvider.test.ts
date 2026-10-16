import { describe, expect, it } from "vitest";
import {
  findTerminalLinks,
  findTerminalUrlLinks,
  parseTerminalLink,
  terminalLinkCellRange,
} from "../terminalLinkProvider";

describe("parseTerminalLink", () => {
  it("accepts absolute file targets with bounded location metadata", () => {
    expect(parseTerminalLink("C:\\repo\\src\\main.ts:12:4")).toEqual({
      path: "C:\\repo\\src\\main.ts",
      line: 12,
      column: 4,
    });
    expect(parseTerminalLink("/workspace/src/main.ts:8")).toEqual({
      path: "/workspace/src/main.ts",
      line: 8,
    });
  });

  it("rejects URLs, traversal, relative paths, and unbounded locations", () => {
    expect(parseTerminalLink("https://example.test/file.ts:1")).toBeNull();
    expect(parseTerminalLink("../../src/main.ts:1")).toBeNull();
    expect(parseTerminalLink("src/main.ts:1")).toBeNull();
    expect(parseTerminalLink("/workspace/src/main.ts:1000001")).toBeNull();
    expect(parseTerminalLink("/workspace/src/\u0001main.ts:1")).toBeNull();
  });

  it("finds only a safe file target inside a diagnostic line", () => {
    expect(findTerminalLinks("error: /workspace/src/main.ts:8:2")).toEqual([expect.objectContaining({
      text: "/workspace/src/main.ts:8:2",
      target: { path: "/workspace/src/main.ts", line: 8, column: 2 },
    })]);
    expect(findTerminalLinks("error: https://example.test/file.ts:8")).toEqual([]);
  });

  it("returns every safe link and maps ranges after a wide Unicode prefix", () => {
    const text = "界 /workspace/src/a.ts:8 /workspace/src/b.ts:12";
    const cells = Array.from(text).flatMap((chars) => {
      const width = chars === "界" ? 2 : 1;
      return [
        { getChars: () => chars, getWidth: () => width },
        ...(width === 2 ? [{ getChars: () => "", getWidth: () => 0 }] : []),
      ];
    });
    const line = {
      length: cells.length,
      getCell: (index: number) => cells[index],
    };
    const links = findTerminalLinks(text);

    expect(links).toHaveLength(2);
    expect(terminalLinkCellRange(line, links[0]!)).toEqual({
      start: 3,
      end: 3 + links[0]!.text.length,
    });
    expect(terminalLinkCellRange(line, links[1]!)).toEqual({
      start: 4 + links[0]!.text.length,
      end: 4 + links[0]!.text.length + links[1]!.text.length,
    });
  });
});

describe("findTerminalUrlLinks", () => {
  it("finds a web URL and flags loopback hosts for the Browser tab", () => {
    expect(findTerminalUrlLinks("ready on http://localhost:5173/")).toEqual([
      expect.objectContaining({ url: "http://localhost:5173/", loopback: true, text: "http://localhost:5173/" }),
    ]);
    expect(findTerminalUrlLinks("http://127.0.0.1:3000/a http://[::1]:8080/")).toEqual([
      expect.objectContaining({ loopback: true }),
      expect.objectContaining({ loopback: true }),
    ]);
    expect(findTerminalUrlLinks("docs at https://example.test/guide")).toEqual([
      expect.objectContaining({ url: "https://example.test/guide", loopback: false }),
    ]);
  });

  it("does not treat a lookalike host as loopback", () => {
    expect(findTerminalUrlLinks("http://localhost.evil.test/")).toEqual([
      expect.objectContaining({ loopback: false }),
    ]);
  });

  it("leaves sentence punctuation out of the link and maps its columns", () => {
    const [link] = findTerminalUrlLinks("(see https://example.test/a.)");

    expect(link?.text).toBe("https://example.test/a");
    expect(link).toMatchObject({ start: 5, end: 5 + "https://example.test/a".length });
  });

  it("keeps a closing bracket that pairs with one inside the URL", () => {
    expect(findTerminalUrlLinks("http://[::1]:8080/")).toEqual([
      expect.objectContaining({ loopback: true, text: "http://[::1]:8080/" }),
    ]);
    expect(findTerminalUrlLinks("http://[::1]")).toEqual([
      expect.objectContaining({ loopback: true, text: "http://[::1]" }),
    ]);
    expect(findTerminalUrlLinks("see https://example.test/wiki/Foo_(bar).")).toEqual([
      expect.objectContaining({ text: "https://example.test/wiki/Foo_(bar)" }),
    ]);
    expect(findTerminalUrlLinks("(https://example.test/a)")).toEqual([
      expect.objectContaining({ text: "https://example.test/a" }),
    ]);
  });

  it("ignores schemes that must never be opened from terminal output", () => {
    expect(findTerminalUrlLinks("javascript:alert(1) file:///etc/passwd ftp://example.test/x")).toEqual([]);
    expect(findTerminalUrlLinks("https://example.test/")).toEqual([]);
  });

  it("skips a URL that wraps onto another row instead of opening a truncated address", () => {
    const row = "ready: http://localhost:5173/doc";
    const none = { continuesPreviousRow: false, continuesOnNextRow: false };

    expect(findTerminalUrlLinks(row, { ...none, continuesOnNextRow: true })).toEqual([]);
    expect(findTerminalUrlLinks("s and more", { ...none, continuesPreviousRow: true })).toEqual([]);
    expect(findTerminalUrlLinks("http://localhost:5173/ next", { ...none, continuesPreviousRow: true })).toEqual([]);
    expect(findTerminalUrlLinks("see http://localhost:5173/ ok", { ...none, continuesOnNextRow: true })).toHaveLength(1);
    expect(findTerminalUrlLinks("http://localhost:5173/    ", { ...none, continuesOnNextRow: true })).toHaveLength(1);
  });

  it("does not claim file paths", () => {
    expect(findTerminalUrlLinks("error: /workspace/src/main.ts:8:2")).toEqual([]);
  });
});
