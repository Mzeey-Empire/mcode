import { describe, expect, it } from "vitest";
import { CLAUDE_STATIC_MODELS, isLegacyClaudeModelId } from "../claude-static-fallback.js";
import { CODEX_STATIC_MODELS } from "../codex-static-fallback.js";
import { ProviderModelInfoSchema } from "../models.js";

describe("static provider catalogs", () => {
  it.each([...CLAUDE_STATIC_MODELS, ...CODEX_STATIC_MODELS].map((row) => [row.id, row] as const))(
    "%s parses as ProviderModelInfo",
    (_id, row) => {
      expect(ProviderModelInfoSchema().parse(row)).toEqual(row);
    },
  );
});

describe("Claude model lifecycle", () => {
  it("folds superseded generations away and keeps the newest of each family current", () => {
    const legacyIds = CLAUDE_STATIC_MODELS.filter((row) => row.lifecycle === "legacy").map((row) => row.id);
    expect(legacyIds).toEqual([
      "claude-opus-5",
      "claude-fable-5",
      "claude-sonnet-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
    ]);
  });

  it("leaves current models unflagged, so absent means current", () => {
    const current = CLAUDE_STATIC_MODELS.filter((row) => row.lifecycle !== "legacy");
    expect(current.map((row) => [row.id, row.lifecycle])).toEqual([
      ["claude-opus-5-5", undefined],
      ["claude-sonnet-5-5", undefined],
      ["claude-fable-5-1", undefined],
      ["claude-haiku-4-5", undefined],
    ]);
  });

  it("recognises dated discovery ids of a legacy model without matching a newer sibling", () => {
    expect(isLegacyClaudeModelId("claude-sonnet-4-6-20250514")).toBe(true);
    expect(isLegacyClaudeModelId("claude-opus-5")).toBe(true);
    expect(isLegacyClaudeModelId("claude-opus-5-5")).toBe(false);
    expect(isLegacyClaudeModelId("claude-opus-5-5-20261001")).toBe(false);
  });
});
