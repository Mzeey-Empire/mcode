// @vitest-environment jsdom
import { createMockThread, createMockWorkspace } from "@mcode/contracts/testing";
import { mockTransport } from "@/__tests__/mocks/transport";
import { act, renderHook, waitFor } from "@testing-library/react";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewState } from "@mcode/contracts/models/review-comparison";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useDiffStore } from "@/stores/diffStore";
import { startPushListeners, stopPushListeners } from "@/transport/ws-events";
import { pushEmitter } from "@/transport/ws-transport";
import { useReviewState } from "./useReviewState";

vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));

const getReviewState = vi.mocked(mockTransport.getReviewState);
const WORKSPACE = "workspace-checkout-change";
let repo = "";

function git(...args: string[]): string {
  return NodeChildProcess.execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

/**
 * Answers each request with the branch checked out when the request starts and
 * holds the answer until `release`, the way a slow server probe reads git
 * before the reply reaches the client.
 */
function delayedProbes() {
  const pending: Array<() => void> = [];
  getReviewState.mockImplementation(() => {
    const state: ReviewState = {
      isGitRepo: true, head: git("rev-parse", "HEAD"), branch: git("rev-parse", "--abbrev-ref", "HEAD"),
      uncommitted: { staged: 0, unstaged: 0, untracked: 0 }, commitsAhead: null, branchDefault: { unavailable: "no-base" },
    };
    return new Promise((resolve) => { pending.push(() => resolve(state)); });
  });
  return { release: async () => { await act(async () => { for (const finish of pending.splice(0)) finish(); }); } };
}

beforeAll(() => {
  repo = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-review-checkout-")));
  NodeChildProcess.execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo]);
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "init");
  git("branch", "feature");
});
afterAll(() => { NodeFS.rmSync(repo, { recursive: true, force: true }); });

beforeEach(() => {
  getReviewState.mockReset();
  useDiffStore.setState({ diffRevisionByScope: {} });
  startPushListeners();
});
afterEach(() => {
  stopPushListeners();
  git("checkout", "--quiet", "main");
});

// A request that started before a checkout change answers for the old HEAD,
// so no reader may join it once the server reports the change.
describe("useReviewState after a checkout change", () => {
  it("does not hand a reader that mounts after a branch switch the read started before it", async () => {
    useWorkspaceStore.setState({
      workspaces: [createMockWorkspace({ id: WORKSPACE, path: repo })],
      threads: [
        createMockThread({ id: "direct-a", workspace_id: WORKSPACE, mode: "direct", worktree_path: null }),
        createMockThread({ id: "direct-b", workspace_id: WORKSPACE, mode: "direct", worktree_path: null }),
      ],
    });
    const probes = delayedProbes();
    const away = renderHook(() => useReviewState(WORKSPACE, "direct-a"));
    away.unmount();

    git("checkout", "--quiet", "feature");
    act(() => pushEmitter.emit("branch.changed", { workspaceId: WORKSPACE, branch: "feature" }));
    const back = renderHook(() => [useReviewState(WORKSPACE, "direct-a"), useReviewState(WORKSPACE, "direct-b")]);
    await probes.release();

    await waitFor(() => expect(back.result.current.map((hook) => hook.state?.isGitRepo && hook.state.branch)).toEqual(["feature", "feature"]));
  });

  it("re-reads every mounted reader of a worktree whose HEAD moved, and only those", async () => {
    useWorkspaceStore.setState({
      workspaces: [createMockWorkspace({ id: WORKSPACE, path: NodePath.join(repo, "..", "elsewhere") })],
      threads: [
        createMockThread({ id: "worktree-a", workspace_id: WORKSPACE, mode: "worktree", worktree_path: repo }),
        createMockThread({ id: "worktree-b", workspace_id: WORKSPACE, mode: "worktree", worktree_path: `${repo}/` }),
        createMockThread({ id: "other", workspace_id: WORKSPACE, mode: "worktree", worktree_path: NodePath.join(repo, "..", "other") }),
      ],
    });
    const probes = delayedProbes();
    const readers = renderHook(() => [useReviewState(WORKSPACE, "worktree-b"), useReviewState(WORKSPACE, "other")]);
    await probes.release();
    await waitFor(() => expect(readers.result.current.map((hook) => hook.state?.isGitRepo && hook.state.branch)).toEqual(["main", "main"]));

    git("checkout", "--quiet", "feature");
    act(() => pushEmitter.emit("thread.checkoutChanged", {
      threadId: "worktree-a", workspaceId: WORKSPACE, branch: "feature", checkoutState: "named", baseBranch: null, headSha: null,
    }));
    await probes.release();

    await waitFor(() => expect(readers.result.current[0]?.state).toMatchObject({ branch: "feature" }));
    expect(getReviewState.mock.calls).toEqual([[WORKSPACE, "worktree-b"], [WORKSPACE, "other"], [WORKSPACE, "worktree-b"]]);
  });
});
