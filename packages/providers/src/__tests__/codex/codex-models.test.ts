import * as NodeStream from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { CodexRpcClient } from "../../private/codex/codex-rpc-client.js";
import { listCodexModels } from "../../private/codex/codex-models.js";

const clients: CodexRpcClient[] = [];
afterEach(() => clients.splice(0).forEach((client) => client.dispose()));

function catalog(pages: unknown[]) {
  const requests: Array<{ method: string; params: unknown }> = [];
  const stdout = new NodeStream.PassThrough();
  const stdin = new NodeStream.Writable({
    write(chunk, _encoding, callback) {
      const request = JSON.parse(chunk.toString());
      requests.push({ method: request.method, params: request.params });
      stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: pages.shift() }) + "\n");
      callback();
    },
  });
  const client = new CodexRpcClient(stdin, stdout);
  clients.push(client);
  return { client, requests };
}

function model(id: string, displayName = id, hidden = false) {
  return {
    id: `catalog-${id}`, model: id, displayName, hidden,
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
    defaultReasoningEffort: "low", inputModalities: ["text", "image"],
  };
}

describe("Codex model discovery", () => {
  it("preserves page order and submission IDs, formats labels, and excludes hidden models", async () => {
    const { client, requests } = catalog([
      { data: [model("gpt-9-zeta", "GPT-9-Zeta"), model("hidden", "Hidden", true)], nextCursor: "page-2" },
      { data: [model("gpt-9-alpha", "  GPT-9\n Alpha\u202e  ")], nextCursor: null },
    ]);
    const models = await listCodexModels(client);
    expect(models).toEqual([
      { id: "gpt-9-zeta", name: "GPT-9 Zeta", group: "OpenAI", supportsVision: true,
        supportsReasoning: true, supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" },
      { id: "gpt-9-alpha", name: "GPT-9 Alpha", group: "OpenAI", supportsVision: true,
        supportsReasoning: true, supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" },
    ]);
    expect(requests).toEqual([
      { method: "model/list", params: { limit: 100, includeHidden: false } },
      { method: "model/list", params: { limit: 100, includeHidden: false, cursor: "page-2" } },
    ]);
  });

  it("rejects malformed responses instead of returning the static catalog", async () => {
    const { client } = catalog([{ data: [{ model: 7 }], nextCursor: null }]);
    await expect(listCodexModels(client)).rejects.toMatchObject({ name: "ZodError" });
  });

  it("stops repeated cursors without returning a partial catalog", async () => {
    const { client, requests } = catalog([
      { data: [], nextCursor: "same" }, { data: [], nextCursor: "same" },
    ]);
    await expect(listCodexModels(client)).rejects.toThrow();
    expect(requests).toHaveLength(2);
  });

  it("returns an empty catalog and does not invent unsupported effort levels", async () => {
    const empty = catalog([{ data: [], nextCursor: null }]);
    expect(await listCodexModels(empty.client)).toEqual([]);
    const unknown = catalog([{ data: [{ ...model("custom", ""),
      supportedReasoningEfforts: [{ reasoningEffort: "future" }], defaultReasoningEffort: "future",
      inputModalities: ["text"],
    }], nextCursor: null }]);
    expect(await listCodexModels(unknown.client)).toEqual([{
      id: "custom", name: "Custom", group: "OpenAI", supportsVision: false,
      supportsReasoning: false, supportedReasoningEfforts: [],
    }]);
  });
});
