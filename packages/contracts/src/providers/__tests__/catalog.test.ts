import { describe, it, expect } from "vitest";
import { PROVIDER_CATALOG, getCatalogEntry } from "../catalog.js";

describe("PROVIDER_CATALOG", () => {
  it("contains all six providers in canonical order", () => {
    expect(PROVIDER_CATALOG.map((p) => p.id)).toEqual([
      "claude", "codex", "copilot", "gemini", "cursor", "opencode",
    ]);
  });

  it("flags copilot as beta and gemini/cursor/opencode as comingSoon", () => {
    expect(getCatalogEntry("copilot").beta).toBe(true);
    expect(getCatalogEntry("gemini").comingSoon).toBe(true);
    expect(getCatalogEntry("cursor").comingSoon).toBe(true);
    expect(getCatalogEntry("opencode").comingSoon).toBe(true);
  });

  it("maps each provider to its CLI binary name", () => {
    expect(getCatalogEntry("claude").cliBinary).toBe("claude");
    expect(getCatalogEntry("codex").cliBinary).toBe("codex");
    expect(getCatalogEntry("copilot").cliBinary).toBe("copilot");
  });
});
