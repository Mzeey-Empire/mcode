import { describe, it, expect } from "vitest";
import { formatModelLabel } from "../format-model-label";

describe("formatModelLabel", () => {
  it("formats Claude opus identifiers", () => {
    expect(formatModelLabel("claude-opus-4-7")).toBe("Claude Opus 4.7");
    expect(formatModelLabel("claude-opus-4-6")).toBe("Claude Opus 4.6");
  });

  it("formats Claude sonnet identifiers", () => {
    expect(formatModelLabel("claude-sonnet-4-6")).toBe("Claude Sonnet 4.6");
    expect(formatModelLabel("claude-sonnet-4-5")).toBe("Claude Sonnet 4.5");
  });

  it("formats Claude haiku identifiers with date suffixes", () => {
    expect(formatModelLabel("claude-haiku-4-5-20251001")).toBe("Claude Haiku 4.5");
    expect(formatModelLabel("claude-haiku-4-5")).toBe("Claude Haiku 4.5");
  });

  it("title-cases single-word provider names", () => {
    expect(formatModelLabel("codex")).toBe("Codex");
    expect(formatModelLabel("cursor-agent")).toBe("Cursor");
  });

  it("returns unknown identifiers unchanged when no segment can be extracted", () => {
    expect(formatModelLabel("")).toBe("");
  });
});
