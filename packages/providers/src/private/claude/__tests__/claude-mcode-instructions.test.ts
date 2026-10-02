import { describe, expect, it } from "vitest";
import { mergeClaudeMcpServers } from "../claude-provider.js";
describe("Claude Mcode instruction boundary", () => {
  it("keeps Claude internal and Browser MCP grants in one effective map", () => {
    const internal = { type: "sdk", instance: {} };
    const merged = mergeClaudeMcpServers(
      { mcode_internal_thread_control: internal },
      { mcpUrl: "http://127.0.0.1:1/mcp", token: "token" },
    );
    expect(merged.mcode_internal_thread_control).toBe(internal);
    expect(merged["mcode-browser"]).toMatchObject({ type: "http", url: "http://127.0.0.1:1/mcp" });
    expect(mergeClaudeMcpServers({}, null)).toEqual({});
  });

});
