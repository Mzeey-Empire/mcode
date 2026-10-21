import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { titleFrom } from "../thread-creation-coordinator.js";

describe("titleFrom", () => {
  it("keeps a 60-character first line whole without an ellipsis", () => {
    const line = "Refactor the provider adapter so retries survive reconnects!";
    expect(titleFrom(line)).toBe(line);
  });

  it("cuts an overlong line at a word boundary without an ellipsis", () => {
    const title = titleFrom("word ".repeat(60).trim() + "tail");
    expect(title.length).toBeLessThanOrEqual(200);
    expect(title.endsWith("...")).toBe(false);
    expect(title.endsWith(" ")).toBe(false);
    expect(title.split(" ").every((word) => word === "word")).toBe(true);
  });

  it("uses only the first line", () => {
    expect(titleFrom("Fix the header\nMore detail here")).toBe("Fix the header");
  });

  it("falls back to New Thread for blank content", () => {
    expect(titleFrom("   \n  ")).toBe("New Thread");
  });
});
