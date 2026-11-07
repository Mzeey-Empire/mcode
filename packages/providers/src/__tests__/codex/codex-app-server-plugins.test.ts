import { describe, expect, it, vi } from "vitest";
import { CodexAppServer } from "../../private/codex/codex-app-server.js";

describe("Codex installed plugin discovery", () => {
  it.each([undefined, ["C:/workspace"]])("requests only installed summaries for %j", async (cwds) => {
    const result = { marketplaces: [], marketplaceLoadErrors: [] };
    const sendRequest = vi.fn(async (method: string) => {
      if (method !== "plugin/installed") throw new Error("Full remote catalog requested");
      return result;
    });
    const server = new CodexAppServer({ cliPath: "codex", platform: process.platform, workingDirectory: process.cwd() });
    Reflect.set(server, "_isAlive", true);
    Reflect.set(server, "rpc", { sendRequest });
    expect(await server.listPlugins(cwds)).toEqual(result);
    expect(sendRequest).toHaveBeenCalledWith("plugin/installed", cwds ? { cwds } : {}, 10000);
  });
});
