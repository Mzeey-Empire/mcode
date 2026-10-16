import { describe, expect, it } from "vitest";
import { TerminalPlainTextDecoder } from "../terminal-plain-text.js";

describe("TerminalPlainTextDecoder", () => {
  it("carries a split CSI inside a URL without exposing escape bytes", () => {
    const decoder = new TerminalPlainTextDecoder();
    expect(decoder.write(Buffer.from("http://localhost:\x1b[1"))).toEqual({ completedLines: [], currentLine: "http://localhost:" });
    expect(decoder.write(Buffer.from("m5173\x1b[22m/\n"))).toEqual({ completedLines: ["http://localhost:5173/"], currentLine: "" });
  });

  it("keeps OSC 8 link labels and discards hyperlink targets and other control strings", () => {
    const decoder = new TerminalPlainTextDecoder();
    decoder.write(Buffer.from("\x1b]8;;http://localhost:9999/\x1b"));
    expect(decoder.write(Buffer.from("\\http://localhost:5173/\x1b]8;;\x07\x1bPdiscard\x07hidden\x1b\\\x1b(B\x1b#8\x00\x08\tOK\n")))
      .toEqual({ completedLines: ["http://localhost:5173/\tOK"], currentLine: "" });
  });

  it("decodes a UTF-8 character split between byte chunks", () => {
    const decoder = new TerminalPlainTextDecoder();
    const bytes = Buffer.from("✓ ready\n");
    expect(decoder.write(bytes.subarray(0, 2))).toEqual({ completedLines: [], currentLine: "" });
    expect(decoder.write(bytes.subarray(2))).toEqual({ completedLines: ["✓ ready"], currentLine: "" });
  });

  it("overwrites from column zero across chunks and preserves the untouched suffix", () => {
    const decoder = new TerminalPlainTextDecoder();
    decoder.write(Buffer.from("progress 10%\r"));
    expect(decoder.write(Buffer.from("progress 90%\rDone"))).toEqual({ completedLines: [], currentLine: "Doneress 90%" });
    expect(decoder.write(Buffer.from("\rprogress 100%\r\nnext"))).toEqual({ completedLines: ["progress 100%"], currentLine: "next" });
  });
});
