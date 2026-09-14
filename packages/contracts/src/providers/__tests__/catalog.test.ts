import { describe, it, expect } from "vitest";
import { PROVIDER_CATALOG, getCatalogEntry } from "../catalog.js";

describe("PROVIDER_CATALOG", () => {
  it("contains all seven providers in canonical order", () => {
    expect(PROVIDER_CATALOG.map((p) => p.id)).toEqual([
      "claude", "codex", "copilot", "gemini", "cursor", "opencode", "devin",
    ]);
  });

  it("flags copilot, cursor, opencode, and devin as beta; gemini remains comingSoon", () => {
    expect(getCatalogEntry("copilot").beta).toBe(true);
    expect(getCatalogEntry("cursor").beta).toBe(true);
    expect(getCatalogEntry("opencode").beta).toBe(true);
    expect(getCatalogEntry("devin").beta).toBe(true);
    expect(getCatalogEntry("devin").comingSoon).toBe(false);
    expect(getCatalogEntry("gemini").comingSoon).toBe(true);
    expect(getCatalogEntry("cursor").comingSoon).toBe(false);
    expect(getCatalogEntry("opencode").comingSoon).toBe(false);
  });

  it("maps each provider to its CLI binary name", () => {
    expect(getCatalogEntry("claude").cliBinary).toBe("claude");
    expect(getCatalogEntry("codex").cliBinary).toBe("codex");
    expect(getCatalogEntry("copilot").cliBinary).toBe("copilot");
    expect(getCatalogEntry("cursor").cliBinary).toBe("cursor-agent");
    expect(getCatalogEntry("devin").cliBinary).toBe("devin");
  });
});
