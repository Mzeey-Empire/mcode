import { beforeEach, describe, expect, it, vi } from "vitest";

const activeTransport = {
  postPullRequestComment: vi.fn(),
  submitPullRequestReview: vi.fn(),
  setPullRequestReadiness: vi.fn(),
  closePullRequest: vi.fn(),
  mergePullRequest: vi.fn(),
};

vi.mock("../index", () => ({ getTransport: () => activeTransport }));

import { getPullRequestMutationTransport } from "../pull-request-mutations";

const identity = {
  provider: "github" as const,
  repositoryNodeId: "R_repo",
  owner: "Mzeey-Empire",
  repository: "mcode",
  number: 42,
};
const expected = {
  providerNodeId: "PR_42",
  state: "open" as const,
  readiness: "ready" as const,
  baseOid: "a".repeat(40),
  headOid: "b".repeat(40),
};

describe("pull request mutation transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const [name, method] of Object.entries(activeTransport)) {
      method.mockResolvedValue({ ok: false, source: name });
    }
  });

  it("routes each mutation to its own transport method", async () => {
    const transport = getPullRequestMutationTransport();
    const common = { identity, expected, idempotencyKey: crypto.randomUUID() };

    await expect(transport.postComment({ ...common, body: "Review note" }))
      .resolves.toEqual({ ok: false, source: "postPullRequestComment" });
    await expect(transport.submitReview({ ...common, event: "approve", drafts: [] }))
      .resolves.toEqual({ ok: false, source: "submitPullRequestReview" });
    await expect(transport.setReadiness({ ...common, readiness: "draft" }))
      .resolves.toEqual({ ok: false, source: "setPullRequestReadiness" });
    await expect(transport.close(common))
      .resolves.toEqual({ ok: false, source: "closePullRequest" });
    await expect(transport.merge({ ...common, method: "squash" }))
      .resolves.toEqual({ ok: false, source: "mergePullRequest" });
  });
});
