import { beforeEach, describe, expect, it, vi } from "vitest";

const activeTransport = {
  createPullRequestReviewTask: vi.fn(),
  getPullRequestReviewLink: vi.fn(),
};

vi.mock("../index", () => ({
  getTransport: () => activeTransport,
}));

import { getPullRequestReviewTaskTransport } from "../pull-request-review-task";

const identity = {
  provider: "github" as const,
  repositoryNodeId: "R_repo",
  owner: "Mzeey-Empire",
  repository: "mcode",
  number: 42,
};

describe("pull request Review-task transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes each Review-task action to its own transport method", async () => {
    for (const [name, method] of Object.entries(activeTransport)) {
      method.mockResolvedValue({ ok: false, source: name });
    }
    const transport = getPullRequestReviewTaskTransport();

    await expect(transport.createReviewTask({ action: "prepare", operationId: "review-prepare-1", identity }))
      .resolves.toEqual({ ok: false, source: "createPullRequestReviewTask" });
    await expect(transport.reviewLink({ threadId: "thread-1" }))
      .resolves.toEqual({ ok: false, source: "getPullRequestReviewLink" });
  });
});
