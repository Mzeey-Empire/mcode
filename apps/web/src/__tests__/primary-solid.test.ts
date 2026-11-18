import { describe, expect, it } from "vitest";
import { contrast, resolveToken, themeTokens } from "./token-contrast";

describe("solid amber fill", () => {
  it.each(["light", "dark"] as const)("keeps its %s label at 4.5:1, at rest and on hover", (themeName) => {
    const tokens = themeTokens[themeName];
    const ink = resolveToken(tokens, "--primary-solid-ink");
    expect(contrast(ink, resolveToken(tokens, "--primary-solid"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(ink, resolveToken(tokens, "--primary-solid-hover"))).toBeGreaterThanOrEqual(4.5);
  });
});
