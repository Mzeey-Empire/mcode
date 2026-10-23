import { describe, expect, it } from "vitest";
import { CLAUDE_STATIC_MODELS, withClaudeLifecycle } from "../claude-static-fallback.js";
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
  const lifecycleOf = (id: string) => CLAUDE_STATIC_MODELS.find((row) => row.id === id)?.lifecycle ?? "current";

  it("folds the previous generation away and keeps the newest of each family current", () => {
    expect(["claude-opus-5", "claude-sonnet-5"].map(lifecycleOf)).toEqual(["legacy", "legacy"]);
    expect(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"].map(lifecycleOf))
      .toEqual(["current", "current", "current"]);
  });

  it("marks a dated discovery snapshot of a legacy model without folding a newer sibling", () => {
    const lifecycle = (id: string) => withClaudeLifecycle({ id, name: id }).lifecycle;
    expect(lifecycle("claude-sonnet-5-20260514")).toBe("legacy");
    expect(lifecycle("claude-opus-5-5")).toBeUndefined();
    expect(lifecycle("claude-opus-5-5-20261001")).toBeUndefined();
  });
});
