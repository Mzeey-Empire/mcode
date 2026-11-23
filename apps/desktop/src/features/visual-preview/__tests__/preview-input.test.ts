import { describe, expect, it } from "vitest";
import { VISUAL_PREVIEW_MAX_CONSOLE_ENTRIES } from "@mcode/contracts/ws/visual-preview";
import { parseVisualPreviewRequest, VisualPreviewConsole, visualPreviewConsoleEntry } from "../preview-input.js";

describe("desktop preview input", () => {
  it("rejects invalid IPC dimensions", () => {
    const input = {
      requestId: "8ab6eb1f-97a8-4813-b3cf-37a89670b485",
      frameDocument: "<p>chart</p>",
      width: 240,
      maxHeight: 2000,
      deadlineMs: 15_000,
    };
    expect(parseVisualPreviewRequest(input)).toEqual(input);
    expect(() => parseVisualPreviewRequest({ ...input, width: 239 })).toThrow();
  });

  it.each([
    ["debug", "log"],
    ["info", "info"],
    ["warning", "warning"],
    ["error", "error"],
  ] as const)("reports Electron %s as %s", (level, expected) => {
    expect(visualPreviewConsoleEntry(level, "chart diagnostic", 6)).toEqual({
      level: expected, text: "chart diagnostic", line: 6,
    });
  });

  it("omits a missing source line", () => {
    expect(visualPreviewConsoleEntry("error", "chart diagnostic", 0)).toEqual({
      level: "error", text: "chart diagnostic",
    });
  });

  it("evicts the oldest non-error at capacity and keeps the remaining entries in order", () => {
    const console = new VisualPreviewConsole();
    const firstError = visualPreviewConsoleEntry("error", "First error", 1);
    const lastError = visualPreviewConsoleEntry("error", "Last error", 4);
    const logs = Array.from({ length: VISUAL_PREVIEW_MAX_CONSOLE_ENTRIES - 1 }, (_, index) =>
      visualPreviewConsoleEntry("log", `Log ${index + 1}`, 2));
    console.add(firstError);
    for (const log of logs) console.add(log);
    console.add(visualPreviewConsoleEntry("info", "Extra info", 3));
    console.add(lastError);
    expect(console.entries).toEqual([firstError, ...logs.slice(1), lastError]);
    expect(console.dropped).toBe(2);
  });

  it("drops an incoming error when the buffer already contains only errors", () => {
    const console = new VisualPreviewConsole();
    const errors = Array.from({ length: VISUAL_PREVIEW_MAX_CONSOLE_ENTRIES }, (_, index) =>
      visualPreviewConsoleEntry("error", `Error ${index + 1}`, index + 1));
    for (const error of errors) console.add(error);
    console.add(visualPreviewConsoleEntry("error", "Extra error", 201));
    expect(console.entries).toEqual(errors);
    expect(console.dropped).toBe(1);
  });

  it("evicts the oldest plain error for an uncaught exception at capacity", () => {
    const console = new VisualPreviewConsole();
    const errors = Array.from({ length: VISUAL_PREVIEW_MAX_CONSOLE_ENTRIES }, (_, index) =>
      visualPreviewConsoleEntry("error", `Error ${index + 1}`, index + 1));
    const exception = visualPreviewConsoleEntry("error", "Uncaught (in promise) Error: broken chart", 201);
    for (const error of errors) console.add(error);
    console.add(exception);
    expect(console.entries.at(-1)).toEqual(exception);
    expect(console.entries).toEqual([...errors.slice(1), exception]);
    expect(console.dropped).toBe(1);
  });
});
