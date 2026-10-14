import { beforeEach, describe, expect, it, vi } from "vitest";

const activeTransport = {
  getPullRequestCapabilities: vi.fn(),
  listPullRequests: vi.fn(),
  getPullRequestResource: vi.fn(),
  getPullRequestTimeline: vi.fn(),
  getPullRequestFiles: vi.fn(),
  getPullRequestPatch: vi.fn(),
  cancelPullRequestOperation: vi.fn(),
};

vi.mock("../index", () => ({
  getTransport: () => activeTransport,
}));

import { getPullRequestTransport } from "../pull-requests";

describe("pull request transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes each call to its own transport method", async () => {
    for (const [name, method] of Object.entries(activeTransport)) {
      method.mockResolvedValue({ ok: false, source: name });
    }
    const transport = getPullRequestTransport();
    const identity = {
      provider: "github" as const,
      repositoryNodeId: "R_repo",
      owner: "Mzeey-Empire",
      repository: "mcode",
      number: 10,
    };
    const range = { identity, baseOid: "a".repeat(40), headOid: "b".repeat(40) };

    await expect(transport.getCapabilities({ operationId: "cap-1", provider: "github" }))
      .resolves.toEqual({ ok: false, source: "getPullRequestCapabilities" });
    await expect(transport.list({
      operationId: "list-1",
      provider: "github",
      relationships: ["authored"],
      states: ["open"],
      limit: 30,
    })).resolves.toEqual({ ok: false, source: "listPullRequests" });
    await expect(transport.get({ operationId: "detail-1", resource: "detail", identity }))
      .resolves.toEqual({ ok: false, source: "getPullRequestResource" });
    await expect(transport.timeline({ operationId: "timeline-1", lane: "initial", identity, limit: 30 }))
      .resolves.toEqual({ ok: false, source: "getPullRequestTimeline" });
    await expect(transport.files({
      operationId: "files-1",
      ...range,
      search: "transport",
      changeTypes: ["modified"],
      limit: 100,
    })).resolves.toEqual({ ok: false, source: "getPullRequestFiles" });
    await expect(transport.patch({ operationId: "patch-1", ...range, locator: "file_1" }))
      .resolves.toEqual({ ok: false, source: "getPullRequestPatch" });
    await expect(transport.cancel({ operationId: "list-1" }))
      .resolves.toEqual({ ok: false, source: "cancelPullRequestOperation" });
  });
});
