import { describe, expect, it } from "vitest";
import { hasCodexMcodeMcp } from "../../private/codex/codex-provider.js";

describe("Codex mcode MCP configuration validation", () => {
  it("accepts effective config containing the mcode server", () => {
    expect(
      hasCodexMcodeMcp({
        config: { mcp_servers: { mcode: { url: "http://fixture" } } },
      }),
    ).toBe(true);
  });

  it("rejects effective config without the mcode server", () => {
    expect(hasCodexMcodeMcp({ config: { mcp_servers: {} } })).toBe(false);
    expect(hasCodexMcodeMcp({ config: { mcp_servers: null } })).toBe(false);
    expect(hasCodexMcodeMcp({ config: { mcp_servers: { "mcode-browser": {} } } })).toBe(false);
  });
});
